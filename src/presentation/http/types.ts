import type { SecurityContext } from '../../security/context.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRequest {
  method: HttpMethod;
  path: string;
  /** Values captured from the route pattern, e.g. ":id". */
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed form or JSON body; empty for bodyless requests. */
  body: Record<string, string>;
  /** The same body, keeping every value of repeated keys (multi-selects). */
  bodyList: Record<string, string[]>;
  headers: Record<string, string | undefined>;
  /** Present once a session has been resolved to a user. */
  context: SecurityContext | null;
  session: SessionData | null;
}

export interface SessionData {
  id: string;
  userId: string;
  csrfToken: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type Handler = (request: HttpRequest) => Promise<HttpResponse>;

export interface Route {
  method: HttpMethod;
  pattern: string;
  handler: Handler;
}

export function html(body: string, status = 200, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    body,
  };
}

export function json(payload: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(payload),
  };
}

export function redirect(location: string, headers: Record<string, string> = {}): HttpResponse {
  return { status: 303, headers: { location, ...headers }, body: '' };
}
