/**
 * Domain model for the platform.
 *
 * These are the logical shapes the application and security layers speak in.
 * They are deliberately storage agnostic: the database layer is responsible
 * for mapping them onto whatever it uses underneath (SQLite, today).
 */

/** Every row in the platform is keyed by an opaque string id. */
export type Id = string;

/** Reserved namespace that ships with every installation. */
export const STD_NAMESPACE = 'std';

/** Reserved security role that ships with every installation. */
export const ADMINISTRATOR_ROLE = 'Administrator';

/**
 * The operations a security rule can grant. A rule must grant at least one.
 * Creating a record is governed by EDIT: a role that may edit a table may
 * insert into it, provided the new record satisfies the rule's clauses.
 */
export enum AccessType {
  Read = 'read',
  Edit = 'edit',
  Delete = 'delete',
}

export const ALL_ACCESS_TYPES: readonly AccessType[] = [
  AccessType.Read,
  AccessType.Edit,
  AccessType.Delete,
];

/**
 * How a rule's clauses combine.
 *  - All:    every clause must be true (AND).
 *  - Any:    at least one clause must be true (OR).
 *  - Custom: `clauseLogic` holds an expression over clause sequence numbers,
 *            e.g. "1 AND (2 OR 3)".
 * A rule with no clauses always applies, whatever the match mode.
 */
export enum ClauseMatch {
  All = 'all',
  Any = 'any',
  Custom = 'custom',
}

/** The data types a field can hold. */
export enum FieldType {
  Text = 'text',
  Number = 'number',
  Boolean = 'boolean',
  Date = 'date',
  DateTime = 'datetime',
  /** A lookup to a record in another table; `referenceTableId` is required. */
  Reference = 'reference',
}

/** Comparison operators available to a security rule clause. */
export enum ClauseOperator {
  Equals = 'equals',
  NotEquals = 'notEquals',
  GreaterThan = 'greaterThan',
  GreaterOrEqual = 'greaterOrEqual',
  LessThan = 'lessThan',
  LessOrEqual = 'lessOrEqual',
  Contains = 'contains',
  StartsWith = 'startsWith',
  In = 'in',
  IsNull = 'isNull',
  IsNotNull = 'isNotNull',
}

/** Operators that take no target value at all. */
export const UNARY_OPERATORS: readonly ClauseOperator[] = [
  ClauseOperator.IsNull,
  ClauseOperator.IsNotNull,
];

export interface Namespace {
  id: Id;
  /** Unique API name, e.g. "std" or "acme". */
  name: string;
  label: string;
  /** True for "std", which cannot be renamed or removed. */
  isSystem: boolean;
  createdAt: string;
}

export interface SecurityRole {
  id: Id;
  name: string;
  /**
   * Null only for the Administrator role, which is the root of the hierarchy.
   * Every other role must name a parent.
   */
  parentId: Id | null;
  /** True for Administrator, which cannot be modified or deleted. */
  isSystem: boolean;
  createdAt: string;
}

export interface NamespaceAccess {
  id: Id;
  securityRoleId: Id;
  namespaceId: Id;
  createdAt: string;
}

export interface User {
  id: Id;
  username: string;
  email: string;
  passwordHash: string;
  securityRoleId: Id;
  isActive: boolean;
  createdAt: string;
}

export interface TableDef {
  id: Id;
  namespaceId: Id;
  name: string;
  label: string;
  createdAt: string;
}

export interface FieldDef {
  id: Id;
  namespaceId: Id;
  tableId: Id;
  name: string;
  label: string;
  type: FieldType;
  isRequired: boolean;
  /** Set only when `type` is Reference: the table this field points at. */
  referenceTableId: Id | null;
  createdAt: string;
}

export interface SecurityRule {
  id: Id;
  name: string;
  tableId: Id;
  accessTypes: AccessType[];
  clauseMatch: ClauseMatch;
  /** Only meaningful when `clauseMatch` is Custom. */
  clauseLogic: string | null;
  createdAt: string;
}

export interface SecurityRoleRule {
  id: Id;
  securityRoleId: Id;
  securityRuleId: Id;
  createdAt: string;
}

export interface SecurityRuleClause {
  id: Id;
  securityRuleId: Id;
  /** 1-based position, referenced by custom clause logic. */
  sequence: number;
  fieldId: Id;
  operator: ClauseOperator;
  /**
   * The literal the field is compared against. Supports the context tokens
   * `$user.id` and `$user.securityRoleId`, which resolve against the acting
   * user at evaluation time. Ignored when `compareFieldId` is set or the
   * operator is unary.
   */
  targetValue: string | null;
  /** When set, the clause compares two fields of the same record. */
  compareFieldId: Id | null;
  createdAt: string;
}

export interface SecurityRuleField {
  id: Id;
  securityRuleId: Id;
  fieldId: Id;
  createdAt: string;
}

export interface RecordRow {
  id: Id;
  tableId: Id;
  createdAt: string;
  updatedAt: string;
}

export interface ValueRow {
  id: Id;
  recordId: Id;
  fieldId: Id;
  /** Values are stored as text and coerced on read using the field's type. */
  value: string | null;
}

/** A record plus its field values, keyed by field API name. */
export interface RecordView {
  id: Id;
  tableId: Id;
  createdAt: string;
  updatedAt: string;
  values: Record<string, unknown>;
}
