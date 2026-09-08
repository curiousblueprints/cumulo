import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Next to the compiled server, so a single `COPY dist` ships both.
const outdir = resolve(root, 'dist/public');
mkdirSync(outdir, { recursive: true });

const watch = process.argv.includes('--watch');

/**
 * Bundles the user-space client. Everything -- React, Mantine and Mantine's
 * stylesheet -- is inlined into two files, so the runtime image ships no
 * node_modules and the page loads no third-party origin.
 */
const options = {
  entryPoints: [resolve(root, 'src/client/main.tsx')],
  outfile: resolve(outdir, 'app.js'),
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  loader: { '.woff2': 'dataurl', '.svg': 'dataurl' },
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  logLevel: 'info',
};

// The favicon is copied rather than bundled: it is referenced by the shell,
// which esbuild never sees.
copyFileSync(resolve(root, 'src/client/favicon.svg'), resolve(outdir, 'favicon.svg'));

const result = await build(options);
if (result.errors?.length) process.exit(1);
console.log(`Client bundled to ${outdir}`);
