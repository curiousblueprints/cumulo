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
import { NotFoundError, ValidationError } from '../src/security/errors.js';

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

// --- API names are unique on a table -------------------------------------

test('an API name identifies a field on its table, whatever the namespace', async () => {
  const { app, admin, std } = await installed();
  const acme = await app.metadata.createNamespace(admin, { name: 'acme' });
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Account' });

  // `name` belongs to the table's own Name field and cannot be claimed again,
  // by this namespace or any other. A label is beside the point.
  for (const namespaceId of [std, acme.id]) {
    await assert.rejects(
      () =>
        app.metadata.createField(admin, {
          tableId: table.id,
          name: 'name',
          label: 'Company Name',
          type: FieldType.Text,
          namespaceId,
        }),
      (error: unknown) =>
        error instanceof ValidationError && /already the API name/.test(error.message),
    );
  }

  await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'status',
    type: FieldType.Text,
  });
  // Two packages cannot both contribute a `status` to the same table either.
  await assert.rejects(
    () =>
      app.metadata.createField(admin, {
        tableId: table.id,
        name: 'status',
        type: FieldType.Text,
        namespaceId: acme.id,
      }),
    ValidationError,
  );

  // A different table is a different scope.
  const other = await app.metadata.createTable(admin, { namespaceId: std, name: 'Contact' });
  const created = await app.metadata.createField(admin, {
    tableId: other.id,
    name: 'status',
    type: FieldType.Text,
  });
  assert.equal(created.name, 'status');
  assert.deepEqual(
    (await app.security.listAllFields(admin, table.id)).map((field) => field.name).sort(),
    ['name', 'status'],
  );
  await app.stop();
});

// --- related lists --------------------------------------------------------

/** Account with two children: Contact.account and Invoice.account. */
async function accountsWithChildren(app: Application, admin: SecurityContext, std: Id) {
  const account = await app.metadata.createTable(admin, { namespaceId: std, name: 'Account' });
  const contact = await app.metadata.createTable(admin, { namespaceId: std, name: 'Contact' });
  const contactLookup = await app.metadata.createField(admin, {
    tableId: contact.id,
    name: 'account',
    label: 'Account',
    type: FieldType.Reference,
    referenceTableId: account.id,
  });
  const invoice = await app.metadata.createTable(admin, { namespaceId: std, name: 'Invoice' });
  const invoiceLookup = await app.metadata.createField(admin, {
    tableId: invoice.id,
    name: 'account',
    label: 'Account',
    type: FieldType.Reference,
    referenceTableId: account.id,
  });
  const amount = await app.metadata.createField(admin, {
    tableId: invoice.id,
    name: 'amount',
    type: FieldType.Number,
  });
  return { account, contact, contactLookup, invoice, invoiceLookup, amount };
}

test('a record lists the records pointing at it', async () => {
  const { app, admin, std } = await installed();
  const { account, contact, invoice } = await accountsWithChildren(app, admin, std);

  const acme = await app.records.create(admin, account.id, { name: 'Acme' });
  const globex = await app.records.create(admin, account.id, { name: 'Globex' });
  const ada = await app.records.create(admin, contact.id, { name: 'Ada', account: acme.id });
  await app.records.create(admin, contact.id, { name: 'Grace', account: globex.id });
  const inv = await app.records.create(admin, invoice.id, {
    name: 'INV-1',
    amount: 10,
    account: acme.id,
  });

  const lists = await app.security.listRelatedLists(admin, acme.id);
  assert.deepEqual(
    lists.map((list) => list.title),
    ['Contact', 'Invoice'],
  );

  const contacts = lists.find((list) => list.table.id === contact.id);
  assert.deepEqual(
    contacts?.records.map((record) => record.id),
    [ada.id],
  );
  // The lookup is the same value on every row, so it is not a column.
  assert.deepEqual(
    contacts?.columns.map((column) => column.name),
    ['name'],
  );

  const invoices = lists.find((list) => list.table.id === invoice.id);
  assert.deepEqual(
    invoices?.records.map((record) => record.id),
    [inv.id],
  );
  assert.deepEqual(
    invoices?.columns.map((column) => column.name).sort(),
    ['amount', 'name'],
  );

  // A record nothing points at gets empty lists, not missing ones: the
  // relationship exists whether or not anything uses it yet.
  const emptyLists = await app.security.listRelatedLists(admin, globex.id);
  assert.deepEqual(
    emptyLists.map((list) => [list.title, list.records.length]),
    [
      ['Contact', 1],
      ['Invoice', 0],
    ],
  );
  await app.stop();
});

test('a self lookup lists a record’s children', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Department' });
  await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'parent',
    label: 'Parent',
    type: FieldType.Reference,
    referenceTableId: table.id,
  });

  const root = await app.records.create(admin, table.id, { name: 'All' });
  const sales = await app.records.create(admin, table.id, { name: 'Sales', parent: root.id });
  const support = await app.records.create(admin, table.id, { name: 'Support', parent: root.id });
  await app.records.create(admin, table.id, { name: 'EMEA', parent: sales.id });

  const lists = await app.security.listRelatedLists(admin, root.id);
  assert.equal(lists.length, 1);
  assert.deepEqual(
    lists[0]?.records.map((record) => record.id).sort(),
    [sales.id, support.id].sort(),
  );
  await app.stop();
});

test('two lookups from the same table are told apart', async () => {
  const { app, admin, std } = await installed();
  const person = await app.metadata.createTable(admin, { namespaceId: std, name: 'Person' });
  const ticket = await app.metadata.createTable(admin, { namespaceId: std, name: 'Ticket' });
  for (const [name, label] of [
    ['reportedBy', 'Reported by'],
    ['assignedTo', 'Assigned to'],
  ] as const) {
    await app.metadata.createField(admin, {
      tableId: ticket.id,
      name,
      label,
      type: FieldType.Reference,
      referenceTableId: person.id,
    });
  }

  const ada = await app.records.create(admin, person.id, { name: 'Ada' });
  const grace = await app.records.create(admin, person.id, { name: 'Grace' });
  const reported = await app.records.create(admin, ticket.id, {
    name: 'Printer jam',
    reportedBy: ada.id,
    assignedTo: grace.id,
  });

  const lists = await app.security.listRelatedLists(admin, ada.id);
  // Both lists are "Tickets"; the lookup's label is what separates them.
  assert.deepEqual(
    lists.map((list) => list.title).sort(),
    ['Ticket (Assigned to)', 'Ticket (Reported by)'],
  );
  const asReporter = lists.find((list) => list.field.name === 'reportedBy');
  const asAssignee = lists.find((list) => list.field.name === 'assignedTo');
  assert.deepEqual(
    asReporter?.records.map((record) => record.id),
    [reported.id],
  );
  assert.deepEqual(asAssignee?.records, []);
  await app.stop();
});

test('related lists obey the security layer', async () => {
  const { app, admin, std } = await installed();
  const { account, contact, contactLookup, invoice } = await accountsWithChildren(app, admin, std);
  const contactName = await nameFieldOf(app, admin, contact.id);
  const accountName = await nameFieldOf(app, admin, account.id);
  const owner = await app.metadata.createField(admin, {
    tableId: contact.id,
    name: 'owner',
    type: FieldType.Text,
  });

  const acme = await app.records.create(admin, account.id, { name: 'Acme' });
  const mine = await app.records.create(admin, contact.id, {
    name: 'Ada',
    account: acme.id,
    owner: 'sally',
  });
  await app.records.create(admin, contact.id, {
    name: 'Grace',
    account: acme.id,
    owner: 'someone-else',
  });
  await app.records.create(admin, invoice.id, { name: 'INV-1', account: acme.id });

  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Reps',
    parentId: admin.role.id,
  });
  // Accounts, and only their own contacts. Invoices are not granted at all.
  for (const rule of [
    {
      name: 'Accounts',
      tableId: account.id,
      accessTypes: [AccessType.Read],
      fieldGrants: [{ fieldId: accountName.id, access: FieldAccess.Read }],
    },
    {
      name: 'Own contacts',
      tableId: contact.id,
      accessTypes: [AccessType.Read],
      clauses: [
        { fieldId: owner.id, operator: ClauseOperator.Equals, targetValue: '$user.username' },
      ],
      fieldGrants: [
        { fieldId: contactName.id, access: FieldAccess.Read },
        { fieldId: contactLookup.id, access: FieldAccess.Read },
      ],
    },
  ]) {
    const created = await app.metadata.createSecurityRule(admin, rule);
    await app.metadata.assignRuleToRole(admin, role.id, created.id);
  }
  await app.metadata.createUser(admin, {
    username: 'sally',
    email: 's@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });
  const sally = await app.auth.authenticate('sally', 'password123');

  const lists = await app.security.listRelatedLists(sally, acme.id);
  // Invoices are invisible, so no list for them at all.
  assert.deepEqual(
    lists.map((list) => list.title),
    ['Contact'],
  );
  // And the clause filters the list down to her own contact.
  assert.deepEqual(
    lists[0]?.records.map((record) => record.id),
    [mine.id],
  );
  // `owner` is not granted, so it is not a column either.
  assert.deepEqual(
    lists[0]?.columns.map((column) => column.name),
    ['name'],
  );
  await app.stop();
});

test('a lookup the caller cannot read produces no list', async () => {
  const { app, admin, std } = await installed();
  const { account, contact, contactLookup } = await accountsWithChildren(app, admin, std);
  const contactName = await nameFieldOf(app, admin, contact.id);
  const accountName = await nameFieldOf(app, admin, account.id);

  const acme = await app.records.create(admin, account.id, { name: 'Acme' });
  await app.records.create(admin, contact.id, { name: 'Ada', account: acme.id });

  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Partial',
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
      // Contacts are readable, but the lookup joining them to an account is
      // not, so the relationship itself is not theirs to see.
      name: 'Contacts without the link',
      tableId: contact.id,
      accessTypes: [AccessType.Read],
      fieldGrants: [{ fieldId: contactName.id, access: FieldAccess.Read }],
    },
  ]) {
    const created = await app.metadata.createSecurityRule(admin, rule);
    await app.metadata.assignRuleToRole(admin, role.id, created.id);
  }
  await app.metadata.createUser(admin, {
    username: 'partial',
    email: 'p@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });
  const user = await app.auth.authenticate('partial', 'password123');

  assert.equal((await app.records.list(user, contact.id)).length, 1);
  assert.deepEqual(await app.security.listRelatedLists(user, acme.id), []);
  void contactLookup;
  await app.stop();
});

test('children cannot be listed for a record the caller may not see', async () => {
  const { app, admin, std } = await installed();
  const { account, contact } = await accountsWithChildren(app, admin, std);
  const acme = await app.records.create(admin, account.id, { name: 'Acme' });
  await app.records.create(admin, contact.id, { name: 'Ada', account: acme.id });

  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Nobody',
    parentId: admin.role.id,
  });
  await app.metadata.createUser(admin, {
    username: 'nobody',
    email: 'n@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });
  const nobody = await app.auth.authenticate('nobody', 'password123');

  await assert.rejects(
    () => app.security.listRelatedLists(nobody, acme.id),
    NotFoundError,
  );
  await app.stop();
});

test('deleting a parent empties the lookup rather than the children', async () => {
  const { app, admin, std } = await installed();
  const { account, contact } = await accountsWithChildren(app, admin, std);
  const acme = await app.records.create(admin, account.id, { name: 'Acme' });
  const ada = await app.records.create(admin, contact.id, { name: 'Ada', account: acme.id });

  assert.equal((await app.security.listRelatedLists(admin, acme.id))[0]?.records.length, 1);
  await app.records.delete(admin, acme.id);

  // The contact survives, detached -- these are lookups, not master-detail.
  const survivor = await app.records.get(admin, ada.id);
  assert.equal(survivor.values['account'], null);
  await app.stop();
});

test('a related list names the lookup, so a new child can join the list it came from', async () => {
  const { app, admin, std } = await installed();
  const { account, contact } = await accountsWithChildren(app, admin, std);
  const acme = await app.records.create(admin, account.id, { name: 'Acme' });

  const [contacts] = (await app.security.listRelatedLists(admin, acme.id)).filter(
    (list) => list.table.id === contact.id,
  );
  assert.ok(contacts);
  // The list carries the lookup it is built on. That is what lets "New" from
  // a related list fill it in, rather than creating a child outside the list.
  assert.equal(contacts.field.name, 'account');
  assert.equal(contacts.field.referenceTableId, account.id);
  assert.equal(contacts.canCreate, true);

  const joined = await app.records.create(admin, contact.id, {
    name: 'Ada',
    [contacts.field.name]: acme.id,
  });
  assert.deepEqual(
    (await app.security.listRelatedLists(admin, acme.id))
      .find((list) => list.table.id === contact.id)
      ?.records.map((record) => record.id),
    [joined.id],
  );
  await app.stop();
});
