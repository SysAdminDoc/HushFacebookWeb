// Finding a setting by its words: a feature matches when every word typed appears somewhere in its
// title, description, section name, option labels, choice names or the few extra words a General
// row lists (backup for Back up). Only the script's own text is searched, nothing from Facebook.

const fold = (text) => String(text ?? '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[-‐‑‒–—'’]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const wordsOf = (query) => fold(query).split(' ').filter(Boolean);
const optionText = (option) => [option.label, ...(option.keywords ?? [])];

export function searchText(feature, sections) {
  const section = sections.find((entry) => entry.id === feature.section)?.title ?? '';
  const options = (feature.options ?? []).flatMap((option) => [...optionText(option), ...(option.choices ?? []).map((choice) => choice.label)]);
  return fold([feature.title, feature.description, section, ...(feature.keywords ?? []), ...options].join(' '));
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
