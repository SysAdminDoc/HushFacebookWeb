// Userscript metadata block. The version comes from package.json at build time.

import { readFileSync } from 'node:fs';

const repo = 'https://github.com/SysAdminDoc/HushFacebookWeb';
export const fileName = 'hushfacebook-web';
// The icon goes in as a data URI (about 2.6 KB), so the manager never fetches an image.
const icon = `data:image/png;base64,${readFileSync(new URL('../assets/icons/icon-48.png', import.meta.url)).toString('base64')}`;

export const metadata = [
  ['name', 'HushFacebook Web'],
  ['namespace', repo],
  ['description', 'Takes ads, suggested posts and Meta AI out of Facebook on the web, and adds download, privacy and playback controls.'],
  ['author', 'SysAdminDoc'],
  ['license', 'MIT'],
  ['icon', icon],
  ['homepageURL', repo],
  ['supportURL', `${repo}/issues`],
  ['updateURL', `${repo}/releases/latest/download/${fileName}.meta.js`],
  ['downloadURL', `${repo}/releases/latest/download/${fileName}.user.js`],
  ['match', 'https://www.facebook.com/*'],
  ['match', 'https://web.facebook.com/*'],
  // Network hooks must wrap fetch and XHR before Facebook's own code captures them.
  ['run-at', 'document-start'],
  // Page world, so the hooks see Facebook's fetch and XHR. facebook.com's CSP only allows
  // nonce'd scripts, so the manager has to put us there; Violentmonkey falls back to content
  // mode when it can't, and the script then runs its DOM features only.
  ['inject-into', 'auto'],
  ['sandbox', 'JavaScript'],
  ['noframes', ''],
  ['grant', 'GM_getValue'],
  ['grant', 'GM_setValue'],
  ['grant', 'GM_deleteValue'],
  ['grant', 'GM_addValueChangeListener'],
  ['grant', 'GM_registerMenuCommand'],
  ['grant', 'GM_download'],
  ['grant', 'GM_xmlhttpRequest'],
  ['grant', 'unsafeWindow'],
  ['connect', 'fbcdn.net'],
  ['connect', 'facebook.com'],
];

export function renderMetaBlock(version) {
  const rows = [];
  for (const row of metadata) {
    rows.push(row);
    if (row[0] === 'namespace') rows.push(['version', version]);
  }
  const width = Math.max(...rows.map(([key]) => key.length)) + 1;
  const lines = rows.map(([key, value]) => `// @${key.padEnd(width)}${value}`.trimEnd());
  return ['// ==UserScript==', ...lines, '// ==/UserScript==', ''].join('\n');
}
