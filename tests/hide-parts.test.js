// Hide parts of the page (src/features/appearance/hide-parts.js) on its own, with a stand-in for
// settings: its "Part hidden" and "That part shows again" notices wait for storage to take the
// change, so a save that fails never says it worked. The picker and panel side is in
// part-picker.test.js and panel.test.js.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import hideParts from '../src/features/appearance/hide-parts.js';

const LINE = 'complementary at 1 1 1';

// full: settings turns down every text, the way it does one over the option's length limit.
function setup(stored = '', { full = false } = {}) {
  let value = stored;
  const pending = [];
  const toasts = [];
  const errors = [];
  const buttons = new Map();
  let links = () => [];
  hideParts.setup({
    settings: {
      display: () => value,
      set: (key, text) => {
        if (full) throw new RangeError('Parts you hid is too long');
        value = text;
        return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      },
    },
    option: () => value,
    toast: (text, options) => toasts.push({ text, options }),
    log: { error: (message) => errors.push(message), warn: () => {} },
    actions: {
      add: (label, run) => buttons.set(label, run),
      links: (get) => {
        links = get;
      },
    },
    pickPart: ({ onSave }) => onSave(LINE),
  });
  return { toasts, errors, pending, pick: () => buttons.get('Pick a part to hide')(), links: () => links(), value: () => value };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('Part hidden shows once storage has the part, and never when the save fails', async () => {
  const kept = setup();
  kept.pick();
  assert.equal(kept.value(), LINE, 'the part shows hidden at once');
  await settle();
  assert.deepEqual(kept.toasts, [], 'nothing said while storage is still saving');
  kept.pending[0].resolve();
  await settle();
  assert.deepEqual(kept.toasts.map(({ text }) => text), ['Part hidden. To show it again, open Appearance in the settings.']);
  assert.equal(kept.toasts[0].options.action.label, 'Undo');

  const lost = setup();
  lost.pick();
  lost.pending[0].reject(new Error('storage refused it'));
  await settle();
  assert.deepEqual(lost.toasts, [], 'no Part hidden, and no Undo for a change that never happened');
  assert.deepEqual(lost.errors, ["Couldn't save the parts you hid"], 'the error is logged, which shows it in the panel');
});

test('a full list says so right away and keeps the parts it had', async () => {
  const full = setup('navigation at 1', { full: true });
  full.pick();
  await settle();
  assert.equal(full.value(), 'navigation at 1');
  assert.deepEqual(full.toasts.map(({ text, options }) => [text, options?.tone]), [["Your list of hidden parts is full, so that part wasn't hidden.", 'error']]);
  assert.deepEqual(full.errors, [], "it isn't a storage error");
});

test('That part shows again waits for storage the same way', async () => {
  const kept = setup(LINE);
  const [link] = kept.links();
  const shown = link.action.run();
  assert.equal(kept.value(), '');
  kept.pending[0].resolve();
  await shown;
  assert.deepEqual(kept.toasts.map(({ text }) => text), ['That part shows again.']);

  const lost = setup(LINE);
  const failed = lost.links()[0].action.run();
  lost.pending[0].reject(new Error('storage refused it'));
  await failed;
  assert.deepEqual(lost.toasts, []);
  assert.deepEqual(lost.errors, ["Couldn't save the parts you hid"]);
});
