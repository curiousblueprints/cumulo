import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Application } from '../src/app/Application.js';
import { LEGACY_SECURITY_RULE_FIELD, T } from '../src/db/index.js';
import { NAME_FIELD } from '../src/domain/types.js';
import { AccessType, FieldAccess, FieldType, STD_NAMESPACE } from '../src/domain/types.js';

/**
 * The rename from `securityRuleField` to `securityRuleFieldGrant` is the one
 * change so far that `applySchema` cannot make on its own, so it gets its own
 * check -- against a real installation rewound to the old shape, so the grant
 * rows point at a rule and a field that genuinely exist.
 */
test('an installation predating the rename keeps its field grants', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cumulo-migration-'));
  const file = join(directory, 'legacy.db');

  try {
    // 1. Build a normal installation with a rule that grants a field.
    const app = await Application.start({ database: { driver: 'sqlite', file } });
    const admin = await app.install.completeSetup({
      username: 'root',
      email: 'r@e.com',
      password: 'correct horse',
    });
    const std = (await app.metadata.listNamespaces(admin)).find(
      (namespace) => namespace.name === STD_NAMESPACE,
    );
    assert.ok(std);
    const table = await app.metadata.createTable(admin, { namespaceId: std.id, name: 'Invoice' });
    const amount = await app.metadata.createField(admin, {
      tableId: table.id,
      name: 'amount',
      type: FieldType.Number,
    });
    const role = await app.metadata.createSecurityRole(admin, {
      name: 'Sales',
      parentId: admin.role.id,
    });
    const rule = await app.metadata.createSecurityRule(admin, {
      name: 'All invoices',
      tableId: table.id,
      accessTypes: [AccessType.Read, AccessType.Edit],
      fieldGrants: [{ fieldId: amount.id, access: FieldAccess.Edit }],
    });
    await app.metadata.assignRuleToRole(admin, role.id, rule.id);
    // A second rule that grants only reading. Its grant must not come back
    // editable, or the migration would hand it access the rule never had.
    const readOnly = await app.metadata.createSecurityRule(admin, {
      name: 'Glance at invoices',
      tableId: table.id,
      accessTypes: [AccessType.Read],
      fieldGrants: [{ fieldId: amount.id, access: FieldAccess.Read }],
    });
    await app.metadata.assignRuleToRole(admin, role.id, readOnly.id);
    await app.metadata.createUser(admin, {
      username: 'sally',
      email: 's@e.com',
      password: 'password123',
      securityRoleId: role.id,
    });
    await app.records.create(admin, table.id, { name: 'Rec 45', amount: 10 });
    await app.stop();

    // 2. Rewind the database to the old shape: the junction under its old
    //    name, with no access column.
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE "${LEGACY_SECURITY_RULE_FIELD}" (
      "id" TEXT PRIMARY KEY,
      "securityRuleId" TEXT NOT NULL,
      "fieldId" TEXT NOT NULL,
      "createdAt" TEXT NOT NULL
    )`);
    raw.exec(`INSERT INTO "${LEGACY_SECURITY_RULE_FIELD}"
      SELECT "id", "securityRuleId", "fieldId", "createdAt" FROM "${T.securityRuleFieldGrant}"`);
    raw.exec(`DROP TABLE "${T.securityRuleFieldGrant}"`);
    // A genuine installation from before the rename has no ledger either --
    // the table did not exist yet -- so forget that the migrations ran.
    raw.exec(`DELETE FROM "${T.schemaMigration}"`);
    const legacyRows = raw.prepare(`SELECT * FROM "${LEGACY_SECURITY_RULE_FIELD}"`).all();
    assert.equal(legacyRows.length, 2);
    raw.close();

    // 3. Booting the current code carries them forward.
    const migrated = await Application.start({ database: { driver: 'sqlite', file } });
    const grants = await migrated.database.find(T.securityRuleFieldGrant);
    assert.equal(grants.length, 2);
    for (const grant of grants) {
      assert.equal(grant['fieldId'], amount.id);
    }
    const byRule = new Map(grants.map((grant) => [grant['securityRuleId'], grant]));
    assert.equal(byRule.get(rule.id)?.['createdAt'], legacyRows[0]?.['createdAt']);

    // The old rows had no level, so each takes the level its own rule
    // justifies: never more than the rule's own access to the table.
    assert.equal(byRule.get(rule.id)?.['access'], FieldAccess.Edit);
    assert.equal(byRule.get(readOnly.id)?.['access'], FieldAccess.Read);
    assert.equal(await migrated.database.hasTable(LEGACY_SECURITY_RULE_FIELD), false);

    // The role still works exactly as it did before the rename.
    const sally = await migrated.auth.authenticate('sally', 'password123');
    const records = await migrated.records.list(sally, table.id);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.values['amount'], 10);
    const updated = await migrated.records.update(sally, records[0]?.id ?? '', { amount: 42 });
    assert.equal(updated.values['amount'], 42);
    await migrated.stop();

    // 4. Booting again over the migrated database is a no-op.
    const again = await Application.start({ database: { driver: 'sqlite', file } });
    assert.equal((await again.database.find(T.securityRuleFieldGrant)).length, 2);
    await again.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A column added to an existing table arrives holding its type's zero value,
 * which is not always what the code that added it would have written. For
 * `isSearchable` on a Name field that zero was false, which turned global
 * search off entirely on any installation upgraded across that point --
 * search looks at Name by default, so nothing matched anything.
 */
test('Name fields keep searching after the isSearchable column is added', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cumulo-searchable-'));
  const file = join(directory, 'legacy.db');

  try {
    const app = await Application.start({ database: { driver: 'sqlite', file } });
    const admin = await app.install.completeSetup({
      username: 'root',
      email: 'r@e.com',
      password: 'correct horse',
    });
    const std = (await app.metadata.listNamespaces(admin)).find(
      (namespace) => namespace.name === STD_NAMESPACE,
    );
    assert.ok(std);
    const table = await app.metadata.createTable(admin, { namespaceId: std.id, name: 'Account' });
    await app.records.create(admin, table.id, { name: 'Acme Industrial' });
    assert.equal((await app.security.search(admin, 'Acme')).length, 1);
    await app.stop();

    // Rewind to before the column existed, and forget that the migrations ran.
    const raw = new DatabaseSync(file);
    raw.exec(`ALTER TABLE "${T.field}" DROP COLUMN "isSearchable"`);
    raw.exec(`DELETE FROM "${T.schemaMigration}"`);
    raw.close();

    // Booting the current code adds the column back -- holding false -- and
    // the migration has to put it right, or search finds nothing.
    const upgraded = await Application.start({ database: { driver: 'sqlite', file } });
    const context = await upgraded.auth.authenticate('root', 'correct horse');
    const name = (await upgraded.security.listAllFields(context, table.id)).find(
      (field) => field.name === NAME_FIELD,
    );
    assert.equal(name?.isSearchable, true);
    assert.equal((await upgraded.security.search(context, 'Acme')).length, 1);
    assert.equal((await upgraded.security.search(context, 'Acme Industrial')).length, 1);
    await upgraded.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a migration runs once, and does not undo what was decided afterwards', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cumulo-once-'));
  const file = join(directory, 'once.db');

  try {
    const app = await Application.start({ database: { driver: 'sqlite', file } });
    const admin = await app.install.completeSetup({
      username: 'root',
      email: 'r@e.com',
      password: 'correct horse',
    });
    const std = (await app.metadata.listNamespaces(admin)).find(
      (namespace) => namespace.name === STD_NAMESPACE,
    );
    assert.ok(std);
    const table = await app.metadata.createTable(admin, { namespaceId: std.id, name: 'Account' });
    const notes = await app.metadata.createField(admin, {
      tableId: table.id,
      name: 'notes',
      type: FieldType.Text,
      isSearchable: true,
    });

    const applied = (await app.database.find(T.schemaMigration)).map((row) => String(row['id']));
    assert.ok(applied.includes('003-name-fields-are-searchable'));

    // The administrator decides this field should not be searched after all.
    await app.metadata.setFieldSearchable(admin, notes.id, false);
    await app.stop();

    // A restart must leave that alone. Being idempotent is not the same as
    // being safe to repeat: re-running would quietly overrule them.
    const again = await Application.start({ database: { driver: 'sqlite', file } });
    const context = await again.auth.authenticate('root', 'correct horse');
    const after = (await again.security.listAllFields(context, table.id)).find(
      (field) => field.name === 'notes',
    );
    assert.equal(after?.isSearchable, false);
    assert.equal(
      (await again.database.find(T.schemaMigration)).length,
      applied.length,
      'no migration should have been recorded twice',
    );
    await again.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
