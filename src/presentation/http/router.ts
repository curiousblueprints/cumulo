import type { Handler, HttpMethod, HttpRequest, HttpResponse, Route } from './types.js';

interface CompiledRoute extends Route {
  segments: string[];
}

/**
 * A pattern router over path segments, e.g. "/tables/:tableId/records".
 * Deliberately transport-shaped rather than HTML-shaped: the same router
 * serves the JSON API when one is added.
 */
export class Router {
  private readonly routes: CompiledRoute[] = [];

  add(method: HttpMethod, pattern: string, handler: Handler): this {
    this.routes.push({ method, pattern, handler, segments: split(pattern) });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  /** Returns null when nothing matches the path at all. */
  match(
    method: HttpMethod,
    path: string,
  ): { handler: Handler; params: Record<string, string> } | null {
    const segments = split(path);
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, segments);
      if (!params) continue;
      pathMatched = true;
      if (route.method === method) return { handler: route.handler, params };
    }
    if (pathMatched) {
      return {
        handler: async (): Promise<HttpResponse> => ({
          status: 405,
          headers: { 'content-type': 'text/plain' },
          body: 'Method not allowed',
        }),
        params: {},
      };
    }
    return null;
  }

  async dispatch(request: HttpRequest): Promise<HttpResponse | null> {
    const matched = this.match(request.method, request.path);
    if (!matched) return null;
    return matched.handler({ ...request, params: matched.params });
  }
}

function split(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of pattern.entries()) {
    const value = actual[index] as string;
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(value);
    else if (segment !== value) return null;
  }
  return params;
}
