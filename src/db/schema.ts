import type { Schema } from './types.js';

/**
 * Physical storage names. The platform's own metadata lives in real tables;
 * only user-defined ("custom") tables are stored as `record` + `value` rows.
 */
/**
 * The pre-`securityRuleFieldGrant` name of the field-grant junction. Kept only
 * so an installation created before the rename can be carried forward.
 */
export const LEGACY_SECURITY_RULE_FIELD = 'securityRuleField';

export const T = {
  namespace: 'namespace',
  securityRole: 'securityRole',
  namespaceAccess: 'namespaceAccess',
  users: 'users',
  securityRule: 'securityRule',
  securityRoleRule: 'securityRoleRule',
  table: 'table',
  field: 'field',
  securityRuleClause: 'securityRuleClause',
  securityRuleFieldGrant: 'securityRuleFieldGrant',
  record: 'record',
  value: 'value',
} as const;

const id = { name: 'id', type: 'text' } as const;
const createdAt = { name: 'createdAt', type: 'text' } as const;

export const PLATFORM_SCHEMA: Schema = [
  {
    name: T.namespace,
    primaryKey: 'id',
    columns: [
      id,
      { name: 'name', type: 'text', unique: true },
      { name: 'label', type: 'text' },
      { name: 'isSystem', type: 'boolean' },
      createdAt,
    ],
  },
  {
    name: T.securityRole,
    primaryKey: 'id',
    columns: [
      id,
      { name: 'name', type: 'text', unique: true },
      {
        name: 'parentId',
        type: 'text',
        nullable: true,
        references: { table: T.securityRole, column: 'id' },
      },
      { name: 'isSystem', type: 'boolean' },
      createdAt,
    ],
    indexes: [['parentId']],
  },
  {
    name: T.namespaceAccess,
    primaryKey: 'id',
    columns: [
      id,
      {
        name: 'securityRoleId',
        type: 'text',
        references: { table: T.securityRole, column: 'id', onDelete: 'cascade' },
      },
      {
        name: 'namespaceId',
        type: 'text',
        references: { table: T.namespace, column: 'id', onDelete: 'cascade' },
      },
      createdAt,
    ],
    uniqueConstraints: [['securityRoleId', 'namespaceId']],
  },
  {
    name: T.users,
    primaryKey: 'id',
    columns: [
      id,
      { name: 'username', type: 'text', unique: true },
      { name: 'email', type: 'text' },
      { name: 'passwordHash', type: 'text' },
      {
        name: 'securityRoleId',
        type: 'text',
        references: { table: T.securityRole, column: 'id' },
      },
      { name: 'isActive', type: 'boolean' },
      createdAt,
    ],
    indexes: [['securityRoleId']],
  },
  {
    name: T.table,
    primaryKey: 'id',
    columns: [
      id,
      {
        name: 'namespaceId',
        type: 'text',
        references: { table: T.namespace, column: 'id' },
      },
      { name: 'name', type: 'text' },
      { name: 'label', type: 'text' },
      createdAt,
    ],
    uniqueConstraints: [['namespaceId', 'name']],
  },
  {
    name: T.field,
    primaryKey: 'id',
    columns: [
      id,
      {
        name: 'namespaceId',
        type: 'text',
        references: { table: T.namespace, column: 'id' },
      },
      {
        name: 'tableId',
        type: 'text',
        references: { table: T.table, column: 'id', onDelete: 'cascade' },
      },
      { name: 'name', type: 'text' },
      { name: 'label', type: 'text' },
      { name: 'type', type: 'text' },
      { name: 'isRequired', type: 'boolean' },
      {
        name: 'referenceTableId',
        type: 'text',
        nullable: true,
        references: { table: T.table, column: 'id' },
      },
      { name: 'isSystem', type: 'boolean' },
      /** The next value an AutoNumber field will hand out. */
      { name: 'autoNumberNext', type: 'integer' },
      createdAt,
    ],
    uniqueConstraints: [['tableId', 'namespaceId', 'name']],
    indexes: [['tableId']],
  },
  {
    name: T.securityRule,
    primaryKey: 'id',
    columns: [
      id,
      { name: 'name', type: 'text' },
      {
        name: 'tableId',
        type: 'text',
        references: { table: T.table, column: 'id', onDelete: 'cascade' },
      },
      /** Comma-separated AccessType values, e.g. "read,edit". May be empty
       *  when the rule only grants create. */
      { name: 'accessTypes', type: 'text' },
      { name: 'canCreate', type: 'boolean' },
      { name: 'clauseMatch', type: 'text' },
      { name: 'clauseLogic', type: 'text', nullable: true },
      createdAt,
    ],
    indexes: [['tableId']],
  },
  {
    name: T.securityRoleRule,
    primaryKey: 'id',
    columns: [
      id,
      {
        name: 'securityRoleId',
        type: 'text',
        references: { table: T.securityRole, column: 'id', onDelete: 'cascade' },
      },
      {
        name: 'securityRuleId',
        type: 'text',
        references: { table: T.securityRule, column: 'id', onDelete: 'cascade' },
      },
      createdAt,
    ],
    uniqueConstraints: [['securityRoleId', 'securityRuleId']],
  },
  {
    name: T.securityRuleClause,
    primaryKey: 'id',
    columns: [
      id,
      {
        name: 'securityRuleId',
        type: 'text',
        references: { table: T.securityRule, column: 'id', onDelete: 'cascade' },
      },
      { name: 'sequence', type: 'integer' },
      {
        name: 'fieldId',
        type: 'text',
        references: { table: T.field, column: 'id', onDelete: 'cascade' },
      },
      { name: 'operator', type: 'text' },
      { name: 'targetValue', type: 'text', nullable: true },
      {
        name: 'compareFieldId',
        type: 'text',
        nullable: true,
        references: { table: T.field, column: 'id', onDelete: 'cascade' },
      },
      createdAt,
    ],
    uniqueConstraints: [['securityRuleId', 'sequence']],
  },
  {
    name: T.securityRuleFieldGrant,
    primaryKey: 'id',
    columns: [
      id,
      {
        name: 'securityRuleId',
        type: 'text',
        references: { table: T.securityRule, column: 'id', onDelete: 'cascade' },
      },
      {
        name: 'fieldId',
        type: 'text',
        references: { table: T.field, column: 'id', onDelete: 'cascade' },
      },
      /** A FieldAccess value: 'read' or 'edit'. */
      { name: 'access', type: 'text' },
      createdAt,
    ],
    uniqueConstraints: [['securityRuleId', 'fieldId']],
  },
  {
    name: T.record,
    primaryKey: 'id',
    columns: [
      id,
      {
        name: 'tableId',
        type: 'text',
        references: { table: T.table, column: 'id', onDelete: 'cascade' },
      },
      createdAt,
      { name: 'updatedAt', type: 'text' },
    ],
    indexes: [['tableId']],
  },
  {
    name: T.value,
    primaryKey: 'id',
    columns: [
      id,
      {
        name: 'recordId',
        type: 'text',
        references: { table: T.record, column: 'id', onDelete: 'cascade' },
      },
      {
        name: 'fieldId',
        type: 'text',
        references: { table: T.field, column: 'id', onDelete: 'cascade' },
      },
      { name: 'value', type: 'text', nullable: true },
    ],
    uniqueConstraints: [['recordId', 'fieldId']],
    indexes: [['recordId'], ['fieldId']],
  },
];
