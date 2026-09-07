import type { ApplicationConfig } from './app/Application.js';

export interface ServerConfig extends ApplicationConfig {
  host: string;
  port: number;
}

/**
 * Configuration comes from the environment so the same image runs anywhere.
 * The database file defaults into ./data, which is the directory the
 * container mounts as a volume.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env['PORT'] ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${String(env['PORT'])}`);
  }
  return {
    host: env['HOST'] ?? '0.0.0.0',
    port,
    database: {
      driver: 'sqlite',
      file: env['CUMULO_DATABASE_FILE'] ?? 'data/cumulo.db',
    },
  };
}
