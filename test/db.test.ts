import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteAdapter } from '../src/db/sqlite/SqliteAdapter.js';
import { UniqueConstraintError, type Schema } from '../src/db/types.js';

const SCHEMA: Schema = [
  {
    name: 'widget',
    primaryKey: 'id',
    columns: [
      { name: 'id', type: 'text' },
      { name: 'name', type: 'text', unique: true },
      { name: 'size', type: 'integer' },
      { name: 'active', type: 'boolean' },
      { name: 'note', type: 'text', nullable: true },
    ],
  },
];

async function open(): Promise<SqliteAdapter> {
  const adapter = new SqliteAdapter({ file: ':memory:' });
  await adapter.open();
  await adapter.applySchema(SCHEMA);
  return adapter;
}

test('applySchema is idempotent', async () => {
  const db = await open();
  await db.applySchema(SCHEMA);
  assert.equal(await db.count('widget'), 0);
  await db.close();
});

test('applySchema adds columns an existing table is missing', async () => {
  const db = await open();
  await db.insert('widget', { id: 'a', name: 'A', size: 1, active: true });

  const evolved: Schema = [
    {
      ...(SCHEMA[0] as Schema[number]),
      columns: [
        ...(SCHEMA[0] as Schema[number]).columns,
        { name: 'colour', type: 'text' },
        { name: 'shiny', type: 'boolean' },
        { name: 'weight', type: 'real', nullable: true },
      ],
    },
  ];
  await db.applySchema(evolved);

  // The existing row survives and takes the type's zero value.
  const row = await db.findById('widget', 'a');
  assert.equal(row?.['name'], 'A');
  assert.equal(row?.['colour'], '');
  assert.equal(row?.['shiny'], false);
  assert.equal(row?.['weight'], null);

  await db.insert('widget', {
    id: 'b',
    name: 'B',
    size: 2,
    active: false,
    colour: 'red',
    shiny: true,
    weight: 1.5,
  });
  const added = await db.findById('widget', 'b');
  assert.equal(added?.['colour'], 'red');
  assert.equal(added?.['shiny'], true);
  await db.close();
});

test('round-trips booleans and nulls', async () => {
  const db = await open();
  await db.insert('widget', { id: 'a', name: 'A', size: 1, active: true, note: null });
  const row = await db.findById('widget', 'a');
  assert.equal(row?.['active'], true);
  assert.equal(row?.['note'], null);
  await db.close();
});

test('filters, ordering and paging', async () => {
  const db = await open();
  for (const [index, name] of ['alpha', 'beta', 'gamma'].entries()) {
    await db.insert('widget', { id: `w${index}`, name, size: index, active: index % 2 === 0 });
  }
  assert.equal((await db.find('widget', { where: [{ column: 'size', operator: 'gte', value: 1 }] })).length, 2);
  assert.equal((await db.find('widget', { where: [{ column: 'active', operator: 'eq', value: true }] })).length, 2);
  assert.equal((await db.find('widget', { where: [{ column: 'id', operator: 'in', value: ['w0', 'w2'] }] })).length, 2);
  assert.equal((await db.find('widget', { where: [{ column: 'id', operator: 'in', value: [] }] })).length, 0);

  const desc = await db.find('widget', { orderBy: [{ column: 'size', direction: 'desc' }], limit: 1 });
  assert.equal(desc[0]?.['name'], 'gamma');

  const paged = await db.find('widget', { orderBy: [{ column: 'size' }], offset: 2 });
  assert.equal(paged.length, 1);
  assert.equal(paged[0]?.['name'], 'gamma');
  await db.close();
});

test('reports unique violations distinctly', async () => {
  const db = await open();
  await db.insert('widget', { id: 'a', name: 'dup', size: 0, active: false });
  await assert.rejects(
    () => db.insert('widget', { id: 'b', name: 'dup', size: 0, active: false }),
    UniqueConstraintError,
  );
  await db.close();
});

test('rolls a failed transaction back', async () => {
  const db = await open();
  await assert.rejects(async () => {
    await db.transaction(async () => {
      await db.insert('widget', { id: 'a', name: 'A', size: 0, active: false });
      throw new Error('boom');
    });
  });
  assert.equal(await db.count('widget'), 0);

  // The connection is still usable afterwards.
  await db.transaction(async () => {
    await db.insert('widget', { id: 'b', name: 'B', size: 0, active: false });
  });
  assert.equal(await db.count('widget'), 1);
  await db.close();
});

test('update returns the stored row and delete reports whether it hit', async () => {
  const db = await open();
  await db.insert('widget', { id: 'a', name: 'A', size: 1, active: true });
  const updated = await db.update('widget', 'a', { size: 9, active: false });
  assert.equal(updated?.['size'], 9);
  assert.equal(updated?.['active'], false);
  assert.equal(await db.delete('widget', 'a'), true);
  assert.equal(await db.delete('widget', 'a'), false);
  await db.close();
});
