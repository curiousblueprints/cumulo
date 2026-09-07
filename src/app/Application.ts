import { createDatabase, type DatabaseConfig } from '../db/index.js';
import type { DatabaseAdapter } from '../db/types.js';
import { SecurityLayer } from '../security/SecurityLayer.js';
import { MetadataStore } from '../store/MetadataStore.js';
import { AuthService } from './AuthService.js';
import { InstallService } from './InstallService.js';
import { MetadataService } from './MetadataService.js';
import { RecordService } from './RecordService.js';

export interface ApplicationConfig {
  database: DatabaseConfig;
}

/**
 * Composition root. Everything is wired here and nowhere else, so the
 * presentation layer receives services rather than reaching for a database.
 */
export class Application {
  readonly database: DatabaseAdapter;
  readonly security: SecurityLayer;
  readonly install: InstallService;
  readonly auth: AuthService;
  readonly metadata: MetadataService;
  readonly records: RecordService;

  private constructor(database: DatabaseAdapter) {
    this.database = database;
    const store = new MetadataStore(database);
    this.security = new SecurityLayer(store);
    this.install = new InstallService(database, store);
    this.auth = new AuthService(store);
    this.metadata = new MetadataService(this.security);
    this.records = new RecordService(this.security);
  }

  /** Open the database and bring the installation up to date. */
  static async start(config: ApplicationConfig): Promise<Application> {
    const database = createDatabase(config.database);
    await database.open();
    const app = new Application(database);
    await app.install.install();
    return app;
  }

  async stop(): Promise<void> {
    await this.database.close();
  }
}
