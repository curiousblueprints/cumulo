/**
 * Database layer contract.
 *
 * Nothing above this layer is allowed to know what the storage engine is or to
 * write a line of SQL. Swapping SQLite for Postgres means writing one new
 * implementation of `DatabaseAdapter` and changing the factory in
 * `src/db/index.ts` -- no other file should need to change.
 */

export type Scalar = string | number | boolean | null;

/** A raw storage row: flat, scalar-valued, keyed by column name. */
export type Row = Record<string, Scalar>;

export type ColumnType = 'text' | 'integer' | 'real' | 'boolean';

export interface ForeignKeyDef {
  table: string;
  column: string;
  /** Defaults to 'restrict'. */
  onDelete?: 'restrict' | 'cascade' | 'setNull';
}

export interface ColumnDef {
  name: string;
  type: ColumnType;
  nullable?: boolean;
  unique?: boolean;
  references?: ForeignKeyDef;
}

export interface TableSchema {
  name: string;
  /** The primary key column. Always a single text column in this platform. */
  primaryKey: string;
  columns: ColumnDef[];
  /** Multi-column uniqueness, e.g. ['namespaceId', 'name']. */
  uniqueConstraints?: string[][];
  indexes?: string[][];
}

export type Schema = TableSchema[];

export type FilterOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'like'
  | 'isNull'
  | 'isNotNull';

export interface Filter {
  column: string;
  operator: FilterOperator;
  /** Omitted for 'isNull'/'isNotNull'; an array for 'in'. */
  value?: Scalar | Scalar[];
}

export interface OrderBy {
  column: string;
  direction?: 'asc' | 'desc';
}

/** Filters are combined with AND. That is deliberately all the expressive
 *  power the layers above get; anything richer belongs in the security or
 *  application layer, where it can be reasoned about portably. */
export interface QuerySpec {
  where?: Filter[];
  orderBy?: OrderBy[];
  limit?: number;
  offset?: number;
}

export interface DatabaseAdapter {
  open(): Promise<void>;
  close(): Promise<void>;

  /** Create anything in `schema` that does not exist yet. Idempotent. */
  applySchema(schema: Schema): Promise<void>;

  /** Whether a table exists, for carrying an older installation forward. */
  hasTable(table: string): Promise<boolean>;

  /** Remove a table and everything in it. Used only by migrations. */
  dropTable(table: string): Promise<void>;

  insert(table: string, row: Row): Promise<Row>;
  /** Returns the updated row, or null when no row has that id. */
  update(table: string, id: Scalar, patch: Row): Promise<Row | null>;
  /** Returns true when a row was removed. */
  delete(table: string, id: Scalar): Promise<boolean>;
  deleteWhere(table: string, query: QuerySpec): Promise<number>;

  findById(table: string, id: Scalar): Promise<Row | null>;
  find(table: string, query?: QuerySpec): Promise<Row[]>;
  findOne(table: string, query?: QuerySpec): Promise<Row | null>;
  count(table: string, query?: QuerySpec): Promise<number>;

  /**
   * Run `fn` atomically. Implementations must roll back if `fn` throws.
   * Nested calls join the outer transaction.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export class DatabaseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseError';
  }
}

/** Thrown when a unique constraint is violated, whatever the engine. */
export class UniqueConstraintError extends DatabaseError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UniqueConstraintError';
  }
}
