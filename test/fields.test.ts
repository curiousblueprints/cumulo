import assert from 'node:assert/strict';
import test from 'node:test';
import { Application } from '../src/app/Application.js';
import {
  AccessType,
  FieldAccess,
  FieldType,
  NAME_FIELD,
  STD_NAMESPACE,
  type FieldDef,
  type Id,
} from '../src/domain/types.js';
import type { SecurityContext } from '../src/security/context.js';
import { AccessDeniedError, ValidationError } from '../src/security/errors.js';

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

function named(fields: FieldDef[], name: string): FieldDef {
  const field = fields.find((candidate) => candidate.name === name);
  assert.ok(field, `expected a field called ${name}`);
  return field;
}

// --- the Name field ------------------------------------------------------

test('every table is created with a free-text Name field', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Account' });
  const fields = await app.security.listAllFields(admin, table.id);

  assert.equal(fields.length, 1);
  const name = named(fields, NAME_FIELD);
  assert.equal(name.type, FieldType.Text);
  assert.equal(name.label, 'Name');
  assert.equal(name.isSystem, true);
  assert.equal(name.isRequired, false);

  const record = await app.records.create(admin, table.id, { name: 'Acme' });
  assert.equal(record.values[NAME_FIELD], 'Acme');
  await app.stop();
});

test('a table can take an auto-number Name instead', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, {
    namespaceId: std,
    name: 'Ticket',
    nameFieldType: FieldType.AutoNumber,
  });
  const name = named(await app.security.listAllFields(admin, table.id), NAME_FIELD);
  assert.equal(name.type, FieldType.AutoNumber);

  // Numbers are handed out in order, without being asked for.
  const first = await app.records.create(admin, table.id, {});
  const second = await app.records.create(admin, table.id, {});
  const third = await app.records.create(admin, table.id, {});
  assert.deepEqual(
    [first, second, third].map((record) => record.values[NAME_FIELD]),
    [1, 2, 3],
  );

  // Nobody sets one, the administrator included.
  await assert.rejects(
    () => app.records.create(admin, table.id, { name: 99 }),
    ValidationError,
  );
  await assert.rejects(
    () => app.records.update(admin, first.id, { name: 99 }),
    ValidationError,
  );
  assert.equal(
    (await app.security.listEditableFields(admin, table.id)).some(
      (field) => field.name === NAME_FIELD,
    ),
    false,
  );

  // Each table counts on its own.
  const other = await app.metadata.createTable(admin, {
    namespaceId: std,
    name: 'Case',
    nameFieldType: FieldType.AutoNumber,
  });
  const elsewhere = await app.records.create(admin, other.id, {});
  assert.equal(elsewhere.values[NAME_FIELD], 1);
  await app.stop();
});

test('an auto number can be granted read-only but never editable', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, {
    namespaceId: std,
    name: 'Ticket',
    nameFieldType: FieldType.AutoNumber,
  });
  const name = named(await app.security.listAllFields(admin, table.id), NAME_FIELD);

  await app.metadata.createSecurityRule(admin, {
    name: 'See ticket numbers',
    tableId: table.id,
    accessTypes: [AccessType.Read],
    fieldGrants: [{ fieldId: name.id, access: FieldAccess.Read }],
  });
  await assert.rejects(
    () =>
      app.metadata.createSecurityRule(admin, {
        name: 'Write ticket numbers',
        tableId: table.id,
        accessTypes: [AccessType.Read, AccessType.Edit],
        fieldGrants: [{ fieldId: name.id, access: FieldAccess.Edit }],
      }),
    ValidationError,
  );
  await app.stop();
});

test('a role granted create cannot set an auto number either', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, {
    namespaceId: std,
    name: 'Ticket',
    nameFieldType: FieldType.AutoNumber,
  });
  const subject = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'subject',
    type: FieldType.Text,
  });
  const name = named(await app.security.listAllFields(admin, table.id), NAME_FIELD);

  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Reporters',
    parentId: admin.role.id,
  });
  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'File tickets',
    tableId: table.id,
    accessTypes: [AccessType.Read],
    canCreate: true,
    fieldGrants: [
      { fieldId: subject.id, access: FieldAccess.Edit },
      { fieldId: name.id, access: FieldAccess.Read },
    ],
  });
  await app.metadata.assignRuleToRole(admin, role.id, rule.id);
  await app.metadata.createUser(admin, {
    username: 'rep',
    email: 'rep@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });
  const reporter = await app.auth.authenticate('rep', 'password123');

  assert.deepEqual(
    (await app.security.listCreatableFields(reporter, table.id)).map((field) => field.name),
    ['subject'],
  );
  const filed = await app.records.create(reporter, table.id, { subject: 'It broke' });
  // Assigned by the platform, and readable because the rule grants it.
  assert.equal(filed.values[NAME_FIELD], 1);
  await assert.rejects(
    () => app.records.create(reporter, table.id, { subject: 'x', name: 7 }),
    ValidationError,
  );
  await app.stop();
});

// --- calendar-part field types -------------------------------------------

test('year, month, day and day of week validate and store as numbers', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Schedule' });
  for (const [name, type] of [
    ['year', FieldType.Year],
    ['month', FieldType.Month],
    ['day', FieldType.Day],
    ['weekday', FieldType.DayOfWeek],
  ] as const) {
    await app.metadata.createField(admin, { tableId: table.id, name, type });
  }

  const record = await app.records.create(admin, table.id, {
    year: '2026',
    month: '9',
    day: '31',
    weekday: '1',
  });
  assert.equal(record.values['year'], 2026);
  assert.equal(record.values['month'], 9);
  // A day standing alone is not checked against a month, so 31 is fine.
  assert.equal(record.values['day'], 31);
  // 1 is Sunday.
  assert.equal(record.values['weekday'], 1);

  const rejects = async (values: Record<string, unknown>): Promise<void> => {
    await assert.rejects(
      () => app.records.create(admin, table.id, values),
      ValidationError,
      `expected ${JSON.stringify(values)} to be refused`,
    );
  };
  await rejects({ year: '26' });
  await rejects({ year: '20265' });
  await rejects({ year: 'abcd' });
  await rejects({ month: '0' });
  await rejects({ month: '13' });
  await rejects({ month: 'September' });
  await rejects({ day: '0' });
  await rejects({ day: '32' });
  await rejects({ weekday: '0' });
  await rejects({ weekday: '8' });
  await app.stop();
});

test('months and weekdays compare as numbers, not as text', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Schedule' });
  const month = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'month',
    type: FieldType.Month,
  });

  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Q4',
    parentId: admin.role.id,
  });
  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'October onwards',
    tableId: table.id,
    accessTypes: [AccessType.Read],
    clauses: [
      {
        fieldId: month.id,
        operator: 'greaterOrEqual' as never,
        targetValue: '10',
      },
    ],
    fieldGrants: [{ fieldId: month.id, access: FieldAccess.Read }],
  });
  await app.metadata.assignRuleToRole(admin, role.id, rule.id);
  await app.metadata.createUser(admin, {
    username: 'quarterly',
    email: 'q4@example.com',
    password: 'password123',
    securityRoleId: role.id,
  });

  const february = await app.records.create(admin, table.id, { month: 2 });
  const october = await app.records.create(admin, table.id, { month: 10 });
  const december = await app.records.create(admin, table.id, { month: 12 });

  const viewer = await app.auth.authenticate('quarterly', 'password123');
  const visible = (await app.records.list(viewer, table.id)).map((record) => record.id).sort();
  // As text, "2" would sort after "10" and February would leak in.
  assert.deepEqual(visible, [october.id, december.id].sort());
  assert.equal(visible.includes(february.id), false);
  await app.stop();
});

// --- deleting fields -----------------------------------------------------

test('deleting a field removes it and its values', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Invoice' });
  const amount = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'amount',
    type: FieldType.Number,
  });
  const note = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'note',
    type: FieldType.Text,
  });
  const record = await app.records.create(admin, table.id, {
    name: 'INV-1',
    amount: 10,
    note: 'keep',
  });

  await app.metadata.deleteField(admin, amount.id);

  const fields = await app.security.listAllFields(admin, table.id);
  assert.deepEqual(fields.map((field) => field.name).sort(), ['name', 'note']);
  const after = await app.records.get(admin, record.id);
  assert.equal('amount' in after.values, false);
  assert.equal(after.values['note'], 'keep');

  // The value row went with it.
  assert.equal(
    await app.database.count('value', {
      where: [{ column: 'fieldId', operator: 'eq', value: amount.id }],
    }),
    0,
  );
  void note;
  await app.stop();
});

test('deleting a field takes its field grants with it', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Invoice' });
  const amount = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'amount',
    type: FieldType.Number,
  });
  const rule = await app.metadata.createSecurityRule(admin, {
    name: 'Read invoices',
    tableId: table.id,
    accessTypes: [AccessType.Read],
    fieldGrants: [{ fieldId: amount.id, access: FieldAccess.Read }],
  });

  await app.metadata.deleteField(admin, amount.id);
  const described = await app.metadata.describeRulesFor(admin, table.id);
  assert.deepEqual(described.find((entry) => entry.rule.id === rule.id)?.grants, []);
  await app.stop();
});

test('a field a rule clause reads cannot be deleted out from under it', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Invoice' });
  const owner = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'owner',
    type: FieldType.Text,
  });
  const limit = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'limitAmount',
    type: FieldType.Number,
  });
  const amount = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'amount',
    type: FieldType.Number,
  });

  await app.metadata.createSecurityRule(admin, {
    name: 'Own big invoices',
    tableId: table.id,
    accessTypes: [AccessType.Read],
    clauses: [
      { fieldId: owner.id, operator: 'equals' as never, targetValue: '$user.username' },
      { fieldId: amount.id, operator: 'greaterThan' as never, compareFieldId: limit.id },
    ],
    fieldGrants: [{ fieldId: amount.id, access: FieldAccess.Read }],
  });

  // Dropping either side of a clause would change what the rule matches.
  for (const field of [owner, amount, limit]) {
    await assert.rejects(
      () => app.metadata.deleteField(admin, field.id),
      (error: unknown) =>
        error instanceof ValidationError && /Own big invoices/.test(error.message),
      `expected ${field.name} to be protected by the rule`,
    );
  }
  assert.equal((await app.security.listAllFields(admin, table.id)).length, 4);
  await app.stop();
});

test('the Name field cannot be deleted', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Account' });
  const name = named(await app.security.listAllFields(admin, table.id), NAME_FIELD);
  await assert.rejects(() => app.metadata.deleteField(admin, name.id), ValidationError);
  await app.stop();
});

test('only an administrator may delete a field', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Invoice' });
  const amount = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'amount',
    type: FieldType.Number,
  });
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
  await assert.rejects(() => app.metadata.deleteField(plain, amount.id), AccessDeniedError);
  await app.stop();
});
