// The colors of the notes the script puts in Facebook's feed (a hidden post's line, the feed's
// loading line), as variables set on Facebook's own theme classes. A variable takes the value of
// the closest element that sets it, so a note follows the mode of whatever it sits in: the page,
// or one of the light islands Facebook keeps inside its dark areas (force-dark.js). html sets the
// dark ones for a page that has no class yet, and loses to either class on specificity.

export const NOTE_COLORS = [
  'html, .__fb-dark-mode { --hfw-note-text: #c4b0ff; --hfw-note-bg: #171923; --hfw-note-bg-strong: #262a3b; --hfw-note-border: #343745; }',
  // Text at 6:1 or better on both backgrounds.
  '.__fb-light-mode { --hfw-note-text: #5b3cc4; --hfw-note-bg: #f4f1ff; --hfw-note-bg-strong: #ebe5ff; --hfw-note-border: #d6ccf5; }',
].join('\n');
