import { T } from '../db/schema.js';
import type { DatabaseAdapter, QuerySpec, Row, Scalar } from '../db/types.js';
import {
  AccessType,
  ClauseMatch,
  ClauseOperator,
  FieldAccess,
  FieldType,
  type FieldDef,
  type Id,
  type Namespace,
  type NamespaceAccess,
  type RecordRow,
  type SecurityRole,
  type SecurityRoleRule,
  type SecurityRule,
  type SecurityRuleClause,
  type SecurityRuleFieldGrant,
  type TableDef,
  type User,
  type ValueRow,
} from '../domain/types.js';

/**
 * Row <-> domain mapping over the database adapter.
 *
 * This is intentionally unguarded: every method here reads or writes whatever
 * it is asked to. Enforcement lives one layer up, in the security layer, which
 * is the only thing the application layer is allowed to call.
 */
export class MetadataStore {
  constructor(private readonly db: DatabaseAdapter) {}

  get database(): DatabaseAdapter {
    return this.db;
  }

  transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  // --- namespace ---------------------------------------------------------

  async insertNamespace(namespace: Namespace): Promise<Namespace> {
    await this.db.insert(T.namespace, { ...namespace });
    return namespace;
  }

  async getNamespace(id: Id): Promise<Namespace | null> {
    return map(await this.db.findById(T.namespace, id), toNamespace);
  }

  async getNamespaceByName(name: string): Promise<Namespace | null> {
    return map(
      await this.db.findOne(T.namespace, { where: [{ column: 'name', operator: 'eq', value: name }] }),
      toNamespace,
    );
  }

  async listNamespaces(): Promise<Namespace[]> {
    return (await this.db.find(T.namespace, { orderBy: [{ column: 'name' }] })).map(toNamespace);
  }

  // --- securityRole ------------------------------------------------------

  async insertSecurityRole(role: SecurityRole): Promise<SecurityRole> {
    await this.db.insert(T.securityRole, { ...role });
    return role;
  }

  async getSecurityRole(id: Id): Promise<SecurityRole | null> {
    return map(await this.db.findById(T.securityRole, id), toSecurityRole);
  }

  async getSecurityRoleByName(name: string): Promise<SecurityRole | null> {
    return map(
      await this.db.findOne(T.securityRole, {
        where: [{ column: 'name', operator: 'eq', value: name }],
      }),
      toSecurityRole,
    );
  }

  async listSecurityRoles(): Promise<SecurityRole[]> {
    return (await this.db.find(T.securityRole, { orderBy: [{ column: 'name' }] })).map(
      toSecurityRole,
    );
  }

  async listChildRoles(parentId: Id): Promise<SecurityRole[]> {
    return (
      await this.db.find(T.securityRole, {
        where: [{ column: 'parentId', operator: 'eq', value: parentId }],
      })
    ).map(toSecurityRole);
  }

  async deleteSecurityRole(id: Id): Promise<boolean> {
    return this.db.delete(T.securityRole, id);
  }

  // --- namespaceAccess ---------------------------------------------------

  async insertNamespaceAccess(access: NamespaceAccess): Promise<NamespaceAccess> {
    await this.db.insert(T.namespaceAccess, { ...access });
    return access;
  }

  async listNamespaceAccessForRoles(roleIds: Id[]): Promise<NamespaceAccess[]> {
    if (roleIds.length === 0) return [];
    return (
      await this.db.find(T.namespaceAccess, {
        where: [{ column: 'securityRoleId', operator: 'in', value: roleIds }],
      })
    ).map(toNamespaceAccess);
  }

  async deleteNamespaceAccess(id: Id): Promise<boolean> {
    return this.db.delete(T.namespaceAccess, id);
  }

  // --- users -------------------------------------------------------------

  async insertUser(user: User): Promise<User> {
    await this.db.insert(T.users, { ...user });
    return user;
  }

  async getUser(id: Id): Promise<User | null> {
    return map(await this.db.findById(T.users, id), toUser);
  }

  async getUserByUsername(username: string): Promise<User | null> {
    return map(
      await this.db.findOne(T.users, {
        where: [{ column: 'username', operator: 'eq', value: username }],
      }),
      toUser,
    );
  }

  async listUsers(): Promise<User[]> {
    return (await this.db.find(T.users, { orderBy: [{ column: 'username' }] })).map(toUser);
  }

  async countUsers(): Promise<number> {
    return this.db.count(T.users);
  }

  async updateUser(id: Id, patch: Row): Promise<User | null> {
    return map(await this.db.update(T.users, id, patch), toUser);
  }

  // --- table -------------------------------------------------------------

  async insertTable(table: TableDef): Promise<TableDef> {
    await this.db.insert(T.table, { ...table });
    return table;
  }

  async getTable(id: Id): Promise<TableDef | null> {
    return map(await this.db.findById(T.table, id), toTable);
  }

  async getTableByName(namespaceId: Id, name: string): Promise<TableDef | null> {
    return map(
      await this.db.findOne(T.table, {
        where: [
          { column: 'namespaceId', operator: 'eq', value: namespaceId },
          { column: 'name', operator: 'eq', value: name },
        ],
      }),
      toTable,
    );
  }

  async listTables(namespaceIds?: Id[]): Promise<TableDef[]> {
    const query: QuerySpec = { orderBy: [{ column: 'name' }] };
    if (namespaceIds) {
      if (namespaceIds.length === 0) return [];
      query.where = [{ column: 'namespaceId', operator: 'in', value: namespaceIds }];
    }
    return (await this.db.find(T.table, query)).map(toTable);
  }

  async deleteTable(id: Id): Promise<boolean> {
    return this.db.delete(T.table, id);
  }

  // --- field -------------------------------------------------------------

  async insertField(field: FieldDef): Promise<FieldDef> {
    await this.db.insert(T.field, { ...field });
    return field;
  }

  async getField(id: Id): Promise<FieldDef | null> {
    return map(await this.db.findById(T.field, id), toField);
  }

  async listFields(tableId: Id): Promise<FieldDef[]> {
    return (
      await this.db.find(T.field, {
        where: [{ column: 'tableId', operator: 'eq', value: tableId }],
        orderBy: [{ column: 'createdAt' }],
      })
    ).map(toField);
  }

  /** Every reference field, on any table, that points at `tableId`. */
  async listFieldsReferencing(tableId: Id): Promise<FieldDef[]> {
    return (
      await this.db.find(T.field, {
        where: [
          { column: 'type', operator: 'eq', value: FieldType.Reference },
          { column: 'referenceTableId', operator: 'eq', value: tableId },
        ],
      })
    ).map(toField);
  }

  /**
   * Clear every lookup pointing at `recordId`. Removing the value row is how a
   * lookup is emptied, so this leaves the referencing records in place -- these
   * are lookups, not master-detail.
   */
  async clearLookupsTo(tableId: Id, recordId: Id): Promise<number> {
    const fields = await this.listFieldsReferencing(tableId);
    if (fields.length === 0) return 0;
    return this.db.deleteWhere(T.value, {
      where: [
        { column: 'fieldId', operator: 'in', value: fields.map((field) => field.id) },
        { column: 'value', operator: 'eq', value: recordId },
      ],
    });
  }

  async listFieldsByIds(ids: Id[]): Promise<FieldDef[]> {
    if (ids.length === 0) return [];
    return (
      await this.db.find(T.field, { where: [{ column: 'id', operator: 'in', value: ids }] })
    ).map(toField);
  }

  async deleteField(id: Id): Promise<boolean> {
    return this.db.delete(T.field, id);
  }

  /**
   * Hand out an AutoNumber field's next value and advance the counter.
   * Callers run this inside the transaction that writes the record, so the
   * number and the record it belongs to are committed together.
   */
  async takeNextAutoNumber(fieldId: Id): Promise<number> {
    const row = await this.db.findById(T.field, fieldId);
    if (!row) throw new Error(`No such field: ${fieldId}`);
    const next = Number(row['autoNumberNext'] ?? 1) || 1;
    await this.db.update(T.field, fieldId, { autoNumberNext: next + 1 });
    return next;
  }

  /** Clauses that read this field, either side of the comparison. */
  async listClausesUsingField(fieldId: Id): Promise<SecurityRuleClause[]> {
    const [asSubject, asComparison] = await Promise.all([
      this.db.find(T.securityRuleClause, {
        where: [{ column: 'fieldId', operator: 'eq', value: fieldId }],
      }),
      this.db.find(T.securityRuleClause, {
        where: [{ column: 'compareFieldId', operator: 'eq', value: fieldId }],
      }),
    ]);
    const byId = new Map(
      [...asSubject, ...asComparison].map((row) => [String(row['id']), toClause(row)]),
    );
    return [...byId.values()];
  }

  // --- securityRule and friends -----------------------------------------

  async insertSecurityRule(rule: SecurityRule): Promise<SecurityRule> {
    await this.db.insert(T.securityRule, {
      ...rule,
      accessTypes: rule.accessTypes.join(','),
    });
    return rule;
  }

  async getSecurityRule(id: Id): Promise<SecurityRule | null> {
    return map(await this.db.findById(T.securityRule, id), toSecurityRule2);
  }

  async listSecurityRules(): Promise<SecurityRule[]> {
    return (await this.db.find(T.securityRule, { orderBy: [{ column: 'name' }] })).map(
      toSecurityRule2,
    );
  }

  async listSecurityRulesByIds(ids: Id[]): Promise<SecurityRule[]> {
    if (ids.length === 0) return [];
    return (
      await this.db.find(T.securityRule, { where: [{ column: 'id', operator: 'in', value: ids }] })
    ).map(toSecurityRule2);
  }

  async deleteSecurityRule(id: Id): Promise<boolean> {
    return this.db.delete(T.securityRule, id);
  }

  async insertSecurityRoleRule(link: SecurityRoleRule): Promise<SecurityRoleRule> {
    await this.db.insert(T.securityRoleRule, { ...link });
    return link;
  }

  async listSecurityRoleRulesForRoles(roleIds: Id[]): Promise<SecurityRoleRule[]> {
    if (roleIds.length === 0) return [];
    return (
      await this.db.find(T.securityRoleRule, {
        where: [{ column: 'securityRoleId', operator: 'in', value: roleIds }],
      })
    ).map(toSecurityRoleRule);
  }

  async deleteSecurityRoleRule(id: Id): Promise<boolean> {
    return this.db.delete(T.securityRoleRule, id);
  }

  async insertSecurityRuleClause(clause: SecurityRuleClause): Promise<SecurityRuleClause> {
    await this.db.insert(T.securityRuleClause, { ...clause });
    return clause;
  }

  async listClausesForRules(ruleIds: Id[]): Promise<SecurityRuleClause[]> {
    if (ruleIds.length === 0) return [];
    return (
      await this.db.find(T.securityRuleClause, {
        where: [{ column: 'securityRuleId', operator: 'in', value: ruleIds }],
        orderBy: [{ column: 'sequence' }],
      })
    ).map(toClause);
  }

  async insertFieldGrant(grant: SecurityRuleFieldGrant): Promise<SecurityRuleFieldGrant> {
    await this.db.insert(T.securityRuleFieldGrant, { ...grant });
    return grant;
  }

  async listFieldGrantsForRules(ruleIds: Id[]): Promise<SecurityRuleFieldGrant[]> {
    if (ruleIds.length === 0) return [];
    return (
      await this.db.find(T.securityRuleFieldGrant, {
        where: [{ column: 'securityRuleId', operator: 'in', value: ruleIds }],
      })
    ).map(toFieldGrant);
  }

  async deleteFieldGrant(id: Id): Promise<boolean> {
    return this.db.delete(T.securityRuleFieldGrant, id);
  }

  // --- record and value --------------------------------------------------

  async insertRecord(record: RecordRow): Promise<RecordRow> {
    await this.db.insert(T.record, { ...record });
    return record;
  }

  async getRecord(id: Id): Promise<RecordRow | null> {
    return map(await this.db.findById(T.record, id), toRecord);
  }

  async listRecords(tableId: Id, limit?: number, offset?: number): Promise<RecordRow[]> {
    const query: QuerySpec = {
      where: [{ column: 'tableId', operator: 'eq', value: tableId }],
      orderBy: [{ column: 'createdAt' }],
    };
    if (limit !== undefined) query.limit = limit;
    if (offset !== undefined) query.offset = offset;
    return (await this.db.find(T.record, query)).map(toRecord);
  }

  async touchRecord(id: Id, updatedAt: string): Promise<void> {
    await this.db.update(T.record, id, { updatedAt });
  }

  async deleteRecord(id: Id): Promise<boolean> {
    return this.db.delete(T.record, id);
  }

  async listValues(recordIds: Id[]): Promise<ValueRow[]> {
    if (recordIds.length === 0) return [];
    return (
      await this.db.find(T.value, {
        where: [{ column: 'recordId', operator: 'in', value: recordIds }],
      })
    ).map(toValue);
  }

  async upsertValue(value: ValueRow): Promise<void> {
    const existing = await this.db.findOne(T.value, {
      where: [
        { column: 'recordId', operator: 'eq', value: value.recordId },
        { column: 'fieldId', operator: 'eq', value: value.fieldId },
      ],
    });
    if (existing) {
      await this.db.update(T.value, existing['id'] as Scalar, { value: value.value });
    } else {
      await this.db.insert(T.value, { ...value });
    }
  }

  async countReferencesTo(fieldId: Id, recordId: Id): Promise<number> {
    return this.db.count(T.value, {
      where: [
        { column: 'fieldId', operator: 'eq', value: fieldId },
        { column: 'value', operator: 'eq', value: recordId },
      ],
    });
  }
}

function map<T>(row: Row | null, fn: (row: Row) => T): T | null {
  return row ? fn(row) : null;
}

const str = (row: Row, key: string): string => String(row[key] ?? '');
const nullableStr = (row: Row, key: string): string | null =>
  row[key] === null || row[key] === undefined ? null : String(row[key]);
const bool = (row: Row, key: string): boolean => row[key] === true || row[key] === 1;

function toNamespace(row: Row): Namespace {
  return {
    id: str(row, 'id'),
    name: str(row, 'name'),
    label: str(row, 'label'),
    isSystem: bool(row, 'isSystem'),
    createdAt: str(row, 'createdAt'),
  };
}

function toSecurityRole(row: Row): SecurityRole {
  return {
    id: str(row, 'id'),
    name: str(row, 'name'),
    parentId: nullableStr(row, 'parentId'),
    isSystem: bool(row, 'isSystem'),
    createdAt: str(row, 'createdAt'),
  };
}

function toNamespaceAccess(row: Row): NamespaceAccess {
  return {
    id: str(row, 'id'),
    securityRoleId: str(row, 'securityRoleId'),
    namespaceId: str(row, 'namespaceId'),
    createdAt: str(row, 'createdAt'),
  };
}

function toUser(row: Row): User {
  return {
    id: str(row, 'id'),
    username: str(row, 'username'),
    email: str(row, 'email'),
    passwordHash: str(row, 'passwordHash'),
    securityRoleId: str(row, 'securityRoleId'),
    isActive: bool(row, 'isActive'),
    createdAt: str(row, 'createdAt'),
  };
}

function toTable(row: Row): TableDef {
  return {
    id: str(row, 'id'),
    namespaceId: str(row, 'namespaceId'),
    name: str(row, 'name'),
    label: str(row, 'label'),
    createdAt: str(row, 'createdAt'),
  };
}

function toField(row: Row): FieldDef {
  return {
    id: str(row, 'id'),
    namespaceId: str(row, 'namespaceId'),
    tableId: str(row, 'tableId'),
    name: str(row, 'name'),
    label: str(row, 'label'),
    type: str(row, 'type') as FieldType,
    isRequired: bool(row, 'isRequired'),
    referenceTableId: nullableStr(row, 'referenceTableId'),
    isSystem: bool(row, 'isSystem'),
    autoNumberNext: Number(row['autoNumberNext'] ?? 1) || 1,
    createdAt: str(row, 'createdAt'),
  };
}

function toSecurityRule2(row: Row): SecurityRule {
  const raw = str(row, 'accessTypes');
  return {
    id: str(row, 'id'),
    name: str(row, 'name'),
    tableId: str(row, 'tableId'),
    accessTypes: raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0) as AccessType[],
    canCreate: bool(row, 'canCreate'),
    clauseMatch: str(row, 'clauseMatch') as ClauseMatch,
    clauseLogic: nullableStr(row, 'clauseLogic'),
    createdAt: str(row, 'createdAt'),
  };
}

function toSecurityRoleRule(row: Row): SecurityRoleRule {
  return {
    id: str(row, 'id'),
    securityRoleId: str(row, 'securityRoleId'),
    securityRuleId: str(row, 'securityRuleId'),
    createdAt: str(row, 'createdAt'),
  };
}

function toClause(row: Row): SecurityRuleClause {
  return {
    id: str(row, 'id'),
    securityRuleId: str(row, 'securityRuleId'),
    sequence: Number(row['sequence'] ?? 0),
    fieldId: str(row, 'fieldId'),
    operator: str(row, 'operator') as ClauseOperator,
    targetValue: nullableStr(row, 'targetValue'),
    compareFieldId: nullableStr(row, 'compareFieldId'),
    createdAt: str(row, 'createdAt'),
  };
}

function toFieldGrant(row: Row): SecurityRuleFieldGrant {
  return {
    id: str(row, 'id'),
    securityRuleId: str(row, 'securityRuleId'),
    fieldId: str(row, 'fieldId'),
    // A grant with no level recorded is read-only: the conservative reading.
    access: str(row, 'access') === FieldAccess.Edit ? FieldAccess.Edit : FieldAccess.Read,
    createdAt: str(row, 'createdAt'),
  };
}

function toRecord(row: Row): RecordRow {
  return {
    id: str(row, 'id'),
    tableId: str(row, 'tableId'),
    createdAt: str(row, 'createdAt'),
    updatedAt: str(row, 'updatedAt'),
  };
}

function toValue(row: Row): ValueRow {
  return {
    id: str(row, 'id'),
    recordId: str(row, 'recordId'),
    fieldId: str(row, 'fieldId'),
    value: nullableStr(row, 'value'),
  };
}
