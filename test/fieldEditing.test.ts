import assert from 'node:assert/strict';
import test from 'node:test';
import { Application } from '../src/app/Application.js';
import { FieldType, STD_NAMESPACE, type Id } from '../src/domain/types.js';
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

async function nameFieldOf(app: Application, admin: SecurityContext, tableId: Id) {
  const field = (await app.security.listAllFields(admin, tableId)).find(
    (candidate) => candidate.name === 'name',
  );
  assert.ok(field);
  return field;
}

test('a custom field’s label, requiredness and searchability can be changed', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Invoice' });
  const amount = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'amount',
    label: 'amount',
    type: FieldType.Number,
  });
  assert.equal(amount.isRequired, false);
  assert.equal(amount.isSearchable, false);

  const updated = await app.metadata.updateField(admin, amount.id, {
    label: 'Amount due',
    isRequired: true,
    isSearchable: true,
  });
  assert.equal(updated.label, 'Amount due');
  assert.equal(updated.isRequired, true);
  assert.equal(updated.isSearchable, true);

  // The things that identify the field are untouched by a label change.
  assert.equal(updated.name, 'amount');
  assert.equal(updated.type, FieldType.Number);
  assert.equal(updated.namespaceId, std);

  // And the change is what the record layer sees.
  await assert.rejects(() => app.records.create(admin, table.id, { name: 'INV-1' }), ValidationError);
  const record = await app.records.create(admin, table.id, { name: 'INV-1', amount: 12 });
  const columns = await app.metadata.listReadableFields(admin, table.id);
  assert.equal(columns.find((field) => field.name === 'amount')?.label, 'Amount due');
  assert.equal((await app.security.search(admin, '12'))[0]?.record.id, record.id);
  await app.stop();
});

test('a label is required and trimmed', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Invoice' });
  const amount = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'amount',
    type: FieldType.Number,
  });

  for (const label of ['', '   ']) {
    await assert.rejects(
      () => app.metadata.updateField(admin, amount.id, { label }),
      ValidationError,
    );
  }
  assert.equal((await app.metadata.updateField(admin, amount.id, { label: '  Total  ' })).label, 'Total');
  await app.stop();
});

test('only the label of the Name field can be changed', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Account' });
  const name = await nameFieldOf(app, admin, table.id);

  const relabelled = await app.metadata.updateField(admin, name.id, { label: 'Account Name' });
  assert.equal(relabelled.label, 'Account Name');
  assert.equal(relabelled.name, 'name');
  assert.equal(relabelled.isRequired, true);
  assert.equal(relabelled.isSearchable, true);

  for (const change of [{ isRequired: false }, { isSearchable: false }, { isSearchable: true }]) {
    await assert.rejects(
      () => app.metadata.updateField(admin, name.id, change),
      (error: unknown) => error instanceof ValidationError && /Only the label/.test(error.message),
    );
  }
  // Nor can it be deleted.
  await assert.rejects(() => app.metadata.deleteField(admin, name.id), ValidationError);
  await app.stop();
});

test('an auto number cannot be made required', async () => {
  const { app, admin, std } = await installed();
  const table = await app.metadata.createTable(admin, { namespaceId: std, name: 'Ticket' });
  const reference = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'reference',
    type: FieldType.AutoNumber,
  });

  await assert.rejects(
    () => app.metadata.updateField(admin, reference.id, { isRequired: true }),
    (error: unknown) =>
      error instanceof ValidationError && /filled in by the platform/.test(error.message),
  );
  // The rest of it edits normally.
  const updated = await app.metadata.updateField(admin, reference.id, {
    label: 'Ticket number',
    isSearchable: true,
    isRequired: false,
  });
  assert.equal(updated.label, 'Ticket number');
  assert.equal(updated.isSearchable, true);
  await app.stop();
});

test('only an administrator may edit a field', async () => {
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

  await assert.rejects(
    () => app.metadata.updateField(plain, amount.id, { label: 'Mine now' }),
    AccessDeniedError,
  );
  await assert.rejects(() => app.metadata.findField(plain, amount.id), AccessDeniedError);
  await app.stop();
});

test('editing a field that does not exist is refused', async () => {
  const { app, admin } = await installed();
  await assert.rejects(
    () => app.metadata.updateField(admin, 'no-such-field', { label: 'x' }),
    ValidationError,
  );
  assert.equal(await app.metadata.findField(admin, 'no-such-field'), null);
  await app.stop();
});
