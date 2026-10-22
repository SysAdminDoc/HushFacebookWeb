// Hide when others are writing a comment. Facebook draws the "is writing a comment" line under a
// post's comments from its feedback's typing_indicator_renderer, an
// XFBFeedbackInlineTypingIndicatorRenderer that the comment list hands to a Relay MatchContainer,
// whose code (CometUFIInlineTypingIndicator) only loads when the field has a value (Facebook's
// code, 2026-10-22: useCometUFITopLevelCommentListComponents). Comment lists, new comments
// (useCometUFICommentCreateSubscription) and the answer to your own comment all carry it. With
// this on, the field comes back empty, so the container has nothing to draw, and new comments
// still arrive the way they did. On the two busy posts watched live (2026-10-22, 2.5 minutes on
// one) the field was already empty, so the line itself hasn't been seen yet.

import { walk } from '../../core/json-walk.js';
import { later } from '../../core/net/payload.js';

export const MARKERS = ['"typing_indicator_renderer":{'];

// Empties every typing line in a parsed answer. How many there were.
export function dropTypingLines(doc) {
  let dropped = 0;
  walk(doc, (value) => {
    if (Array.isArray(value)) return undefined;
    const renderer = value.typing_indicator_renderer;
    if (renderer && typeof renderer === 'object') {
      value.typing_indicator_renderer = null;
      dropped++;
    }
    return undefined;
  });
  return dropped;
}

export default {
  id: 'hideIncomingCommentTyping',
  section: 'comments',
  android: 'Hide who is typing in comments',
  title: 'Hide when others are writing a comment',
  description: "Takes away the line under a post's comments that says someone is writing one. New comments still show up as they're posted.",
  default: false,
  needsPage: true,

  setup({ net, enabled, diagnostics }) {
    let dropped = 0;
    net.transformResponses({
      id: 'hideIncomingCommentTyping',
      enabled,
      markers: MARKERS,
      // Facebook parses every answer and the page's inline data with JSON.parse.
      match: (ctx) => ctx.transport === 'json-parse',
      transform(data, ctx, stage) {
        const count = dropTypingLines(data);
        if (!count) return false;
        later(stage, () => {
          dropped += count;
          diagnostics?.changed();
        });
        return true;
      },
    });
    diagnostics?.add('Comment typing lines kept out', () => String(dropped));
  },
};
