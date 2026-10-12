// Finding a setting by its words: a feature matches when every word typed appears somewhere in its
// title, description, section name, option labels or choice names. Only the script's own text is
// searched, nothing from Facebook.

const fold = (text) => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

export function searchText(feature, sections) {
  const section = sections.find((entry) => entry.id === feature.section)?.title ?? '';
  const options = (feature.options ?? []).flatMap((option) => [option.label, ...(option.choices ?? []).map((choice) => choice.label)]);
  return fold([feature.title, feature.description, section, ...options].join(' '));
}

export function findFeatures(features, sections, query) {
  const words = fold(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  return features.filter((feature) => {
    const text = searchText(feature, sections);
    return words.every((word) => text.includes(word));
  });
}
