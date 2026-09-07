import { PLATFORM_SCHEMA } from '../db/schema.js';
import type { DatabaseAdapter } from '../db/types.js';
import {
  ADMINISTRATOR_ROLE,
  STD_NAMESPACE,
  type Namespace,
  type SecurityRole,
  type User,
} from '../domain/types.js';
import { createContext, type SecurityContext } from '../security/context.js';
import { ValidationError } from '../security/errors.js';
import type { MetadataStore } from '../store/MetadataStore.js';
import { newId, nowIso } from '../util/index.js';
import { hashPassword } from './passwords.js';

export interface FirstUserInput {
  username: string;
  email: string;
  password: string;
}

/**
 * Brings an empty database up to a usable installation:
 * the schema, the `std` namespace, and the Administrator role.
 *
 * The first user is created separately, through `completeSetup`, which is what
 * the initial setup page calls. Until then the installation has no users and
 * the only page the presentation layer will serve is that setup page.
 */
export class InstallService {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly store: MetadataStore,
  ) {}

  /** Idempotent: safe to run on every boot. */
  async install(): Promise<void> {
    await this.db.applySchema(PLATFORM_SCHEMA);
    await this.db.transaction(async () => {
      if (!(await this.store.getNamespaceByName(STD_NAMESPACE))) {
        const namespace: Namespace = {
          id: newId(),
          name: STD_NAMESPACE,
          label: 'Standard',
          isSystem: true,
          createdAt: nowIso(),
        };
        await this.store.insertNamespace(namespace);
      }
      if (!(await this.store.getSecurityRoleByName(ADMINISTRATOR_ROLE))) {
        const role: SecurityRole = {
          id: newId(),
          name: ADMINISTRATOR_ROLE,
          // The root of the hierarchy: no parent, ever.
          parentId: null,
          isSystem: true,
          createdAt: nowIso(),
        };
        await this.store.insertSecurityRole(role);
      }
    });
  }

  /** True once at least one user exists. */
  async isSetupComplete(): Promise<boolean> {
    return (await this.store.countUsers()) > 0;
  }

  /**
   * Create the first user. Their role is locked to Administrator -- an
   * installation whose only user could not administer it would be stranded.
   */
  async completeSetup(input: FirstUserInput): Promise<SecurityContext> {
    if (await this.isSetupComplete()) {
      throw new ValidationError('Setup has already been completed');
    }
    const role = await this.store.getSecurityRoleByName(ADMINISTRATOR_ROLE);
    if (!role) throw new ValidationError('Installation is missing the Administrator role');

    const username = input.username.trim();
    if (username.length < 3) {
      throw new ValidationError('Username must be at least 3 characters');
    }
    if (input.password.length < 8) {
      throw new ValidationError('Password must be at least 8 characters');
    }

    const user: User = {
      id: newId(),
      username,
      email: input.email.trim(),
      passwordHash: hashPassword(input.password),
      securityRoleId: role.id,
      isActive: true,
      createdAt: nowIso(),
    };
    await this.store.transaction(async () => {
      await this.store.insertUser(user);
    });
    return createContext(user, role);
  }
}
