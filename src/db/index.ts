import { SqliteAdapter } from './sqlite/SqliteAdapter.js';
import type { DatabaseAdapter } from './types.js';

export * from './types.js';
export { LEGACY_SECURITY_RULE_FIELD, PLATFORM_SCHEMA, T } from './schema.js';
export { SqliteAdapter } from './sqlite/SqliteAdapter.js';

export interface DatabaseConfig {
  /** The only driver shipped today; the seam exists for the next one. */
  driver: 'sqlite';
  /** SQLite file path, or ':memory:'. */
  file: string;
}

/**
 * The single place that knows which adapter implementation is in play.
 * Adding Postgres means adding a case here and a new adapter class.
 */
export function createDatabase(config: DatabaseConfig): DatabaseAdapter {
  switch (config.driver) {
    case 'sqlite':
      return new SqliteAdapter({ file: config.file });
    default: {
      const driver: never = config.driver;
      throw new Error(`Unsupported database driver: ${String(driver)}`);
    }
  }
}
