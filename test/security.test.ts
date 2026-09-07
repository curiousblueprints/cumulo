import assert from 'node:assert/strict';
import test from 'node:test';
import { Application } from '../src/app/Application.js';
import {
  AccessType,
  FieldAccess,
  ClauseMatch,
  ClauseOperator,
  FieldType,
  STD_NAMESPACE,
  type Id,
} from '../src/domain/types.js';
import type { SecurityContext } from '../src/security/context.js';
import { AccessDeniedError, NotFoundError, ValidationError } from '../src/security/errors.js';

async function freshApp(): Promise<Application> {
  return Application.start({ database: { driver: 'sqlite', file: ':memory:' } });
}

/** A fresh install with the first (Administrator) user created. */
async function installed(): Promise<{ app: Application; admin: SecurityContext }> {
  const app = await freshApp();
  const admin = await app.install.completeSetup({
    username: 'root',
    email: 'root@example.com',
    password: 'correct horse',
  });
  return { app, admin };
}

test('a fresh install has exactly the std namespace and the Administrator role', async () => {
  const app = await freshApp();
  assert.equal(await app.install.isSetupComplete(), false);

  const admin = await app.install.completeSetup({
    username: 'root',
    email: 'root@example.com',
    password: 'correct horse',
  });
  assert.equal(admin.role.name, 'Administrator');
  assert.equal(admin.role.parentId, null);
  assert.equal(admin.role.isSystem, true);

  const spaces = await app.metadata.listNamespaces(admin);
  assert.deepEqual(
    spaces.map((n) => n.name),
    [STD_NAMESPACE],
  );
  assert.deepEqual(
    (await app.metadata.listSecurityRoles(admin)).map((r) => r.name),
    ['Administrator'],
  );
  assert.equal((await app.metadata.listTables(admin)).length, 0);
  await app.stop();
});

test('setup can only be completed once', async () => {
  const { app } = await installed();
  await assert.rejects(
    () =>
      app.install.completeSetup({
        username: 'second',
        email: 's@example.com',
        password: 'another one',
      }),
    ValidationError,
  );
  await app.stop();
});

test('authentication produces a usable context and rejects bad credentials', async () => {
  const { app } = await installed();
  const context = await app.auth.authenticate('root', 'correct horse');
  assert.equal(context.user.username, 'root');
  await assert.rejects(() => app.auth.authenticate('root', 'wrong'), AccessDeniedError);
  await assert.rejects(() => app.auth.authenticate('nobody', 'correct horse'), AccessDeniedError);
  await app.stop();
});

/** Builds an Invoice table with a few fields, as the administrator. */
async function invoiceTable(app: Application, admin: SecurityContext) {
  const std = (await app.metadata.listNamespaces(admin)).find((n) => n.name === STD_NAMESPACE);
  assert.ok(std);
  const table = await app.metadata.createTable(admin, {
    namespaceId: std.id,
    name: 'Invoice',
    label: 'Invoice',
  });
  const amount = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'amount',
    type: FieldType.Number,
  });
  const owner = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'owner',
    type: FieldType.Text,
  });
  const secret = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'secret',
    type: FieldType.Text,
  });
  const nameField = (await app.security.listAllFields(admin, table.id)).find(
    (field) => field.name === 'name',
  );
  assert.ok(nameField);
  return { std, table, amount, owner, secret, nameField };
}

test('the Administrator role reads and writes without any rules', async () => {
  const { app, admin } = await installed();
  const { table } = await invoiceTable(app, admin);

  const created = await app.records.create(admin, table.id, {
    name: 'Rec 1',
    amount: 100,
    owner: 'root',
    secret: 'hidden',
  });
  assert.equal(created.values['amount'], 100);

  const all = await app.records.list(admin, table.id);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.values['secret'], 'hidden');

  const updated = await app.records.update(admin, created.id, { amount: 250 });
  assert.equal(updated.values['amount'], 250);

  await app.records.delete(admin, created.id);
  assert.equal((await app.records.list(admin, table.id)).length, 0);
  await app.stop();
});

test('a role with no rules sees nothing', async () => {
  const { app, admin } = await installed();
  const { table } = await invoiceTable(app, admin);
  await app.records.create(admin, table.id, { name: 'Rec 2', amount: 10, owner: 'root', secret: 's' });

  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Empty',
    parentId: admin.role.id,
  });
  await app.metadata.createUser(admin, {
    username: 'nobody',
    email: 'n@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });
  const user = await app.auth.authenticate('nobody', 'password123');

  assert.equal((await app.metadata.listTables(user)).length, 0);
  await assert.rejects(() => app.records.list(user, table.id), AccessDeniedError);
  await app.stop();
});

test('rules gate records by clause and fields by grant', async () => {
  const { app, admin } = await installed();
  const { table, amount, owner } = await invoiceTable(app, admin);

  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Sales',
    parentId: admin.role.id,
  });
  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'Own large invoices',
    tableId: table.id,
    accessTypes: [AccessType.Read],
    clauseMatch: ClauseMatch.All,
    clauses: [
      { fieldId: owner.id, operator: ClauseOperator.Equals, targetValue: '$user.username' },
      { fieldId: amount.id, operator: ClauseOperator.GreaterThan, targetValue: '50' },
    ],
    // `secret` is deliberately left out of the grant.
    fieldGrants: [{ fieldId: amount.id, access: FieldAccess.Read }, { fieldId: owner.id, access: FieldAccess.Read }],
  });
  await app.metadata.assignRuleToRole(admin, role.id, rule.id);
  await app.metadata.createUser(admin, {
    username: 'sally',
    email: 's@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });

  const mine = await app.records.create(admin, table.id, {
    name: 'Rec 3',
    amount: 100,
    owner: 'sally',
    secret: 'hidden',
  });
  const tooSmall = await app.records.create(admin, table.id, {
    name: 'Rec 4',
    amount: 10,
    owner: 'sally',
    secret: 'hidden',
  });
  const someoneElse = await app.records.create(admin, table.id, {
    name: 'Rec 5',
    amount: 900,
    owner: 'root',
    secret: 'hidden',
  });

  const sally = await app.auth.authenticate('sally', 'password123');
  const visible = await app.records.list(sally, table.id);
  assert.deepEqual(
    visible.map((record) => record.id),
    [mine.id],
  );
  // Field-level security: `secret` is not in the projection at all.
  assert.deepEqual(Object.keys(visible[0]?.values ?? {}).sort(), ['amount', 'owner']);
  assert.deepEqual(
    (await app.metadata.listReadableFields(sally, table.id)).map((f) => f.name).sort(),
    ['amount', 'owner'],
  );

  // Records outside the rule are indistinguishable from records that do not exist.
  await assert.rejects(() => app.records.get(sally, tooSmall.id), NotFoundError);
  await assert.rejects(() => app.records.get(sally, someoneElse.id), NotFoundError);

  // Read access is not edit or delete access.
  await assert.rejects(() => app.records.update(sally, mine.id, { amount: 1 }), NotFoundError);
  await assert.rejects(() => app.records.delete(sally, mine.id), NotFoundError);
  await app.stop();
});

test('creating is a table-level grant, separate from edit', async () => {
  const { app, admin } = await installed();
  const { table, amount, owner, secret } = await invoiceTable(app, admin);

  // Edit on your own invoices, but no create.
  const editors = await app.metadata.createSecurityRole(admin, {
    name: 'Editors',
    parentId: admin.role.id,
  });
  const editRule = await app.metadata.createSecurityRule(admin, {
    name: 'Edit own invoices',
    tableId: table.id,
    accessTypes: [AccessType.Read, AccessType.Edit],
    clauses: [{ fieldId: owner.id, operator: ClauseOperator.Equals, targetValue: '$user.username' }],
    fieldGrants: [{ fieldId: amount.id, access: FieldAccess.Edit }, { fieldId: owner.id, access: FieldAccess.Edit }],
  });
  await app.metadata.assignRuleToRole(admin, editors.id, editRule.id);
  await app.metadata.createUser(admin, {
    username: 'eddie',
    email: 'e@example.com',
    password: 'password123',
    securityRoleId: editors.id,
  });
  const eddie = await app.auth.authenticate('eddie', 'password123');

  assert.equal(await app.security.canCreate(eddie, table.id), false);
  await assert.rejects(
    () => app.records.create(eddie, table.id, { name: 'Rec 6', amount: 5, owner: 'eddie' }),
    AccessDeniedError,
  );

  // Editing an existing record it does cover still works.
  const existing = await app.records.create(admin, table.id, { name: 'Rec 7', amount: 5, owner: 'eddie' });
  const updated = await app.records.update(eddie, existing.id, { amount: 42 });
  assert.equal(updated.values['amount'], 42);
  await assert.rejects(
    () => app.records.update(eddie, existing.id, { secret: 'x' }),
    AccessDeniedError,
  );
  await assert.rejects(() => app.records.delete(eddie, existing.id), NotFoundError);
  void secret;
  await app.stop();
});

test('a create grant ignores the clauses but still bounds the fields', async () => {
  const { app, admin } = await installed();
  const { table, amount, owner, secret, nameField } = await invoiceTable(app, admin);

  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Creators',
    parentId: admin.role.id,
  });
  // The clause would exclude everything this role creates, and that is fine:
  // creation is table-level, so the clause only governs reading it back.
  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'Create invoices, read own',
    tableId: table.id,
    accessTypes: [AccessType.Read],
    canCreate: true,
    clauses: [{ fieldId: owner.id, operator: ClauseOperator.Equals, targetValue: '$user.username' }],
    fieldGrants: [
      { fieldId: amount.id, access: FieldAccess.Edit },
      { fieldId: owner.id, access: FieldAccess.Edit },
      // Name is required, so a role that may create has to be able to set it.
      { fieldId: nameField.id, access: FieldAccess.Edit },
    ],
  });
  await app.metadata.assignRuleToRole(admin, role.id, rule.id);
  await app.metadata.createUser(admin, {
    username: 'carla',
    email: 'c@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });
  const carla = await app.auth.authenticate('carla', 'password123');

  assert.equal(await app.security.canCreate(carla, table.id), true);
  assert.deepEqual(
    (await app.security.listCreatableFields(carla, table.id)).map((field) => field.name).sort(),
    ['amount', 'name', 'owner'],
  );

  // A record the rule's clause does not cover can still be created...
  const invisible = await app.records.create(carla, table.id, { name: 'Rec 8', amount: 1, owner: 'someone-else' });
  // ...it just cannot be read back afterwards.
  await assert.rejects(() => app.records.get(carla, invisible.id), NotFoundError);

  const mine = await app.records.create(carla, table.id, { name: 'Rec 9', amount: 2, owner: 'carla' });
  assert.equal((await app.records.get(carla, mine.id)).values['amount'], 2);

  // Fields the rule does not name are still refused on create.
  await assert.rejects(
    () => app.records.create(carla, table.id, { name: 'Rec 10', amount: 3, owner: 'carla', secret: 'x' }),
    AccessDeniedError,
  );

  // Create is not edit: the record it just made is read-only to it.
  await assert.rejects(() => app.records.update(carla, mine.id, { amount: 9 }), NotFoundError);
  await app.stop();
});

test('a rule must grant something', async () => {
  const { app, admin } = await installed();
  const { table } = await invoiceTable(app, admin);
  await assert.rejects(
    () =>
      app.metadata.createSecurityRule(admin, {
        name: 'Grants nothing',
        tableId: table.id,
        accessTypes: [],
      }),
    ValidationError,
  );
  // Create alone is enough.
  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'Create only',
    tableId: table.id,
    accessTypes: [],
    canCreate: true,
  });
  assert.equal(rule.canCreate, true);
  assert.deepEqual(rule.accessTypes, []);
  await app.stop();
});

test('a role encompasses the access of the roles beneath it', async () => {
  const { app, admin } = await installed();
  const { table, amount, owner } = await invoiceTable(app, admin);

  const manager = await app.metadata.createSecurityRole(admin, {
    name: 'Manager',
    parentId: admin.role.id,
  });
  const rep = await app.metadata.createSecurityRole(admin, {
    name: 'Rep',
    parentId: manager.id,
  });

  // The rule belongs to the child role only.
  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'All invoices',
    tableId: table.id,
    accessTypes: [AccessType.Read],
    fieldGrants: [{ fieldId: amount.id, access: FieldAccess.Read }, { fieldId: owner.id, access: FieldAccess.Read }],
  });
  await app.metadata.assignRuleToRole(admin, rep.id, rule.id);

  for (const [username, roleId] of [
    ['mandy', manager.id],
    ['ricky', rep.id],
  ] as const) {
    await app.metadata.createUser(admin, {
      username,
      email: `${username}@example.com`,
      password: 'password123',
      securityRoleId: roleId,
    });
  }
  await app.records.create(admin, table.id, { name: 'Rec 11', amount: 7, owner: 'root', secret: 's' });

  const ricky = await app.auth.authenticate('ricky', 'password123');
  const mandy = await app.auth.authenticate('mandy', 'password123');

  // The child holds the rule; the parent inherits it upward.
  assert.equal((await app.records.list(ricky, table.id)).length, 1);
  assert.equal((await app.records.list(mandy, table.id)).length, 1);

  // ...but not downward: a sibling under Manager sees nothing.
  const sibling = await app.metadata.createSecurityRole(admin, {
    name: 'Intern',
    parentId: manager.id,
  });
  await app.metadata.createUser(admin, {
    username: 'iris',
    email: 'i@example.com',
    password: 'password123',
    securityRoleId: sibling.id,
  });
  const iris = await app.auth.authenticate('iris', 'password123');
  await assert.rejects(() => app.records.list(iris, table.id), AccessDeniedError);
  await app.stop();
});

test('namespace access gates tables outside std', async () => {
  const { app, admin } = await installed();
  const acme = await app.metadata.createNamespace(admin, { name: 'acme', label: 'Acme' });
  const table = await app.metadata.createTable(admin, {
    namespaceId: acme.id,
    name: 'Gadget',
  });
  const name = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'title',
    type: FieldType.Text,
  });
  await app.records.create(admin, table.id, { name: 'Rec 12', title: 'thing' });

  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Outsiders',
    parentId: admin.role.id,
  });
  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'All gadgets',
    tableId: table.id,
    accessTypes: [AccessType.Read],
    fieldGrants: [{ fieldId: name.id, access: FieldAccess.Read }],
  });
  await app.metadata.assignRuleToRole(admin, role.id, rule.id);
  await app.metadata.createUser(admin, {
    username: 'olive',
    email: 'o@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });

  // The rule alone is not enough without access to the namespace.
  let olive = await app.auth.authenticate('olive', 'password123');
  await assert.rejects(() => app.records.list(olive, table.id), AccessDeniedError);
  assert.equal((await app.metadata.listTables(olive)).length, 0);

  await app.metadata.grantNamespaceAccess(admin, role.id, acme.id);
  olive = await app.auth.authenticate('olive', 'password123');
  assert.equal((await app.records.list(olive, table.id)).length, 1);
  assert.equal((await app.metadata.listTables(olive)).length, 1);
  await app.stop();
});

test('custom clause logic decides which records a rule covers', async () => {
  const { app, admin } = await installed();
  const { table, amount, owner } = await invoiceTable(app, admin);

  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Analysts',
    parentId: admin.role.id,
  });
  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'Mine or big',
    tableId: table.id,
    accessTypes: [AccessType.Read],
    clauseMatch: ClauseMatch.Custom,
    clauseLogic: '1 OR (2 AND NOT 3)',
    clauses: [
      { fieldId: owner.id, operator: ClauseOperator.Equals, targetValue: '$user.username' },
      { fieldId: amount.id, operator: ClauseOperator.GreaterThan, targetValue: '500' },
      { fieldId: amount.id, operator: ClauseOperator.GreaterThan, targetValue: '5000' },
    ],
    fieldGrants: [{ fieldId: amount.id, access: FieldAccess.Read }, { fieldId: owner.id, access: FieldAccess.Read }],
  });
  await app.metadata.assignRuleToRole(admin, role.id, rule.id);
  await app.metadata.createUser(admin, {
    username: 'annie',
    email: 'a@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });

  const own = await app.records.create(admin, table.id, { name: 'Rec 13', amount: 1, owner: 'annie' });
  const big = await app.records.create(admin, table.id, { name: 'Rec 14', amount: 900, owner: 'root' });
  await app.records.create(admin, table.id, { name: 'Rec 15', amount: 9000, owner: 'root' });
  await app.records.create(admin, table.id, { name: 'Rec 16', amount: 3, owner: 'root' });

  const annie = await app.auth.authenticate('annie', 'password123');
  const visible = (await app.records.list(annie, table.id)).map((record) => record.id).sort();
  assert.deepEqual(visible, [own.id, big.id].sort());

  await assert.rejects(
    () =>
      app.metadata.createSecurityRule(admin, {
        name: 'Bad logic',
        tableId: table.id,
        accessTypes: [AccessType.Read],
        clauseMatch: ClauseMatch.Custom,
        clauseLogic: '1 AND 7',
        clauses: [{ fieldId: owner.id, operator: ClauseOperator.IsNotNull }],
      }),
    ValidationError,
  );
  await app.stop();
});

test('clauses can compare two fields of the same record', async () => {
  const { app, admin } = await installed();
  const { table, amount } = await invoiceTable(app, admin);
  const limit = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'limitAmount',
    type: FieldType.Number,
  });

  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Auditors',
    parentId: admin.role.id,
  });
  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'Over limit',
    tableId: table.id,
    accessTypes: [AccessType.Read],
    clauses: [
      { fieldId: amount.id, operator: ClauseOperator.GreaterThan, compareFieldId: limit.id },
    ],
    fieldGrants: [{ fieldId: amount.id, access: FieldAccess.Read }, { fieldId: limit.id, access: FieldAccess.Read }],
  });
  await app.metadata.assignRuleToRole(admin, role.id, rule.id);
  await app.metadata.createUser(admin, {
    username: 'aud',
    email: 'aud@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });

  const over = await app.records.create(admin, table.id, { name: 'Rec 17', amount: 100, limitAmount: 50 });
  await app.records.create(admin, table.id, { name: 'Rec 18', amount: 10, limitAmount: 50 });
  // A null on either side is not "greater than"; the clause fails closed.
  await app.records.create(admin, table.id, { name: 'Rec 19', amount: 999 });

  const auditor = await app.auth.authenticate('aud', 'password123');
  assert.deepEqual(
    (await app.records.list(auditor, table.id)).map((record) => record.id),
    [over.id],
  );
  await app.stop();
});

test('only the Administrator role may change metadata', async () => {
  const { app, admin } = await installed();
  const { std } = await invoiceTable(app, admin);
  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Plain',
    parentId: admin.role.id,
  });
  await app.metadata.createUser(admin, {
    username: 'plain',
    email: 'p@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });
  const plain = await app.auth.authenticate('plain', 'password123');

  await assert.rejects(
    () => app.metadata.createTable(plain, { namespaceId: std.id, name: 'Sneaky' }),
    AccessDeniedError,
  );
  await assert.rejects(
    () => app.metadata.createSecurityRole(plain, { name: 'Sneakier', parentId: role.id }),
    AccessDeniedError,
  );
  await assert.rejects(
    () =>
      app.metadata.createUser(plain, {
        username: 'mallory',
        email: 'm@example.com',
        password: 'password123',
        securityRoleId: role.id,
      }),
    AccessDeniedError,
  );
  await assert.rejects(() => app.metadata.listUsers(plain), AccessDeniedError);
  await app.stop();
});

test('the Administrator role is protected from modification', async () => {
  const { app, admin } = await installed();
  await assert.rejects(
    () => app.metadata.createSecurityRole(admin, { name: 'Administrator', parentId: admin.role.id }),
    ValidationError,
  );
  await assert.rejects(() => app.metadata.deleteSecurityRole(admin, admin.role.id), ValidationError);
  await assert.rejects(
    () => app.metadata.grantNamespaceAccess(admin, admin.role.id, 'anything'),
    ValidationError,
  );
  await app.stop();
});

test('custom roles must name a parent', async () => {
  const { app, admin } = await installed();
  await assert.rejects(
    () => app.metadata.createSecurityRole(admin, { name: 'Orphan', parentId: '' as Id }),
    ValidationError,
  );
  await assert.rejects(
    () => app.metadata.createSecurityRole(admin, { name: 'Orphan', parentId: 'nope' }),
    ValidationError,
  );
  await app.stop();
});

test('field values are validated and coerced by type', async () => {
  const { app, admin } = await installed();
  const { table } = await invoiceTable(app, admin);
  await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'paid',
    type: FieldType.Boolean,
  });
  await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'dueOn',
    type: FieldType.Date,
  });

  const record = await app.records.create(admin, table.id, {
    name: 'Rec 20',
    amount: '42.5',
    paid: 'yes',
    dueOn: '2026-01-31',
  });
  assert.equal(record.values['amount'], 42.5);
  assert.equal(record.values['paid'], true);
  assert.equal(record.values['dueOn'], '2026-01-31');

  await assert.rejects(
    () => app.records.create(admin, table.id, { name: 'Rec 21', amount: 'not a number' }),
    ValidationError,
  );
  await assert.rejects(
    () => app.records.create(admin, table.id, { name: 'Rec 22', dueOn: '31/01/2026' }),
    ValidationError,
  );
  await assert.rejects(
    () => app.records.create(admin, table.id, { name: 'Rec 23', nosuchfield: 1 }),
    ValidationError,
  );
  await app.stop();
});

test('reference fields must point at a record of the referenced table', async () => {
  const { app, admin } = await installed();
  const { std, table } = await invoiceTable(app, admin);
  const lines = await app.metadata.createTable(admin, { namespaceId: std.id, name: 'InvoiceLine' });
  await app.metadata.createField(admin, {
    tableId: lines.id,
    name: 'invoice',
    type: FieldType.Reference,
    referenceTableId: table.id,
  });

  const invoice = await app.records.create(admin, table.id, { name: 'Rec 24', amount: 1 });
  const line = await app.records.create(admin, lines.id, { name: 'Rec 25', invoice: invoice.id });
  assert.equal(line.values['invoice'], invoice.id);

  await assert.rejects(
    () => app.records.create(admin, lines.id, { name: 'Rec 26', invoice: 'not-a-record' }),
    ValidationError,
  );
  // Pointing at a record in the wrong table is rejected too.
  await assert.rejects(
    () => app.records.create(admin, lines.id, { name: 'Rec 27', invoice: line.id }),
    ValidationError,
  );
  await assert.rejects(
    () =>
      app.metadata.createField(admin, {
        tableId: lines.id,
        name: 'dangling',
        type: FieldType.Reference,
      }),
    ValidationError,
  );
  await app.stop();
});

test('required fields are enforced on create and on clearing', async () => {
  const { app, admin } = await installed();
  const { std } = await invoiceTable(app, admin);
  const table = await app.metadata.createTable(admin, { namespaceId: std.id, name: 'Contact' });
  await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'lastName',
    type: FieldType.Text,
    isRequired: true,
  });

  await assert.rejects(() => app.records.create(admin, table.id, { name: 'Rec 28' }), ValidationError);
  const record = await app.records.create(admin, table.id, { name: 'Rec 29', lastName: 'Ada' });
  await assert.rejects(
    () => app.records.update(admin, record.id, { lastName: '' }),
    ValidationError,
  );
  await app.stop();
});

test('deleting a record removes its values', async () => {
  const { app, admin } = await installed();
  const { table } = await invoiceTable(app, admin);
  const record = await app.records.create(admin, table.id, { name: 'Rec 30', amount: 1, owner: 'root' });
  await app.records.delete(admin, record.id);
  assert.equal(await app.database.count('value', { where: [{ column: 'recordId', operator: 'eq', value: record.id }] }), 0);
  await app.stop();
});

test('metadata changes take effect for already-authenticated users', async () => {
  const { app, admin } = await installed();
  const { table, amount } = await invoiceTable(app, admin);
  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Late',
    parentId: admin.role.id,
  });
  await app.metadata.createUser(admin, {
    username: 'lena',
    email: 'l@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });
  await app.records.create(admin, table.id, { name: 'Rec 31', amount: 5 });

  const lena = await app.auth.authenticate('lena', 'password123');
  await assert.rejects(() => app.records.list(lena, table.id), AccessDeniedError);

  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'Everything',
    tableId: table.id,
    accessTypes: [AccessType.Read],
    fieldGrants: [{ fieldId: amount.id, access: FieldAccess.Read }],
  });
  await app.metadata.assignRuleToRole(admin, role.id, rule.id);

  // The same context now sees the record: the permission cache was invalidated.
  assert.equal((await app.records.list(lena, table.id)).length, 1);
  await app.stop();
});

test('one rule can expose some fields read-only and others editable', async () => {
  const { app, admin } = await installed();
  const { table, amount, owner, secret } = await invoiceTable(app, admin);

  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Collectors',
    parentId: admin.role.id,
  });
  // The point of the grant table: one rule, three fields, three reaches.
  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'Work own invoices',
    tableId: table.id,
    accessTypes: [AccessType.Read, AccessType.Edit],
    clauses: [{ fieldId: owner.id, operator: ClauseOperator.Equals, targetValue: '$user.username' }],
    fieldGrants: [
      { fieldId: amount.id, access: FieldAccess.Edit },
      { fieldId: owner.id, access: FieldAccess.Read },
      // `secret` is granted at neither level, so it stays invisible.
    ],
  });
  await app.metadata.assignRuleToRole(admin, role.id, rule.id);
  await app.metadata.createUser(admin, {
    username: 'cass',
    email: 'c@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });
  const record = await app.records.create(admin, table.id, {
    name: 'Rec 32',
    amount: 10,
    owner: 'cass',
    secret: 'hidden',
  });
  const cass = await app.auth.authenticate('cass', 'password123');

  // Read sees both granted fields, at either level.
  const view = await app.records.get(cass, record.id);
  assert.deepEqual(Object.keys(view.values).sort(), ['amount', 'owner']);
  assert.deepEqual(
    (await app.metadata.listReadableFields(cass, table.id)).map((field) => field.name).sort(),
    ['amount', 'owner'],
  );

  // Only the editable grant may be written.
  assert.deepEqual(
    (await app.security.listEditableFields(cass, table.id)).map((field) => field.name),
    ['amount'],
  );
  const updated = await app.records.update(cass, record.id, { amount: 99 });
  assert.equal(updated.values['amount'], 99);
  await assert.rejects(
    () => app.records.update(cass, record.id, { owner: 'someone-else' }),
    AccessDeniedError,
  );
  await assert.rejects(
    () => app.records.update(cass, record.id, { secret: 'x' }),
    AccessDeniedError,
  );

  // The read-only field is genuinely untouched by the refused write.
  assert.equal((await app.records.get(admin, record.id)).values['owner'], 'cass');
  void secret;
  await app.stop();
});

test('a field cannot be granted as editable by a rule that grants no writing', async () => {
  const { app, admin } = await installed();
  const { table, amount } = await invoiceTable(app, admin);

  await assert.rejects(
    () =>
      app.metadata.createSecurityRule(admin, {
        name: 'Read only rule, editable field',
        tableId: table.id,
        accessTypes: [AccessType.Read],
        fieldGrants: [{ fieldId: amount.id, access: FieldAccess.Edit }],
      }),
    ValidationError,
  );

  // A create-only rule may grant editable fields: creating is writing.
  const created = await app.metadata.createSecurityRule(admin, {
    name: 'Create only',
    tableId: table.id,
    accessTypes: [],
    canCreate: true,
    fieldGrants: [{ fieldId: amount.id, access: FieldAccess.Edit }],
  });
  assert.equal(created.canCreate, true);
  await app.stop();
});

test('a grant defaults to read-only, and read-only fields cannot be set on create', async () => {
  const { app, admin } = await installed();
  const { table, amount, owner, nameField } = await invoiceTable(app, admin);

  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Submitters',
    parentId: admin.role.id,
  });
  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'Submit invoices',
    tableId: table.id,
    accessTypes: [AccessType.Read],
    canCreate: true,
    fieldGrants: [
      { fieldId: amount.id, access: FieldAccess.Edit },
      { fieldId: nameField.id, access: FieldAccess.Edit },
      // No access given, so this is read-only: visible, never written.
      { fieldId: owner.id },
    ],
  });
  await app.metadata.assignRuleToRole(admin, role.id, rule.id);
  await app.metadata.createUser(admin, {
    username: 'sub',
    email: 's@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });
  const sub = await app.auth.authenticate('sub', 'password123');

  assert.deepEqual(
    (await app.security.listCreatableFields(sub, table.id)).map((field) => field.name).sort(),
    ['amount', 'name'],
  );
  // `owner` is granted read-only, so setting it on create is refused.
  await assert.rejects(
    () => app.records.create(sub, table.id, { name: 'INV-1', amount: 1, owner: 'sub' }),
    AccessDeniedError,
  );

  const record = await app.records.create(sub, table.id, { name: 'INV-1', amount: 1 });
  // Readable afterwards at both grant levels.
  assert.deepEqual(Object.keys(record.values).sort(), ['amount', 'name', 'owner']);
  await app.stop();
});

test('the widest grant wins when a field is named twice', async () => {
  const { app, admin } = await installed();
  const { table, amount } = await invoiceTable(app, admin);
  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'Twice',
    tableId: table.id,
    accessTypes: [AccessType.Read, AccessType.Edit],
    fieldGrants: [
      { fieldId: amount.id, access: FieldAccess.Read },
      { fieldId: amount.id, access: FieldAccess.Edit },
    ],
  });
  const described = await app.metadata.describeRulesFor(admin, table.id);
  const grants = described.find((entry) => entry.rule.id === rule.id)?.grants ?? [];
  assert.deepEqual(grants, [{ field: 'amount', access: FieldAccess.Edit }]);
  await app.stop();
});

test('a field grant can never exceed its rule access to the table', async () => {
  const { app, admin } = await installed();
  const { table, amount } = await invoiceTable(app, admin);

  // The rule says what may be done to records of its table; the grant says
  // what may be done to a field of it. The only thing tying them together is
  // that the field cannot reach further than the table does.
  const combinations: { accessTypes: AccessType[]; canCreate: boolean }[] = [];
  for (const read of [false, true]) {
    for (const edit of [false, true]) {
      for (const remove of [false, true]) {
        for (const canCreate of [false, true]) {
          const accessTypes: AccessType[] = [];
          if (read) accessTypes.push(AccessType.Read);
          if (edit) accessTypes.push(AccessType.Edit);
          if (remove) accessTypes.push(AccessType.Delete);
          if (accessTypes.length === 0 && !canCreate) continue;
          combinations.push({ accessTypes, canCreate });
        }
      }
    }
  }
  assert.equal(combinations.length, 15);

  let index = 0;
  for (const combination of combinations) {
    const writes =
      combination.canCreate || combination.accessTypes.includes(AccessType.Edit);

    // A read-only grant is always fine: it never exceeds anything.
    await app.metadata.createSecurityRule(admin, {
      ...combination,
      name: `read grant ${index}`,
      tableId: table.id,
      fieldGrants: [{ fieldId: amount.id, access: FieldAccess.Read }],
    });

    const editable = app.metadata.createSecurityRule(admin, {
      ...combination,
      name: `edit grant ${index}`,
      tableId: table.id,
      fieldGrants: [{ fieldId: amount.id, access: FieldAccess.Edit }],
    });
    if (writes) {
      const rule = await editable;
      assert.equal(rule.canCreate, combination.canCreate);
    } else {
      // Read-only or delete-only on the table: an editable field would reach
      // further than the rule does, so it is refused.
      await assert.rejects(
        () => editable,
        ValidationError,
        `expected refusal for ${JSON.stringify(combination)}`,
      );
    }
    index += 1;
  }
  await app.stop();
});

test('delete access alone does not make a field writable', async () => {
  const { app, admin } = await installed();
  const { table, amount, owner } = await invoiceTable(app, admin);

  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Purgers',
    parentId: admin.role.id,
  });
  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'Read and delete',
    tableId: table.id,
    accessTypes: [AccessType.Read, AccessType.Delete],
    fieldGrants: [
      { fieldId: amount.id, access: FieldAccess.Read },
      { fieldId: owner.id, access: FieldAccess.Read },
    ],
  });
  await app.metadata.assignRuleToRole(admin, role.id, rule.id);
  await app.metadata.createUser(admin, {
    username: 'purge',
    email: 'p@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });
  const record = await app.records.create(admin, table.id, { name: 'Rec 35', amount: 1, owner: 'root' });
  const purger = await app.auth.authenticate('purge', 'password123');

  assert.deepEqual(await app.security.listEditableFields(purger, table.id), []);
  assert.equal(await app.security.canCreate(purger, table.id), false);
  // No rule grants edit on this table at all, so the record is not editable
  // and reports as missing -- the same answer as for a record outside your
  // rules. "Forbidden" is reserved for a field you may not touch on a record
  // you may otherwise edit.
  await assert.rejects(
    () => app.records.update(purger, record.id, { amount: 2 }),
    NotFoundError,
  );
  // Deleting the whole record is a different question, and this role may.
  await app.records.delete(purger, record.id);
  assert.equal((await app.records.list(admin, table.id)).length, 0);
  await app.stop();
});

test('granting access or assigning a rule twice leaves one row, not an error', async () => {
  const { app, admin } = await installed();
  const { std, table } = await invoiceTable(app, admin);
  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Repeat',
    parentId: admin.role.id,
  });

  const first = await app.metadata.grantNamespaceAccess(admin, role.id, std.id);
  const second = await app.metadata.grantNamespaceAccess(admin, role.id, std.id);
  assert.equal(first.created, true);
  // The second call reports that it changed nothing, so the console can say so
  // instead of claiming a grant it did not make.
  assert.equal(second.created, false);
  assert.equal(first.record.id, second.record.id);
  assert.equal((await app.metadata.listNamespaceAccess(admin)).length, 1);

  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'Some rule',
    tableId: table.id,
    accessTypes: [AccessType.Read],
  });
  const linkA = await app.metadata.assignRuleToRole(admin, role.id, rule.id);
  const linkB = await app.metadata.assignRuleToRole(admin, role.id, rule.id);
  assert.equal(linkA.created, true);
  assert.equal(linkB.created, false);
  assert.equal(linkA.record.id, linkB.record.id);
  assert.equal((await app.metadata.listRoleRules(admin)).length, 1);
  await app.stop();
});
