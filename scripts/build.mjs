// Bundles src/ into one readable userscript plus a small .meta.js for update checks.
// Greasy Fork and reviewers need readable code, so the bundle is never minified.

import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fileName, renderMetaBlock } from './meta.mjs';

const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const meta = renderMetaBlock(pkg.version);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const result = await build({
  entryPoints: [fileURLToPath(new URL('src/main.js', root))],
  bundle: true,
  format: 'iife',
  target: ['chrome120', 'firefox128', 'safari17'],
  minify: false,
  charset: 'utf8',
  legalComments: 'none',
  write: false,
  banner: { js: meta },
  define: { __HFW_VERSION__: JSON.stringify(pkg.version) },
});

const script = result.outputFiles[0].text;
await writeFile(new URL(`${fileName}.user.js`, dist), script);
await writeFile(new URL(`${fileName}.meta.js`, dist), meta);
console.log(`Built ${fileName}.user.js v${pkg.version} (${(script.length / 1024).toFixed(1)} KiB)`);
