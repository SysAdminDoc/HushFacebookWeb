// Which world the userscript manager put us in. Tampermonkey 5.5 on Firefox runs @sandbox
// JavaScript scripts in an Xray sandbox whose unsafeWindow is the page's window from another
// realm. Treated as the page, the network hooks there kept Home on the splash and 14 features
// failed with "Permission denied" (issue #8, live 2026-10-22). A vm context stands in for the
// other realm.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { accessFor, inPageRealm, windowFor } from '../src/core/env.js';

test('a window from our own realm is the page, and so is no unsafe window at all', () => {
  assert.equal(inPageRealm(globalThis), true);
  assert.equal(inPageRealm(null), true, 'the extension has no unsafeWindow and runs in the page');
});

test('a window from another realm is not the page', () => {
  const context = vm.createContext({});
  const other = vm.runInContext('globalThis', context);
  assert.equal(inPageRealm(other), false);
  assert.equal(inPageRealm(other, vm.runInContext('() => {}', context)), true, 'code made over there is');
});

test('a window that refuses the read is not the page', () => {
  const xray = Object.defineProperty({}, 'Function', {
    get() {
      throw new Error('Permission denied to access property "Function"');
    },
  });
  assert.equal(inPageRealm(xray), false);
});

test('page access needs the page realm and a manager in page mode', () => {
  assert.equal(accessFor({ scriptHandler: 'Tampermonkey', sandboxMode: 'raw' }, true), 'page');
  assert.equal(accessFor({ scriptHandler: 'Tampermonkey', sandboxMode: 'js' }, false), 'content', 'Tampermonkey JavaScript mode on Firefox');
  assert.equal(accessFor({ scriptHandler: 'Violentmonkey', injectInto: 'page' }, true), 'page');
  assert.equal(accessFor({ scriptHandler: 'Violentmonkey', injectInto: 'content' }, true), 'content');
  assert.equal(accessFor({ scriptHandler: 'Tampermonkey', sandboxMode: 'dom' }, true), 'content');
  assert.equal(accessFor(null, true), 'page', 'the extension');
});

// Violentmonkey 2.49 in content mode on Firefox hands over an unsafeWindow whose top isn't
// itself, and the script read that as a frame and never started (live 2026-10-22).
test('only page mode works on the unsafe window, content mode on its own', () => {
  const unsafe = { name: 'unsafe' };
  const own = { name: 'own' };
  assert.equal(windowFor(unsafe, 'page', own), unsafe);
  assert.equal(windowFor(unsafe, 'content', own), own);
  assert.equal(windowFor(null, 'page', own), own, 'the extension');
});
