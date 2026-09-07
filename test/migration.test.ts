import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Application } from '../src/app/Application.js';
import { LEGACY_SECURITY_RULE_FIELD, T } from '../src/db/index.js';
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
    await app.metadata.createUser(admin, {
      username: 'sally',
      email: 's@e.com',
      password: 'password123',
      securityRoleId: role.id,
    });
    await app.records.create(admin, table.id, { amount: 10 });
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
    const legacyRows = raw.prepare(`SELECT * FROM "${LEGACY_SECURITY_RULE_FIELD}"`).all();
    assert.equal(legacyRows.length, 1);
    raw.close();

    // 3. Booting the current code carries them forward.
    const migrated = await Application.start({ database: { driver: 'sqlite', file } });
    const grants = await migrated.database.find(T.securityRuleFieldGrant);
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.['id'], legacyRows[0]?.['id']);
    assert.equal(grants[0]?.['fieldId'], amount.id);
    assert.equal(grants[0]?.['createdAt'], legacyRows[0]?.['createdAt']);
    // Old rows granted a field at whatever the rule allowed, so they arrive
    // editable: the reading that leaves existing behaviour unchanged.
    assert.equal(grants[0]?.['access'], FieldAccess.Edit);
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
    assert.equal((await again.database.find(T.securityRuleFieldGrant)).length, 1);
    await again.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
