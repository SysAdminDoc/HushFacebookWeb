// Shared by the tests that read tests/fixtures/. Not a test file itself, so importing it
// doesn't register (and run) another file's tests a second time.

import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

export const FIXTURES = new URL('../fixtures/', import.meta.url);

// Captures are .jsonl, and a large one is kept compressed as .jsonl.gz (the organic posts'
// page markup).
export const isFixture = (name) => /\.jsonl(?:\.gz)?$/.test(name);
export const decodeFixture = (name, raw) => (name.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
export const fixtureText = async (name) => decodeFixture(name, await readFile(new URL(name, FIXTURES)));

export async function fixtureLines(name) {
  return (await fixtureText(name)).split('\n').filter((line) => line !== '');
}

export const parseLine = (line) => JSON.parse(line.replace(/^for \(;;\);/, ''));
