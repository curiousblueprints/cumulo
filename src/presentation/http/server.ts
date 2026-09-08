import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { Application } from '../../app/Application.js';
import type { FeatureFlags } from '../../config.js';
import { UniqueConstraintError } from '../../db/types.js';
import { SecurityError, AccessDeniedError, NotFoundError, ValidationError } from '../../security/errors.js';
import { registerApiRoutes } from '../api/routes.js';
import { registerWebRoutes } from '../web/routes.js';
import { RedirectSignal } from './signals.js';
import { serveStaticFile } from './static.js';
import { Router } from './router.js';
import { parseCookies, SESSION_COOKIE, SessionStore } from './sessions.js';
import type { HttpMethod, HttpRequest, HttpResponse } from './types.js';

export interface ServerOptions {
  /** Rejects request bodies larger than this, in bytes. */
  maxBodyBytes?: number;
  /** Defaults to everything off. */
  features?: Partial<FeatureFlags>;
  /** Where the built client bundle lives. Defaults to ./public. */
  clientRoot?: string;
}

const DEFAULT_FEATURES: FeatureFlags = {
  namespaceCreation: false,
};

const DEFAULT_MAX_BODY = 1024 * 256;

/**
 * The presentation layer's transport.
 *
 * It knows about HTTP and nothing else: it parses a request, resolves the
 * session into a SecurityContext, hands it to the router, and writes back
 * whatever the route produced. Adding a JSON API means registering another
 * set of routes on this same router -- the plumbing here does not change.
 */
export function buildRouter(
  app: Application,
  sessions: SessionStore,
  features: FeatureFlags = DEFAULT_FEATURES,
): Router {
  const router = new Router();
  // A dependency-free liveness probe, which is also what the container's
  // HEALTHCHECK calls.
  router.get('/healthz', async () => ({
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ status: 'ok' }),
  }));
  registerApiRoutes(router, app);
  registerWebRoutes(router, app, sessions, features);
  return router;
}

export function createServer(app: Application, options: ServerOptions = {}): Server {
  const sessions = new SessionStore();
  const router = buildRouter(app, sessions, { ...DEFAULT_FEATURES, ...options.features });
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const clientRoot = options.clientRoot ?? defaultClientRoot();

  return createHttpServer((incoming, outgoing) => {
    void handle(app, router, sessions, maxBody, clientRoot, incoming, outgoing).catch((error) => {
      writeResponse(outgoing, {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: `Internal error: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
  });
}

/** The bundle sits next to the compiled server, at dist/public. */
function defaultClientRoot(): string {
  return fileURLToPath(new URL('../../../public/', import.meta.url));
}

async function handle(
  app: Application,
  router: Router,
  sessions: SessionStore,
  maxBody: number,
  clientRoot: string,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  const url = new URL(incoming.url ?? '/', 'http://localhost');
  const method = (incoming.method ?? 'GET').toUpperCase() as HttpMethod;

  let parsed: ParsedBody = { fields: {}, lists: {} };
  if (method !== 'GET' && method !== 'DELETE') {
    const raw = await readBody(incoming, maxBody);
    if (raw === null) {
      writeResponse(outgoing, {
        status: 413,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'Request body too large',
      });
      return;
    }
    parsed = parseBody(incoming.headers['content-type'], raw);
  }

  const cookies = parseCookies(incoming.headers.cookie);
  const session = sessions.get(cookies[SESSION_COOKIE]);
  const context = session ? await app.auth.contextForUser(session.userId) : null;
  // A session whose user has gone away or been deactivated is not a session.
  if (session && !context) sessions.destroy(session.id);

  const request: HttpRequest = {
    method,
    path: url.pathname,
    params: {},
    query: url.searchParams,
    body: parsed.fields,
    bodyList: parsed.lists,
    headers: incoming.headers as Record<string, string | undefined>,
    context,
    session: context ? session : null,
  };

  let response: HttpResponse | null;
  try {
    response = await router.dispatch(request);
    if (!response && method === 'GET' && url.pathname.startsWith('/assets/')) {
      response = await serveStaticFile(clientRoot, url.pathname.slice('/assets/'.length));
    }
  } catch (error) {
    response = error instanceof RedirectSignal
      ? { status: 303, headers: { location: error.location }, body: '' }
      : errorResponse(error, url.pathname);
  }
  writeResponse(
    outgoing,
    response ?? {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'Not found',
    },
  );
}

/** Maps the security layer's vocabulary onto HTTP status codes. */
export function statusFor(error: unknown): number {
  if (error instanceof AccessDeniedError) return 403;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ValidationError) return 400;
  if (error instanceof SecurityError) return 403;
  // A constraint that reached storage is a conflict, not a server fault.
  if (error instanceof UniqueConstraintError) return 409;
  return 500;
}

function errorResponse(error: unknown, path = ''): HttpResponse {
  const status = statusFor(error);
  const message =
    error instanceof UniqueConstraintError
      ? 'That already exists.'
      : error instanceof Error
        ? error.message
        : 'Unexpected error';
  const text = status === 500 ? 'Internal error' : message;
  // The client reads errors as JSON, so the API answers in its own language.
  if (path.startsWith('/api/')) {
    return {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: text }),
    };
  }
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: text };
}

async function readBody(incoming: IncomingMessage, maxBytes: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface ParsedBody {
  fields: Record<string, string>;
  lists: Record<string, string[]>;
}

function parseBody(contentType: string | undefined, raw: string): ParsedBody {
  const empty: ParsedBody = { fields: {}, lists: {} };
  if (raw.length === 0) return empty;

  if (contentType?.includes('application/json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return empty;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    const fields: Record<string, string> = {};
    const lists: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const values = (Array.isArray(value) ? value : [value]).map((item) =>
        item === null || item === undefined ? '' : String(item),
      );
      lists[key] = values;
      fields[key] = values[values.length - 1] ?? '';
    }
    return { fields, lists };
  }

  const params = new URLSearchParams(raw);
  const fields: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  for (const [key, value] of params) {
    fields[key] = value;
    (lists[key] ??= []).push(value);
  }
  return { fields, lists };
}

function writeResponse(outgoing: ServerResponse, response: HttpResponse): void {
  outgoing.writeHead(response.status, response.headers);
  outgoing.end(response.body);
}
