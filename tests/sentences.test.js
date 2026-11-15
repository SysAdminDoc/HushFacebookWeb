// Where a row's help ends its first sentence (src/ui/sentences.js), and that every feature's
// first sentence fits on its row before More.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { features } from '../src/features/index.js';
import { firstSentence } from '../src/ui/sentences.js';

test('the first sentence ends where the sentence does, quotes and questions included', () => {
  assert.deepEqual(firstSentence('Hides posts. Shows the rest.', 'en'), ['Hides posts.', 'Shows the rest.']);
  assert.deepEqual(firstSentence('One sentence only.', 'en'), ['One sentence only.', '']);
  assert.deepEqual(firstSentence('Next to the short "3h" or "2d". You don\'t point at it.', 'en'), ['Next to the short "3h" or "2d".', 'You don\'t point at it.']);
  assert.deepEqual(firstSentence('Takes the "Write something..." box off groups. Comments stay.', 'en'), ['Takes the "Write something..." box off groups.', 'Comments stay.']);
  assert.deepEqual(
    firstSentence('Takes the "What\'s on your mind?" box off your profile, for reading. Comments stay.', 'en'),
    ['Takes the "What\'s on your mind?" box off your profile, for reading.', 'Comments stay.'],
    "a quoted question in the middle doesn't end it",
  );
  assert.deepEqual(firstSentence('', 'en'), ['', '']);
});

test('without Intl.Segmenter the whole text shows as one', (t) => {
  const { Segmenter } = Intl;
  t.after(() => { Intl.Segmenter = Segmenter; });
  Intl.Segmenter = undefined;
  assert.deepEqual(firstSentence('Hides posts. Shows the rest.', 'xx'), ['Hides posts. Shows the rest.', '']);
});

test("every feature's help opens with one sentence of 120 characters or less, and splitting loses no words", () => {
  for (const feature of features) {
    const [first, rest] = firstSentence(feature.description, 'en');
    assert.ok(first.length <= 120, `${feature.id}: ${first.length} characters before More: ${first}`);
    assert.equal([first, rest].filter(Boolean).join(' '), feature.description, `${feature.id} keeps every word`);
  }
});
