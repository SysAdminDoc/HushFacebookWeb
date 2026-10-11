// Shared by the tests that read tests/fixtures/. Not a test file itself, so importing it
// doesn't register (and run) another file's tests a second time.

import { readFile } from 'node:fs/promises';

export const FIXTURES = new URL('../fixtures/', import.meta.url);

export async function fixtureLines(name) {
  const text = await readFile(new URL(name, FIXTURES), 'utf8');
  return text.split('\n').filter((line) => line !== '');
}

export const parseLine = (line) => JSON.parse(line.replace(/^for \(;;\);/, ''));
