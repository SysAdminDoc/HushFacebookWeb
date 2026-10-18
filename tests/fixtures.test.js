// Every fixture under tests/fixtures/ came out of scripts/scrub-fixture.mjs. This checks
// nothing that points at a person slipped through, and that each line is a document the
// network layer could receive. Compressed fixtures are read through the same decoder the
// tests use and get the same checks.

import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { STATIC_SEGMENTS, findLeftovers, findRealText } from '../scripts/lib/scrub.mjs';
import { FIXTURES, decodeFixture, fixtureLines, fixtureText, isFixture, parseLine } from './helpers/fixtures.js';

const names = (await readdir(FIXTURES)).filter(isFixture);
const PLACE_KEYS = new Set(['city', 'state', 'region', 'county', 'zip', 'zipcode', 'zip_code', 'postal_code', 'street', 'street_address', 'neighborhood', 'locality', 'location_name', 'hometown', 'current_city']);
const GEO_KEYS = new Set(['latitude', 'longitude', 'lat', 'lng', 'lon', 'long']);
const PLACEHOLDER = /^[A-Z][a-z]+( [a-z]+)*$/;

function* entries(value, key) {
  if (Array.isArray(value)) for (const item of value) yield* entries(item, key);
  else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* entries(v, k);
  else yield [key, value];
}

// What in a fixture's text points at a person.
function privacyProblems(text) {
  const problems = findLeftovers(text);
  // Facebook URLs may only be made of the site's own path words, stand-in ids and stand-in slugs.
  for (const [, path] of text.matchAll(/https?:\/\/(?:[a-z0-9-]+\.)*facebook\.com(\/[^"\\?#\s]*)/g)) {
    for (const segment of path.split('/')) {
      if (segment === '' || STATIC_SEGMENTS.has(segment) || /^u[a-z0-9]{7}$/.test(segment) || /^\d{1,9}$/.test(segment)) continue;
      problems.push(`${segment} in ${path} looks like a real name`);
    }
  }
  // Page markup also gets each text run and label checked for words the scrub didn't replace.
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const html = parseLine(line)?.html;
    if (typeof html === 'string') problems.push(...findRealText(html));
  }
  return problems;
}

test('there are fixtures for the feed, the home page, Marketplace, search, the story seen request and page markup', () => {
  for (const expected of [
    'CometNewsFeedPaginationQuery.jsonl', 'home-data-sjs.jsonl', 'MarketplaceCometBrowseFeedLightPaginationQuery.jsonl',
    'SearchCometResultsPaginatedResultsQuery.jsonl', 'storiesUpdateSeenStateMutation.request.jsonl', 'organic-posts.jsonl.gz',
  ]) {
    assert.ok(names.includes(expected), `${expected} is missing`);
  }
});

test('a compressed fixture gets the same privacy checks as a plain one, so a leak in either is caught', () => {
  const clean = '{"html":"<div><span>Like</span></div>"}';
  const canaries = [
    ['{"id":"12345678901234"}', 'ten or more digits in a row'],
    ['{"from":"someone@mail.test"}', 'email address'],
    ['{"src":"https://scontent.xx.fbcdn.net/v/t1/photo.jpg"}', 'CDN host'],
    ['{"href":"https://www.facebook.com/harriet.quill"}', 'harriet.quill in /harriet.quill'],
    ['{"html":"<div><span>Harriet Quill wrote this</span></div>"}', 'text H'],
  ];
  for (const [canary, expected] of canaries) {
    const text = `${clean}\n${canary}\n`;
    const plain = privacyProblems(decodeFixture('canary.jsonl', Buffer.from(text)));
    const compressed = privacyProblems(decodeFixture('canary.jsonl.gz', gzipSync(text)));
    assert.ok(plain.some((problem) => problem.startsWith(expected)), `${expected}: ${plain.join(', ')}`);
    assert.deepEqual(compressed, plain, expected);
  }
  assert.deepEqual(privacyProblems(decodeFixture('clean.jsonl.gz', gzipSync(`${clean}\n`))), []);
});

for (const name of names) {
  test(`${name} holds nothing that points at a person`, async () => {
    assert.deepEqual(privacyProblems(await fixtureText(name)), []);
  });

  test(`${name} carries no real place or coordinates`, async () => {
    for (const line of await fixtureLines(name)) {
      for (const [key, value] of entries(parseLine(line))) {
        if (PLACE_KEYS.has(key) && typeof value === 'string') assert.match(value, PLACEHOLDER, `${key}: ${value}`);
        if (GEO_KEYS.has(key) && value !== null) assert.ok(Number(value) === 0, `${key}: ${value}`);
      }
    }
  });

  test(`${name} is one JSON document per line`, async () => {
    const lines = await fixtureLines(name);
    assert.ok(lines.length > 0);
    for (const line of lines) {
      const doc = parseLine(line);
      assert.equal(typeof doc, 'object');
    }
  });
}
