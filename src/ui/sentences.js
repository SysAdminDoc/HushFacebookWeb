// A row's help split where its first sentence ends, by the shown language's own sentence rules,
// so the rest can wait behind More. A browser without Intl.Segmenter shows it all as one.

const segmenters = new Map();

export function firstSentence(text, lang) {
  const Segmenter = globalThis.Intl?.Segmenter;
  if (typeof Segmenter !== 'function' || !text) return [text, ''];
  let segmenter = segmenters.get(lang);
  if (!segmenter) {
    segmenter = new Segmenter(lang, { granularity: 'sentence' });
    segmenters.set(lang, segmenter);
  }
  // The rules end a sentence at a quoted question ("What's on your mind?") even when the words
  // after it go on in lowercase, so a piece that starts lowercase still belongs to the first.
  const [first, ...rest] = [...segmenter.segment(text)].map((piece) => piece.segment);
  let end = first.length;
  for (const piece of rest) {
    if (!/^\p{Ll}/u.test(piece)) break;
    end += piece.length;
  }
  return [text.slice(0, end).trimEnd(), text.slice(end).trim()];
}
