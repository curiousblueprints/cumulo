import { randomBytes } from 'node:crypto';
import type { SessionData } from './types.js';

export const SESSION_COOKIE = 'cumulo_session';

/**
 * In-memory sessions. Fine for a single process; a shared store would slot in
 * behind the same three methods when there is more than one.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionData>();

  create(userId: string): SessionData {
    const session: SessionData = {
      id: randomBytes(24).toString('hex'),
      userId,
      csrfToken: randomBytes(24).toString('hex'),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string | undefined): SessionData | null {
    if (!id) return null;
    return this.sessions.get(id) ?? null;
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }
}

export function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/`;
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}
