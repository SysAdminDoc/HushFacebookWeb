// Shared by the tests that read tests/fixtures/. Not a test file itself, so importing it
// doesn't register (and run) another file's tests a second time.

import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

export const FIXTURES = new URL('../fixtures/', import.meta.url);

// A .gz fixture is a large one kept compressed (the organic posts' page markup).
export async function fixtureLines(name) {
  const raw = await readFile(new URL(name, FIXTURES));
  const text = (name.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
  return text.split('\n').filter((line) => line !== '');
}

export const parseLine = (line) => JSON.parse(line.replace(/^for \(;;\);/, ''));
