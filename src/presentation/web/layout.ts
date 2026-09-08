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
header .spacer { flex:1; }
header .who { color:var(--muted); font-size:13px; }
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

export interface PageOptions {
  title: string;
  context?: SecurityContext | null;
  error?: string | null;
  notice?: string | null;
}

export function page(options: PageOptions, body: string): string {
  const nav = options.context
    ? `<a href="/tables">Data</a>${
        options.context.role.isSystem ? '<a href="/admin">Setup</a>' : ''
      }<span class="spacer"></span><span class="who">${escapeHtml(
        options.context.user.username,
      )} &middot; ${escapeHtml(options.context.role.name)}</span>
      <form method="post" action="/logout" class="inline"><button class="secondary" style="margin:0">Sign out</button></form>`
    : '<span class="spacer"></span>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)} &middot; Cumulo</title>
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<style>${STYLE}</style></head>
<body>
<header><div class="bar"><a class="brand" href="/">Cumulo</a>${nav}</div></header>
<main>
${options.error ? `<p class="notice error">${escapeHtml(options.error)}</p>` : ''}
${options.notice ? `<p class="notice">${escapeHtml(options.notice)}</p>` : ''}
${body}
</main></body></html>`;
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
