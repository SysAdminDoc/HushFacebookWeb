import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanCopiedText, cleanUrl, isOutbound, unshim } from '../src/core/url.js';

const target = 'https://example.com/a?b=1&fbclid=IwAR0abc';
const shim = (host) => `https://${host}/l.php?u=${encodeURIComponent(target)}&h=AT0xyz&__tn__=-UK-R`;

test('unshim finds the real destination of every redirect host', () => {
  for (const host of ['l.facebook.com', 'lm.facebook.com', 'www.facebook.com']) assert.equal(unshim(shim(host)), target);
  assert.equal(unshim('https://www.facebook.com/groups/1/'), null);
  assert.equal(unshim('https://l.facebook.com/l.php?u=javascript%3Aalert(1)'), null);
  assert.equal(unshim('not a url'), null);
});

test('cleanUrl unwraps the redirect and drops fbclid from the destination', () => {
  assert.equal(cleanUrl(shim('l.facebook.com')), 'https://example.com/a?b=1');
});

test('Facebook tracking tags go and the context a link needs stays', () => {
  assert.equal(
    cleanUrl('https://www.facebook.com/groups/123/posts/456/?__cft__[0]=AZXabc&__tn__=%2CO%2CP-R&comment_id=789'),
    'https://www.facebook.com/groups/123/posts/456/?comment_id=789',
  );
  assert.equal(cleanUrl('https://www.facebook.com/photo/?fbid=1&set=a.2&__tn__=x'), 'https://www.facebook.com/photo/?fbid=1&set=a.2');
  assert.equal(cleanUrl('https://www.facebook.com/x?__cft__%5B0%5D=AZ&__xts__%5B1%5D=q'), 'https://www.facebook.com/x');
  assert.equal(cleanUrl('https://www.facebook.com/reel/123?mibextid=abc&rdid=x&share_url=y'), 'https://www.facebook.com/reel/123');
});

test('outside links only lose fbclid', () => {
  assert.equal(cleanUrl('https://example.com/?ref=abc&fbclid=1'), 'https://example.com/?ref=abc');
});

test('signed CDN URLs are never touched', () => {
  const cdn = 'https://scontent.xx.fbcdn.net/v/t39/1.jpg?_nc_cat=1&oh=abc&oe=def&fbclid=1';
  assert.equal(cleanUrl(cdn), cdn);
});

test('a URL that needs nothing comes back as the same string', () => {
  const url = 'https://www.facebook.com/marketplace/item/1/?ref_component=x';
  assert.equal(cleanUrl(url), url);
  assert.equal(cleanUrl('mailto:someone@example.com'), 'mailto:someone@example.com');
});

test('relative links resolve against the page', () => {
  assert.equal(cleanUrl('/groups/1/?__tn__=x', { base: 'https://www.facebook.com/' }), 'https://www.facebook.com/groups/1/');
});

test('cleanUrl leaves the redirect alone when unwrap is off', () => {
  assert.equal(
    cleanUrl(shim('l.facebook.com'), { unwrap: false }),
    `https://l.facebook.com/l.php?u=${encodeURIComponent(target)}&h=AT0xyz`,
  );
});

test('copied text is cleaned only when it is a single URL', () => {
  assert.equal(cleanCopiedText('https://www.facebook.com/reel/1?mibextid=a'), 'https://www.facebook.com/reel/1');
  assert.equal(cleanCopiedText('look at https://www.facebook.com/reel/1?mibextid=a'), 'look at https://www.facebook.com/reel/1?mibextid=a');
  assert.equal(cleanCopiedText(42), 42);
});

test('isOutbound treats Facebook and its CDN as home', () => {
  assert.equal(isOutbound('https://example.com/'), true);
  assert.equal(isOutbound('https://www.facebook.com/'), false);
  assert.equal(isOutbound('https://scontent.fbcdn.net/x.jpg'), false);
  assert.equal(isOutbound('https://fb.watch/abc'), false);
  assert.equal(isOutbound('blob:https://www.facebook.com/1'), false);
});
