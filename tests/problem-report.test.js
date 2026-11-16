import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProblemReport, MAX_PROBLEM_BODY_LENGTH, PROBLEM_REPORT_URL } from '../src/ui/problem-report.js';

test('the problem link contains versions and enabled titles without private settings', () => {
  const features = [
    { id: 'quiet', title: 'Quiet mode' },
    { id: 'other', title: 'Other mode' },
  ];
  const values = { quiet: true, other: false };
  const schema = new Map([
    ['ui.launcher', { type: 'toggle', label: 'Show the settings button on Facebook' }],
    ['quiet', { type: 'toggle', label: 'Quiet mode', featureId: 'quiet' }],
    ['quiet.detail', { type: 'toggle', label: 'Quiet detail', featureId: 'quiet' }],
    ['other', { type: 'toggle', label: 'Other mode', featureId: 'other' }],
    ['other.detail', { type: 'toggle', label: 'Other detail', featureId: 'other' }],
  ]);
  Object.assign(values, { 'ui.launcher': true, 'quiet.detail': true, 'other.detail': true });
  const report = buildProblemReport({
    version: '0.0.4',
    browser: 'Example Browser 1.2',
    manager: 'Tampermonkey',
    managerVersion: '5.5.1',
    features,
    settings: { schema, get: (key) => values[key], snapshot: () => ({ account: '615000000000017' }) },
  });
  assert.equal(report.title, 'HushFacebook Web 0.0.4 problem');
  assert.match(report.body, /^HushFacebook Web: 0\.0\.4$/m);
  assert.match(report.body, /^Browser: Example Browser 1\.2$/m);
  assert.match(report.body, /^Userscript manager: Tampermonkey 5\.5\.1$/m);
  assert.match(report.body, /^- Quiet mode$/m);
  assert.match(report.body, /^- Quiet detail$/m);
  assert.match(report.body, /^- Show the settings button on Facebook$/m);
  assert.ok(!report.body.includes('Other mode'));
  assert.match(report.body, /^- Other detail$/m);
  assert.ok(!report.body.includes('615000000000017'));
  assert.match(report.body, /What happened:\n\n\nWhat I expected:\n$/);
  const url = new URL(report.url);
  assert.equal(`${url.origin}${url.pathname}`, PROBLEM_REPORT_URL);
  assert.equal(url.searchParams.get('title'), report.title);
  assert.equal(url.searchParams.get('body'), report.body);
});

test('the problem link lists each choice moved off its default by the words the panel shows', () => {
  const features = [{ id: 'comments', title: 'Sort comments' }];
  const note = {
    type: 'select', default: false, label: 'Leave a note where a post was hidden',
    choices: [{ value: false, label: 'Never' }, { value: 'own', label: 'Only for your own filters' }, { value: true, label: 'Always' }],
  };
  const order = {
    type: 'select', default: 'newest', label: 'Order', featureId: 'comments',
    choices: [{ value: 'newest', label: 'Newest first' }, { value: 'oldest', label: 'Oldest first' }],
  };
  const schema = new Map([['ui.hiddenNote', note], ['comments.order', order]]);
  const report = (values) => buildProblemReport({
    version: '0.0.4', browser: 'Example Browser 1.2', manager: 'Tampermonkey', managerVersion: '5.5.1', features,
    settings: { schema, get: (key) => values[key] },
  }).body;
  // A choice that was a switch once, at each of its values, and a feature's option named with it.
  assert.match(report({ 'ui.hiddenNote': 'own', 'comments.order': 'oldest' }), /^Changed choices:\n- Leave a note where a post was hidden: Only for your own filters\n- Order \(Sort comments\): Oldest first$/m);
  assert.match(report({ 'ui.hiddenNote': true, 'comments.order': 'newest' }), /^Changed choices:\n- Leave a note where a post was hidden: Always\n\n/m);
  // Defaults, and a value no choice has, list nothing.
  for (const values of [{ 'ui.hiddenNote': false, 'comments.order': 'newest' }, { 'ui.hiddenNote': 'Own', 'comments.order': 'sideways' }]) {
    const body = report(values);
    assert.match(body, /^Changed choices:\n- None$/m, JSON.stringify(values));
    assert.ok(!body.includes('Leave a note'), JSON.stringify(values));
  }
});

test('the problem body is capped and keeps both questions', () => {
  const features = Array.from({ length: 100 }, (_, index) => ({ id: `feature-${index}`, title: `Feature ${index} ${'x'.repeat(100)}` }));
  const report = buildProblemReport({
    version: '0.0.4',
    browser: `Browser ${'x'.repeat(10000)} 615000000000017`,
    manager: 'Manager',
    managerVersion: '1',
    features,
    settings: { get() { return true; } },
  });
  assert.ok(report.body.length <= MAX_PROBLEM_BODY_LENGTH);
  assert.match(report.body, /\[details shortened\]/);
  assert.match(report.body, /^Userscript manager: Manager 1$/m);
  assert.match(report.body, /^- Feature 0 /m);
  assert.match(report.body, /What happened:\n\n\nWhat I expected:\n$/);
  assert.ok(!report.body.includes('615000000000017'));
});
