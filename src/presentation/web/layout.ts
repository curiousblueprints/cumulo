import type { SecurityContext } from '../../security/context.js';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
:root { color-scheme: light dark; --bg:#fbfbfd; --fg:#1c1c1f; --muted:#6b6b76;
  --line:#e2e2e8; --card:#ffffff; --accent:#2f5bd1; --danger:#b1372f; }
@media (prefers-color-scheme: dark) { :root { --bg:#141417; --fg:#ececed; --muted:#9a9aa4;
  --line:#2c2c33; --card:#1c1c21; --accent:#7ea2ff; --danger:#e2796f; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
header { border-bottom:1px solid var(--line); background:var(--card); }
header .bar { max-width:960px; margin:0 auto; padding:12px 20px; display:flex; gap:18px; align-items:center; }
header a { color:var(--fg); text-decoration:none; }
header .brand { font-weight:650; letter-spacing:-.01em; }
/* The outer thirds share the space, so "Setup" sits on the middle of the
   window -- the same arrangement as the search box in the user space. */
header .side { flex:1 1 0; min-width:0; display:flex; align-items:center; gap:12px; }
header .side.right { justify-content:flex-end; }
header .middle { flex:0 1 auto; font-weight:600; letter-spacing:.02em; color:var(--muted);
  text-transform:uppercase; font-size:13px; }
header .app-link { font-size:13px; color:var(--muted); }
header .app-link:hover { color:var(--fg); }
header .tabs { max-width:960px; margin:0 auto; padding:0 20px; display:flex; gap:2px; }
header .tabs a { padding:8px 14px; font-size:14px; color:var(--muted); border:1px solid transparent;
  border-bottom:none; border-radius:8px 8px 0 0; margin-bottom:-1px; }
header .tabs a:hover { color:var(--fg); }
header .tabs a.current { color:var(--fg); background:var(--bg); border-color:var(--line);
  border-bottom:1px solid var(--bg); font-weight:550; }
details.account { position:relative; }
details.account summary { list-style:none; cursor:pointer; }
details.account summary::-webkit-details-marker { display:none; }
.avatar { display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px;
  border-radius:50%; background:color-mix(in srgb, var(--accent) 18%, transparent);
  color:var(--accent); font-size:12px; font-weight:650; letter-spacing:.02em; }
details.account .menu { position:absolute; right:0; top:42px; z-index:20; min-width:220px;
  background:var(--card); border:1px solid var(--line); border-radius:10px; padding:6px;
  box-shadow:0 8px 24px rgba(0,0,0,.12); }
details.account .menu .who { display:flex; flex-direction:column; padding:8px 10px 10px;
  border-bottom:1px solid var(--line); margin-bottom:6px; font-size:13px; }
details.account .menu .who span { color:var(--muted); font-size:12px; }
details.account .menu a { display:block; padding:8px 10px; border-radius:7px; font-size:14px; }
details.account .menu a:hover { background:var(--bg); }
details.account .menu form { margin:0; }
details.account .menu button { margin:0; width:100%; text-align:left; border:none; padding:8px 10px; }
main { max-width:960px; margin:0 auto; padding:24px 20px 64px; }
h1 { font-size:22px; margin:0 0 4px; letter-spacing:-.01em; }
h2 { font-size:16px; margin:28px 0 10px; }
p.lede { color:var(--muted); margin:0 0 20px; }
section.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin:0 0 18px; }
table { width:100%; border-collapse:collapse; font-size:14px; }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
tr:last-child td { border-bottom:none; }
label { display:block; font-size:13px; color:var(--muted); margin:10px 0 4px; }
input, select, textarea { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:7px;
  background:var(--bg); color:var(--fg); font:inherit; font-size:14px; }
.row { display:flex; gap:12px; flex-wrap:wrap; }
.row > * { flex:1 1 200px; }
button, .button { margin-top:14px; padding:8px 14px; border:1px solid transparent; border-radius:7px;
  background:var(--accent); color:#fff; font:inherit; font-size:14px; cursor:pointer; display:inline-block; text-decoration:none; }
button.secondary { background:transparent; color:var(--fg); border-color:var(--line); }
button.danger { background:transparent; color:var(--danger); border-color:var(--line); }
.inline { display:inline; }
.notice { border-left:3px solid var(--accent); padding:8px 12px; margin:0 0 16px; background:var(--card); font-size:14px; }
.error { border-left-color:var(--danger); color:var(--danger); }
.muted { color:var(--muted); }
code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
a { color:var(--accent); }
ul.tree, ul.tree ul { list-style:none; margin:0; padding:0; }
ul.tree ul { margin-left:10px; padding-left:14px; border-left:1px solid var(--line); }
ul.tree li { padding:5px 0; }
`;

/** The four areas of setup. Hard-coded: these are the platform's own parts. */
export const SETUP_TABS = [
  { id: 'users', label: 'Users', href: '/admin/users' },
  { id: 'roles', label: 'Roles', href: '/admin/roles' },
  { id: 'data', label: 'Data', href: '/admin/data' },
  { id: 'security', label: 'Security', href: '/admin/security' },
] as const;

export type SetupTab = (typeof SETUP_TABS)[number]['id'];

export interface PageOptions {
  title: string;
  context?: SecurityContext | null;
  /** Which setup tab to mark as current. */
  tab?: SetupTab;
  error?: string | null;
  notice?: string | null;
}

/**
 * The setup frame: the same shape as the user space -- brand, a centred
 * label, controls at the right, tabs beneath -- but the middle says "Setup"
 * rather than offering a search, and the tabs are the platform's own four
 * rather than a role's configured tables.
 */
export function page(options: PageOptions, body: string): string {
  const user = options.context;
  const account = user
    ? `<details class="account">
         <summary aria-label="Account menu"><span class="avatar">${escapeHtml(
           initials(user.user.username),
         )}</span></summary>
         <div class="menu">
           <div class="who"><strong>${escapeHtml(user.user.username)}</strong>
             <span>${escapeHtml(user.role.name)}</span></div>
           <a href="/app">Back to the app</a>
           <form method="post" action="/logout">
             <button class="danger">Sign out</button>
           </form>
         </div>
       </details>`
    : '';

  const tabs = options.tab
    ? `<nav class="tabs">${SETUP_TABS.map(
        (tab) =>
          `<a href="${tab.href}"${tab.id === options.tab ? ' class="current"' : ''}>${escapeHtml(
            tab.label,
          )}</a>`,
      ).join('')}</nav>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)} &middot; Setup &middot; Cumulo</title>
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<style>${STYLE}</style></head>
<body>
<header>
  <div class="bar">
    <div class="side"><a class="brand" href="/app">Cumulo</a></div>
    <div class="middle">Setup</div>
    <div class="side right">${
      user
        ? `<a class="app-link" href="/app" title="Back to the app">Data</a>${account}`
        : ''
    }</div>
  </div>
  ${tabs}
</header>
<main>
${options.error ? `<p class="notice error">${escapeHtml(options.error)}</p>` : ''}
${options.notice ? `<p class="notice">${escapeHtml(options.notice)}</p>` : ''}
${body}
</main></body></html>`;
}

/** Up to two letters, matching how the user space builds an avatar. */
function initials(username: string): string {
  const parts = username.trim().split(/[\s._-]+/).filter(Boolean);
  const [first, second] = parts;
  if (!first) return '?';
  if (!second) return first.slice(0, 2).toUpperCase();
  return (first.slice(0, 1) + second.slice(0, 1)).toUpperCase();
}

/** Hidden CSRF input; every state-changing form carries one. */
export function csrfInput(token: string | undefined): string {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(token ?? '')}">`;
}

export function optionList(
  items: { id: string; label: string }[],
  selected?: string,
): string {
  return items
    .map(
      (item) =>
        `<option value="${escapeHtml(item.id)}"${item.id === selected ? ' selected' : ''}>${escapeHtml(
          item.label,
        )}</option>`,
    )
    .join('');
}
