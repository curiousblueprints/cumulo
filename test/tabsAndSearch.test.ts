import assert from 'node:assert/strict';
import test from 'node:test';
import { Application } from '../src/app/Application.js';
import {
  AccessType,
  ClauseOperator,
  FieldAccess,
  FieldType,
  STD_NAMESPACE,
  type Id,
} from '../src/domain/types.js';
import type { SecurityContext } from '../src/security/context.js';
import { ValidationError } from '../src/security/errors.js';

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

async function nameFieldOf(app: Application, admin: SecurityContext, tableId: Id) {
  const field = (await app.security.listAllFields(admin, tableId)).find(
    (candidate) => candidate.name === 'name',
  );
  assert.ok(field);
  return field;
}

// --- tabs ----------------------------------------------------------------

test('a role shows the tabs it is given, in the order it is given them', async () => {
  const { app, admin, std } = await installed();
  const tables = [];
  for (const name of ['Account', 'Contact', 'Invoice']) {
    tables.push(await app.metadata.createTable(admin, { namespaceId: std, name }));
  }
  const [account, contact, invoice] = tables;
  assert.ok(account && contact && invoice);

  // Nothing is on the bar until it is put there, even for Administrator.
  assert.deepEqual(await app.security.listTabs(admin), []);

  for (const table of [invoice, account]) {
    await app.metadata.addRoleTab(admin, admin.role.id, table.id);
  }
  assert.deepEqual(
    (await app.security.listTabs(admin)).map((table) => table.name),
    ['Invoice', 'Account'],
  );

  // Adding the same table again is not an error and does not duplicate it.
  const repeat = await app.metadata.addRoleTab(admin, admin.role.id, invoice.id);
  assert.equal(repeat.created, false);
  assert.equal((await app.security.listTabs(admin)).length, 2);

  await app.metadata.addRoleTab(admin, admin.role.id, contact.id);
  assert.deepEqual(
    (await app.security.listTabs(admin)).map((table) => table.name),
    ['Invoice', 'Account', 'Contact'],
  );
  await app.stop();
});

test('tabs can be reordered and removed', async () => {
  const { app, admin, std } = await installed();
  const names = ['Account', 'Contact', 'Invoice'];
  for (const name of names) {
    const table = await app.metadata.createTable(admin, { namespaceId: std, name });
    await app.metadata.addRoleTab(admin, admin.role.id, table.id);
  }
  const order = async (): Promise<string[]> =>
    (await app.security.listTabs(admin)).map((table) => table.name);
  assert.deepEqual(await order(), names);

  const tabs = await app.metadata.listRoleTabs(admin, admin.role.id);
  const invoice = tabs.find((entry) => entry.table.name === 'Invoice');
  assert.ok(invoice);

  await app.metadata.moveRoleTab(admin, invoice.tab.id, 'earlier');
  assert.deepEqual(await order(), ['Account', 'Invoice', 'Contact']);
  await app.metadata.moveRoleTab(admin, invoice.tab.id, 'earlier');
  assert.deepEqual(await order(), ['Invoice', 'Account', 'Contact']);
  // Already first: moving further is a no-op rather than an error.
  await app.metadata.moveRoleTab(admin, invoice.tab.id, 'earlier');
  assert.deepEqual(await order(), ['Invoice', 'Account', 'Contact']);
  await app.metadata.moveRoleTab(admin, invoice.tab.id, 'later');
  assert.deepEqual(await order(), ['Account', 'Invoice', 'Contact']);

  await app.metadata.removeRoleTab(admin, invoice.tab.id);
  assert.deepEqual(await order(), ['Account', 'Contact']);
  await assert.rejects(
    () => app.metadata.removeRoleTab(admin, invoice.tab.id),
    ValidationError,
  );
  await app.stop();
});

test('tabs belong to one role and are inherited in neither direction', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Account' });
  const nameField = await nameFieldOf(app, admin, table.id);

  const manager = await app.metadata.createSecurityRole(admin, {
    name: 'Manager',
    parentId: admin.role.id,
  });
  const rep = await app.metadata.createSecurityRole(admin, { name: 'Rep', parentId: manager.id });

  // Both roles can reach the table, so visibility is not what differs here.
  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'Read accounts',
    tableId: table.id,
    accessTypes: [AccessType.Read],
    fieldGrants: [{ fieldId: nameField.id, access: FieldAccess.Read }],
  });
  for (const role of [manager, rep]) {
    await app.metadata.assignRuleToRole(admin, role.id, rule.id);
    await app.metadata.createUser(admin, {
      username: role.name.toLowerCase() + 'user',
      email: `${role.name}@example.com`,
      password: 'password123',
      securityRoleId: role.id,
    });
  }

  // The tab is given to the child only.
  await app.metadata.addRoleTab(admin, rep.id, table.id);

  const repUser = await app.auth.authenticate('repuser', 'password123');
  const managerUser = await app.auth.authenticate('manageruser', 'password123');

  assert.deepEqual(
    (await app.security.listTabs(repUser)).map((t) => t.name),
    ['Account'],
  );
  // Rules roll up to the parent; tabs do not.
  assert.deepEqual(await app.security.listTabs(managerUser), []);
  assert.deepEqual(await app.security.listTabs(admin), []);
  // Yet the manager can still reach the table -- it is simply not on their bar.
  assert.equal((await app.metadata.listTables(managerUser)).length, 1);
  await app.stop();
});

test('a tab for a table the role cannot reach is not shown', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Account' });
  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Newcomers',
    parentId: admin.role.id,
  });
  await app.metadata.addRoleTab(admin, role.id, table.id);
  await app.metadata.createUser(admin, {
    username: 'newcomer',
    email: 'n@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });

  // The tab exists, but no rule lets this role see the table, so the bar is
  // empty rather than offering a tab that leads nowhere.
  const newcomer = await app.auth.authenticate('newcomer', 'password123');
  assert.equal((await app.metadata.listRoleTabs(admin, role.id)).length, 1);
  assert.deepEqual(await app.security.listTabs(newcomer), []);
  await app.stop();
});

// --- global search --------------------------------------------------------

test('search looks at Name without being asked, and at nothing else by default', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Account' });
  await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'notes',
    type: FieldType.Text,
  });
  const acme = await app.records.create(admin, table.id, {
    name: 'Acme Industrial',
    notes: 'introduced by Widgets Ltd',
  });
  await app.records.create(admin, table.id, { name: 'Globex', notes: 'no relation' });

  const byName = await app.security.search(admin, 'acme');
  assert.deepEqual(
    byName.map((hit) => hit.record.id),
    [acme.id],
  );
  assert.equal(byName[0]?.field.name, 'name');
  assert.equal(byName[0]?.table.name, 'Account');
  assert.equal(byName[0]?.label, 'Acme Industrial');

  // `notes` is not searchable, so a match in it returns nothing.
  assert.deepEqual(await app.security.search(admin, 'Widgets'), []);

  await app.metadata.setFieldSearchable(
    admin,
    (await app.security.listAllFields(admin, table.id)).find((f) => f.name === 'notes')?.id ?? '',
    true,
  );
  const byNotes = await app.security.search(admin, 'Widgets');
  assert.deepEqual(
    byNotes.map((hit) => hit.record.id),
    [acme.id],
  );
  assert.equal(byNotes[0]?.field.name, 'notes');
  // A hit found through another field is still titled by the record's Name.
  assert.equal(byNotes[0]?.label, 'Acme Industrial');
  await app.stop();
});

test('search spans tables and is case insensitive', async () => {
  const { app, admin, std } = await installed();
  const account = await app.metadata.createTable(admin, { namespaceId: std, name: 'Account' });
  const contact = await app.metadata.createTable(admin, { namespaceId: std, name: 'Contact' });
  await app.records.create(admin, account.id, { name: 'Northwind Traders' });
  await app.records.create(admin, contact.id, { name: 'Ada Northwind' });
  await app.records.create(admin, contact.id, { name: 'Someone Else' });

  const hits = await app.security.search(admin, 'NORTHWIND');
  assert.equal(hits.length, 2);
  assert.deepEqual(
    [...new Set(hits.map((hit) => hit.table.name))].sort(),
    ['Account', 'Contact'],
  );
  assert.deepEqual(await app.security.search(admin, '   '), []);
  await app.stop();
});

test('search cannot surface a record or a field the caller may not read', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Invoice' });
  const owner = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'owner',
    type: FieldType.Text,
    isSearchable: true,
  });
  const secret = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'secret',
    type: FieldType.Text,
    isSearchable: true,
  });
  const nameField = await nameFieldOf(app, admin, table.id);

  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Sales',
    parentId: admin.role.id,
  });
  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'Own invoices',
    tableId: table.id,
    accessTypes: [AccessType.Read],
    clauses: [{ fieldId: owner.id, operator: ClauseOperator.Equals, targetValue: '$user.username' }],
    // `secret` is searchable but not granted, so it can never produce a hit.
    fieldGrants: [
      { fieldId: nameField.id, access: FieldAccess.Read },
      { fieldId: owner.id, access: FieldAccess.Read },
    ],
  });
  await app.metadata.assignRuleToRole(admin, role.id, rule.id);
  await app.metadata.createUser(admin, {
    username: 'sally',
    email: 's@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });

  const mine = await app.records.create(admin, table.id, {
    name: 'Ledger entry',
    owner: 'sally',
    secret: 'ledger detail',
  });
  await app.records.create(admin, table.id, {
    name: 'Ledger entry',
    owner: 'root',
    secret: 'ledger detail',
  });

  const sally = await app.auth.authenticate('sally', 'password123');

  // The clause keeps the other record out, even though its Name matches.
  const byName = await app.security.search(sally, 'Ledger entry');
  assert.deepEqual(
    byName.map((hit) => hit.record.id),
    [mine.id],
  );
  assert.equal(byName[0]?.label, 'Ledger entry');

  // A field she cannot read produces no hit, on her own record or anyone's.
  assert.deepEqual(await app.security.search(sally, 'ledger detail'), []);
  // The administrator, who reads everything, sees both.
  assert.equal((await app.security.search(admin, 'ledger detail')).length, 2);
  await app.stop();
});

test('search treats % and _ as characters, not wildcards', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Offer' });
  const half = await app.records.create(admin, table.id, { name: '50% off everything' });
  await app.records.create(admin, table.id, { name: 'No discount' });

  assert.deepEqual(
    (await app.security.search(admin, '50%')).map((hit) => hit.record.id),
    [half.id],
  );
  // A bare "%" finds records containing a percent sign -- not every record,
  // which is what it would mean if it were still a wildcard.
  assert.deepEqual(
    (await app.security.search(admin, '%')).map((hit) => hit.record.id),
    [half.id],
  );
  // Likewise "_" matches an underscore, and nothing here has one.
  assert.deepEqual(await app.security.search(admin, '_'), []);
  await app.stop();
});

test('the tabs the client is given are the ones it lands on', async () => {
  const { app, admin, std } = await installed();
  // The client sends /app to the first tab, so the order the API reports is
  // also which table a user sees when they sign in.
  const contact = await app.metadata.createTable(admin, { namespaceId: std, name: 'Contact' });
  const account = await app.metadata.createTable(admin, { namespaceId: std, name: 'Account' });

  await app.metadata.addRoleTab(admin, admin.role.id, contact.id);
  await app.metadata.addRoleTab(admin, admin.role.id, account.id);
  assert.equal((await app.security.listTabs(admin))[0]?.name, 'Contact');

  const tabs = await app.metadata.listRoleTabs(admin, admin.role.id);
  const accountTab = tabs.find((entry) => entry.table.id === account.id);
  assert.ok(accountTab);
  await app.metadata.moveRoleTab(admin, accountTab.tab.id, 'earlier');
  assert.equal((await app.security.listTabs(admin))[0]?.name, 'Account');
  await app.stop();
});
