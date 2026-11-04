// Fails when the README badge or CHANGELOG disagree with package.json's version.

import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (name) => readFile(new URL(name, root), 'utf8');
const { version } = JSON.parse(await read('package.json'));
const problems = [];

const readme = await read('README.md');
const badge = readme.match(/img\.shields\.io\/badge\/version-([\d.]+)-/);
if (!badge) problems.push('README.md has no version badge');
else if (badge[1] !== version) problems.push(`README.md badge says ${badge[1]}, package.json says ${version}`);

const changelog = await read('CHANGELOG.md');
// The heading has to end at the version, or v0.0.1 would pass on a v0.0.10 section.
const heading = new RegExp(`^## v${version.replaceAll('.', '\\.')}(?:\\s|$)`, 'm');
if (!heading.test(changelog) && !changelog.includes('## Unreleased')) {
  problems.push(`CHANGELOG.md has neither "## v${version}" nor "## Unreleased"`);
}

if (problems.length) {
  for (const problem of problems) console.error(`version check: ${problem}`);
  process.exit(1);
}
console.log(`version check: ${version} matches README.md and CHANGELOG.md`);
