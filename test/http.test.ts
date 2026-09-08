import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Application } from '../src/app/Application.js';
import { FieldAccess } from '../src/domain/types.js';
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

  /** GET a JSON endpoint and parse it. */
  async json<T>(path: string): Promise<T> {
    const response = await this.get(path);
    assert.equal(response.status, 200, `GET ${path} returned ${response.status}`);
    return JSON.parse(await response.text()) as T;
  }

  /** POST JSON, carrying the session's CSRF token the way the client does. */
  async postJson(path: string, body: unknown, csrfToken: string): Promise<Response> {
    return this.request('POST', path, JSON.stringify(body), {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    });
  }

  private async request(
    method: string,
    path: string,
    body?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0] as string;
    return response;
  }
}

async function serve(
  features?: { namespaceCreation?: boolean },
): Promise<{ app: Application; base: string; close: () => Promise<void> }> {
  const app = await Application.start({ database: { driver: 'sqlite', file: ':memory:' } });
  const server = createServer(app, features ? { features } : {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  // A test that fails before close() would otherwise keep the runner alive.
  server.unref();
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
  // The user space is the client now, so setup lands in it.
  assert.equal(created.headers.get('location'), '/app');

  const shell = await (await client.get('/app')).text();
  assert.match(shell, /<div id="root">/);
  assert.match(shell, /\/assets\/app\.js/);

  // Who is signed in comes from the API rather than the shell.
  const me = JSON.parse(await (await client.get('/api/v1/me')).text()) as {
    user: { username: string };
    role: { name: string; isAdministrator: boolean };
    tabs: unknown[];
  };
  assert.equal(me.user.username, 'root');
  assert.equal(me.role.name, 'Administrator');
  assert.equal(me.role.isAdministrator, true);
  assert.deepEqual(me.tabs, []);

  // Setup is closed once it has been used.
  assert.equal((await client.get('/setup')).headers.get('location'), '/login');
  await close();
});

test('signed-out visitors are redirected to the sign-in page', async () => {
  const { base, close } = await serve();
  const setup = new Client(base);
  await setup.post('/setup', { username: 'root', email: 'r@e.com', password: 'correct horse' });

  const stranger = new Client(base);
  assert.equal((await stranger.get('/')).headers.get('location'), '/login');
  assert.equal((await stranger.get('/admin')).headers.get('location'), '/login');
  // The API refuses rather than redirecting; the client turns that into /login.
  assert.equal((await stranger.get('/api/v1/me')).status, 403);

  const failed = await stranger.post('/login', { username: 'root', password: 'nope' });
  assert.match(failed.headers.get('location') ?? '', /^\/login\?error=/);
  await close();
});

test('an administrator builds a table in setup and works it through the API', async () => {
  const { base, close } = await serve();
  const client = new Client(base);
  await client.post('/setup', { username: 'root', email: 'r@e.com', password: 'correct horse' });

  // Metadata is still the server-rendered setup console.
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
  const tableId = tablePath.split('/').pop() as string;

  const tablePage = await (await client.get(tablePath)).text();
  await client.post('/admin/fields', {
    _csrf: csrf(tablePage),
    tableId,
    name: 'amount',
    label: 'Amount',
    type: 'number',
  });

  // Records are the client's job, so they go through the API.
  const me = await client.json<{ csrfToken: string }>('/api/v1/me');
  const view = await client.json<{
    table: { label: string };
    fields: { name: string }[];
    canCreate: boolean;
  }>(`/api/v1/tables/${tableId}`);
  assert.equal(view.table.label, 'Invoice');
  assert.equal(view.canCreate, true);
  assert.deepEqual(
    view.fields.map((field) => field.name).sort(),
    ['amount', 'name'],
  );

  const created = await client.postJson(
    `/api/v1/tables/${tableId}/records`,
    { name: 'INV-1', amount: 125 },
    me.csrfToken,
  );
  assert.equal(created.status, 201);

  const listed = await client.json<{ records: { values: Record<string, unknown> }[] }>(
    `/api/v1/tables/${tableId}/records`,
  );
  assert.equal(listed.records.length, 1);
  assert.equal(listed.records[0]?.values['amount'], 125);
  await close();
});

test('the API refuses a mutation without the CSRF token', async () => {
  const { app, base, close } = await serve();
  const client = new Client(base);
  await client.post('/setup', { username: 'root', email: 'r@e.com', password: 'correct horse' });
  const admin = await app.auth.authenticate('root', 'correct horse');
  const std = (await app.metadata.listNamespaces(admin))[0];
  assert.ok(std);
  const table = await app.metadata.createTable(admin, { namespaceId: std.id, name: 'Note' });

  const forged = await client.postJson(
    `/api/v1/tables/${table.id}/records`,
    { name: 'Sneaky' },
    'not-the-token',
  );
  assert.equal(forged.status, 403);
  const body = JSON.parse(await forged.text()) as { error: string };
  // Errors come back as JSON on the API, not as a plain-text page.
  assert.match(body.error, /CSRF/i);
  assert.equal((await app.records.list(admin, table.id)).length, 0);
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
  assert.equal((await client.get('/')).headers.get('location'), '/login');
  assert.equal((await client.get('/api/v1/me')).status, 403);
  await close();
});

test('unknown paths are 404 and wrong methods are 405', async () => {
  const { base, close } = await serve();
  const client = new Client(base);
  assert.equal((await client.get('/nope')).status, 404);
  assert.equal((await client.post('/healthz', {})).status, 405);
  await close();
});

test('the rule form posts a multi-select and one access level per field', async () => {
  const { app, base, close } = await serve();
  const client = new Client(base);
  await client.post('/setup', { username: 'root', email: 'r@e.com', password: 'correct horse' });
  const admin = await app.auth.authenticate('root', 'correct horse');
  const std = (await app.metadata.listNamespaces(admin))[0];
  assert.ok(std);
  const table = await app.metadata.createTable(admin, { namespaceId: std.id, name: 'Thing' });
  const title = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'title',
    type: 'text' as never,
  });
  const internal = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'internalNote',
    type: 'text' as never,
  });

  const page = await (await client.get(`/admin/tables/${table.id}`)).text();
  // Every field on the table gets its own access picker.
  assert.match(page, new RegExp(`name="grant_${title.id}"`));
  assert.match(page, new RegExp(`name="grant_${internal.id}"`));

  await client.post('/admin/rules', {
    _csrf: csrf(page),
    tableId: table.id,
    name: 'Read and edit',
    accessTypes: ['read', 'edit'],
    clauseMatch: 'all',
    [`grant_${title.id}`]: 'edit',
    [`grant_${internal.id}`]: 'read',
  });

  const rules = await app.metadata.listSecurityRules(admin);
  assert.equal(rules.length, 1);
  // The multi-select posted both values.
  assert.deepEqual(rules[0]?.accessTypes.sort(), ['edit', 'read']);

  const described = await app.metadata.describeRulesFor(admin, table.id);
  assert.deepEqual(
    described[0]?.grants.map((grant) => [grant.field, grant.access]).sort(),
    [
      ['internalNote', FieldAccess.Read],
      ['title', FieldAccess.Edit],
    ].sort(),
  );

  // ...and the console shows what the rule exposes.
  const after = await (await client.get(`/admin/tables/${table.id}`)).text();
  assert.match(after, /read\+edit/);
  await close();
});

test('the API reports creation as unavailable where no rule permits it', async () => {
  const { app, base, close } = await serve();
  const admin = await app.install.completeSetup({
    username: 'root',
    email: 'r@e.com',
    password: 'correct horse',
  });
  const std = (await app.metadata.listNamespaces(admin))[0];
  assert.ok(std);
  const table = await app.metadata.createTable(admin, { namespaceId: std.id, name: 'Note' });
  const body = await app.metadata.createField(admin, {
    tableId: table.id,
    name: 'body',
    type: 'text' as never,
  });
  const nameField = (await app.security.listAllFields(admin, table.id)).find(
    (field) => field.name === 'name',
  );
  assert.ok(nameField);

  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Readers',
    parentId: admin.role.id,
  });
  const readOnly = await app.metadata.createSecurityRule(admin, {
    name: 'Read notes',
    tableId: table.id,
    accessTypes: ['read' as never],
    fieldGrants: [
      { fieldId: body.id, access: FieldAccess.Read },
      { fieldId: nameField.id, access: FieldAccess.Read },
    ],
  });
  await app.metadata.assignRuleToRole(admin, role.id, readOnly.id);
  await app.metadata.createUser(admin, {
    username: 'reader',
    email: 'reader@e.com',
    password: 'password123',
    securityRoleId: role.id,
  });

  const client = new Client(base);
  await client.post('/login', { username: 'reader', password: 'password123' });
  const me = await client.json<{ csrfToken: string }>('/api/v1/me');

  const view = await client.json<{ canCreate: boolean; creatableFields: string[] }>(
    `/api/v1/tables/${table.id}`,
  );
  // The client hides the button because the API says so...
  assert.equal(view.canCreate, false);
  assert.deepEqual(view.creatableFields, []);

  // ...and the answer does not depend on the client honouring that.
  const attempt = await client.postJson(
    `/api/v1/tables/${table.id}/records`,
    { name: 'Sneaky' },
    me.csrfToken,
  );
  assert.equal(attempt.status, 403);
  await close();
});

test('the API exposes a lookup field and the records it can point at', async () => {
  const { app, base, close } = await serve();
  const admin = await app.install.completeSetup({
    username: 'root',
    email: 'r@e.com',
    password: 'correct horse',
  });
  const std = (await app.metadata.listNamespaces(admin))[0];
  assert.ok(std);
  const account = await app.metadata.createTable(admin, {
    namespaceId: std.id,
    name: 'Account',
  });
  const contact = await app.metadata.createTable(admin, {
    namespaceId: std.id,
    name: 'Contact',
  });
  await app.metadata.createField(admin, {
    tableId: contact.id,
    name: 'account',
    type: 'reference' as never,
    referenceTableId: account.id,
  });
  const acme = await app.records.create(admin, account.id, { name: 'Acme' });

  const client = new Client(base);
  await client.post('/login', { username: 'root', password: 'correct horse' });
  const me = await client.json<{ csrfToken: string }>('/api/v1/me');

  // The field says which table it points at, which is how the client knows
  // where to fetch the picker's options from.
  const view = await client.json<{
    fields: { name: string; type: string; referenceTableId: string | null }[];
  }>(`/api/v1/tables/${contact.id}`);
  const lookup = view.fields.find((field) => field.name === 'account');
  assert.equal(lookup?.type, 'reference');
  assert.equal(lookup?.referenceTableId, account.id);

  const targets = await client.json<{ records: { id: string; values: Record<string, unknown> }[] }>(
    `/api/v1/tables/${account.id}/records`,
  );
  assert.deepEqual(
    targets.records.map((record) => record.values['name']),
    ['Acme'],
  );

  const created = await client.postJson(
    `/api/v1/tables/${contact.id}/records`,
    { name: 'Ada', account: acme.id },
    me.csrfToken,
  );
  assert.equal(created.status, 201);
  const { record } = JSON.parse(await created.text()) as {
    record: { id: string; values: Record<string, unknown> };
  };
  assert.equal(record.values['account'], acme.id);

  const detail = await client.json<{ record: { values: Record<string, unknown> } }>(
    `/api/v1/records/${record.id}`,
  );
  assert.equal(detail.record.values['account'], acme.id);
  await close();
});

test('namespace creation is hidden and refused unless the flag is set', async () => {
  const { app, base, close } = await serve();
  const client = new Client(base);
  await client.post('/setup', { username: 'root', email: 'r@e.com', password: 'correct horse' });

  const console_ = await (await client.get('/admin')).text();
  assert.doesNotMatch(console_, /action="\/admin\/namespaces"/);
  assert.match(console_, /arrive with a package/);

  // The bare POST is refused too, not just hidden.
  const refused = await client.post('/admin/namespaces', {
    _csrf: csrf(console_),
    name: 'acme',
  });
  assert.match(decodeURIComponent(refused.headers.get('location') ?? ''), /disabled/i);
  assert.deepEqual(
    (await app.metadata.listNamespaces(await app.auth.authenticate('root', 'correct horse'))).map(
      (namespace) => namespace.name,
    ),
    ['std'],
  );
  await close();
});

test('the flag turns namespace creation back on', async () => {
  const { app, base, close } = await serve({ namespaceCreation: true });
  const client = new Client(base);
  await client.post('/setup', { username: 'root', email: 'r@e.com', password: 'correct horse' });

  const console_ = await (await client.get('/admin')).text();
  assert.match(console_, /action="\/admin\/namespaces"/);
  await client.post('/admin/namespaces', { _csrf: csrf(console_), name: 'acme', label: 'Acme' });

  const admin = await app.auth.authenticate('root', 'correct horse');
  assert.deepEqual(
    (await app.metadata.listNamespaces(admin)).map((namespace) => namespace.name).sort(),
    ['acme', 'std'],
  );
  await close();
});

test('granting the same namespace access twice is not an error', async () => {
  const { app, base, close } = await serve({ namespaceCreation: true });
  const client = new Client(base);
  await client.post('/setup', { username: 'root', email: 'r@e.com', password: 'correct horse' });
  const admin = await app.auth.authenticate('root', 'correct horse');
  const acme = await app.metadata.createNamespace(admin, { name: 'acme' });
  const role = await app.metadata.createSecurityRole(admin, {
    name: 'Child',
    parentId: admin.role.id,
  });

  const page = await (await client.get('/admin')).text();
  const token = csrf(page);
  for (const _attempt of [1, 2]) {
    const response = await client.post('/admin/namespace-access', {
      _csrf: token,
      roleId: role.id,
      namespaceId: acme.id,
    });
    const location = decodeURIComponent(response.headers.get('location') ?? '');
    // Never a raw storage message such as "UNIQUE constraint failed".
    assert.doesNotMatch(location, /constraint/i);
    assert.match(location, /notice=/);
  }
  assert.equal((await app.metadata.listNamespaceAccess(admin)).length, 1);

  // ...and the console shows the grant, which is what made the repeat likely.
  const after = await (await client.get('/admin')).text();
  assert.match(after, /Child/);
  assert.match(after, /acme/);
  await close();
});

test('the role hierarchy page nests roles under their parents', async () => {
  const { app, base, close } = await serve();
  const client = new Client(base);
  await client.post('/setup', { username: 'root', email: 'r@e.com', password: 'correct horse' });
  const admin = await app.auth.authenticate('root', 'correct horse');

  const manager = await app.metadata.createSecurityRole(admin, {
    name: 'Manager',
    parentId: admin.role.id,
  });
  const rep = await app.metadata.createSecurityRole(admin, {
    name: 'Rep',
    parentId: manager.id,
  });
  await app.metadata.createUser(admin, {
    username: 'ricky',
    email: 'ricky@e.com',
    password: 'password123',
    securityRoleId: rep.id,
  });

  const tree = await (await client.get('/admin/roles')).text();
  // Administrator contains Manager contains Rep, in that nesting order.
  const administratorAt = tree.indexOf('Administrator');
  const managerAt = tree.indexOf('Manager');
  const repAt = tree.indexOf('Rep');
  assert.ok(administratorAt < managerAt && managerAt < repAt);
  assert.match(tree, /<ul[^>]*>[\s\S]*<ul>[\s\S]*<ul>/);
  assert.match(tree, /1 user/);
  assert.match(tree, /all access/);

  // It is administrative, like the rest of setup.
  const stranger = new Client(base);
  await stranger.post('/login', { username: 'ricky', password: 'password123' });
  assert.equal((await stranger.get('/admin/roles')).status, 403);
  await close();
});

test('the role page orders tabs top to bottom, with up and down controls', async () => {
  const { app, base, close } = await serve();
  const admin = await app.install.completeSetup({
    username: 'root',
    email: 'r@e.com',
    password: 'correct horse',
  });
  const std = (await app.metadata.listNamespaces(admin))[0];
  assert.ok(std);
  for (const name of ['Account', 'Contact', 'Invoice']) {
    const table = await app.metadata.createTable(admin, { namespaceId: std.id, name });
    await app.metadata.addRoleTab(admin, admin.role.id, table.id);
  }

  const client = new Client(base);
  await client.post('/login', { username: 'root', password: 'correct horse' });
  const rolePage = await (await client.get(`/admin/roles/${admin.role.id}`)).text();

  // The list runs top to bottom here, whatever the tab bar does.
  assert.match(rolePage, /aria-label="Move up"/);
  assert.match(rolePage, /aria-label="Move down"/);
  assert.doesNotMatch(rolePage, /&larr;|&rarr;/);
  // The ends are fixed: nothing above the first, nothing below the last.
  assert.equal((rolePage.match(/disabled/g) ?? []).length, 2);

  const tabIds = [...rolePage.matchAll(/action="\/admin\/tabs\/([^/]+)\/move"/g)].map(
    (match) => match[1] as string,
  );
  const last = tabIds[tabIds.length - 1] as string;

  await client.post(`/admin/tabs/${last}/move`, { _csrf: csrf(rolePage), direction: 'earlier' });
  const me = await client.json<{ tabs: { label: string }[] }>('/api/v1/me');
  assert.deepEqual(
    me.tabs.map((tab) => tab.label),
    ['Account', 'Invoice', 'Contact'],
  );
  await close();
});
