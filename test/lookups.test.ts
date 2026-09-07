import assert from 'node:assert/strict';
import test from 'node:test';
import { Application } from '../src/app/Application.js';
import { AccessType, FieldAccess, FieldType, STD_NAMESPACE, type Id } from '../src/domain/types.js';
import type { SecurityContext } from '../src/security/context.js';
import { ValidationError } from '../src/security/errors.js';

/** The Name field every table is created with. */
async function nameField(
  app: Application,
  admin: SecurityContext,
  tableId: Id,
): Promise<{ id: Id; name: string }> {
  const field = (await app.security.listAllFields(admin, tableId)).find(
    (candidate) => candidate.name === 'name',
  );
  assert.ok(field, 'every table is created with a Name field');
  return field;
}

async function installed(): Promise<{ app: Application; admin: SecurityContext; std: Id }> {
  const app = await Application.start({ database: { driver: 'sqlite', file: ':memory:' } });
  const admin = await app.install.completeSetup({
    username: 'root',
    email: 'root@example.com',
    password: 'correct horse',
  });
  const std = (await app.metadata.listNamespaces(admin)).find(
    (namespace) => namespace.name === STD_NAMESPACE,
  );
  assert.ok(std);
  return { app, admin, std: std.id };
}

test('a lookup field points a record at a record in another table', async () => {
  const { app, admin, std } = await installed();
  const account = await app.metadata.createTable(admin, { namespaceId: std, name: 'Account' });
  const contact = await app.metadata.createTable(admin, { namespaceId: std, name: 'Contact' });
  const accountLookup = await app.metadata.createField(admin, {
    tableId: contact.id,
    name: 'account',
    type: FieldType.Reference,
    referenceTableId: account.id,
  });
  assert.equal(accountLookup.referenceTableId, account.id);

  const acme = await app.records.create(admin, account.id, { name: 'Acme' });
  const ada = await app.records.create(admin, contact.id, { name: 'Ada', account: acme.id });
  assert.equal(ada.values['account'], acme.id);

  // The target has to exist, and has to be in the looked-up table.
  await assert.rejects(
    () => app.records.create(admin, contact.id, { name: 'Bad', account: 'nope' }),
    ValidationError,
  );
  await assert.rejects(
    () => app.records.create(admin, contact.id, { name: 'Bad', account: ada.id }),
    ValidationError,
  );
  await app.stop();
});

test('a lookup can point at its own table, giving a hierarchy', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Department' });
  await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'parent',
    type: FieldType.Reference,
    referenceTableId: table.id,
  });

  const root = await app.records.create(admin, table.id, { name: 'All' });
  const sales = await app.records.create(admin, table.id, { name: 'Sales', parent: root.id });
  const emea = await app.records.create(admin, table.id, { name: 'EMEA', parent: sales.id });
  assert.equal(emea.values['parent'], sales.id);

  // A record cannot be its own parent, nor its own ancestor.
  await assert.rejects(
    () => app.records.update(admin, sales.id, { parent: sales.id }),
    ValidationError,
  );
  await assert.rejects(
    () => app.records.update(admin, root.id, { parent: emea.id }),
    ValidationError,
  );
  // Re-parenting that does not close a loop is fine.
  const moved = await app.records.update(admin, emea.id, { parent: root.id });
  assert.equal(moved.values['parent'], root.id);
  await app.stop();
});

test('a self lookup cannot be required', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Node' });
  await assert.rejects(
    () =>
      app.metadata.createField(admin, {
        tableId: table.id,
        name: 'parent',
        type: FieldType.Reference,
        referenceTableId: table.id,
        isRequired: true,
      }),
    ValidationError,
  );
  await app.stop();
});

test('a lookup field must name a table, and only a lookup may', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Thing' });
  await assert.rejects(
    () => app.metadata.createField(admin, { tableId: table.id, name: 'a', type: FieldType.Reference }),
    ValidationError,
  );
  await assert.rejects(
    () =>
      app.metadata.createField(admin, {
        tableId: table.id,
        name: 'b',
        type: FieldType.Reference,
        referenceTableId: 'no-such-table',
      }),
    ValidationError,
  );
  await assert.rejects(
    () =>
      app.metadata.createField(admin, {
        tableId: table.id,
        name: 'c',
        type: FieldType.Text,
        referenceTableId: table.id,
      }),
    ValidationError,
  );
  await app.stop();
});

test('deleting a looked-up record clears the lookups, not the records', async () => {
  const { app, admin, std } = await installed();
  const account = await app.metadata.createTable(admin, { namespaceId: std, name: 'Account' });
  const contact = await app.metadata.createTable(admin, { namespaceId: std, name: 'Contact' });
  await app.metadata.createField(admin, {
    tableId: contact.id,
    name: 'account',
    type: FieldType.Reference,
    referenceTableId: account.id,
  });

  const acme = await app.records.create(admin, account.id, { name: 'Acme' });
  const ada = await app.records.create(admin, contact.id, { name: 'Ada', account: acme.id });
  const grace = await app.records.create(admin, contact.id, { name: 'Grace', account: acme.id });

  await app.records.delete(admin, acme.id);

  // These are lookups, not master-detail: the children survive, emptied.
  const survivors = await app.records.list(admin, contact.id);
  assert.deepEqual(survivors.map((record) => record.id).sort(), [ada.id, grace.id].sort());
  for (const record of survivors) {
    assert.equal(record.values['account'], null);
    assert.equal(record.values['name'] === 'Ada' || record.values['name'] === 'Grace', true);
  }
  await app.stop();
});

test('deleting a record in a hierarchy detaches its children', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Department' });
  await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'parent',
    type: FieldType.Reference,
    referenceTableId: table.id,
  });

  const root = await app.records.create(admin, table.id, { name: 'All' });
  const child = await app.records.create(admin, table.id, { name: 'Sales', parent: root.id });
  await app.records.delete(admin, root.id);

  const remaining = await app.records.list(admin, table.id);
  assert.deepEqual(
    remaining.map((record) => record.id),
    [child.id],
  );
  assert.equal(remaining[0]?.values['parent'], null);
  await app.stop();
});

test('a lookup can only be set to a record the user is allowed to see', async () => {
  const { app, admin, std } = await installed();
  const account = await app.metadata.createTable(admin, { namespaceId: std, name: 'Account' });
  const accountName = await nameField(app, admin, account.id);
  const contact = await app.metadata.createTable(admin, { namespaceId: std, name: 'Contact' });
  const contactName = await nameField(app, admin, contact.id);
  const lookup = await app.metadata.createField(admin, {
    tableId: contact.id,
    name: 'account',
    type: FieldType.Reference,
    referenceTableId: account.id,
  });

  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Reps',
    parentId: admin.role.id,
  });
  for (const rule of [
    {
      name: 'Accounts',
      tableId: account.id,
      accessTypes: [AccessType.Read],
      fieldGrants: [{ fieldId: accountName.id, access: FieldAccess.Read }],
    },
    {
      name: 'Contacts',
      tableId: contact.id,
      accessTypes: [AccessType.Read],
      canCreate: true,
      fieldGrants: [{ fieldId: contactName.id, access: FieldAccess.Edit }, { fieldId: lookup.id, access: FieldAccess.Edit }],
    },
  ]) {
    const created = await app.metadata.createSecurityRule(admin, rule);
    await app.metadata.assignRuleToRole(admin, role.id, created.id);
  }
  await app.metadata.createUser(admin, {
    username: 'rep',
    email: 'rep@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });

  const acme = await app.records.create(admin, account.id, { name: 'Acme' });
  const rep = await app.auth.authenticate('rep', 'password123');
  const created = await app.records.create(rep, contact.id, { name: 'Ada', account: acme.id });
  assert.equal(created.values['account'], acme.id);
  await app.stop();
});
