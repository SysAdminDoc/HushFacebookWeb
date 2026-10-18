// Finding a setting by its words: a feature matches when every word typed appears somewhere in its
// title, description, section name, option labels, choice names or the few extra words a General
// row lists (backup for Back up). Each counts in the language shown and in English, so the
// English words keep finding a setting in any language. A General row's {name} words come from
// its vars. Only the script's own text is searched, nothing from Facebook.

import { english, t } from '../core/i18n.js';

const fold = (text) => String(text ?? '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[-‐‑‒–—'’]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const wordsOf = (query) => fold(query).split(' ').filter(Boolean);
const both = (text, vars) => {
  if (typeof text !== 'string' || !text) return [];
  const plain = english(text, vars);
  const shown = t(text, vars);
  return shown === plain ? [plain] : [shown, plain];
};
const optionText = (option) => [option.label, ...(option.keywords ?? [])].flatMap((text) => both(text));

export function searchText(feature, sections) {
  const section = sections.find((entry) => entry.id === feature.section)?.title ?? '';
  const options = (feature.options ?? []).flatMap((option) => [...optionText(option), ...(option.choices ?? []).flatMap((choice) => both(choice.label))]);
  const own = [feature.title, feature.description].flatMap((text) => both(text, feature.vars));
  return fold([...own, ...both(section), ...(feature.keywords ?? []).flatMap((text) => both(text)), ...options].join(' '));
}

export function findFeatures(features, sections, query) {
  const words = wordsOf(query);
  if (!words.length) return [];
  return features.filter((feature) => {
    const text = searchText(feature, sections);
    return words.every((word) => text.includes(word));
  });
}

// The button a result should land on in its section: the first option with its own focus key
// whose words hold every word typed. Null keeps the row's usual control.
export function matchingAction(setting, query) {
  const words = wordsOf(query);
  if (!words.length) return null;
  const option = (setting.options ?? []).find((entry) => {
    if (!entry.focusKey) return false;
    const text = fold(optionText(entry).join(' '));
    return words.every((word) => text.includes(word));
  });
  return option?.focusKey ?? null;
}
