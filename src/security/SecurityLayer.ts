import {
  AccessType,
  FieldType,
  type FieldDef,
  type Id,
  type Namespace,
  type RecordRow,
  type RecordView,
  type SecurityRole,
  type TableDef,
  type User,
} from '../domain/types.js';
import type { MetadataStore } from '../store/MetadataStore.js';
import { newId, nowIso } from '../util/index.js';
import { ruleApplies, type CompiledRule, type ValueMap } from './clauses.js';
import type { SecurityContext } from './context.js';
import { AccessDeniedError, NotFoundError, ValidationError } from './errors.js';
import {
  PermissionResolver,
  rulesGranting,
  rulesGrantingCreate,
  type PermissionSet,
} from './PermissionResolver.js';
import { fromStoredValue, toStoredValue } from './values.js';

export interface QueryOptions {
  limit?: number;
  offset?: number;
}

/**
 * The security layer: the only way in or out of the database for anything the
 * application layer does.
 *
 * The store is held privately here on purpose. Metadata mutations are reached
 * through `asAdministrator`, which asserts the acting user's role before
 * handing over the store; record operations are mediated method by method.
 */
export class SecurityLayer {
  private readonly resolver: PermissionResolver;

  constructor(private readonly store: MetadataStore) {
    this.resolver = new PermissionResolver(store);
  }

  permissions(context: SecurityContext): Promise<PermissionSet> {
    return this.resolver.resolve(context);
  }

  /**
   * Run a metadata mutation as an administrator.
   *
   * Security rules describe custom tables and their fields, so they have
   * nothing to say about the platform's own metadata. Administrator is
   * therefore the only role that may change it.
   */
  async asAdministrator<T>(
    context: SecurityContext,
    action: (store: MetadataStore) => Promise<T>,
  ): Promise<T> {
    this.assertAdministrator(context);
    const result = await this.store.transaction(() => action(this.store));
    // Permissions are derived from metadata, so any change invalidates them.
    this.resolver.invalidate();
    return result;
  }

  /**
   * Read metadata as an administrator. Separate from `asAdministrator` so a
   * read does not open a transaction or discard the permission cache.
   */
  async readAsAdministrator<T>(
    context: SecurityContext,
    action: (store: MetadataStore) => Promise<T>,
  ): Promise<T> {
    this.assertAdministrator(context);
    return action(this.store);
  }

  assertAdministrator(context: SecurityContext): void {
    if (!context.role.isSystem) {
      throw new AccessDeniedError(
        `Only the Administrator role may change platform metadata (role: ${context.role.name})`,
      );
    }
  }

  // --- metadata reads ----------------------------------------------------

  async listNamespaces(context: SecurityContext): Promise<Namespace[]> {
    const permissions = await this.permissions(context);
    const namespaces = await this.store.listNamespaces();
    if (permissions.isAdministrator) return namespaces;
    return namespaces.filter((namespace) => permissions.namespaceIds.has(namespace.id));
  }

  async listSecurityRoles(context: SecurityContext): Promise<SecurityRole[]> {
    this.assertAdministrator(context);
    return this.store.listSecurityRoles();
  }

  async listUsers(context: SecurityContext): Promise<User[]> {
    this.assertAdministrator(context);
    return this.store.listUsers();
  }

  /** Tables in namespaces the user can reach and has at least one rule for. */
  async listTables(context: SecurityContext): Promise<TableDef[]> {
    const permissions = await this.permissions(context);
    const tables = await this.store.listTables(
      permissions.isAdministrator ? undefined : [...permissions.namespaceIds],
    );
    if (permissions.isAdministrator) return tables;
    return tables.filter((table) => (permissions.rulesByTable.get(table.id) ?? []).length > 0);
  }

  async getTable(context: SecurityContext, tableId: Id): Promise<TableDef> {
    const permissions = await this.permissions(context);
    const table = await this.store.getTable(tableId);
    if (!table) throw new NotFoundError(`No such table: ${tableId}`);
    this.assertNamespaceAccess(permissions, table.namespaceId, table.name);
    if (!permissions.isAdministrator && (permissions.rulesByTable.get(table.id) ?? []).length === 0) {
      throw new AccessDeniedError(`No access to table "${table.name}"`);
    }
    return table;
  }

  /** Fields the user may see at all, i.e. named by some rule granting read. */
  async listReadableFields(context: SecurityContext, tableId: Id): Promise<FieldDef[]> {
    const permissions = await this.permissions(context);
    const fields = await this.store.listFields(tableId);
    if (permissions.isAdministrator) return fields;
    const allowed = fieldUnion(rulesGranting(permissions, tableId, AccessType.Read));
    return fields.filter((field) => allowed.has(field.id));
  }

  /** Every field on the table, regardless of access. Administrators only. */
  async listAllFields(context: SecurityContext, tableId: Id): Promise<FieldDef[]> {
    this.assertAdministrator(context);
    return this.store.listFields(tableId);
  }

  // --- record operations -------------------------------------------------

  async queryRecords(
    context: SecurityContext,
    tableId: Id,
    options: QueryOptions = {},
  ): Promise<RecordView[]> {
    const permissions = await this.permissions(context);
    const table = await this.requireTable(permissions, tableId);
    const fields = await this.fieldMap(table.id);

    const records = await this.store.listRecords(table.id, options.limit, options.offset);
    const values = await this.valuesByRecord(records.map((record) => record.id));

    const rules = permissions.isAdministrator
      ? []
      : rulesGranting(permissions, table.id, AccessType.Read);
    if (!permissions.isAdministrator && rules.length === 0) {
      throw new AccessDeniedError(`No read access to table "${table.name}"`);
    }

    const results: RecordView[] = [];
    for (const record of records) {
      const recordValues = values.get(record.id) ?? new Map<Id, string | null>();
      if (permissions.isAdministrator) {
        results.push(this.project(record, recordValues, fields, null));
        continue;
      }
      const matching = rules.filter((rule) =>
        ruleApplies(rule, recordValues, fields, context.user),
      );
      if (matching.length === 0) continue;
      results.push(this.project(record, recordValues, fields, fieldUnion(matching)));
    }
    return results;
  }

  async getRecord(context: SecurityContext, recordId: Id): Promise<RecordView> {
    const permissions = await this.permissions(context);
    const record = await this.requireRecord(recordId);
    const table = await this.requireTable(permissions, record.tableId);
    const fields = await this.fieldMap(table.id);
    const values = (await this.valuesByRecord([record.id])).get(record.id) ?? new Map();

    if (permissions.isAdministrator) return this.project(record, values, fields, null);

    const matching = rulesGranting(permissions, table.id, AccessType.Read).filter((rule) =>
      ruleApplies(rule, values, fields, context.user),
    );
    // Indistinguishable from "does not exist", by design.
    if (matching.length === 0) throw new NotFoundError(`No such record: ${recordId}`);
    return this.project(record, values, fields, fieldUnion(matching));
  }

  /**
   * Creating is a table-level grant: a rule whose `canCreate` is set permits
   * inserting into its table. The clauses play no part -- there is no record
   * yet for them to describe -- but the rule's fields still bound what the
   * creator may set.
   */
  async createRecord(
    context: SecurityContext,
    tableId: Id,
    input: Record<string, unknown>,
  ): Promise<RecordView> {
    const permissions = await this.permissions(context);
    const table = await this.requireTable(permissions, tableId);
    const fields = await this.fieldMap(table.id);
    const byName = nameIndex(fields);

    const stored = this.normalizeInput(input, byName);
    for (const field of fields.values()) {
      if (field.isRequired && (stored.get(field.id) ?? null) === null) {
        throw new ValidationError(`Field "${field.name}" is required`);
      }
    }
    await this.assertLookupsResolve(stored, fields, null);

    let writable: ReadonlySet<Id> | null = null;
    if (!permissions.isAdministrator) {
      const granting = rulesGrantingCreate(permissions, table.id);
      if (granting.length === 0) {
        throw new AccessDeniedError(`No permission to create records in "${table.name}"`);
      }
      writable = fieldUnion(granting);
      for (const [fieldId, value] of stored) {
        if (value !== null && !writable.has(fieldId)) {
          throw new AccessDeniedError(
            `No permission to set field "${fields.get(fieldId)?.name ?? fieldId}"`,
          );
        }
      }
    }

    const timestamp = nowIso();
    const record: RecordRow = {
      id: newId(),
      tableId: table.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.store.transaction(async () => {
      await this.store.insertRecord(record);
      for (const [fieldId, value] of stored) {
        if (value === null) continue;
        await this.store.upsertValue({ id: newId(), recordId: record.id, fieldId, value });
      }
    });

    return this.project(record, stored, fields, writable);
  }

  /**
   * Updating requires EDIT access to the record as it stands today. The
   * post-update state is not re-checked, so a permitted edit may move a
   * record out of the user's own visibility -- the same way transferring
   * ownership works on a hierarchy-scoped platform.
   */
  async updateRecord(
    context: SecurityContext,
    recordId: Id,
    input: Record<string, unknown>,
  ): Promise<RecordView> {
    const permissions = await this.permissions(context);
    const record = await this.requireRecord(recordId);
    const table = await this.requireTable(permissions, record.tableId);
    const fields = await this.fieldMap(table.id);
    const byName = nameIndex(fields);
    const current = (await this.valuesByRecord([record.id])).get(record.id) ?? new Map();

    const patch = this.normalizeInput(input, byName);
    await this.assertLookupsResolve(patch, fields, record.id);

    let writable: ReadonlySet<Id> | null = null;
    if (!permissions.isAdministrator) {
      const matching = rulesGranting(permissions, table.id, AccessType.Edit).filter((rule) =>
        ruleApplies(rule, current, fields, context.user),
      );
      if (matching.length === 0) throw new NotFoundError(`No such record: ${recordId}`);
      writable = fieldUnion(matching);
      for (const fieldId of patch.keys()) {
        if (!writable.has(fieldId)) {
          throw new AccessDeniedError(
            `No permission to edit field "${fields.get(fieldId)?.name ?? fieldId}"`,
          );
        }
      }
    }

    for (const [fieldId, value] of patch) {
      const field = fields.get(fieldId);
      if (field?.isRequired && value === null) {
        throw new ValidationError(`Field "${field.name}" is required`);
      }
    }

    const updatedAt = nowIso();
    await this.store.transaction(async () => {
      for (const [fieldId, value] of patch) {
        await this.store.upsertValue({ id: newId(), recordId: record.id, fieldId, value });
      }
      await this.store.touchRecord(record.id, updatedAt);
    });

    const merged = new Map(current);
    for (const [fieldId, value] of patch) merged.set(fieldId, value);
    return this.project({ ...record, updatedAt }, merged, fields, writable);
  }

  async deleteRecord(context: SecurityContext, recordId: Id): Promise<void> {
    const permissions = await this.permissions(context);
    const record = await this.requireRecord(recordId);
    const table = await this.requireTable(permissions, record.tableId);
    const fields = await this.fieldMap(table.id);
    const values = (await this.valuesByRecord([record.id])).get(record.id) ?? new Map();

    if (!permissions.isAdministrator) {
      const matching = rulesGranting(permissions, table.id, AccessType.Delete).filter((rule) =>
        ruleApplies(rule, values, fields, context.user),
      );
      if (matching.length === 0) throw new NotFoundError(`No such record: ${recordId}`);
    }

    await this.store.transaction(async () => {
      // Lookups are lookups, never master-detail: deleting a record clears the
      // fields pointing at it rather than deleting whatever pointed.
      await this.store.clearLookupsTo(record.tableId, record.id);
      await this.store.deleteRecord(record.id);
    });
  }

  // --- what the caller may do, for the UI to ask before offering it -------

  /** Whether the user may create records in this table at all. */
  async canCreate(context: SecurityContext, tableId: Id): Promise<boolean> {
    const permissions = await this.permissions(context);
    if (permissions.isAdministrator) return true;
    return rulesGrantingCreate(permissions, tableId).length > 0;
  }

  /** Fields the user may set when creating a record in this table. */
  async listCreatableFields(context: SecurityContext, tableId: Id): Promise<FieldDef[]> {
    return this.grantedFields(context, tableId, (permissions) =>
      rulesGrantingCreate(permissions, tableId),
    );
  }

  /** Fields the user may write when editing a record in this table. */
  async listEditableFields(context: SecurityContext, tableId: Id): Promise<FieldDef[]> {
    return this.grantedFields(context, tableId, (permissions) =>
      rulesGranting(permissions, tableId, AccessType.Edit),
    );
  }

  private async grantedFields(
    context: SecurityContext,
    tableId: Id,
    select: (permissions: PermissionSet) => CompiledRule[],
  ): Promise<FieldDef[]> {
    const permissions = await this.permissions(context);
    const fields = await this.store.listFields(tableId);
    if (permissions.isAdministrator) return fields;
    const granted = fieldUnion(select(permissions));
    return fields.filter((field) => granted.has(field.id));
  }

  // --- internals ---------------------------------------------------------

  private assertNamespaceAccess(
    permissions: PermissionSet,
    namespaceId: Id,
    label: string,
  ): void {
    if (permissions.isAdministrator) return;
    if (!permissions.namespaceIds.has(namespaceId)) {
      throw new AccessDeniedError(`No access to the namespace owning "${label}"`);
    }
  }

  private async requireTable(permissions: PermissionSet, tableId: Id): Promise<TableDef> {
    const table = await this.store.getTable(tableId);
    if (!table) throw new NotFoundError(`No such table: ${tableId}`);
    this.assertNamespaceAccess(permissions, table.namespaceId, table.name);
    return table;
  }

  private async requireRecord(recordId: Id): Promise<RecordRow> {
    const record = await this.store.getRecord(recordId);
    if (!record) throw new NotFoundError(`No such record: ${recordId}`);
    return record;
  }

  private async fieldMap(tableId: Id): Promise<Map<Id, FieldDef>> {
    const fields = await this.store.listFields(tableId);
    return new Map(fields.map((field) => [field.id, field]));
  }

  private async valuesByRecord(recordIds: Id[]): Promise<Map<Id, Map<Id, string | null>>> {
    const grouped = new Map<Id, Map<Id, string | null>>();
    for (const recordId of recordIds) grouped.set(recordId, new Map());
    for (const value of await this.store.listValues(recordIds)) {
      grouped.get(value.recordId)?.set(value.fieldId, value.value);
    }
    return grouped;
  }

  private normalizeInput(
    input: Record<string, unknown>,
    byName: Map<string, FieldDef>,
  ): Map<Id, string | null> {
    const stored = new Map<Id, string | null>();
    for (const [name, raw] of Object.entries(input)) {
      const field = byName.get(name);
      if (!field) throw new ValidationError(`Unknown field: "${name}"`);
      stored.set(field.id, toStoredValue(field, raw));
    }
    return stored;
  }

  /**
   * Check every lookup being written: the target has to exist and belong to
   * the table the field points at. A lookup whose target table is its own
   * table is a hierarchy, so those are also checked for cycles -- a record
   * that is its own ancestor is not a hierarchy.
   */
  private async assertLookupsResolve(
    values: Map<Id, string | null>,
    fields: ReadonlyMap<Id, FieldDef>,
    recordId: Id | null,
  ): Promise<void> {
    for (const [fieldId, value] of values) {
      const field = fields.get(fieldId);
      if (!field || field.type !== FieldType.Reference || value === null) continue;

      const target = await this.store.getRecord(value);
      if (!target || (field.referenceTableId && target.tableId !== field.referenceTableId)) {
        throw new ValidationError(`Field "${field.name}" does not point at a valid record`);
      }
      if (recordId && field.referenceTableId === target.tableId) {
        await this.assertNoLookupCycle(field, recordId, value);
      }
    }
  }

  /** Walk up the chain from `targetId`; reaching `recordId` closes a loop. */
  private async assertNoLookupCycle(
    field: FieldDef,
    recordId: Id,
    targetId: Id,
  ): Promise<void> {
    const seen = new Set<Id>([recordId]);
    let current: Id | null = targetId;
    while (current) {
      if (seen.has(current)) {
        throw new ValidationError(
          `Field "${field.name}" would make this record its own ancestor`,
        );
      }
      seen.add(current);
      const values: Map<Id, string | null> | undefined = (
        await this.valuesByRecord([current])
      ).get(current);
      const next: string | null = values?.get(field.id) ?? null;
      current = next === null || next === '' ? null : next;
    }
  }

  /**
   * Build the caller's view of a record. `visibleFields` of null means every
   * field (administrator); otherwise only the named fields are included.
   */
  private project(
    record: RecordRow,
    values: ValueMap,
    fields: ReadonlyMap<Id, FieldDef>,
    visibleFields: ReadonlySet<Id> | null,
  ): RecordView {
    const projected: Record<string, unknown> = {};
    for (const field of fields.values()) {
      if (visibleFields && !visibleFields.has(field.id)) continue;
      projected[field.name] = fromStoredValue(field, values.get(field.id) ?? null);
    }
    return {
      id: record.id,
      tableId: record.tableId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      values: projected,
    };
  }
}

function fieldUnion(rules: CompiledRule[]): ReadonlySet<Id> {
  const union = new Set<Id>();
  for (const rule of rules) for (const fieldId of rule.fieldIds) union.add(fieldId);
  return union;
}

function nameIndex(fields: ReadonlyMap<Id, FieldDef>): Map<string, FieldDef> {
  return new Map([...fields.values()].map((field) => [field.name, field]));
}
