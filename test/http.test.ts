import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Application } from '../src/app/Application.js';
import { createServer } from '../src/presentation/http/server.js';

/** A tiny cookie-jar client, so the tests exercise the real request path. */
class Client {
  private cookie = '';

  constructor(private readonly base: string) {}

  async get(path: string): Promise<Response> {
    return this.request('GET', path);
  }

  async post(path: string, form: Record<string, string | string[]>): Promise<Response> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
    }
    return this.request('POST', path, body.toString());
  }

  private async request(method: string, path: string, body?: string): Promise<Response> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
      },
      ...(body === undefined ? {} : { body }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0] as string;
    return response;
  }
}

async function serve(): Promise<{ app: Application; base: string; close: () => Promise<void> }> {
  const app = await Application.start({ database: { driver: 'sqlite', file: ':memory:' } });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.stop();
    },
  };
}

/** Pull the CSRF token out of a rendered page. */
function csrf(page: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(page);
  assert.ok(match, 'expected a CSRF token on the page');
  return match[1] as string;
}

test('an uninstalled server routes everything to setup', async () => {
  const { base, close } = await serve();
  const client = new Client(base);

  assert.equal((await client.get('/')).headers.get('location'), '/setup');
  assert.equal((await client.get('/login')).headers.get('location'), '/setup');
  assert.match(await (await client.get('/setup')).text(), /Welcome to Cumulo/);
  await close();
});

test('setup creates the administrator and signs them in', async () => {
  const { base, close } = await serve();
  const client = new Client(base);

  const created = await client.post('/setup', {
    username: 'root',
    email: 'root@example.com',
    password: 'correct horse',
  });
  assert.equal(created.status, 303);
  assert.equal(created.headers.get('location'), '/tables');

  const dataPage = await (await client.get('/tables')).text();
  assert.match(dataPage, /root/);
  assert.match(dataPage, /Administrator/);

  // Setup is closed once it has been used.
  assert.equal((await client.get('/setup')).headers.get('location'), '/login');
  await close();
});

test('signed-out visitors are redirected to the sign-in page', async () => {
  const { base, close } = await serve();
  const setup = new Client(base);
  await setup.post('/setup', { username: 'root', email: 'r@e.com', password: 'correct horse' });

  const stranger = new Client(base);
  assert.equal((await stranger.get('/tables')).headers.get('location'), '/login');
  assert.equal((await stranger.get('/admin')).headers.get('location'), '/login');

  const failed = await stranger.post('/login', { username: 'root', password: 'nope' });
  assert.match(failed.headers.get('location') ?? '', /^\/login\?error=/);
  await close();
});

test('an administrator can build a table and a record through the UI', async () => {
  const { base, close } = await serve();
  const client = new Client(base);
  await client.post('/setup', { username: 'root', email: 'r@e.com', password: 'correct horse' });

  const admin = await (await client.get('/admin')).text();
  const token = csrf(admin);
  const stdId = /name="namespaceId" required>\s*<option value="([^"]+)"/.exec(admin)?.[1];
  assert.ok(stdId);

  const tableResponse = await client.post('/admin/tables', {
    _csrf: token,
    namespaceId: stdId,
    name: 'Invoice',
    label: 'Invoice',
  });
  const tablePath = (tableResponse.headers.get('location') ?? '').split('?')[0] as string;
  assert.match(tablePath, /^\/admin\/tables\//);
  const tableId = tablePath.split('/').pop() as string;

  const tablePage = await (await client.get(tablePath)).text();
  await client.post('/admin/fields', {
    _csrf: csrf(tablePage),
    tableId,
    name: 'amount',
    label: 'Amount',
    type: 'number',
  });

  const newRecordPage = await (await client.get(`/tables/${tableId}/new`)).text();
  assert.match(newRecordPage, /Amount/);
  const created = await client.post(`/tables/${tableId}/records`, {
    _csrf: csrf(newRecordPage),
    field_amount: '125',
  });
  assert.match(created.headers.get('location') ?? '', /^\/records\//);

  const listing = await (await client.get(`/tables/${tableId}`)).text();
  assert.match(listing, /125/);
  await close();
});

test('form posts without a valid CSRF token are refused', async () => {
  const { base, close } = await serve();
  const client = new Client(base);
  await client.post('/setup', { username: 'root', email: 'r@e.com', password: 'correct horse' });

  const response = await client.post('/admin/namespaces', { name: 'acme', _csrf: 'forged' });
  const location = response.headers.get('location') ?? '';
  assert.match(location, /error=/);
  assert.match(decodeURIComponent(location), /form token/i);
  await close();
});

test('a non-administrator cannot reach the setup pages', async () => {
  const { app, base, close } = await serve();
  const admin = await app.install.completeSetup({
    username: 'root',
    email: 'r@e.com',
    password: 'correct horse',
  });
  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Plain',
    parentId: admin.role.id,
  });
  await app.metadata.createUser(admin, {
    username: 'plain',
    email: 'p@e.com',
    password: 'password123',
    securityRoleId: role.id,
  });

  const client = new Client(base);
  await client.post('/login', { username: 'plain', password: 'password123' });
  const denied = await client.get('/admin');
  assert.equal(denied.status, 403);

  // The nav offers no route there either.
  const dataPage = await (await client.get('/tables')).text();
  assert.doesNotMatch(dataPage, /href="\/admin"/);
  await close();
});

test('signing out clears the session', async () => {
  const { base, close } = await serve();
  const client = new Client(base);
  await client.post('/setup', { username: 'root', email: 'r@e.com', password: 'correct horse' });
  await client.post('/logout', {});
  assert.equal((await client.get('/tables')).headers.get('location'), '/login');
  await close();
});

test('unknown paths are 404 and wrong methods are 405', async () => {
  const { base, close } = await serve();
  const client = new Client(base);
  assert.equal((await client.get('/nope')).status, 404);
  assert.equal((await client.post('/healthz', {})).status, 405);
  await close();
});

test('a multi-select posts every selected value', async () => {
  const { app, base, close } = await serve();
  const client = new Client(base);
  await client.post('/setup', { username: 'root', email: 'r@e.com', password: 'correct horse' });
  const admin = await app.auth.authenticate('root', 'correct horse');
  const std = (await app.metadata.listNamespaces(admin))[0];
  assert.ok(std);
  const table = await app.metadata.createTable(admin, { namespaceId: std.id, name: 'Thing' });
  const field = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'title',
    type: 'text' as never,
  });

  const page = await (await client.get(`/admin/tables/${table.id}`)).text();
  await client.post('/admin/rules', {
    _csrf: csrf(page),
    tableId: table.id,
    name: 'Read and edit',
    accessTypes: ['read', 'edit'],
    clauseMatch: 'all',
    fieldIds: [field.id],
  });

  const rules = await app.metadata.listSecurityRules(admin);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0]?.accessTypes.sort(), ['edit', 'read']);
  await close();
});
