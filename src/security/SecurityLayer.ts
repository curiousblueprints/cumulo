import {
  AccessType,
  fieldKey,
  FieldAccess,
  FieldType,
  isFieldSearchable,
  isNameField,
  type FieldDef,
  type FieldView,
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
import { grantedFieldIds, ruleApplies, type CompiledRule, type ValueMap } from './clauses.js';
import type { SecurityContext } from './context.js';
import { AccessDeniedError, NotFoundError, ValidationError } from './errors.js';
import {
  PermissionResolver,
  rulesGranting,
  rulesGrantingCreate,
  type PermissionSet,
} from './PermissionResolver.js';
import { fromStoredValue, isSystemAssigned, labelForValue, toStoredValue } from './values.js';

export interface QueryOptions {
  limit?: number;
  offset?: number;
}

/** Records pointing at one record through a single lookup field. */
export interface RelatedList {
  table: TableDef;
  /** The lookup on the child table that points at the record being viewed. */
  field: FieldView;
  title: string;
  columns: FieldView[];
  records: RecordView[];
  canCreate: boolean;
}

/** One global-search result: the record, and the field that matched. */
export interface SearchHit {
  record: RecordView;
  table: TableDef;
  /** How the record reads in a list -- its Name where the caller can see it. */
  label: string;
  field: FieldView;
  value: string;
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
  /** Namespace names, for building field keys. Derived from metadata, so it
   *  is dropped whenever the permission cache is. */
  private namespaceNames: Map<Id, string> | null = null;

  constructor(private readonly store: MetadataStore) {
    this.resolver = new PermissionResolver(store);
  }

  private async namespaceName(id: Id): Promise<string> {
    if (!this.namespaceNames) {
      this.namespaceNames = new Map(
        (await this.store.listNamespaces()).map((namespace) => [namespace.id, namespace.name]),
      );
    }
    return this.namespaceNames.get(id) ?? '';
  }

  /** Attach each field's addressing key, which depends on its table. */
  private async asViews(table: TableDef, fields: FieldDef[]): Promise<FieldView[]> {
    const views: FieldView[] = [];
    for (const field of fields) {
      const namespaceName = await this.namespaceName(field.namespaceId);
      views.push({
        ...field,
        namespaceName,
        key: fieldKey(field, table.namespaceId, namespaceName),
      });
    }
    return views;
  }

  private async viewsForTable(tableId: Id, fields: FieldDef[]): Promise<FieldView[]> {
    const table = await this.store.getTable(tableId);
    if (!table) throw new NotFoundError(`No such table: ${tableId}`);
    return this.asViews(table, fields);
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
    // Permissions and field keys are both derived from metadata, so any change
    // invalidates them.
    this.resolver.invalidate();
    this.namespaceNames = null;
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
  async listReadableFields(context: SecurityContext, tableId: Id): Promise<FieldView[]> {
    const permissions = await this.permissions(context);
    const fields = await this.store.listFields(tableId);
    if (permissions.isAdministrator) return this.viewsForTable(tableId, fields);
    const allowed = grantedFieldIds(
      rulesGranting(permissions, tableId, AccessType.Read),
      FieldAccess.Read,
    );
    return this.viewsForTable(
      tableId,
      fields.filter((field) => allowed.has(field.id)),
    );
  }

  /** Every field on the table, regardless of access. Administrators only. */
  async listAllFields(context: SecurityContext, tableId: Id): Promise<FieldView[]> {
    this.assertAdministrator(context);
    return this.viewsForTable(tableId, await this.store.listFields(tableId));
  }

  // --- record operations -------------------------------------------------

  async queryRecords(
    context: SecurityContext,
    tableId: Id,
    options: QueryOptions = {},
  ): Promise<RecordView[]> {
    const permissions = await this.permissions(context);
    const table = await this.requireTable(permissions, tableId);
    const fields = await this.fieldMap(table);

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
      results.push(
        this.project(record, recordValues, fields, grantedFieldIds(matching, FieldAccess.Read)),
      );
    }
    return results;
  }

  async getRecord(context: SecurityContext, recordId: Id): Promise<RecordView> {
    const permissions = await this.permissions(context);
    const record = await this.requireRecord(recordId);
    const table = await this.requireTable(permissions, record.tableId);
    const fields = await this.fieldMap(table);
    const values = (await this.valuesByRecord([record.id])).get(record.id) ?? new Map();

    if (permissions.isAdministrator) return this.project(record, values, fields, null);

    const matching = rulesGranting(permissions, table.id, AccessType.Read).filter((rule) =>
      ruleApplies(rule, values, fields, context.user),
    );
    // Indistinguishable from "does not exist", by design.
    if (matching.length === 0) throw new NotFoundError(`No such record: ${recordId}`);
    return this.project(record, values, fields, grantedFieldIds(matching, FieldAccess.Read));
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
    const fields = await this.fieldMap(table);
    const byName = nameIndex(fields);

    // Permission first, then validation. Answering "that field is required"
    // to someone who may not create here would both tell them the wrong thing
    // and describe a table they cannot see.
    let writable: ReadonlySet<Id> | null = null;
    if (!permissions.isAdministrator) {
      const granting = rulesGrantingCreate(permissions, table.id);
      if (granting.length === 0) {
        throw new AccessDeniedError(`No permission to create records in "${table.name}"`);
      }
      // Only fields the rule grants as editable may be set on the way in; a
      // read-only grant makes the field visible, not writable.
      writable = grantedFieldIds(granting, FieldAccess.Edit);
    }

    const stored = this.normalizeInput(input, byName);
    if (writable) {
      for (const [fieldId, value] of stored) {
        if (value !== null && !writable.has(fieldId)) {
          throw new AccessDeniedError(
            `No permission to set field "${fields.get(fieldId)?.name ?? fieldId}"`,
          );
        }
      }
    }
    this.assertRequiredPresent(fields.values(), stored, writable);
    await this.assertLookupsResolve(stored, fields, null);

    const timestamp = nowIso();
    const record: RecordRow = {
      id: newId(),
      tableId: table.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.store.transaction(async () => {
      await this.store.insertRecord(record);
      // Auto numbers are handed out here, inside the same transaction, so the
      // number and the record it belongs to commit together.
      for (const field of fields.values()) {
        if (field.type !== FieldType.AutoNumber) continue;
        stored.set(field.id, String(await this.store.takeNextAutoNumber(field.id)));
      }
      for (const [fieldId, value] of stored) {
        if (value === null) continue;
        await this.store.upsertValue({ id: newId(), recordId: record.id, fieldId, value });
      }
    });

    // Show back what the caller may read, which is wider than what they wrote.
    return this.project(record, stored, fields, this.readableAfterWrite(permissions, table.id));
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
    const fields = await this.fieldMap(table);
    const byName = nameIndex(fields);
    const current = (await this.valuesByRecord([record.id])).get(record.id) ?? new Map();

    // Permission first here too, so a record the caller cannot edit reports as
    // missing rather than commenting on the values they sent.
    let writable: ReadonlySet<Id> | null = null;
    if (!permissions.isAdministrator) {
      const matching = rulesGranting(permissions, table.id, AccessType.Edit).filter((rule) =>
        ruleApplies(rule, current, fields, context.user),
      );
      if (matching.length === 0) throw new NotFoundError(`No such record: ${recordId}`);
      writable = grantedFieldIds(matching, FieldAccess.Edit);
    }

    const patch = this.normalizeInput(input, byName);
    if (writable) {
      for (const fieldId of patch.keys()) {
        if (!writable.has(fieldId)) {
          throw new AccessDeniedError(
            `No permission to edit field "${fields.get(fieldId)?.name ?? fieldId}"`,
          );
        }
      }
    }
    // Only what is being written is checked: a required field left alone stays
    // as it is, which is what lets records predating the rule be edited.
    this.assertRequiredPresent(
      [...patch.keys()].flatMap((fieldId) => {
        const field = fields.get(fieldId);
        return field ? [field] : [];
      }),
      patch,
      writable,
    );
    await this.assertLookupsResolve(patch, fields, record.id);

    const updatedAt = nowIso();
    await this.store.transaction(async () => {
      for (const [fieldId, value] of patch) {
        await this.store.upsertValue({ id: newId(), recordId: record.id, fieldId, value });
      }
      await this.store.touchRecord(record.id, updatedAt);
    });

    const merged = new Map(current);
    for (const [fieldId, value] of patch) merged.set(fieldId, value);
    return this.project(
      { ...record, updatedAt },
      merged,
      fields,
      this.readableAfterWrite(permissions, table.id),
    );
  }

  async deleteRecord(context: SecurityContext, recordId: Id): Promise<void> {
    const permissions = await this.permissions(context);
    const record = await this.requireRecord(recordId);
    const table = await this.requireTable(permissions, record.tableId);
    const fields = await this.fieldMap(table);
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

  // --- tabs ---------------------------------------------------------------

  /**
   * The tables this user's role puts on screen, in its configured order.
   *
   * Tabs are the role's own: unlike rules, they are neither inherited from a
   * parent nor rolled up from children. A tab is still only shown if the role
   * can actually reach the table, so a tab left behind by a revoked rule
   * quietly stops appearing rather than leading somewhere forbidden.
   */
  async listTabs(context: SecurityContext): Promise<TableDef[]> {
    const tabs = await this.store.listRoleTabs(context.role.id);
    const reachable = new Map(
      (await this.listTables(context)).map((table) => [table.id, table]),
    );
    return tabs.flatMap((tab) => {
      const table = reachable.get(tab.tableId);
      return table ? [table] : [];
    });
  }

  // --- related lists --------------------------------------------------------

  /**
   * The records that point at this one.
   *
   * No extra metadata is needed to work these out: a lookup field already
   * records the table it points at, so "which tables have children here" is a
   * query over `field`, not an inspection of every table in turn. The field
   * lives on the child, but it names the parent, and that is the structure.
   *
   * Everything is decided the ordinary way. The parent record is read first,
   * so children cannot be enumerated for a record the caller may not see; each
   * child is read through `getRecord`, so clauses and field grants apply; and a
   * lookup the caller cannot read produces no list at all, since the
   * relationship itself would otherwise be visible through it.
   */
  async listRelatedLists(
    context: SecurityContext,
    recordId: Id,
    limitPerList = 50,
  ): Promise<RelatedList[]> {
    // Throws if this record is not theirs to see.
    const parent = await this.getRecord(context, recordId);

    const lookups = await this.store.listFieldsReferencing(parent.tableId);
    if (lookups.length === 0) return [];

    const reachable = new Map((await this.listTables(context)).map((table) => [table.id, table]));
    // Two lookups from the same table need telling apart, so count them first.
    const perTable = new Map<Id, number>();
    for (const lookup of lookups) {
      perTable.set(lookup.tableId, (perTable.get(lookup.tableId) ?? 0) + 1);
    }

    const lists: RelatedList[] = [];
    for (const lookup of lookups) {
      const childTable = reachable.get(lookup.tableId);
      if (!childTable) continue;

      const readable = await this.listReadableFields(context, childTable.id);
      // The caller's view of the lookup, which carries how it is addressed.
      const lookupView = readable.find((field) => field.id === lookup.id);
      if (!lookupView) continue;

      const candidates = await this.store.findRecordIdsByFieldValue(
        lookup.id,
        parent.id,
        limitPerList * 4,
      );
      const records: RecordView[] = [];
      for (const candidateId of candidates) {
        if (records.length >= limitPerList) break;
        try {
          records.push(await this.getRecord(context, candidateId));
        } catch {
          // Not theirs to see: the list is shorter, not an error.
        }
      }

      lists.push({
        table: childTable,
        field: lookupView,
        title:
          (perTable.get(lookup.tableId) ?? 0) > 1
            ? `${childTable.label} (${lookup.label})`
            : childTable.label,
        // The lookup itself is the same value on every row, so it is not a
        // column worth spending width on.
        columns: readable.filter((field) => field.id !== lookup.id),
        records,
        canCreate: await this.canCreate(context, childTable.id),
      });
    }

    lists.sort((a, b) => a.title.localeCompare(b.title));
    return lists;
  }

  // --- global search --------------------------------------------------------

  /**
   * Search every table the caller can reach.
   *
   * Storage narrows the candidates by matching searchable fields; the security
   * layer then loads each candidate the ordinary way, so record-level clauses
   * and field grants decide what actually comes back. A field the caller may
   * not read cannot produce a hit for them, even when its value matches.
   */
  async search(context: SecurityContext, term: string, limit = 50): Promise<SearchHit[]> {
    const query = term.trim();
    if (query === '') return [];

    const tables = await this.listTables(context);
    const hits: SearchHit[] = [];

    for (const table of tables) {
      if (hits.length >= limit) break;
      const readable = await this.listReadableFields(context, table.id);
      const searchable = readable.filter(isFieldSearchable);
      if (searchable.length === 0) continue;

      const candidates = await this.store.findRecordIdsMatching(
        searchable.map((field) => field.id),
        query,
        limit * 4,
      );

      for (const recordId of candidates) {
        if (hits.length >= limit) break;
        let record: RecordView;
        try {
          // The ordinary read path, so the clauses run.
          record = await this.getRecord(context, recordId);
        } catch {
          continue;
        }
        const matched = searchable.find((field) => {
          const value = record.values[field.key];
          return (
            value !== null &&
            value !== undefined &&
            String(value).toLowerCase().includes(query.toLowerCase())
          );
        });
        if (!matched) continue;
        hits.push({
          record,
          table,
          label: recordLabel(record, readable),
          field: matched,
          value: String(record.values[matched.key] ?? ''),
        });
      }
    }
    return hits;
  }

  // --- what the caller may do, for the UI to ask before offering it -------

  /** Whether the user may create records in this table at all. */
  async canCreate(context: SecurityContext, tableId: Id): Promise<boolean> {
    const permissions = await this.permissions(context);
    if (permissions.isAdministrator) return true;
    return rulesGrantingCreate(permissions, tableId).length > 0;
  }

  /** Fields the user may set when creating a record in this table. */
  async listCreatableFields(context: SecurityContext, tableId: Id): Promise<FieldView[]> {
    return this.grantedFields(context, tableId, (permissions) =>
      rulesGrantingCreate(permissions, tableId),
    );
  }

  /** Fields the user may write when editing a record in this table. */
  async listEditableFields(context: SecurityContext, tableId: Id): Promise<FieldView[]> {
    return this.grantedFields(context, tableId, (permissions) =>
      rulesGranting(permissions, tableId, AccessType.Edit),
    );
  }

  private async grantedFields(
    context: SecurityContext,
    tableId: Id,
    select: (permissions: PermissionSet) => CompiledRule[],
  ): Promise<FieldView[]> {
    const permissions = await this.permissions(context);
    // A field the platform fills in is writable by nobody, administrator
    // included, so it never appears in a list of what may be written.
    const fields = (await this.store.listFields(tableId)).filter(
      (field) => !isSystemAssigned(field),
    );
    if (permissions.isAdministrator) return this.viewsForTable(tableId, fields);
    const granted = grantedFieldIds(select(permissions), FieldAccess.Edit);
    return this.viewsForTable(
      tableId,
      fields.filter((field) => granted.has(field.id)),
    );
  }

  /**
   * The fields to show in the view returned after a write. Clauses are not
   * re-run here -- the caller has just been told the write succeeded -- so this
   * is the read grant for the table, not for the specific record.
   */
  private readableAfterWrite(permissions: PermissionSet, tableId: Id): ReadonlySet<Id> | null {
    if (permissions.isAdministrator) return null;
    return grantedFieldIds(
      rulesGranting(permissions, tableId, AccessType.Read),
      FieldAccess.Read,
    );
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

  private async fieldMap(table: TableDef): Promise<Map<Id, FieldView>> {
    const views = await this.asViews(table, await this.store.listFields(table.id));
    return new Map(views.map((field) => [field.id, field]));
  }

  private async valuesByRecord(recordIds: Id[]): Promise<Map<Id, Map<Id, string | null>>> {
    const grouped = new Map<Id, Map<Id, string | null>>();
    for (const recordId of recordIds) grouped.set(recordId, new Map());
    for (const value of await this.store.listValues(recordIds)) {
      grouped.get(value.recordId)?.set(value.fieldId, value.value);
    }
    return grouped;
  }

  /**
   * Every required field among `candidates` has a value in `values`.
   *
   * When the caller could not have supplied one -- the field is required but
   * not writable by them -- the message says so, since "it is required" on its
   * own sends an administrator looking in the wrong place.
   */
  private assertRequiredPresent(
    candidates: Iterable<FieldDef>,
    values: Map<Id, string | null>,
    writable: ReadonlySet<Id> | null,
  ): void {
    for (const field of candidates) {
      if (isSystemAssigned(field)) continue;
      if (!field.isRequired) continue;
      if ((values.get(field.id) ?? null) !== null) continue;
      if (writable && !writable.has(field.id)) {
        throw new ValidationError(
          `Field "${field.name}" is required, but this role has no permission to set it`,
        );
      }
      throw new ValidationError(`Field "${field.name}" is required`);
    }
  }

  private normalizeInput(
    input: Record<string, unknown>,
    byKey: Map<string, FieldView>,
  ): Map<Id, string | null> {
    const stored = new Map<Id, string | null>();
    for (const [key, raw] of Object.entries(input)) {
      const field = byKey.get(key);
      if (!field) throw new ValidationError(`Unknown field: "${key}"`);
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
    fields: ReadonlyMap<Id, FieldView>,
    visibleFields: ReadonlySet<Id> | null,
  ): RecordView {
    const projected: Record<string, unknown> = {};
    for (const field of fields.values()) {
      if (visibleFields && !visibleFields.has(field.id)) continue;
      projected[field.key] = fromStoredValue(field, values.get(field.id) ?? null);
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

/**
 * How a record reads in a list: its Name, or the first readable value that
 * will do, or its id. Computed here rather than in the client because only
 * this layer knows which fields the caller may actually read.
 */
function recordLabel(record: RecordView, fields: FieldView[]): string {
  const named = fields.find((field) => isNameField(field));
  const ordered = named ? [named, ...fields.filter((field) => field !== named)] : fields;
  for (const field of ordered) {
    if (field.type === FieldType.Reference) continue;
    const value = record.values[field.key];
    if (value !== null && value !== undefined && String(value) !== '') {
      return labelForValue(field, value);
    }
  }
  return record.id.slice(0, 8);
}

function nameIndex(fields: ReadonlyMap<Id, FieldView>): Map<string, FieldView> {
  return new Map([...fields.values()].map((field) => [field.key, field]));
}
