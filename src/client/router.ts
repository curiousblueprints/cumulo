import { useCallback, useEffect, useState } from 'react';

/**
 * The whole router. The user space has four places to be, so a library would
 * be more machinery than the problem has.
 */
export type Route =
  | { kind: 'home' }
  | { kind: 'table'; tableId: string }
  | { kind: 'record'; recordId: string }
  | { kind: 'new'; tableId: string }
  | { kind: 'search'; term: string };

export function parseRoute(url: URL): Route {
  const segments = url.pathname.split('/').filter(Boolean);
  // Everything here lives under /app.
  if (segments[0] !== 'app') return { kind: 'home' };
  if (segments[1] === 'tables' && segments[2]) {
    return segments[3] === 'new'
      ? { kind: 'new', tableId: segments[2] }
      : { kind: 'table', tableId: segments[2] };
  }
  if (segments[1] === 'records' && segments[2]) {
    return { kind: 'record', recordId: segments[2] };
  }
  if (segments[1] === 'search') return { kind: 'search', term: url.searchParams.get('q') ?? '' };
  return { kind: 'home' };
}

export function hrefFor(route: Route): string {
  switch (route.kind) {
    case 'table':
      return `/app/tables/${encodeURIComponent(route.tableId)}`;
    case 'new':
      return `/app/tables/${encodeURIComponent(route.tableId)}/new`;
    case 'record':
      return `/app/records/${encodeURIComponent(route.recordId)}`;
    case 'search':
      return `/app/search?q=${encodeURIComponent(route.term)}`;
    default:
      return '/app';
  }
}

export interface NavigateOptions {
  /**
   * Overwrite the current entry rather than adding one. Used when the app
   * sends you somewhere you did not ask to go -- landing on the first tab --
   * so the back button leaves the app instead of bouncing off the redirect.
   */
  replace?: boolean;
}

export type Navigate = (route: Route, options?: NavigateOptions) => void;

export function useRouter(): { route: Route; navigate: Navigate } {
  const [route, setRoute] = useState<Route>(() => parseRoute(new URL(window.location.href)));

  useEffect(() => {
    const onPop = (): void => setRoute(parseRoute(new URL(window.location.href)));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback<Navigate>((next, options) => {
    const href = hrefFor(next);
    if (options?.replace) window.history.replaceState({}, '', href);
    else window.history.pushState({}, '', href);
    setRoute(next);
  }, []);

  return { route, navigate };
}
