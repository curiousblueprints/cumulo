import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { HttpResponse } from './types.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Serves the built client bundle.
 *
 * The path is resolved and checked to be inside the root before anything is
 * read, so "../" in a URL cannot walk out of the directory.
 */
export async function serveStaticFile(root: string, urlPath: string): Promise<HttpResponse | null> {
  const relative = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const target = resolve(join(root, relative));
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) return null;

  try {
    const info = await stat(target);
    if (!info.isFile()) return null;
    const body = await readFile(target);
    return {
      status: 200,
      headers: {
        'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
        // The bundle's name carries no hash yet, so it is revalidated rather
        // than cached hard; a stale client is worse than a conditional GET.
        'cache-control': 'no-cache',
      },
      body: body.toString('utf8'),
    };
  } catch {
    return null;
  }
}
