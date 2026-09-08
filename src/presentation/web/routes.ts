import type { Application } from '../../app/Application.js';
import type { FeatureFlags } from '../../config.js';
import { DatabaseError, UniqueConstraintError } from '../../db/types.js';
import {
  AccessType,
  ClauseMatch,
  ClauseOperator,
  FieldAccess,
  FieldType,
  isNameField,
  type FieldDef,
  type SecurityRole,
} from '../../domain/types.js';
import type { SecurityContext } from '../../security/context.js';
import { AccessDeniedError } from '../../security/errors.js';
import type { Router } from '../http/router.js';
import { clearedCookie, sessionCookie, type SessionStore } from '../http/sessions.js';
import { RedirectSignal } from '../http/signals.js';
import { html, redirect, type HttpRequest, type HttpResponse } from '../http/types.js';
import { labelForValue } from '../../security/values.js';
import { appShellHtml } from './appShell.js';
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
    return redirect(request.context ? '/app' : '/login');
  });

  // --- user space ---------------------------------------------------------
  // Everything under /app is the Mantine client, which does its own routing.
  // The shell is static, so an unauthenticated visitor gets a page that then
  // sends them to /login rather than a redirect that leaks nothing useful.
  const shell = async (): Promise<HttpResponse> => html(appShellHtml());
  router.get('/app', shell);
  router.get('/app/search', shell);
  router.get('/app/tables/:tableId', shell);
  router.get('/app/tables/:tableId/new', shell);
  router.get('/app/records/:recordId', shell);

  // The old server-rendered data pages now live in the client. Keeping the
  // paths pointed at it means existing links and bookmarks still work.
  router.get('/tables', async () => redirect('/app'));
  router.get('/tables/:tableId', async (request) =>
    redirect(`/app/tables/${encodeURIComponent(request.params['tableId'] ?? '')}`),
  );
  router.get('/records/:recordId', async (request) =>
    redirect(`/app/records/${encodeURIComponent(request.params['recordId'] ?? '')}`),
  );

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
      return redirect('/app', { 'set-cookie': sessionCookie(session.id) });
    } catch (error) {
      return redirect(withMessage('/setup', 'error', messageOf(error)));
    }
  });

  // --- authentication ----------------------------------------------------

  router.get('/login', async (request) => {
    if (!(await app.install.isSetupComplete())) return redirect('/setup');
    if (request.context) return redirect('/app');
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
      return redirect('/app', { 'set-cookie': sessionCookie(session.id) });
    } catch (error) {
      return redirect(withMessage('/login', 'error', messageOf(error)));
    }
  });

  router.post('/logout', async (request) => {
    sessions.destroy(request.session?.id);
    return redirect('/login', { 'set-cookie': clearedCookie() });
  });

  // --- data --------------------------------------------------------------

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
                   `<tr><td><a href="/admin/roles/${escapeHtml(role.id)}">${escapeHtml(
                     role.name,
                   )}</a>${role.isSystem ? ' <span class="muted">(system)</span>' : ''}</td>
                     <td class="muted">${
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

    const tabsByRole = new Map<string, number>();
    for (const role of roles) {
      tabsByRole.set(role.id, (await app.metadata.listRoleTabs(context, role.id)).length);
    }

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
      const tabCount = tabsByRole.get(role.id) ?? 0;
      const facts = [
        `${userCount} user${userCount === 1 ? '' : 's'}`,
        role.isSystem ? 'all access' : `${ruleCount} rule${ruleCount === 1 ? '' : 's'}`,
        `${tabCount} tab${tabCount === 1 ? '' : 's'}`,
        ...(grants.length > 0 ? [`namespaces: ${grants.join(', ')}`] : []),
      ]
        .map(escapeHtml)
        .join(' &middot; ');

      return `<li>
        <a href="/admin/roles/${escapeHtml(role.id)}"><strong>${escapeHtml(
          role.name,
        )}</strong></a>${role.isSystem ? ' <span class="muted">(system)</span>' : ''}
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
             root with no rules of its own, holds everything. Tabs are the exception &mdash; they
             are configured per role and inherited in neither direction. Open a role to set them.</p>
           <ul class="tree">${roots.map((role) => renderRole(role)).join('')}</ul>
         </section>`,
      ),
    );
  });

  router.get('/admin/roles/:roleId', async (request) => {
    const context = requireUser(request);
    app.security.assertAdministrator(context);
    const roleId = request.params['roleId'] as string;
    const roles = await app.metadata.listSecurityRoles(context);
    const role = roles.find((candidate) => candidate.id === roleId);
    if (!role) throw new AccessDeniedError('No such role');

    const [tabs, tables] = await Promise.all([
      app.metadata.listRoleTabs(context, role.id),
      app.metadata.listTables(context),
    ]);
    const token = request.session?.csrfToken;
    const onTabs = new Set(tabs.map((entry) => entry.table.id));

    return html(
      page(
        { title: role.name, context, ...messages(request) },
        `<h1>${escapeHtml(role.name)}</h1>
         <p class="lede"><a href="/admin/roles">Back to the hierarchy</a> &middot;
           <a href="/admin">Setup</a></p>

         <h2>Tabs</h2>
         <section class="card">
           <p class="muted">The tables this role sees along the top of the app, in this order.
             Tabs belong to this role alone &mdash; unlike rules, they are not inherited from a
             parent or rolled up from children.</p>
           <p class="muted">First in this list is leftmost on the tab bar.</p>
           <table><thead><tr><th>#</th><th>Table</th><th>Order</th><th></th></tr></thead><tbody>
             ${
               tabs
                 .map(
                   (entry, index) =>
                     `<tr><td class="muted">${index + 1}</td>
                        <td>${escapeHtml(entry.table.label)}
                          <code class="muted">${escapeHtml(entry.table.name)}</code></td>
                        <td><form method="post" action="/admin/tabs/${escapeHtml(
                          entry.tab.id,
                        )}/move" class="inline">${csrfInput(token)}
                            <button name="direction" value="earlier" class="secondary"
                              style="margin:0" title="Move up"
                              aria-label="Move up"${index === 0 ? ' disabled' : ''}>&uarr;</button>
                          </form>
                          <form method="post" action="/admin/tabs/${escapeHtml(
                            entry.tab.id,
                          )}/move" class="inline">${csrfInput(token)}
                            <button name="direction" value="later" class="secondary"
                              style="margin:0" title="Move down" aria-label="Move down"${
                                index === tabs.length - 1 ? ' disabled' : ''
                              }>&darr;</button>
                          </form></td>
                        <td><form method="post" action="/admin/tabs/${escapeHtml(
                          entry.tab.id,
                        )}/delete" class="inline">${csrfInput(token)}
                            <button class="danger" style="margin:0">Remove</button></form></td>
                      </tr>`,
                 )
                 .join('') ||
               '<tr><td colspan="4" class="muted">No tabs. This role sees an empty app.</td></tr>'
             }
           </tbody></table>
           <form method="post" action="/admin/roles/${escapeHtml(role.id)}/tabs">${csrfInput(
             token,
           )}
             <label>Add a tab</label>
             <select name="tableId" required>
               ${optionList(
                 tables
                   .filter((table) => !onTabs.has(table.id))
                   .map((table) => ({ id: table.id, label: table.label })),
               )}
             </select>
             <button>Add tab</button></form>
           ${
             role.isSystem
               ? '<p class="muted">Administrator reaches every table, so any of them can be a tab.</p>'
               : '<p class="muted">A tab whose table this role cannot reach is simply not shown.</p>'
           }
         </section>`,
      ),
    );
  });

  router.get('/admin/fields/:fieldId', async (request) => {
    const context = requireUser(request);
    app.security.assertAdministrator(context);
    const fieldId = request.params['fieldId'] as string;

    const found = await app.metadata.findField(context, fieldId);
    if (!found) throw new AccessDeniedError('No such field');
    const { field, table } = found;
    const token = request.session?.csrfToken;
    const nameField = isNameField(field);
    const tables = await app.metadata.listTables(context);

    /** What the field is, as opposed to what can be changed about it. */
    const facts = [
      ['API name', `<code>${escapeHtml(field.key)}</code>`],
      ['Namespace', `<code>${escapeHtml(field.namespaceName)}</code>`],
      ['Type', escapeHtml(fieldTypeLabel(field.type))],
      ...(field.referenceTableId
        ? [
            [
              'Looks up',
              escapeHtml(
                tables.find((other) => other.id === field.referenceTableId)?.label ?? '',
              ),
            ],
          ]
        : []),
      ['Table', escapeHtml(table.label)],
    ];

    return html(
      page(
        { title: field.label, context, ...messages(request) },
        `<h1>${escapeHtml(field.label)}</h1>
         <p class="lede"><a href="/admin/tables/${escapeHtml(table.id)}">Back to ${escapeHtml(
           table.label,
         )}</a></p>

         <section class="card">
           <table><tbody>
             ${facts.map(([term, value]) => `<tr><th>${term}</th><td>${value}</td></tr>`).join('')}
           </tbody></table>
           <p class="muted">A field's type, namespace and API name are fixed. Records store
             values per field and are addressed by API name, so changing one of those would not
             rename a field but replace it${
               field.referenceTableId
                 ? ', and moving a lookup would leave its values pointing into the wrong table'
                 : ''
             }.</p>
         </section>

         <h2>Edit</h2>
         <section class="card">
           <form method="post" action="/admin/fields/${escapeHtml(field.id)}">${csrfInput(token)}
             <label for="label">Label</label>
             <input id="label" name="label" value="${escapeHtml(field.label)}" required>
             ${
               nameField
                 ? `<p class="muted">Only the label can be changed here. Every table has a Name
                      and a search always reads it, so the rest is not configurable.</p>`
                 : `<div class="row">
                      ${
                        field.type === FieldType.AutoNumber
                          ? `<div><label>Required</label>
                               <p class="muted">An auto number is filled in by the platform,
                                 so there is nothing to require.</p></div>`
                          : `<div><label for="isRequired">Required</label>
                               <select id="isRequired" name="isRequired">
                                 <option value=""${field.isRequired ? '' : ' selected'}>No</option>
                                 <option value="on"${
                                   field.isRequired ? ' selected' : ''
                                 }>Yes</option>
                               </select></div>`
                      }
                      <div><label for="isSearchable">Searchable</label>
                        <select id="isSearchable" name="isSearchable">
                          <option value=""${field.isSearchable ? '' : ' selected'}>No</option>
                          <option value="on"${field.isSearchable ? ' selected' : ''}>Yes</option>
                        </select></div>
                    </div>`
             }
             <button>Save</button>
           </form>
         </section>

         ${
           field.isSystem
             ? `<p class="muted">This is a system field and cannot be deleted.</p>`
             : `<h2>Delete</h2>
                <section class="card">
                  <p class="muted">Deleting a field removes its values from every record, and
                    the field grants that name it. A field a security rule clause reads cannot
                    be deleted until that rule is dealt with.</p>
                  <form method="post" action="/admin/fields/${escapeHtml(
                    field.id,
                  )}/delete">${csrfInput(token)}
                    <button class="danger">Delete this field</button>
                  </form>
                </section>`
         }`,
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
           <p class="muted">A global search always looks at Name &mdash; that cannot be turned
             off. Mark any other field searchable to have matches on it return the record too.</p>
           <table><thead><tr><th>API name</th><th>Label</th><th>Type</th><th>Required</th>
             <th>Searchable</th><th></th></tr></thead><tbody>
             ${
               fields
                 .map(
                   (field) =>
                     `<tr><td><code>${escapeHtml(field.key)}</code></td><td>${escapeHtml(
                       field.label,
                     )}</td><td class="muted">${escapeHtml(fieldTypeLabel(field.type))}${
                       field.referenceTableId
                         ? ` &rarr; ${escapeHtml(
                             tables.find((other) => other.id === field.referenceTableId)?.label ??
                               '',
                           )}`
                         : ''
                     }</td><td class="muted">${field.isRequired ? 'yes' : 'no'}</td>
                     <td class="muted">${
                       isNameField(field) ? 'always' : field.isSearchable ? 'yes' : 'no'
                     }</td>
                     <td><a href="/admin/fields/${escapeHtml(field.id)}">Edit</a></td></tr>`,
                 )
                 .join('') || '<tr><td colspan="6" class="muted">No fields yet.</td></tr>'
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
               <div><label>Searchable</label><select name="isSearchable">
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
    '/admin/roles/:roleId/tabs',
    adminAction(async (request, context) => {
      const result = await app.metadata.addRoleTab(
        context,
        request.params['roleId'] ?? '',
        request.body['tableId'] ?? '',
      );
      return result.created ? 'Tab added' : 'That table is already a tab for this role';
    }),
  );

  router.post(
    '/admin/tabs/:tabId/move',
    adminAction(async (request, context) => {
      await app.metadata.moveRoleTab(
        context,
        request.params['tabId'] ?? '',
        request.body['direction'] === 'earlier' ? 'earlier' : 'later',
      );
      return 'Tab moved';
    }),
  );

  router.post(
    '/admin/tabs/:tabId/delete',
    adminAction(async (request, context) => {
      await app.metadata.removeRoleTab(context, request.params['tabId'] ?? '');
      return 'Tab removed';
    }),
  );

  router.post(
    '/admin/fields/:fieldId',
    adminAction(async (request, context) => {
      const fieldId = request.params['fieldId'] ?? '';
      const found = await app.metadata.findField(context, fieldId);
      if (!found) throw new AccessDeniedError('No such field');

      // The Name field's form offers only a label, so only a label is sent.
      const changes = isNameField(found.field)
        ? { label: request.body['label'] ?? '' }
        : {
            label: request.body['label'] ?? '',
            isSearchable: request.body['isSearchable'] === 'on',
            ...(found.field.type === FieldType.AutoNumber
              ? {}
              : { isRequired: request.body['isRequired'] === 'on' }),
          };

      const field = await app.metadata.updateField(context, fieldId, changes);
      throw new RedirectSignal(
        withMessage(`/admin/fields/${field.id}`, 'notice', `"${field.label}" saved`),
      );
    }),
  );

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
        isSearchable: request.body['isSearchable'] === 'on',
        referenceTableId: request.body['referenceTableId'] || null,
      });
      return 'Field created';
    }),
  );

  router.post(
    '/admin/fields/:fieldId/delete',
    adminAction(async (request, context) => {
      const found = await app.metadata.findField(context, request.params['fieldId'] ?? '');
      await app.metadata.deleteField(context, request.params['fieldId'] ?? '');
      throw new RedirectSignal(
        withMessage(
          found ? `/admin/tables/${found.table.id}` : '/admin',
          'notice',
          `"${found?.field.label ?? 'Field'}" deleted`,
        ),
      );
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
