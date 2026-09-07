import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DatabaseError,
  UniqueConstraintError,
  type ColumnDef,
  type DatabaseAdapter,
  type Filter,
  type QuerySpec,
  type Row,
  type Scalar,
  type Schema,
  type TableSchema,
} from '../types.js';

/** SQLite stores no booleans, so we track column types to coerce on read. */
type ColumnTypes = Map<string, Map<string, ColumnDef['type']>>;

/** The value types node:sqlite will actually bind to a statement. */
type SqlParam = string | number | null;

export interface SqliteAdapterOptions {
  /** File path, or ':memory:' for an ephemeral database. */
  file: string;
}

const SQL_TYPES: Record<ColumnDef['type'], string> = {
  text: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  boolean: 'INTEGER',
};

const FK_ACTIONS = {
  restrict: 'RESTRICT',
  cascade: 'CASCADE',
  setNull: 'SET NULL',
} as const;

function quote(identifier: string): string {
  if (identifier.includes('"')) {
    throw new DatabaseError(`Illegal identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export class SqliteAdapter implements DatabaseAdapter {
  private db: DatabaseSync | null = null;
  private readonly columnTypes: ColumnTypes = new Map();
  private transactionDepth = 0;

  constructor(private readonly options: SqliteAdapterOptions) {}

  async open(): Promise<void> {
    if (this.db) return;
    if (this.options.file !== ':memory:') {
      mkdirSync(dirname(this.options.file), { recursive: true });
    }
    this.db = new DatabaseSync(this.options.file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  private handle(): DatabaseSync {
    if (!this.db) throw new DatabaseError('Database is not open');
    return this.db;
  }

  async applySchema(schema: Schema): Promise<void> {
    const db = this.handle();
    for (const table of schema) {
      this.rememberTypes(table);
      db.exec(createTableSql(table));
      for (const index of table.indexes ?? []) {
        const name = `idx_${table.name}_${index.join('_')}`;
        db.exec(
          `CREATE INDEX IF NOT EXISTS ${quote(name)} ON ${quote(table.name)} ` +
            `(${index.map(quote).join(', ')})`,
        );
      }
    }
  }

  private rememberTypes(table: TableSchema): void {
    const types = new Map<string, ColumnDef['type']>();
    for (const column of table.columns) types.set(column.name, column.type);
    this.columnTypes.set(table.name, types);
  }

  async insert(table: string, row: Row): Promise<Row> {
    const columns = Object.keys(row);
    if (columns.length === 0) {
      throw new DatabaseError(`Cannot insert an empty row into ${table}`);
    }
    const sql =
      `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) ` +
      `VALUES (${columns.map(() => '?').join(', ')})`;
    this.run(sql, columns.map((column) => this.toStorage(table, column, row[column] ?? null)));
    return { ...row };
  }

  async update(table: string, id: Scalar, patch: Row): Promise<Row | null> {
    const columns = Object.keys(patch);
    if (columns.length > 0) {
      const sql =
        `UPDATE ${quote(table)} SET ${columns.map((c) => `${quote(c)} = ?`).join(', ')} ` +
        `WHERE ${quote('id')} = ?`;
      const params: SqlParam[] = columns.map((column) =>
        this.toStorage(table, column, patch[column] ?? null),
      );
      params.push(this.toStorage(table, 'id', id));
      this.run(sql, params);
    }
    return this.findById(table, id);
  }

  async delete(table: string, id: Scalar): Promise<boolean> {
    const result = this.run(`DELETE FROM ${quote(table)} WHERE ${quote('id')} = ?`, [
      this.toStorage(table, 'id', id),
    ]);
    return Number(result.changes) > 0;
  }

  async deleteWhere(table: string, query: QuerySpec): Promise<number> {
    const { clause, params } = buildWhere(query.where ?? [], (column, value) =>
      this.toStorage(table, column, value),
    );
    const result = this.run(`DELETE FROM ${quote(table)}${clause}`, params);
    return Number(result.changes);
  }

  async findById(table: string, id: Scalar): Promise<Row | null> {
    const rows = this.all(`SELECT * FROM ${quote(table)} WHERE ${quote('id')} = ? LIMIT 1`, [
      this.toStorage(table, 'id', id),
    ]);
    const row = rows[0];
    return row ? this.fromStorage(table, row) : null;
  }

  async find(table: string, query: QuerySpec = {}): Promise<Row[]> {
    const { clause, params } = buildWhere(query.where ?? [], (column, value) =>
      this.toStorage(table, column, value),
    );
    let sql = `SELECT * FROM ${quote(table)}${clause}`;
    if (query.orderBy?.length) {
      const order = query.orderBy
        .map((o) => `${quote(o.column)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`)
        .join(', ');
      sql += ` ORDER BY ${order}`;
    }
    if (query.limit !== undefined) sql += ` LIMIT ${Number(query.limit)}`;
    if (query.offset !== undefined) {
      if (query.limit === undefined) sql += ' LIMIT -1';
      sql += ` OFFSET ${Number(query.offset)}`;
    }
    return this.all(sql, params).map((row) => this.fromStorage(table, row));
  }

  async findOne(table: string, query: QuerySpec = {}): Promise<Row | null> {
    const rows = await this.find(table, { ...query, limit: 1 });
    return rows[0] ?? null;
  }

  async count(table: string, query: QuerySpec = {}): Promise<number> {
    const { clause, params } = buildWhere(query.where ?? [], (column, value) =>
      this.toStorage(table, column, value),
    );
    const rows = this.all(`SELECT COUNT(*) AS n FROM ${quote(table)}${clause}`, params);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * SQLite has no nested transactions, so inner calls simply join the
   * outermost one and only the outermost commits or rolls back.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const db = this.handle();
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        return await fn();
      } finally {
        this.transactionDepth -= 1;
      }
    }
    db.exec('BEGIN');
    this.transactionDepth = 1;
    try {
      const result = await fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction was already unwound; surface the original error.
      }
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  private prepare(sql: string): StatementSync {
    return this.handle().prepare(sql);
  }

  private run(sql: string, params: SqlParam[]): { changes: number | bigint } {
    try {
      return this.prepare(sql).run(...params);
    } catch (error) {
      throw translate(error, sql);
    }
  }

  private all(sql: string, params: SqlParam[]): Record<string, Scalar>[] {
    try {
      return this.prepare(sql).all(...params) as unknown as Record<string, Scalar>[];
    } catch (error) {
      throw translate(error, sql);
    }
  }

  /** node:sqlite has no boolean binding, so booleans become 0/1 on the way in. */
  private toStorage(_table: string, _column: string, value: Scalar): SqlParam {
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  }

  private fromStorage(table: string, row: Record<string, Scalar>): Row {
    const types = this.columnTypes.get(table);
    if (!types) return { ...row };
    const result: Row = {};
    for (const [column, value] of Object.entries(row)) {
      result[column] =
        types.get(column) === 'boolean' && value !== null ? Number(value) !== 0 : value;
    }
    return result;
  }
}

function createTableSql(table: TableSchema): string {
  const lines: string[] = [];
  for (const column of table.columns) {
    let line = `${quote(column.name)} ${SQL_TYPES[column.type]}`;
    if (column.name === table.primaryKey) line += ' PRIMARY KEY';
    else if (!column.nullable) line += ' NOT NULL';
    if (column.unique && column.name !== table.primaryKey) line += ' UNIQUE';
    lines.push(line);
  }
  for (const unique of table.uniqueConstraints ?? []) {
    lines.push(`UNIQUE (${unique.map(quote).join(', ')})`);
  }
  for (const column of table.columns) {
    if (!column.references) continue;
    const action = FK_ACTIONS[column.references.onDelete ?? 'restrict'];
    lines.push(
      `FOREIGN KEY (${quote(column.name)}) REFERENCES ` +
        `${quote(column.references.table)} (${quote(column.references.column)}) ` +
        `ON DELETE ${action}`,
    );
  }
  return `CREATE TABLE IF NOT EXISTS ${quote(table.name)} (\n  ${lines.join(',\n  ')}\n)`;
}

function buildWhere(
  filters: Filter[],
  coerce: (column: string, value: Scalar) => SqlParam,
): { clause: string; params: SqlParam[] } {
  if (filters.length === 0) return { clause: '', params: [] };
  const parts: string[] = [];
  const params: SqlParam[] = [];
  for (const filter of filters) {
    const column = quote(filter.column);
    switch (filter.operator) {
      case 'isNull':
        parts.push(`${column} IS NULL`);
        break;
      case 'isNotNull':
        parts.push(`${column} IS NOT NULL`);
        break;
      case 'in': {
        const values = (filter.value ?? []) as Scalar[];
        if (values.length === 0) {
          parts.push('0 = 1');
          break;
        }
        parts.push(`${column} IN (${values.map(() => '?').join(', ')})`);
        for (const value of values) params.push(coerce(filter.column, value));
        break;
      }
      case 'like':
        parts.push(`${column} LIKE ?`);
        params.push(coerce(filter.column, filter.value as Scalar));
        break;
      default: {
        const sqlOperator = {
          eq: '=',
          ne: '!=',
          gt: '>',
          gte: '>=',
          lt: '<',
          lte: '<=',
        }[filter.operator];
        parts.push(`${column} ${sqlOperator} ?`);
        params.push(coerce(filter.column, (filter.value ?? null) as Scalar));
      }
    }
  }
  return { clause: ` WHERE ${parts.join(' AND ')}`, params };
}

function translate(error: unknown, sql: string): DatabaseError {
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed/i.test(message)) {
    return new UniqueConstraintError(message, { cause: error });
  }
  return new DatabaseError(`${message} (while running: ${sql})`, { cause: error });
}
