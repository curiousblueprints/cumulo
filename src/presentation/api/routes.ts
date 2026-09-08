import type { Application } from '../../app/Application.js';
import { FieldType, type FieldDef, type RecordView, type TableDef } from '../../domain/types.js';
import type { SecurityContext } from '../../security/context.js';
import { AccessDeniedError } from '../../security/errors.js';
import type { Router } from '../http/router.js';
import { json, type HttpRequest } from '../http/types.js';

/**
 * The JSON API behind the user-space client.
 *
 * It calls the same application services the server-rendered pages do, so the
 * security layer remains the only way to the data. Authentication is the same
 * session cookie; mutations additionally carry the session's CSRF token in an
 * `x-csrf-token` header, since a cookie alone would let another origin post.
 */
export function registerApiRoutes(router: Router, app: Application): void {
  const requireUser = (request: HttpRequest): SecurityContext => {
    if (!request.context) throw new AccessDeniedError('Not signed in');
    return request.context;
  };

  const checkCsrf = (request: HttpRequest): void => {
    const expected = request.session?.csrfToken;
    const supplied = request.headers['x-csrf-token'];
    if (!expected || supplied !== expected) {
      throw new AccessDeniedError('Missing or invalid CSRF token');
    }
  };

  /** Who is asking, what their tabs are, and the token for mutations. */
  router.get('/api/v1/me', async (request) => {
    const context = requireUser(request);
    const tabs = await app.security.listTabs(context);
    return json({
      user: { id: context.user.id, username: context.user.username },
      role: { id: context.role.id, name: context.role.name, isAdministrator: context.role.isSystem },
      csrfToken: request.session?.csrfToken ?? '',
      tabs: tabs.map(describeTable),
    });
  });

  router.get('/api/v1/tables/:tableId', async (request) => {
    const context = requireUser(request);
    const tableId = request.params['tableId'] as string;
    const table = await app.security.getTable(context, tableId);
    const [readable, creatable, editable, canCreate] = await Promise.all([
      app.metadata.listReadableFields(context, table.id),
      app.security.listCreatableFields(context, table.id),
      app.security.listEditableFields(context, table.id),
      app.security.canCreate(context, table.id),
    ]);
    return json({
      table: describeTable(table),
      fields: readable.map(describeField),
      creatableFields: creatable.map((field) => field.name),
      editableFields: editable.map((field) => field.name),
      canCreate,
    });
  });

  router.get('/api/v1/tables/:tableId/records', async (request) => {
    const context = requireUser(request);
    const tableId = request.params['tableId'] as string;
    const limit = numberParam(request, 'limit', 200);
    const records = await app.records.list(context, tableId, { limit });
    return json({ records: records.map(describeRecord) });
  });

  router.post('/api/v1/tables/:tableId/records', async (request) => {
    const context = requireUser(request);
    checkCsrf(request);
    const tableId = request.params['tableId'] as string;
    const record = await app.records.create(context, tableId, request.body);
    return json({ record: describeRecord(record) }, 201);
  });

  router.get('/api/v1/records/:recordId', async (request) => {
    const context = requireUser(request);
    const recordId = request.params['recordId'] as string;
    const record = await app.records.get(context, recordId);
    const table = await app.security.getTable(context, record.tableId);
    const [readable, editable] = await Promise.all([
      app.metadata.listReadableFields(context, table.id),
      app.security.listEditableFields(context, table.id),
    ]);
    return json({
      record: describeRecord(record),
      table: describeTable(table),
      fields: readable.map(describeField),
      editableFields: editable.map((field) => field.name),
    });
  });

  router.post('/api/v1/records/:recordId', async (request) => {
    const context = requireUser(request);
    checkCsrf(request);
    const recordId = request.params['recordId'] as string;
    const record = await app.records.update(context, recordId, request.body);
    return json({ record: describeRecord(record) });
  });

  router.post('/api/v1/records/:recordId/delete', async (request) => {
    const context = requireUser(request);
    checkCsrf(request);
    await app.records.delete(context, request.params['recordId'] as string);
    return json({ deleted: true });
  });

  router.get('/api/v1/search', async (request) => {
    const context = requireUser(request);
    const term = request.query.get('q') ?? '';
    const hits = await app.security.search(context, term, numberParam(request, 'limit', 30));
    return json({
      term,
      hits: hits.map((hit) => ({
        record: describeRecord(hit.record),
        table: describeTable(hit.table),
        label: hit.label,
        field: describeField(hit.field),
        value: hit.value,
      })),
    });
  });
}

function describeTable(table: TableDef): {
  id: string;
  name: string;
  label: string;
} {
  return { id: table.id, name: table.name, label: table.label };
}

function describeField(field: FieldDef): {
  id: string;
  name: string;
  label: string;
  type: FieldType;
  isRequired: boolean;
  isSearchable: boolean;
  referenceTableId: string | null;
} {
  return {
    id: field.id,
    name: field.name,
    label: field.label,
    type: field.type,
    isRequired: field.isRequired,
    isSearchable: field.isSearchable,
    referenceTableId: field.referenceTableId,
  };
}

function describeRecord(record: RecordView): RecordView {
  return {
    id: record.id,
    tableId: record.tableId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    values: record.values,
  };
}

function numberParam(request: HttpRequest, name: string, fallback: number): number {
  const raw = Number(request.query.get(name));
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 500) : fallback;
}
