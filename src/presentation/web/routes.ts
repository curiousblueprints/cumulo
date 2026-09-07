import type { Application } from '../../app/Application.js';
import type { FeatureFlags } from '../../config.js';
import { DatabaseError, UniqueConstraintError } from '../../db/types.js';
import {
  AccessType,
  ClauseMatch,
  ClauseOperator,
  DAYS_OF_WEEK,
  FieldAccess,
  FieldType,
  MONTHS,
  NAME_FIELD,
  type FieldDef,
  type RecordView,
  type SecurityRole,
} from '../../domain/types.js';
import type { SecurityContext } from '../../security/context.js';
import { AccessDeniedError } from '../../security/errors.js';
import type { Router } from '../http/router.js';
import { clearedCookie, sessionCookie, type SessionStore } from '../http/sessions.js';
import { RedirectSignal } from '../http/signals.js';
import { html, redirect, type HttpRequest, type HttpResponse } from '../http/types.js';
import { labelForValue } from '../../security/values.js';
import { csrfInput, escapeHtml, optionList, page } from './layout.js';

/**
 * The HTML face of the platform.
 *
 * Handlers only ever call application services, never the store or the
 * database. Every mutation is a form POST guarded by the session's CSRF token.
 */
export function registerWebRoutes(
  router: Router,
  app: Application,
  sessions: SessionStore,
  features: FeatureFlags,
): void {
  const requireUser = (request: HttpRequest): SecurityContext => {
    if (!request.context) throw new RedirectSignal('/login');
    return request.context;
  };

  const checkCsrf = (request: HttpRequest): void => {
    const expected = request.session?.csrfToken;
    if (!expected || request.body['_csrf'] !== expected) {
      throw new AccessDeniedError('Invalid or expired form token; please try again');
    }
  };

  /** POST helper: run the action, then land somewhere with a message. */
  const action = (
    run: (request: HttpRequest) => Promise<string>,
    fallback: (request: HttpRequest) => string,
  ) =>
    async (request: HttpRequest): Promise<HttpResponse> => {
      const target = fallback(request);
      try {
        checkCsrf(request);
        const notice = await run(request);
        return redirect(withMessage(target, 'notice', notice));
      } catch (error) {
        if (error instanceof RedirectSignal) return redirect(error.location);
        return redirect(withMessage(target, 'error', messageOf(error)));
      }
    };

  router.get('/', async (request) => {
    if (!(await app.install.isSetupComplete())) return redirect('/setup');
    return redirect(request.context ? '/tables' : '/login');
  });

  // --- initial setup -----------------------------------------------------

  router.get('/setup', async (request) => {
    if (await app.install.isSetupComplete()) return redirect('/login');
    return html(
      page(
        { title: 'Set up Cumulo', ...messages(request) },
        `<h1>Welcome to Cumulo</h1>
         <p class="lede">This installation has no users yet. The first user is created with the
           <strong>Administrator</strong> role, which sits at the top of the role hierarchy and
           therefore holds every permission on the installation.</p>
         <section class="card"><form method="post" action="/setup">
           <div class="row">
             <div><label for="username">Username</label>
               <input id="username" name="username" required minlength="3" autocomplete="username"></div>
             <div><label for="email">Email</label>
               <input id="email" name="email" type="email" required></div>
           </div>
           <label for="password">Password</label>
           <input id="password" name="password" type="password" required minlength="8"
             autocomplete="new-password">
           <button>Create administrator</button>
         </form></section>`,
      ),
    );
  });

  // Setup runs before any session exists, so it cannot carry a CSRF token;
  // it is protected instead by only working while there are zero users.
  router.post('/setup', async (request) => {
    try {
      const context = await app.install.completeSetup({
        username: request.body['username'] ?? '',
        email: request.body['email'] ?? '',
        password: request.body['password'] ?? '',
      });
      const session = sessions.create(context.user.id);
      return redirect('/tables', { 'set-cookie': sessionCookie(session.id) });
    } catch (error) {
      return redirect(withMessage('/setup', 'error', messageOf(error)));
    }
  });

  // --- authentication ----------------------------------------------------

  router.get('/login', async (request) => {
    if (!(await app.install.isSetupComplete())) return redirect('/setup');
    if (request.context) return redirect('/tables');
    return html(
      page(
        { title: 'Sign in', ...messages(request) },
        `<h1>Sign in</h1>
         <section class="card"><form method="post" action="/login">
           <label for="username">Username</label>
           <input id="username" name="username" required autocomplete="username">
           <label for="password">Password</label>
           <input id="password" name="password" type="password" required autocomplete="current-password">
           <button>Sign in</button>
         </form></section>`,
      ),
    );
  });

  router.post('/login', async (request) => {
    try {
      const context = await app.auth.authenticate(
        request.body['username'] ?? '',
        request.body['password'] ?? '',
      );
      const session = sessions.create(context.user.id);
      return redirect('/tables', { 'set-cookie': sessionCookie(session.id) });
    } catch (error) {
      return redirect(withMessage('/login', 'error', messageOf(error)));
    }
  });

  router.post('/logout', async (request) => {
    sessions.destroy(request.session?.id);
    return redirect('/login', { 'set-cookie': clearedCookie() });
  });

  // --- data --------------------------------------------------------------

  router.get('/tables', async (request) => {
    const context = requireUser(request);
    const tables = await app.metadata.listTables(context);
    const namespaces = await app.metadata.listNamespaces(context);
    const namespaceName = (id: string): string =>
      namespaces.find((namespace) => namespace.id === id)?.name ?? '';

    const rows = tables
      .map(
        (table) =>
          `<tr><td><a href="/tables/${escapeHtml(table.id)}">${escapeHtml(table.label)}</a></td>
             <td><code>${escapeHtml(namespaceName(table.namespaceId))}.${escapeHtml(table.name)}</code></td></tr>`,
      )
      .join('');

    return html(
      page(
        { title: 'Data', context, ...messages(request) },
        `<h1>Data</h1>
         <p class="lede">Tables your security role can reach.</p>
         ${
           tables.length === 0
             ? `<section class="card"><p class="muted">No tables are visible to the
                 <strong>${escapeHtml(context.role.name)}</strong> role.${
                   context.role.isSystem
                     ? ' <a href="/admin">Create one in Setup</a>.'
                     : ' A rule granting access has to be assigned to your role first.'
                 }</p></section>`
             : `<section class="card"><table><thead><tr><th>Table</th><th>API name</th></tr></thead>
                 <tbody>${rows}</tbody></table></section>`
         }`,
      ),
    );
  });

  router.get('/tables/:tableId', async (request) => {
    const context = requireUser(request);
    const tableId = request.params['tableId'] as string;
    const table = await app.security.getTable(context, tableId);
    const fields = await app.metadata.listReadableFields(context, table.id);
    const records = await app.records.list(context, table.id, { limit: 200 });
    const mayCreate = await app.security.canCreate(context, table.id);

    const header = fields.map((field) => `<th>${escapeHtml(field.label)}</th>`).join('');
    const rows = records
      .map(
        (record) =>
          `<tr><td><a href="/records/${escapeHtml(record.id)}">Open</a></td>${fields
            .map((field) => `<td>${cell(field, record.values[field.name])}</td>`)
            .join('')}</tr>`,
      )
      .join('');

    return html(
      page(
        { title: table.label, context, ...messages(request) },
        `<h1>${escapeHtml(table.label)}</h1>
         <p class="lede">${records.length} record${records.length === 1 ? '' : 's'} visible to you.
           ${
             mayCreate
               ? `<a href="/tables/${escapeHtml(table.id)}/new">New record</a>`
               : ''
           }</p>
         <section class="card"><table><thead><tr><th></th>${header}</tr></thead>
           <tbody>${rows || `<tr><td colspan="${fields.length + 1}" class="muted">Nothing to show.</td></tr>`}</tbody>
         </table></section>`,
      ),
    );
  });

  router.get('/tables/:tableId/new', async (request) => {
    const context = requireUser(request);
    const tableId = request.params['tableId'] as string;
    const table = await app.security.getTable(context, tableId);
    if (!(await app.security.canCreate(context, table.id))) {
      throw new AccessDeniedError(`No permission to create records in "${table.label}"`);
    }
    const fields = await app.security.listCreatableFields(context, table.id);
    const lookups = await lookupOptions(app, context, fields);

    return html(
      page(
        { title: `New ${table.label}`, context, ...messages(request) },
        `<h1>New ${escapeHtml(table.label)}</h1>
         <section class="card"><form method="post" action="/tables/${escapeHtml(table.id)}/records">
           ${csrfInput(request.session?.csrfToken)}
           ${fields.map((field) => fieldInput(field, null, lookups)).join('')}
           <button>Create</button>
           <a class="button secondary" href="/tables/${escapeHtml(table.id)}">Cancel</a>
         </form></section>`,
      ),
    );
  });

  router.post(
    '/tables/:tableId/records',
    action(
      async (request) => {
        const context = requireUser(request);
        const tableId = request.params['tableId'] as string;
        const table = await app.security.getTable(context, tableId);
        const fields = await app.security.listCreatableFields(context, table.id);
        const record = await app.records.create(context, table.id, valuesFrom(request, fields));
        throw new RedirectSignal(withMessage(`/records/${record.id}`, 'notice', 'Record created'));
      },
      (request) => `/tables/${request.params['tableId'] ?? ''}/new`,
    ),
  );

  router.get('/records/:recordId', async (request) => {
    const context = requireUser(request);
    const recordId = request.params['recordId'] as string;
    const record = await app.records.get(context, recordId);
    const table = await app.security.getTable(context, record.tableId);
    const fields = await app.security.listEditableFields(context, table.id);
    const readable = await app.metadata.listReadableFields(context, table.id);
    const lookups = await lookupOptions(app, context, fields);

    const details = readable
      .map(
        (field) =>
          `<tr><th>${escapeHtml(field.label)}</th><td>${cell(
            field,
            record.values[field.name],
          )}</td></tr>`,
      )
      .join('');

    return html(
      page(
        { title: table.label, context, ...messages(request) },
        `<h1>${escapeHtml(table.label)}</h1>
         <p class="lede"><a href="/tables/${escapeHtml(table.id)}">Back to ${escapeHtml(
           table.label,
         )}</a> &middot; <code>${escapeHtml(record.id)}</code></p>
         <section class="card"><table><tbody>${details}
           <tr><th>Created</th><td>${escapeHtml(record.createdAt)}</td></tr>
           <tr><th>Updated</th><td>${escapeHtml(record.updatedAt)}</td></tr></tbody></table></section>
         ${
           fields.length > 0
             ? `<h2>Edit</h2><section class="card">
                <form method="post" action="/records/${escapeHtml(record.id)}">
                  ${csrfInput(request.session?.csrfToken)}
                  ${fields
                    .map((field) => fieldInput(field, record.values[field.name], lookups))
                    .join('')}
                  <button>Save</button>
                </form>
                <form method="post" action="/records/${escapeHtml(record.id)}/delete">
                  ${csrfInput(request.session?.csrfToken)}
                  <button class="danger">Delete record</button>
                </form></section>`
             : '<p class="muted">You have read-only access to this record.</p>'
         }`,
      ),
    );
  });

  router.post(
    '/records/:recordId',
    action(
      async (request) => {
        const context = requireUser(request);
        const recordId = request.params['recordId'] as string;
        const record = await app.records.get(context, recordId);
        const fields = await app.security.listEditableFields(context, record.tableId);
        await app.records.update(context, record.id, valuesFrom(request, fields));
        return 'Record saved';
      },
      (request) => `/records/${request.params['recordId'] ?? ''}`,
    ),
  );

  router.post(
    '/records/:recordId/delete',
    action(
      async (request) => {
        const context = requireUser(request);
        const recordId = request.params['recordId'] as string;
        const record = await app.records.get(context, recordId);
        await app.records.delete(context, record.id);
        throw new RedirectSignal(
          withMessage(`/tables/${record.tableId}`, 'notice', 'Record deleted'),
        );
      },
      (request) => `/records/${request.params['recordId'] ?? ''}`,
    ),
  );

  registerAdminRoutes(router, app, { requireUser, action, features });
}

// --- setup / administration ---------------------------------------------

interface AdminHelpers {
  features: FeatureFlags;
  requireUser: (request: HttpRequest) => SecurityContext;
  action: (
    run: (request: HttpRequest) => Promise<string>,
    fallback: (request: HttpRequest) => string,
  ) => (request: HttpRequest) => Promise<HttpResponse>;
}

function registerAdminRoutes(router: Router, app: Application, helpers: AdminHelpers): void {
  const { requireUser, action, features } = helpers;

  router.get('/admin', async (request) => {
    const context = requireUser(request);
    app.security.assertAdministrator(context);

    const [namespaces, roles, users, tables, rules, namespaceAccess, roleRules] =
      await Promise.all([
        app.metadata.listNamespaces(context),
        app.metadata.listSecurityRoles(context),
        app.metadata.listUsers(context),
        app.metadata.listTables(context),
        app.metadata.listSecurityRules(context),
        app.metadata.listNamespaceAccess(context),
        app.metadata.listRoleRules(context),
      ]);
    const token = request.session?.csrfToken;
    const roleName = (id: string): string => roles.find((role) => role.id === id)?.name ?? '';
    const tableName = (id: string): string => tables.find((table) => table.id === id)?.label ?? '';
    const customRoles = roles.filter((role) => !role.isSystem);

    return html(
      page(
        { title: 'Setup', context, ...messages(request) },
        `<h1>Setup</h1>
         <p class="lede">Namespaces, roles, users, tables and security rules.</p>

         <h2>Namespaces</h2>
         <section class="card">
           <table><thead><tr><th>Name</th><th>Label</th><th>Kind</th></tr></thead><tbody>
             ${namespaces
               .map(
                 (namespace) =>
                   `<tr><td><code>${escapeHtml(namespace.name)}</code></td><td>${escapeHtml(
                     namespace.label,
                   )}</td><td class="muted">${namespace.isSystem ? 'system' : 'package'}</td></tr>`,
               )
               .join('')}
           </tbody></table>
           ${
             features.namespaceCreation
               ? `<p class="muted">Namespace creation is enabled for testing
                    (<code>CUMULO_ENABLE_NAMESPACE_CREATION</code>).</p>
                  <form method="post" action="/admin/namespaces">${csrfInput(token)}
                    <div class="row">
                      <div><label>API name</label><input name="name" required></div>
                      <div><label>Label</label><input name="label"></div>
                    </div><button>Add namespace</button></form>`
               : `<p class="muted">Namespaces arrive with a package rather than by hand, so
                    there is nothing to add here yet.</p>`
           }
         </section>

         <h2>Security roles</h2>
         <section class="card">
           <table><thead><tr><th>Role</th><th>Parent</th></tr></thead><tbody>
             ${roles
               .map(
                 (role) =>
                   `<tr><td>${escapeHtml(role.name)}${
                     role.isSystem ? ' <span class="muted">(system)</span>' : ''
                   }</td><td class="muted">${
                     role.parentId ? escapeHtml(roleName(role.parentId)) : '&mdash;'
                   }</td></tr>`,
               )
               .join('')}
           </tbody></table>
           <p class="muted">A role inherits the access of every role beneath it, which is why
             Administrator &mdash; the only role without a parent &mdash; sees everything.
             <a href="/admin/roles">View the hierarchy</a>.</p>
           <form method="post" action="/admin/roles">${csrfInput(token)}
             <div class="row">
               <div><label>Name</label><input name="name" required></div>
               <div><label>Parent role</label><select name="parentId" required>
                 ${optionList(roles.map((role) => ({ id: role.id, label: role.name })))}
               </select></div>
             </div><button>Add role</button></form>
         </section>

         <h2>Namespace access</h2>
         <section class="card">
           <p class="muted">Every role can reach <code>std</code>. Other namespaces need a grant.</p>
           <table><thead><tr><th>Role</th><th>Namespace</th></tr></thead><tbody>
             ${
               namespaceAccess
                 .map(
                   (access) =>
                     `<tr><td>${escapeHtml(roleName(access.securityRoleId))}</td>
                        <td><code>${escapeHtml(
                          namespaces.find((namespace) => namespace.id === access.namespaceId)
                            ?.name ?? '',
                        )}</code></td></tr>`,
                 )
                 .join('') ||
               '<tr><td colspan="2" class="muted">No grants yet, and none needed for std.</td></tr>'
             }
           </tbody></table>
           <form method="post" action="/admin/namespace-access">${csrfInput(token)}
             <div class="row">
               <div><label>Role</label><select name="roleId" required>
                 ${optionList(customRoles.map((role) => ({ id: role.id, label: role.name })))}
               </select></div>
               <div><label>Namespace</label><select name="namespaceId" required>
                 ${optionList(
                   namespaces
                     .filter((namespace) => !namespace.isSystem)
                     .map((namespace) => ({ id: namespace.id, label: namespace.name })),
                 )}
               </select></div>
             </div><button>Grant access</button></form>
         </section>

         <h2>Users</h2>
         <section class="card">
           <table><thead><tr><th>Username</th><th>Email</th><th>Role</th><th>Status</th></tr></thead><tbody>
             ${users
               .map(
                 (user) =>
                   `<tr><td>${escapeHtml(user.username)}</td><td>${escapeHtml(
                     user.email,
                   )}</td><td>${escapeHtml(roleName(user.securityRoleId))}</td><td class="muted">${
                     user.isActive ? 'active' : 'inactive'
                   }</td></tr>`,
               )
               .join('')}
           </tbody></table>
           <form method="post" action="/admin/users">${csrfInput(token)}
             <div class="row">
               <div><label>Username</label><input name="username" required minlength="3"></div>
               <div><label>Email</label><input name="email" type="email" required></div>
             </div>
             <div class="row">
               <div><label>Password</label><input name="password" type="password" required minlength="8"></div>
               <div><label>Role</label><select name="securityRoleId" required>
                 ${optionList(roles.map((role) => ({ id: role.id, label: role.name })))}
               </select></div>
             </div><button>Add user</button></form>
         </section>

         <h2>Tables</h2>
         <section class="card">
           <table><thead><tr><th>Table</th><th>Namespace</th></tr></thead><tbody>
             ${tables
               .map(
                 (table) =>
                   `<tr><td><a href="/admin/tables/${escapeHtml(table.id)}">${escapeHtml(
                     table.label,
                   )}</a></td><td class="muted"><code>${escapeHtml(
                     namespaces.find((namespace) => namespace.id === table.namespaceId)?.name ?? '',
                   )}</code></td></tr>`,
               )
               .join('')}
           </tbody></table>
           <form method="post" action="/admin/tables">${csrfInput(token)}
             <div class="row">
               <div><label>API name</label><input name="name" required></div>
               <div><label>Label</label><input name="label"></div>
               <div><label>Namespace</label><select name="namespaceId" required>
                 ${optionList(namespaces.map((namespace) => ({ id: namespace.id, label: namespace.name })))}
               </select></div>
               <div><label>Name field</label><select name="nameFieldType">
                 <option value="${FieldType.Text}">Free text</option>
                 <option value="${FieldType.AutoNumber}">Auto number</option>
               </select></div>
             </div>
             <p class="muted">Every table gets a Name field, which is how a record is
               referred to elsewhere. It cannot be deleted.</p>
             <button>Add table</button></form>
         </section>

         <h2>Security rules</h2>
         <section class="card">
           <table><thead><tr><th>Rule</th><th>Table</th><th>Record access</th><th>Create</th>
             <th>Match</th></tr></thead><tbody>
             ${
               rules
                 .map(
                   (rule) =>
                     `<tr><td>${escapeHtml(rule.name)}</td><td>${escapeHtml(
                       tableName(rule.tableId),
                     )}</td><td class="muted">${escapeHtml(
                       rule.accessTypes.join(', ') || '&mdash;',
                     )}</td><td class="muted">${rule.canCreate ? 'yes' : 'no'}</td>` +
                     `<td class="muted">${escapeHtml(rule.clauseMatch)}</td></tr>`,
                 )
                 .join('') || '<tr><td colspan="5" class="muted">No rules yet.</td></tr>'
             }
           </tbody></table>
           <p class="muted">Build a rule on a table&rsquo;s page, then assign it to a role here.</p>
           <table><thead><tr><th>Role</th><th>Rule</th></tr></thead><tbody>
             ${
               roleRules
                 .map(
                   (link) =>
                     `<tr><td>${escapeHtml(roleName(link.securityRoleId))}</td>
                        <td>${escapeHtml(
                          rules.find((rule) => rule.id === link.securityRuleId)?.name ?? '',
                        )}</td></tr>`,
                 )
                 .join('') ||
               '<tr><td colspan="2" class="muted">No rules assigned to any role yet.</td></tr>'
             }
           </tbody></table>
           <form method="post" action="/admin/role-rules">${csrfInput(token)}
             <div class="row">
               <div><label>Role</label><select name="roleId" required>
                 ${optionList(customRoles.map((role) => ({ id: role.id, label: role.name })))}
               </select></div>
               <div><label>Rule</label><select name="ruleId" required>
                 ${optionList(rules.map((rule) => ({ id: rule.id, label: rule.name })))}
               </select></div>
             </div><button>Assign rule to role</button></form>
         </section>`,
      ),
    );
  });

  router.get('/admin/roles', async (request) => {
    const context = requireUser(request);
    app.security.assertAdministrator(context);

    const [roles, users, namespaces, namespaceAccess, roleRules, rules] = await Promise.all([
      app.metadata.listSecurityRoles(context),
      app.metadata.listUsers(context),
      app.metadata.listNamespaces(context),
      app.metadata.listNamespaceAccess(context),
      app.metadata.listRoleRules(context),
      app.metadata.listSecurityRules(context),
    ]);

    const countBy = <T,>(items: T[], roleId: string, of: (item: T) => string): number =>
      items.filter((item) => of(item) === roleId).length;

    const renderRole = (role: SecurityRole): string => {
      const children = roles.filter((other) => other.parentId === role.id);
      const grants = namespaceAccess
        .filter((access) => access.securityRoleId === role.id)
        .map(
          (access) =>
            namespaces.find((namespace) => namespace.id === access.namespaceId)?.name ?? '',
        );
      const ruleCount = countBy(roleRules, role.id, (link) => link.securityRoleId);
      const userCount = countBy(users, role.id, (user) => user.securityRoleId);

      // Escaped one fact at a time, so the separator stays an entity rather
      // than being escaped into visible text.
      const facts = [
        `${userCount} user${userCount === 1 ? '' : 's'}`,
        role.isSystem ? 'all access' : `${ruleCount} rule${ruleCount === 1 ? '' : 's'}`,
        ...(grants.length > 0 ? [`namespaces: ${grants.join(', ')}`] : []),
      ]
        .map(escapeHtml)
        .join(' &middot; ');

      return `<li>
        <strong>${escapeHtml(role.name)}</strong>${
          role.isSystem ? ' <span class="muted">(system)</span>' : ''
        }
        <span class="muted">&mdash; ${facts}</span>
        ${children.length > 0 ? `<ul>${children.map((child) => renderRole(child)).join('')}</ul>` : ''}
      </li>`;
    };

    // Administrator is the root; anything orphaned is listed after it so a
    // broken parent link cannot make a role disappear from this page.
    const roots = roles.filter(
      (role) => role.parentId === null || !roles.some((other) => other.id === role.parentId),
    );

    return html(
      page(
        { title: 'Role hierarchy', context, ...messages(request) },
        `<h1>Role hierarchy</h1>
         <p class="lede"><a href="/admin">Back to setup</a> &middot;
           ${rules.length} rule${rules.length === 1 ? '' : 's'} defined.</p>
         <section class="card">
           <p class="muted">Access flows <strong>up</strong> this tree: a role holds its own
             rules plus every rule of every role beneath it. That is why Administrator, at the
             root with no rules of its own, holds everything.</p>
           <ul class="tree">${roots.map((role) => renderRole(role)).join('')}</ul>
         </section>`,
      ),
    );
  });

  router.get('/admin/tables/:tableId', async (request) => {
    const context = requireUser(request);
    app.security.assertAdministrator(context);
    const tableId = request.params['tableId'] as string;
    const table = await app.security.getTable(context, tableId);
    const fields = await app.security.listAllFields(context, table.id);
    const token = request.session?.csrfToken;
    const fieldOptions = fields.map((field) => ({ id: field.id, label: field.name }));
    const tables = await app.metadata.listTables(context);
    const tableRules = await app.metadata.describeRulesFor(context, table.id);

    return html(
      page(
        { title: table.label, context, ...messages(request) },
        `<h1>${escapeHtml(table.label)}</h1>
         <p class="lede"><a href="/admin">Back to setup</a> &middot;
           <a href="/tables/${escapeHtml(table.id)}">View data</a></p>

         <h2>Fields</h2>
         <section class="card">
           <table><thead><tr><th>Name</th><th>Label</th><th>Type</th><th>Required</th>
             <th></th></tr></thead><tbody>
             ${
               fields
                 .map(
                   (field) =>
                     `<tr><td><code>${escapeHtml(field.name)}</code></td><td>${escapeHtml(
                       field.label,
                     )}</td><td class="muted">${escapeHtml(fieldTypeLabel(field.type))}${
                       field.referenceTableId
                         ? ` &rarr; ${escapeHtml(
                             tables.find((other) => other.id === field.referenceTableId)?.label ??
                               '',
                           )}`
                         : ''
                     }</td><td class="muted">${field.isRequired ? 'yes' : 'no'}</td>
                     <td>${
                       field.isSystem
                         ? '<span class="muted">system</span>'
                         : `<form method="post" action="/admin/fields/${escapeHtml(
                             field.id,
                           )}/delete" class="inline">${csrfInput(token)}
                              <button class="danger" style="margin:0">Delete</button></form>`
                     }</td></tr>`,
                 )
                 .join('') || '<tr><td colspan="5" class="muted">No fields yet.</td></tr>'
             }
           </tbody></table>
           <form method="post" action="/admin/fields">${csrfInput(token)}
             <input type="hidden" name="tableId" value="${escapeHtml(table.id)}">
             <div class="row">
               <div><label>API name</label><input name="name" required></div>
               <div><label>Label</label><input name="label"></div>
               <div><label>Type</label><select name="type">
                 ${optionList(
                   Object.values(FieldType)
                     .filter((type) => type !== FieldType.AutoNumber)
                     .map((type) => ({ id: type, label: fieldTypeLabel(type) })),
                 )}
               </select></div>
             </div>
             <div class="row">
               <div><label>Looked-up table (lookup fields only; may be this table)</label>
                 <select name="referenceTableId">
                   <option value="">&mdash;</option>
                   ${optionList(tables.map((other) => ({ id: other.id, label: other.label })))}
                 </select></div>
               <div><label>Required</label><select name="isRequired">
                 <option value="">No</option><option value="on">Yes</option></select></div>
             </div>
             <button>Add field</button></form>
         </section>

         <h2>Rules on this table</h2>
         <section class="card">
           <table><thead><tr><th>Rule</th><th>Record access</th><th>Create</th>
             <th>Field access</th></tr></thead><tbody>
             ${
               tableRules
                 .map(
                   (entry) =>
                     `<tr><td>${escapeHtml(entry.rule.name)}</td>
                        <td class="muted">${escapeHtml(
                          entry.rule.accessTypes.join(', ') || '—',
                        )}</td>
                        <td class="muted">${entry.rule.canCreate ? 'yes' : 'no'}</td>
                        <td class="muted">${
                          entry.grants
                            .map(
                              (grant) =>
                                `<code>${escapeHtml(grant.field)}</code> ${escapeHtml(
                                  grant.access === FieldAccess.Edit ? 'read+edit' : 'read',
                                )}`,
                            )
                            .join('<br>') || 'no fields granted'
                        }</td></tr>`,
                 )
                 .join('') || '<tr><td colspan="4" class="muted">No rules on this table.</td></tr>'
             }
           </tbody></table>
         </section>

         <h2>New security rule</h2>
         <section class="card">
           <p class="muted">A rule grants access to records of this table that satisfy its clauses,
             and to the fields it names. Leave the clauses empty to cover every record.</p>
           <form method="post" action="/admin/rules">${csrfInput(token)}
             <input type="hidden" name="tableId" value="${escapeHtml(table.id)}">
             <label>Rule name</label><input name="name" required>
             <div class="row">
               <div><label>Record access (per record, gated by the clauses)</label>
                 <select name="accessTypes" multiple size="3">
                   ${optionList(
                     Object.values(AccessType).map((access) => ({ id: access, label: access })),
                   )}
                 </select>
                 <label>Create (whole table; the clauses do not apply)</label>
                 <select name="canCreate">
                   <option value="">No</option><option value="on">Yes</option>
                 </select></div>
               <div><label>Clause matching</label><select name="clauseMatch">
                 ${optionList(Object.values(ClauseMatch).map((match) => ({ id: match, label: match })))}
               </select>
               <label>Custom logic (e.g. <code>1 AND (2 OR 3)</code>)</label>
               <input name="clauseLogic" placeholder="only used when matching is custom"></div>
             </div>
             <h2>Field access</h2>
             <p class="muted">Each field is granted separately. Read-only makes a field visible;
               editable also lets it be written, which needs the rule to grant edit or create.</p>
             <table><thead><tr><th>Field</th><th>Access</th></tr></thead><tbody>
               ${
                 fields
                   .map(
                     (field) =>
                       `<tr><td><code>${escapeHtml(field.name)}</code>
                          <span class="muted">${escapeHtml(field.type)}</span></td>
                        <td><select name="${GRANT_PREFIX}${escapeHtml(field.id)}" style="margin:0">
                          <option value="" selected>No access</option>
                          <option value="${FieldAccess.Read}">Read only</option>
                          <option value="${FieldAccess.Edit}">Read and edit</option>
                        </select></td></tr>`,
                   )
                   .join('') ||
                 '<tr><td colspan="2" class="muted">Add a field first.</td></tr>'
               }
             </tbody></table>
             ${[1, 2, 3]
               .map(
                 (index) => `<h2>Clause ${index}</h2>
               <div class="row">
                 <div><label>Field</label><select name="clause${index}Field">
                   <option value="">&mdash; no clause &mdash;</option>${optionList(fieldOptions)}
                 </select></div>
                 <div><label>Operator</label><select name="clause${index}Operator">
                   ${optionList(
                     Object.values(ClauseOperator).map((operator) => ({
                       id: operator,
                       label: operator,
                     })),
                   )}
                 </select></div>
                 <div><label>Target value</label>
                   <input name="clause${index}Value" placeholder="$user.id, 0, ..."></div>
                 <div><label>&hellip; or compare to field</label>
                   <select name="clause${index}CompareField">
                     <option value="">&mdash;</option>${optionList(fieldOptions)}
                   </select></div>
               </div>`,
               )
               .join('')}
             <button>Create rule</button>
           </form>
         </section>`,
      ),
    );
  });

  const adminAction = (run: (request: HttpRequest, context: SecurityContext) => Promise<string>) =>
    action(async (request) => {
      const context = requireUser(request);
      app.security.assertAdministrator(context);
      return run(request, context);
    }, backTo);

  router.post(
    '/admin/namespaces',
    adminAction(async (request, context) => {
      // The form is hidden without the flag; refuse the bare POST as well.
      if (!features.namespaceCreation) {
        throw new AccessDeniedError(
          'Namespace creation is disabled. Set CUMULO_ENABLE_NAMESPACE_CREATION to enable it.',
        );
      }
      await app.metadata.createNamespace(context, {
        name: request.body['name'] ?? '',
        label: request.body['label'] ?? '',
      });
      return 'Namespace created';
    }),
  );

  router.post(
    '/admin/roles',
    adminAction(async (request, context) => {
      await app.metadata.createSecurityRole(context, {
        name: request.body['name'] ?? '',
        parentId: request.body['parentId'] ?? '',
      });
      return 'Role created';
    }),
  );

  router.post(
    '/admin/namespace-access',
    adminAction(async (request, context) => {
      const result = await app.metadata.grantNamespaceAccess(
        context,
        request.body['roleId'] ?? '',
        request.body['namespaceId'] ?? '',
      );
      return result.created
        ? 'Namespace access granted'
        : 'That role already had access to that namespace';
    }),
  );

  router.post(
    '/admin/users',
    adminAction(async (request, context) => {
      await app.metadata.createUser(context, {
        username: request.body['username'] ?? '',
        email: request.body['email'] ?? '',
        password: request.body['password'] ?? '',
        securityRoleId: request.body['securityRoleId'] ?? '',
      });
      return 'User created';
    }),
  );

  router.post(
    '/admin/tables',
    adminAction(async (request, context) => {
      const table = await app.metadata.createTable(context, {
        namespaceId: request.body['namespaceId'] ?? '',
        name: request.body['name'] ?? '',
        label: request.body['label'] ?? '',
        nameFieldType:
          request.body['nameFieldType'] === FieldType.AutoNumber
            ? FieldType.AutoNumber
            : FieldType.Text,
      });
      throw new RedirectSignal(
        withMessage(`/admin/tables/${table.id}`, 'notice', 'Table created; now add fields'),
      );
    }),
  );

  router.post(
    '/admin/fields',
    adminAction(async (request, context) => {
      const tableId = request.body['tableId'] ?? '';
      await app.metadata.createField(context, {
        tableId,
        name: request.body['name'] ?? '',
        label: request.body['label'] ?? '',
        type: (request.body['type'] ?? FieldType.Text) as FieldType,
        isRequired: request.body['isRequired'] === 'on',
        referenceTableId: request.body['referenceTableId'] || null,
      });
      return 'Field created';
    }),
  );

  router.post(
    '/admin/fields/:fieldId/delete',
    adminAction(async (request, context) => {
      await app.metadata.deleteField(context, request.params['fieldId'] ?? '');
      return 'Field deleted';
    }),
  );

  router.post(
    '/admin/rules',
    adminAction(async (request, context) => {
      const body = request.body;
      const clauses = [1, 2, 3]
        .map((index) => ({
          fieldId: body[`clause${index}Field`] ?? '',
          operator: (body[`clause${index}Operator`] ?? ClauseOperator.Equals) as ClauseOperator,
          targetValue: body[`clause${index}Value`] || null,
          compareFieldId: body[`clause${index}CompareField`] || null,
        }))
        .filter((clause) => clause.fieldId.length > 0);

      await app.metadata.createSecurityRule(context, {
        name: body['name'] ?? '',
        tableId: body['tableId'] ?? '',
        accessTypes: multi(request, 'accessTypes') as AccessType[],
        canCreate: body['canCreate'] === 'on',
        clauseMatch: (body['clauseMatch'] ?? ClauseMatch.All) as ClauseMatch,
        clauseLogic: body['clauseLogic'] || null,
        clauses,
        // One select per field, so each grant carries its own access level.
        fieldGrants: Object.entries(body)
          .filter(([key, value]) => key.startsWith(GRANT_PREFIX) && value.length > 0)
          .map(([key, value]) => ({
            fieldId: key.slice(GRANT_PREFIX.length),
            access: value as FieldAccess,
          })),
      });
      return 'Rule created';
    }),
  );

  router.post(
    '/admin/role-rules',
    adminAction(async (request, context) => {
      const result = await app.metadata.assignRuleToRole(
        context,
        request.body['roleId'] ?? '',
        request.body['ruleId'] ?? '',
      );
      return result.created
        ? 'Rule assigned to role'
        : 'That rule was already assigned to that role';
    }),
  );
}

// --- helpers -------------------------------------------------------------

/** Form-field prefix carrying one field's grant on the rule form. */
const GRANT_PREFIX = 'grant_';

/** One selectable target per lookup field, keyed by field id. */
type LookupOptions = Map<string, { id: string; label: string }[]>;

/**
 * Load the records a lookup field can point at, through the security layer, so
 * the picker only ever offers records the user can actually see.
 */
async function lookupOptions(
  app: Application,
  context: SecurityContext,
  fields: FieldDef[],
): Promise<LookupOptions> {
  const options: LookupOptions = new Map();
  for (const field of fields) {
    if (field.type !== FieldType.Reference || !field.referenceTableId) continue;
    try {
      const targets = await app.records.list(context, field.referenceTableId, { limit: 200 });
      const labelFields = await app.metadata.listReadableFields(context, field.referenceTableId);
      options.set(
        field.id,
        targets.map((target) => ({ id: target.id, label: recordLabel(target, labelFields) })),
      );
    } catch {
      // No access to the looked-up table: offer nothing rather than failing
      // the whole page. Typing an id is still refused by the security layer.
      options.set(field.id, []);
    }
  }
  return options;
}

/** How a record reads in a picker: its Name, or the first thing that will do. */
function recordLabel(record: RecordView, fields: FieldDef[]): string {
  const named = fields.find((field) => field.name === NAME_FIELD);
  const ordered = named ? [named, ...fields.filter((field) => field !== named)] : fields;
  for (const field of ordered) {
    if (field.type === FieldType.Reference) continue;
    const value = record.values[field.name];
    if (value !== null && value !== undefined && String(value).length > 0) {
      return `${labelForValue(field, value)} (${record.id.slice(0, 8)})`;
    }
  }
  return record.id;
}

function valuesFrom(request: HttpRequest, fields: FieldDef[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = request.body[`field_${field.name}`];
    if (raw === undefined) continue;
    if (field.type === FieldType.Boolean) values[field.name] = raw === 'on' ? 'true' : 'false';
    else values[field.name] = raw;
  }
  return values;
}

/** Human wording for a field type, since the API names are terse. */
function fieldTypeLabel(type: FieldType): string {
  switch (type) {
    case FieldType.DateTime:
      return 'date and time';
    case FieldType.Reference:
      return 'lookup';
    case FieldType.AutoNumber:
      return 'auto number';
    case FieldType.DayOfWeek:
      return 'day of week';
    default:
      return type;
  }
}

function fieldInput(field: FieldDef, current: unknown, lookups: LookupOptions): string {
  const name = `field_${field.name}`;
  const label = `<label for="${escapeHtml(name)}">${escapeHtml(field.label)}${
    field.isRequired ? ' *' : ''
  }</label>`;
  const value = escapeHtml(display(current));
  const currentNumber = current === null || current === undefined ? '' : String(current);

  /** A picker over a fixed list, which is what months and weekdays are. */
  const choose = (choices: readonly { value: number; label: string }[]): string =>
    `${label}<select id="${escapeHtml(name)}" name="${escapeHtml(name)}"${
      field.isRequired ? ' required' : ''
    }>
      <option value=""${currentNumber ? '' : ' selected'}>&mdash; none &mdash;</option>
      ${optionList(
        choices.map((choice) => ({ id: String(choice.value), label: choice.label })),
        currentNumber,
      )}</select>`;

  switch (field.type) {
    case FieldType.Month:
      return choose(MONTHS);
    case FieldType.DayOfWeek:
      return choose(DAYS_OF_WEEK);
    case FieldType.Year:
      return `${label}<input id="${escapeHtml(name)}" name="${escapeHtml(
        name,
      )}" type="number" min="1000" max="9999" step="1" inputmode="numeric" value="${value}"${
        field.isRequired ? ' required' : ''
      }>`;
    case FieldType.Day:
      return `${label}<input id="${escapeHtml(name)}" name="${escapeHtml(
        name,
      )}" type="number" min="1" max="31" step="1" value="${value}"${
        field.isRequired ? ' required' : ''
      }>`;
    case FieldType.Reference: {
      const targets = lookups.get(field.id) ?? [];
      const currentId = current === null || current === undefined ? '' : String(current);
      // A value the picker cannot show (no read access to that record) is kept
      // as an option so saving the form does not silently clear the lookup.
      const missing =
        currentId && !targets.some((target) => target.id === currentId)
          ? `<option value="${escapeHtml(currentId)}" selected>${escapeHtml(currentId)}</option>`
          : '';
      return `${label}<select id="${escapeHtml(name)}" name="${escapeHtml(name)}"${
        field.isRequired ? ' required' : ''
      }>
        <option value=""${currentId ? '' : ' selected'}>&mdash; none &mdash;</option>
        ${missing}${optionList(targets, currentId)}</select>`;
    }
    case FieldType.Boolean:
      return `${label}<select id="${escapeHtml(name)}" name="${escapeHtml(name)}">
        <option value="off"${current === true ? '' : ' selected'}>No</option>
        <option value="on"${current === true ? ' selected' : ''}>Yes</option></select>`;
    case FieldType.Number:
      return `${label}<input id="${escapeHtml(name)}" name="${escapeHtml(
        name,
      )}" type="number" step="any" value="${value}"${field.isRequired ? ' required' : ''}>`;
    case FieldType.Date:
      return `${label}<input id="${escapeHtml(name)}" name="${escapeHtml(
        name,
      )}" type="date" value="${value}"${field.isRequired ? ' required' : ''}>`;
    case FieldType.DateTime:
      return `${label}<input id="${escapeHtml(name)}" name="${escapeHtml(
        name,
      )}" value="${value}" placeholder="2026-01-31T09:00:00Z"${field.isRequired ? ' required' : ''}>`;
    default:
      return `${label}<input id="${escapeHtml(name)}" name="${escapeHtml(name)}" value="${value}"${
        field.isRequired ? ' required' : ''
      }>`;
  }
}

/** A table cell: lookups link through, and coded values read as their names. */
function cell(field: FieldDef, value: unknown): string {
  if (field.type === FieldType.Reference && value) {
    const id = String(value);
    return `<a href="/records/${escapeHtml(id)}"><code>${escapeHtml(id.slice(0, 8))}</code></a>`;
  }
  return escapeHtml(labelForValue(field, value));
}

function display(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/** Multi-selects arrive as repeated keys, which the body parser keeps intact. */
function multi(request: HttpRequest, name: string): string[] {
  return (request.bodyList[name] ?? []).filter((value) => value.length > 0);
}

function messages(request: HttpRequest): { error: string | null; notice: string | null } {
  return {
    error: request.query.get('error'),
    notice: request.query.get('notice'),
  };
}

function withMessage(path: string, kind: 'error' | 'notice', message: string): string {
  if (!message) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${kind}=${encodeURIComponent(message)}`;
}

function messageOf(error: unknown): string {
  // A storage constraint reaching a person means something above it failed to
  // check first, so say something usable rather than quoting the engine.
  if (error instanceof UniqueConstraintError) return 'That already exists.';
  if (error instanceof DatabaseError) return 'The change could not be saved.';
  return error instanceof Error ? error.message : 'Something went wrong';
}

function backTo(request: HttpRequest): string {
  const referer = request.headers['referer'];
  if (referer) {
    try {
      return new URL(referer).pathname;
    } catch {
      // fall through
    }
  }
  return '/admin';
}
