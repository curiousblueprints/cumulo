import { Application } from './app/Application.js';
import { loadConfig } from './config.js';
import { createServer } from './presentation/http/server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await Application.start(config);
  const server = createServer(app);

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const ready = (await app.install.isSetupComplete()) ? 'sign in at /login' : 'set up at /setup';
  console.log(`Cumulo listening on http://${config.host}:${config.port} - ${ready}`);

  // Containers stop by signal, so unwind the server and the database cleanly.
  const shutdown = (signal: string): void => {
    console.log(`Received ${signal}, shutting down`);
    server.close(() => {
      void app.stop().then(() => process.exit(0));
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
