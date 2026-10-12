// Bundles src/ into one readable userscript plus a small .meta.js for update checks, and the
// same source into a Chrome extension: dist/extension/ to load unpacked, and a zip of it.
// Greasy Fork and reviewers need readable code, so nothing is minified.

import { build } from 'esbuild';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EXTENSION_ZIP } from './lib/release.mjs';
import { extensionManifest } from './manifest.mjs';
import { fileName, renderMetaBlock } from './meta.mjs';
import { zip } from './zip.mjs';

const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
const unpacked = new URL('extension/', dist);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const meta = renderMetaBlock(pkg.version);
const kib = (text) => `${(text.length / 1024).toFixed(1)} KiB`;

await rm(dist, { recursive: true, force: true });
await mkdir(new URL('icons/', unpacked), { recursive: true });

const bundle = async (entry, { banner, target = 'userscript' } = {}) => (await build({
  entryPoints: [fileURLToPath(new URL(entry, root))],
  bundle: true,
  format: 'iife',
  target: ['chrome120', 'firefox128', 'safari17'],
  minify: false,
  charset: 'utf8',
  // /*! */ notices (third-party MIT code) go to the end of the script, once each.
  legalComments: 'eof',
  write: false,
  banner: banner ? { js: banner } : undefined,
  define: { __HFW_VERSION__: JSON.stringify(pkg.version), __HFW_TARGET__: JSON.stringify(target) },
})).outputFiles[0].text;

const script = await bundle('src/main.js', { banner: meta });
await writeFile(new URL(`${fileName}.user.js`, dist), script);
await writeFile(new URL(`${fileName}.meta.js`, dist), meta);
console.log(`Built ${fileName}.user.js v${pkg.version} (${kib(script)})`);

const notice = `// HushFacebook Web v${pkg.version}. Source: https://github.com/SysAdminDoc/HushFacebookWeb\n`;
const parts = {
  'main.js': await bundle('src/main.js', { banner: notice, target: 'extension' }),
  'isolated.js': await bundle('extension/isolated.js', { banner: notice, target: 'extension' }),
  // Copied as written: a classic script whose functions the live check can call.
  'background.js': notice + await readFile(new URL('extension/background.js', root), 'utf8'),
  'manifest.json': `${JSON.stringify(extensionManifest(pkg), null, 2)}\n`,
};
for (const [name, text] of Object.entries(parts)) await writeFile(new URL(name, unpacked), text);
for (const icon of await readdir(new URL('assets/icons/', root))) {
  if (/^icon-(16|32|48|128)\.png$/.test(icon)) await copyFile(new URL(`assets/icons/${icon}`, root), new URL(`icons/${icon}`, unpacked));
}

const files = [];
const walk = async (dir, prefix = '') => {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) await walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
    else files.push({ name: `${prefix}${entry.name}`, data: await readFile(new URL(entry.name, dir)) });
  }
};
await walk(unpacked);
const packed = zip(files);
await writeFile(new URL(EXTENSION_ZIP, dist), packed);
console.log(`Built extension/ and ${EXTENSION_ZIP} v${pkg.version} (main.js ${kib(parts['main.js'])}, zip ${(packed.length / 1024).toFixed(1)} KiB)`);
