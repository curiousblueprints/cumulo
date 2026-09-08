import {
  LEGACY_FIELD_NAME_INDEX,
  LEGACY_SECURITY_RULE_FIELD,
  PLATFORM_SCHEMA,
  T,
} from '../db/schema.js';
import type { DatabaseAdapter } from '../db/types.js';
import {
  AccessType,
  ADMINISTRATOR_ROLE,
  FieldAccess,
  FieldType,
  NAME_FIELD,
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
    await this.runMigrations();
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

  /**
   * Data migrations, in order, each run at most once.
   *
   * `applySchema` adds tables and columns, but a new column arrives holding
   * its type's zero value, which is not always what the code that added it
   * would have written. Those gaps are closed here.
   *
   * Once run, a migration must not run again: an administrator may since have
   * changed what it set, and a second pass would quietly undo them. That is
   * what the ledger is for -- being idempotent is not the same as being
   * repeatable without harm.
   *
   * Ids are permanent. Rename one and it runs a second time.
   */
  private migrations(): { id: string; run: () => Promise<void> }[] {
    return [
      { id: '001-field-grants-from-legacy-table', run: () => this.carryForwardFieldGrants() },
      { id: '002-name-field-for-existing-tables', run: () => this.addMissingNameFields() },
      { id: '003-name-fields-are-searchable', run: () => this.makeNameFieldsSearchable() },
      {
        id: '004-field-names-unique-per-namespace',
        run: () => this.db.dropIndex(LEGACY_FIELD_NAME_INDEX),
      },
    ];
  }

  private async runMigrations(): Promise<void> {
    const applied = new Set(
      (await this.db.find(T.schemaMigration)).map((row) => String(row['id'])),
    );
    for (const migration of this.migrations()) {
      if (applied.has(migration.id)) continue;
      await migration.run();
      await this.db.insert(T.schemaMigration, {
        id: migration.id,
        appliedAt: nowIso(),
      });
    }
  }

  /**
   * A table's Name field is searchable from the moment it is created, but the
   * `isSearchable` column arrived after some of those fields did, and a column
   * is added holding false. Installations upgraded across that point had Name
   * fields that global search would not look at -- which, since Name is what
   * search looks at by default, meant it found nothing at all.
   *
   * Only system Name fields are touched. A field an administrator created and
   * happened to call `name` is theirs to decide about.
   */
  private async makeNameFieldsSearchable(): Promise<void> {
    const stale = await this.db.find(T.field, {
      where: [
        { column: 'name', operator: 'eq', value: NAME_FIELD },
        { column: 'isSystem', operator: 'eq', value: true },
        { column: 'isSearchable', operator: 'eq', value: false },
      ],
    });
    await this.db.transaction(async () => {
      for (const row of stale) {
        await this.db.update(T.field, row['id'] as string, { isSearchable: true });
      }
    });
  }

  /**
   * `securityRuleField` became `securityRuleFieldGrant`, which carries an
   * access level per field.
   *
   * The old rows had no level: a granted field was writable exactly when its
   * rule allowed writing. So each row comes across at the level its own rule
   * justifies -- editable where the rule grants edit or create, read-only
   * otherwise. That preserves the behaviour these installations already had
   * and keeps the invariant true in the data: a field grant never exceeds its
   * rule's access to the table.
   *
   * `applySchema` only ever adds, so a rename needs this explicit step.
   */
  private async carryForwardFieldGrants(): Promise<void> {
    if (!(await this.db.hasTable(LEGACY_SECURITY_RULE_FIELD))) return;
    await this.db.transaction(async () => {
      if ((await this.db.count(T.securityRuleFieldGrant)) === 0) {
        const writesFor = await this.rulesThatAllowWriting();
        for (const row of await this.db.find(LEGACY_SECURITY_RULE_FIELD)) {
          const securityRuleId = String(row['securityRuleId'] ?? '');
          await this.db.insert(T.securityRuleFieldGrant, {
            id: row['id'] ?? newId(),
            securityRuleId,
            fieldId: row['fieldId'] ?? '',
            access: writesFor.has(securityRuleId) ? FieldAccess.Edit : FieldAccess.Read,
            createdAt: row['createdAt'] ?? nowIso(),
          });
        }
      }
      await this.db.dropTable(LEGACY_SECURITY_RULE_FIELD);
    });
  }

  /**
   * Every table has a Name field. Tables created before that was true get one
   * now, as free text -- an auto number would have to invent values for
   * records that already exist.
   *
   * It is required, as a free-text name is anywhere else. Records that predate
   * it keep their empty name until something writes one: an update only checks
   * the fields it is actually setting.
   *
   * A table that already has a field called `name` is left alone: it is doing
   * the job, and renaming someone's field out from under them would be worse
   * than not marking it as a system field.
   */
  private async addMissingNameFields(): Promise<void> {
    for (const table of await this.store.listTables()) {
      const fields = await this.store.listFields(table.id);
      if (fields.some((field) => field.name === NAME_FIELD)) continue;
      await this.store.transaction(async () => {
        await this.store.insertField({
          id: newId(),
          namespaceId: table.namespaceId,
          tableId: table.id,
          name: NAME_FIELD,
          label: 'Name',
          type: FieldType.Text,
          isRequired: true,
          referenceTableId: null,
          isSearchable: true,
          isSystem: true,
          autoNumberNext: 1,
          createdAt: nowIso(),
        });
      });
    }
  }

  /** Ids of the rules that permit writing at all, by edit or by create. */
  private async rulesThatAllowWriting(): Promise<Set<string>> {
    const writing = new Set<string>();
    for (const rule of await this.db.find(T.securityRule)) {
      const accessTypes = String(rule['accessTypes'] ?? '')
        .split(',')
        .map((part) => part.trim());
      const canCreate = rule['canCreate'] === true || rule['canCreate'] === 1;
      if (canCreate || accessTypes.includes(AccessType.Edit)) {
        writing.add(String(rule['id'] ?? ''));
      }
    }
    return writing;
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
