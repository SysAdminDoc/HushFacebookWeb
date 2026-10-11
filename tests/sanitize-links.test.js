import assert from 'node:assert/strict';
import { test } from 'node:test';
import sanitizeLinks from '../src/features/links/sanitize-links.js';

const pageWindow = () => ({ addEventListener() {}, navigator: {}, location: { href: 'https://www.facebook.com/' } });

test("Copy link's share link request is held back with an empty success, and only while the feature is on", () => {
  const rules = [];
  let on = true;
  sanitizeLinks.setup({ win: pageWindow(), net: { blockRequests: (rule) => rules.push(rule) }, enabled: () => on });
  assert.equal(rules.length, 1);
  const [rule] = rules;
  assert.equal(rule.match({ friendlyName: 'useLinkSharingCreateWrappedUrlMutation' }), true);
  assert.equal(rule.match({ friendlyName: 'useUpdateLinkSharingUrlMetadataMutation' }), false);
  assert.deepEqual(JSON.parse(rule.fakeResponse()), { data: {}, errors: [] });
  on = false;
  assert.equal(rule.enabled(), false);
});

test('without page access the link cleaning still starts', () => {
  assert.doesNotThrow(() => sanitizeLinks.setup({ win: pageWindow(), net: null, enabled: () => true }));
});
