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
 * The record-level operations a security rule can grant. A rule must grant at
 * least one of these, or set `canCreate`.
 *
 * These are all evaluated per record, against the rule's clauses. Creating is
 * not: it is a table-level grant, carried by `SecurityRule.canCreate`, because
 * there is no record yet to evaluate clauses against.
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

/**
 * How far a single field grant reaches. Edit implies read: a field you may
 * change is necessarily a field you may see.
 */
export enum FieldAccess {
  Read = 'read',
  Edit = 'edit',
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
  /** Assigned by the platform on create, sequential within the field. */
  AutoNumber = 'autoNumber',
  /** A four-digit year. */
  Year = 'year',
  /** A month of the year, stored 1-12. */
  Month = 'month',
  /**
   * A day of the month, stored 1-31. Not validated against a month: a day
   * standing on its own has no month to be too large for.
   */
  Day = 'day',
  /** A day of the week, stored 1-7 with Sunday as 1. */
  DayOfWeek = 'dayOfWeek',
}

/** Types compared as numbers rather than as text. */
export const NUMERIC_FIELD_TYPES: readonly FieldType[] = [
  FieldType.Number,
  FieldType.AutoNumber,
  FieldType.Year,
  FieldType.Month,
  FieldType.Day,
  FieldType.DayOfWeek,
];

/** Types the platform fills in, which no one may set or edit. */
export const SYSTEM_ASSIGNED_FIELD_TYPES: readonly FieldType[] = [FieldType.AutoNumber];

/** Months, by their stored value. */
export const MONTHS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'January' },
  { value: 2, label: 'February' },
  { value: 3, label: 'March' },
  { value: 4, label: 'April' },
  { value: 5, label: 'May' },
  { value: 6, label: 'June' },
  { value: 7, label: 'July' },
  { value: 8, label: 'August' },
  { value: 9, label: 'September' },
  { value: 10, label: 'October' },
  { value: 11, label: 'November' },
  { value: 12, label: 'December' },
];

/** Days of the week, by their stored value. The week starts on Sunday. */
export const DAYS_OF_WEEK: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Sunday' },
  { value: 2, label: 'Monday' },
  { value: 3, label: 'Tuesday' },
  { value: 4, label: 'Wednesday' },
  { value: 5, label: 'Thursday' },
  { value: 6, label: 'Friday' },
  { value: 7, label: 'Saturday' },
];

/**
 * The API name of the field every table is created with. It is a system field:
 * it cannot be deleted, so anything referring to a record by name can count on
 * it being there.
 */
export const NAME_FIELD = 'name';

/** What a table's Name field may be. */
export type NameFieldType = FieldType.Text | FieldType.AutoNumber;

/**
 * A table's own Name field, which cannot be deleted and is always searched.
 *
 * A field an administrator happened to call `name` on some table is not this:
 * it is theirs to configure like any other, which is why `isSystem` is part of
 * the test.
 */
export function isNameField(field: FieldDef): boolean {
  return field.isSystem && field.name === NAME_FIELD;
}

/**
 * Whether a global search looks at this field.
 *
 * Name is always searched, whatever the stored flag says. Deciding it here
 * rather than trusting the column means no upgrade, migration or stray write
 * can leave an installation whose search has nothing to look at.
 */
export function isFieldSearchable(field: FieldDef): boolean {
  return isNameField(field) || field.isSearchable;
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
  /**
   * Whether a global search looks at this field. Name fields are searchable
   * from the moment they are created; anything else opts in.
   */
  isSearchable: boolean;
  /** True for fields the platform created and will not let you delete. */
  isSystem: boolean;
  /** Only meaningful for AutoNumber: the value the next record will take. */
  autoNumberNext: number;
  createdAt: string;
}

export interface SecurityRule {
  id: Id;
  name: string;
  tableId: Id;
  accessTypes: AccessType[];
  /**
   * Whether the rule grants creating records in its table. Table-level, so the
   * clauses play no part: a new record has no values to evaluate them against.
   * The fields the rule names still apply -- they are what a creator may set.
   */
  canCreate: boolean;
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

/**
 * One field made accessible by one rule, and how far that reach goes.
 *
 * This is what makes field security granular: a rule that grants read and edit
 * on its records can still expose most of its fields read-only and only a few
 * as editable, rather than all of them at whatever the rule's widest access
 * happens to be.
 */
export interface SecurityRuleFieldGrant {
  id: Id;
  securityRuleId: Id;
  fieldId: Id;
  access: FieldAccess;
  createdAt: string;
}

/**
 * A field as the layers above see it: the stored definition plus how it is
 * addressed.
 *
 * A record's values are keyed by API name, and two namespaces may each
 * contribute a `status` to the same table -- that is what namespaces are for.
 * So the key is qualified with the contributing namespace whenever it is not
 * the table's own: `status` for the table's namespace, `acme.status` for a
 * package's. Without that the two would collide and a write would land on
 * whichever field happened to win.
 */
export interface FieldView extends FieldDef {
  /** How this field is addressed in a record's values and in write input. */
  key: string;
  /** The namespace that contributed the field. */
  namespaceName: string;
}

/** The key a field is addressed by on records of `tableNamespaceId`. */
export function fieldKey(field: FieldDef, tableNamespaceId: Id, namespaceName: string): string {
  return field.namespaceId === tableNamespaceId ? field.name : `${namespaceName}.${field.name}`;
}

/**
 * A tab in the user space, belonging to one security role.
 *
 * Tabs are discrete per role: they are NOT inherited up or down the hierarchy
 * the way rules are. A role that can reach a table does not thereby show it,
 * and a parent role does not inherit its children's tabs -- what a role puts
 * on screen is its own decision.
 */
export interface SecurityRoleTab {
  id: Id;
  securityRoleId: Id;
  tableId: Id;
  /** Ascending; decides the left-to-right order of the tabs. */
  position: number;
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
