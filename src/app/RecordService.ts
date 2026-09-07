import type { Id, RecordView } from '../domain/types.js';
import type { SecurityContext } from '../security/context.js';
import type { QueryOptions, SecurityLayer } from '../security/SecurityLayer.js';

/**
 * Record CRUD for the application layer.
 *
 * It is a thin pass-through today, and that is the point: business logic can
 * accumulate here without any of it being able to route around the security
 * layer, which owns every read and write underneath.
 */
export class RecordService {
  constructor(private readonly security: SecurityLayer) {}

  list(context: SecurityContext, tableId: Id, options?: QueryOptions): Promise<RecordView[]> {
    return this.security.queryRecords(context, tableId, options);
  }

  get(context: SecurityContext, recordId: Id): Promise<RecordView> {
    return this.security.getRecord(context, recordId);
  }

  create(
    context: SecurityContext,
    tableId: Id,
    values: Record<string, unknown>,
  ): Promise<RecordView> {
    return this.security.createRecord(context, tableId, values);
  }

  update(
    context: SecurityContext,
    recordId: Id,
    values: Record<string, unknown>,
  ): Promise<RecordView> {
    return this.security.updateRecord(context, recordId, values);
  }

  delete(context: SecurityContext, recordId: Id): Promise<void> {
    return this.security.deleteRecord(context, recordId);
  }
}
