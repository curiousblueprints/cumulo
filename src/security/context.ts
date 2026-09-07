import type { SecurityRole, User } from '../domain/types.js';

/**
 * Who is acting. Every call into the security layer requires one; there is no
 * anonymous path into the data, and no "system" context that skips checks.
 */
export interface SecurityContext {
  readonly user: User;
  readonly role: SecurityRole;
}

export function createContext(user: User, role: SecurityRole): SecurityContext {
  if (user.securityRoleId !== role.id) {
    throw new Error('Security context role does not match the user');
  }
  return { user, role };
}
