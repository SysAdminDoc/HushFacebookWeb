import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLog } from '../src/core/log.js';
import { createSettings } from '../src/core/settings.js';
import { createMemoryStorage } from '../src/core/storage.js';
import { mountFeatureStyles, renderFeatureCss } from '../src/core/style.js';
import { SKIP, walk } from '../src/core/json-walk.js';
import { rootlessDocument } from './fake-dom.js';

test('the log keeps a bounded buffer and tells subscribers', () => {
  const printed = [];
  const log = createLog({ capacity: 2, sink: { info: (...args) => printed.push(args[0]), error() {}, warn() {} } });
  const heard = [];
  log.subscribe((entry) => heard.push(entry.level));
  log.debug('quiet');
  log.info('one');
  log.error('two', new Error('why'));
  assert.deepEqual(log.entries().map((entry) => entry.message), ['one', 'two']);
  assert.match(log.entries()[1].detail, /^Error: why/);
  assert.deepEqual(heard, ['debug', 'info', 'error']);
  assert.deepEqual(printed, ['[HushFacebook Web] one']);
});

test('feature CSS covers only features that are on, and nothing while paused', () => {
  const features = [
    { id: 'a', title: 'A', default: true, css: '.a{}' },
    { id: 'b', title: 'B', default: false, css: '.b{}' },
    { id: 'c', title: 'C', default: true, options: [{ key: 'color', type: 'text', default: 'red' }], css: (get) => `.c{color:${get('c.color')}}` },
  ];
  const settings = createSettings({ storage: createMemoryStorage(), features });
  assert.equal(renderFeatureCss(features, settings), '/* a */\n.a{}\n/* c */\n.c{color:red}');
  settings.set('paused', true);
  assert.equal(renderFeatureCss(features, settings), '');
});

test('feature CSS waits for <html> when the script starts before it exists', () => {
  const features = [{ id: 'a', title: 'A', default: true, css: '.a{}' }];
  const settings = createSettings({ storage: createMemoryStorage(), features });
  const { doc, addRoot } = rootlessDocument();
  const style = mountFeatureStyles({ features, settings, doc });
  const appended = [];
  addRoot({ append: (element) => appended.push(element) });
  assert.deepEqual(appended, [style]);
  assert.equal(style.textContent, '/* a */\n.a{}');
});

test('walk reaches every nested object and honors SKIP', () => {
  const seen = [];
  walk({ a: [{ id: 1 }, { id: 2, skip: true, inner: { id: 3 } }], b: null }, (value) => {
    if ('id' in value) seen.push(value.id);
    return value.skip ? SKIP : undefined;
  });
  assert.deepEqual(seen.sort(), [1, 2]);
});
