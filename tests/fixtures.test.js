// Every fixture under tests/fixtures/ came out of scripts/scrub-fixture.mjs. This checks
// nothing that points at a person slipped through, and that each line is a document the
// network layer could receive.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { STATIC_SEGMENTS, findLeftovers } from '../scripts/lib/scrub.mjs';
import { FIXTURES, fixtureLines, parseLine } from './helpers/fixtures.js';

const names = (await readdir(FIXTURES)).filter((name) => name.endsWith('.jsonl'));
const PLACE_KEYS = new Set(['city', 'state', 'region', 'county', 'zip', 'zipcode', 'zip_code', 'postal_code', 'street', 'street_address', 'neighborhood', 'locality', 'location_name', 'hometown', 'current_city']);
const GEO_KEYS = new Set(['latitude', 'longitude', 'lat', 'lng', 'lon', 'long']);
const PLACEHOLDER = /^[A-Z][a-z]+( [a-z]+)*$/;

function* entries(value, key) {
  if (Array.isArray(value)) for (const item of value) yield* entries(item, key);
  else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* entries(v, k);
  else yield [key, value];
}

test('there are fixtures for the feed, the home page, Marketplace, search and the story seen request', () => {
  for (const expected of [
    'CometNewsFeedPaginationQuery.jsonl', 'home-data-sjs.jsonl', 'MarketplaceCometBrowseFeedLightPaginationQuery.jsonl',
    'SearchCometResultsPaginatedResultsQuery.jsonl', 'storiesUpdateSeenStateMutation.request.jsonl',
  ]) {
    assert.ok(names.includes(expected), `${expected} is missing`);
  }
});

for (const name of names) {
  test(`${name} holds nothing that points at a person`, async () => {
    const text = await readFile(new URL(name, FIXTURES), 'utf8');
    assert.deepEqual(findLeftovers(text), []);
    // Facebook URLs may only be made of the site's own path words, stand-in ids and stand-in slugs.
    for (const [, path] of text.matchAll(/https?:\/\/(?:[a-z0-9-]+\.)*facebook\.com(\/[^"\\?#\s]*)/g)) {
      for (const segment of path.split('/')) {
        assert.ok(segment === '' || STATIC_SEGMENTS.has(segment) || /^u[a-z0-9]{7}$/.test(segment) || /^\d{1,9}$/.test(segment), `${segment} in ${path} looks like a real name`);
      }
    }
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
