import type { ApplicationConfig } from './app/Application.js';

/** Optional behaviour that is off unless the environment turns it on. */
export interface FeatureFlags {
  /**
   * Lets the setup console create namespaces. Off by default: namespaces
   * arrive with a package, not by hand. On for testing, via
   * CUMULO_ENABLE_NAMESPACE_CREATION=true.
   */
  namespaceCreation: boolean;
}

export interface ServerConfig extends ApplicationConfig {
  host: string;
  port: number;
  features: FeatureFlags;
}

function flag(raw: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());
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
    features: {
      namespaceCreation: flag(env['CUMULO_ENABLE_NAMESPACE_CREATION']),
    },
  };
}
