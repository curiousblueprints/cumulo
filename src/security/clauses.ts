import {
  ClauseMatch,
  ClauseOperator,
  FieldType,
  UNARY_OPERATORS,
  type FieldDef,
  type Id,
  type SecurityRuleClause,
  type User,
} from '../domain/types.js';
import { evaluateClauseLogic } from './clauseLogic.js';
import { ValidationError } from './errors.js';

/** Field values of a single record, keyed by field id. */
export type ValueMap = ReadonlyMap<Id, string | null>;

/**
 * Context tokens usable in a clause's target value. They let a rule say
 * "records this user owns" without hard-coding a user id.
 */
function resolveTarget(target: string | null, user: User): string | null {
  if (target === null) return null;
  switch (target) {
    case '$user.id':
      return user.id;
    case '$user.securityRoleId':
      return user.securityRoleId;
    case '$user.username':
      return user.username;
    default:
      return target;
  }
}

function compareNumbers(
  left: string,
  right: string,
  compare: (a: number, b: number) => boolean,
): boolean {
  const a = Number(left);
  const b = Number(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return compare(a, b);
}

function ordered(
  type: FieldType,
  left: string,
  right: string,
  numeric: (a: number, b: number) => boolean,
  textual: (a: string, b: string) => boolean,
): boolean {
  if (type === FieldType.Number) return compareNumbers(left, right, numeric);
  // ISO-8601 dates and datetimes sort correctly as text.
  return textual(left, right);
}

function equals(type: FieldType, left: string, right: string): boolean {
  if (type === FieldType.Number) return compareNumbers(left, right, (a, b) => a === b);
  if (type === FieldType.Boolean) return normalizeBoolean(left) === normalizeBoolean(right);
  return left === right;
}

function normalizeBoolean(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return 'true';
  if (lower === 'false' || lower === '0' || lower === 'no' || lower === '') return 'false';
  return lower;
}

/**
 * Evaluate a single clause against one record.
 *
 * Empty values are read literally rather than defensively: an empty field is
 * simply not equal to "x", so `field != x` matches it. Only `equals`-shaped
 * questions can be answered about an empty value; the ordering and text
 * operators have nothing to compare, so they are false. Use `isNull` /
 * `isNotNull` when emptiness itself is the thing you mean.
 */
export function evaluateClause(
  clause: SecurityRuleClause,
  field: FieldDef,
  compareField: FieldDef | null,
  values: ValueMap,
  user: User,
): boolean {
  const left = blankToNull(values.get(clause.fieldId) ?? null);

  if (clause.operator === ClauseOperator.IsNull) return left === null;
  if (clause.operator === ClauseOperator.IsNotNull) return left !== null;

  const right = blankToNull(
    compareField
      ? (values.get(compareField.id) ?? null)
      : resolveTarget(clause.targetValue, user),
  );

  const type = field.type;

  // Equality is the one comparison that stays meaningful when a side is empty:
  // two empty values are equal, and an empty value differs from any other.
  if (clause.operator === ClauseOperator.Equals) {
    if (left === null || right === null) return left === right;
    return equals(type, left, right);
  }
  if (clause.operator === ClauseOperator.NotEquals) {
    if (left === null || right === null) return left !== right;
    return !equals(type, left, right);
  }

  if (left === null || right === null) return false;

  switch (clause.operator) {
    case ClauseOperator.GreaterThan:
      return ordered(type, left, right, (a, b) => a > b, (a, b) => a > b);
    case ClauseOperator.GreaterOrEqual:
      return ordered(type, left, right, (a, b) => a >= b, (a, b) => a >= b);
    case ClauseOperator.LessThan:
      return ordered(type, left, right, (a, b) => a < b, (a, b) => a < b);
    case ClauseOperator.LessOrEqual:
      return ordered(type, left, right, (a, b) => a <= b, (a, b) => a <= b);
    case ClauseOperator.Contains:
      return left.includes(right);
    case ClauseOperator.StartsWith:
      return left.startsWith(right);
    case ClauseOperator.In:
      return right
        .split(',')
        .map((part) => part.trim())
        .some((part) => equals(type, left, part));
    default:
      throw new ValidationError(`Unsupported clause operator: ${String(clause.operator)}`);
  }
}

/** An absent value and an empty string mean the same thing: no value. */
function blankToNull(value: string | null): string | null {
  return value === null || value === '' ? null : value;
}

/** A rule with its clauses and accessible fields resolved once, up front. */
export interface CompiledRule {
  id: Id;
  name: string;
  tableId: Id;
  accessTypes: ReadonlySet<string>;
  /** Table-level: this rule permits creating records in its table. */
  canCreate: boolean;
  clauseMatch: ClauseMatch;
  clauseLogic: string | null;
  clauses: SecurityRuleClause[];
  fieldIds: ReadonlySet<Id>;
}

/**
 * Does `rule` apply to a record with these values?
 * A rule with no clauses applies to every record in its table.
 */
export function ruleApplies(
  rule: CompiledRule,
  values: ValueMap,
  fields: ReadonlyMap<Id, FieldDef>,
  user: User,
): boolean {
  if (rule.clauses.length === 0) return true;

  const results = new Map<number, boolean>();
  for (const clause of rule.clauses) {
    const field = fields.get(clause.fieldId);
    if (!field) {
      // A clause pointing at a field that no longer exists cannot be
      // satisfied; treating it as false keeps the rule from over-granting.
      results.set(clause.sequence, false);
      continue;
    }
    const compareField = clause.compareFieldId ? (fields.get(clause.compareFieldId) ?? null) : null;
    if (clause.compareFieldId && !compareField) {
      results.set(clause.sequence, false);
      continue;
    }
    results.set(clause.sequence, evaluateClause(clause, field, compareField, values, user));
  }

  switch (rule.clauseMatch) {
    case ClauseMatch.All:
      return [...results.values()].every(Boolean);
    case ClauseMatch.Any:
      return [...results.values()].some(Boolean);
    case ClauseMatch.Custom:
      if (!rule.clauseLogic) {
        throw new ValidationError(`Rule "${rule.name}" uses custom logic but defines none`);
      }
      return evaluateClauseLogic(rule.clauseLogic, results);
    default:
      throw new ValidationError(`Unsupported clause match: ${String(rule.clauseMatch)}`);
  }
}

export { UNARY_OPERATORS };
