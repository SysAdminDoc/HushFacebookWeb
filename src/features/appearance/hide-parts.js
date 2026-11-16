// Hide parts of the page: point at a part of Facebook outside the feed, like a shortcut in the left
// column or a box in the right one, and it stays hidden. The picker (src/ui/part-picker.js) starts
// from the button on this card, and each part is saved as one line of a hidden setting, in the
// shapes part-rules.js reads. Every line becomes one CSS rule, so nothing is written on Facebook's
// elements and turning the feature off shows every part again at once.

import { t } from '../../core/i18n.js';
import { describeRule, partsCss, ruleFor, ruleLines } from './part-rules.js';

const KEY = 'hideParts.parts';

// What the picker asks of the rules.
export const pickerRules = Object.freeze({ ruleFor: (node) => ruleFor(node), cssFor: (line) => partsCss(line), describe: describeRule });

const append = (text, line) => `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}`;

// The text without its last copy of line, or null when line isn't in it.
function without(text, line) {
  const lines = text.split(/\r?\n/);
  const index = lines.findLastIndex((entry) => entry.trim() === line);
  if (index < 0) return null;
  lines.splice(index, 1);
  return lines.join('\n');
}

export default {
  id: 'hideParts',
  section: 'layout',
  title: 'Hide parts of the page',
  description: "Point at a part of Facebook outside the feed, like a box in the right column, and it stays hidden on that kind of page. Parts of the top bar stay hidden on every page. Each part you hide is listed here with a Show again button. Posts can't be picked, since Hide posts by words on the Feed page is for those.",
  default: true,
  webOnly: true,
  keywords: ['element picker', 'block element', 'zapper', 'right column', 'left column', 'shortcuts'],
  options: [{ key: 'parts', type: 'text', hidden: true, label: 'Parts you hid', default: '', maxLength: 20000 }],
  css: (get) => partsCss(String(get(KEY) ?? '')),

  setup({ settings, option, toast, log, actions, pickPart }) {
    if (!settings?.set) return;
    // Read the way the panel shows it, so two quick saves both stay.
    const parts = () => String(settings.display?.(KEY) ?? option('parts') ?? '');
    // Settles true once storage has it, and false when it couldn't be saved (logged, which shows
    // the error), so a toast never says it worked before it has. Throws before saving anything
    // when settings refuses the text (over its length limit).
    const save = (text) => Promise.resolve(settings.set(KEY, text)).then(() => true, (error) => {
      log?.error("Couldn't save the parts you hid", error);
      return false;
    });
    // full: the error notice when the list has no room left. Gives save's promise, or null when
    // the list was full.
    const tryToSave = (text, full) => {
      try {
        return save(text);
      } catch (error) {
        log?.warn('The list of hidden parts is full', error);
        toast?.(full(), { tone: 'error' });
        return null;
      }
    };
    // Undo puts the list back when nothing else changed it since, and otherwise takes back only
    // what that one change did.
    const undoAdd = (line, before, after) => {
      const now = parts();
      if (now === after) save(before);
      else if (ruleLines(now).includes(line)) save(without(now, line));
    };
    const undoRemove = (line, before, after) => {
      const now = parts();
      const full = () => t("Your list of hidden parts is full, so that part wasn't hidden again.");
      if (now === after) tryToSave(before, full);
      else if (!ruleLines(now).includes(line)) tryToSave(append(now, line), full);
    };

    const addPart = (line) => {
      const before = parts();
      if (ruleLines(before).includes(line)) {
        toast?.(t('That part is already hidden.'));
        return;
      }
      const after = append(before, line);
      const saving = tryToSave(after, () => t("Your list of hidden parts is full, so that part wasn't hidden."));
      return saving?.then((saved) => {
        if (saved) toast?.(t('Part hidden. To show it again, open Appearance in the settings.'), { action: { label: 'Undo', run: () => undoAdd(line, before, after) } });
      });
    };
    const showAgain = (line) => {
      const before = parts();
      const after = without(before, line);
      if (after === null) return;
      return save(after).then((saved) => {
        if (saved) toast?.(t('That part shows again.'), { action: { label: 'Undo', run: () => undoRemove(line, before, after) } });
      });
    };

    actions?.add('Pick a part to hide', () => pickPart?.({ section: 'layout', rules: pickerRules, onSave: addPart }));
    actions?.links(() => ruleLines(parts()).map((line) => ({
      label: describeRule(line),
      detail: line,
      action: { label: 'Show again', run: () => showAgain(line) },
    })), 'No parts hidden yet.');
  },
};
