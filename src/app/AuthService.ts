import { createContext, type SecurityContext } from '../security/context.js';
import { AccessDeniedError } from '../security/errors.js';
import type { MetadataStore } from '../store/MetadataStore.js';
import { verifyPassword } from './passwords.js';

/**
 * Turns credentials into a SecurityContext. It is the only place that reads
 * users without going through the security layer, because it has to run
 * before there is a user to check anything against.
 */
export class AuthService {
  constructor(private readonly store: MetadataStore) {}

  async authenticate(username: string, password: string): Promise<SecurityContext> {
    const user = await this.store.getUserByUsername(username.trim());
    // Hash a throwaway comparison anyway so a missing user and a wrong
    // password cost roughly the same.
    const hash = user?.passwordHash ?? 'scrypt$16384$00$00';
    const ok = verifyPassword(password, hash);
    if (!user || !ok || !user.isActive) {
      throw new AccessDeniedError('Invalid username or password');
    }
    const role = await this.store.getSecurityRole(user.securityRoleId);
    if (!role) throw new AccessDeniedError('User has no valid security role');
    return createContext(user, role);
  }

  /** Rebuild a context from a session's stored user id. */
  async contextForUser(userId: string): Promise<SecurityContext | null> {
    const user = await this.store.getUser(userId);
    if (!user || !user.isActive) return null;
    const role = await this.store.getSecurityRole(user.securityRoleId);
    if (!role) return null;
    return createContext(user, role);
  }
}
