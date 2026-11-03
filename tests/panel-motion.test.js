// Reduced motion in the settings panel. Live on signed-in Home on 2026-11-03 with the extension and
// prefers-reduced-motion emulated, every switch's knob (.switch::after) still slid for 0.15 s,
// because a bare `*` doesn't match pseudo-elements.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { panelCss } from '../src/ui/styles.js';

const reducedBlock = () => {
  const at = panelCss.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(at >= 0, 'the panel has a reduced motion block');
  const open = panelCss.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < panelCss.length; i++) {
    if (panelCss[i] === '{') depth++;
    if (panelCss[i] === '}' && --depth === 0) return panelCss.slice(open + 1, i);
  }
  throw new Error('unclosed block');
};

test('reduced motion stops transitions and animations on pseudo-elements too', () => {
  const block = reducedBlock();
  const rule = block.match(/([^{}]+)\{[^}]*transition:\s*none\s*!important[^}]*animation:\s*none\s*!important/);
  assert.ok(rule, 'one rule turns off both');
  const selectors = rule[1].split(',').map((s) => s.trim());
  for (const wanted of ['*', '*::before', '*::after']) assert.ok(selectors.includes(wanted), `${wanted} is covered`);
});

test('every pseudo-element the panel animates is one that rule reaches', () => {
  const animated = [...panelCss.matchAll(/([^{}]+)\{[^}]*\b(?:transition|animation)\s*:[^}]*\}/g)]
    .flatMap((m) => m[1].split(','))
    .map((s) => s.trim().match(/::(before|after)$/)?.[1])
    .filter(Boolean);
  assert.ok(animated.includes('after'), 'the switch knob is animated');
  const covered = new Set(reducedBlock().match(/\*::(before|after)/g)?.map((s) => s.slice(3)) ?? []);
  for (const pseudo of animated) assert.ok(covered.has(pseudo), `::${pseudo} is stopped under reduced motion`);
});
