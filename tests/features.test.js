// Guards the feature registry: its shape and its settings.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { features } from '../src/features/index.js';
import { PAGES, SECTIONS } from '../src/features/sections.js';
import { buildSchema, isValid } from '../src/core/settings.js';

const sectionIds = new Set(SECTIONS.map((section) => section.id));

test('feature ids are unique camelCase keys', () => {
  const ids = features.map((feature) => feature.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z][A-Za-z0-9]*$/);
});

test('every feature is complete and in a known section', () => {
  for (const feature of features) {
    assert.ok(sectionIds.has(feature.section), `${feature.id}: unknown section ${feature.section}`);
    assert.equal(typeof feature.default, 'boolean', `${feature.id}: default`);
    assert.ok(feature.title?.length && feature.description?.length, `${feature.id}: title and description`);
    assert.ok(feature.setup || feature.css, `${feature.id}: needs setup or css`);
  }
});

test('every group sits on a page, and every page has switches in at least one of its groups', () => {
  const pageIds = PAGES.map((page) => page.id);
  assert.equal(new Set(pageIds).size, pageIds.length);
  assert.equal(sectionIds.size, SECTIONS.length);
  for (const section of SECTIONS) assert.ok(pageIds.includes(section.page), `${section.id}: unknown page ${section.page}`);
  for (const page of PAGES) {
    const groups = SECTIONS.filter((section) => section.page === page.id).map((section) => section.id);
    assert.ok(features.some((feature) => groups.includes(feature.section)), `${page.id}: an empty page`);
  }
  for (const section of SECTIONS) assert.ok(features.some((feature) => feature.section === section.id), `${section.id}: an empty group`);
});

test("no two features add a Diagnostics row with the same label, since one would replace the other's", async () => {
  const dir = new URL('../src/features/', import.meta.url);
  const labels = new Map();
  for (const file of await readdir(dir, { recursive: true })) {
    if (!file.endsWith('.js')) continue;
    const source = await readFile(new URL(file.replaceAll('\\', '/'), dir), 'utf8');
    for (const [, label] of source.matchAll(/diagnostics\??\.add\(\s*'([^']+)'/g)) {
      assert.ok(!labels.has(label), `"${label}" in ${file} and ${labels.get(label)}`);
      labels.set(label, file);
    }
  }
  assert.ok(labels.size > 20, `found ${labels.size} rows`);
});

test('the settings schema builds and every option default is valid', () => {
  const schema = buildSchema(features);
  for (const spec of schema.values()) assert.ok(isValid(spec, spec.default), `${spec.key}: default ${JSON.stringify(spec.default)}`);
});
