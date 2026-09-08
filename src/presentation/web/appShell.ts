/**
 * The page the user-space client boots from.
 *
 * It carries no data: the client asks `/api/v1/me` for that, so this document
 * is the same for every user and can be served without touching the database.
 */
export function appShellHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cumulo</title>
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/app.css">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; }
</style>
</head>
<body>
<div id="root"></div>
<script src="/assets/app.js" defer></script>
</body>
</html>`;
}
