// Facebook's comment orders. Each comment section in Facebook's data lists them, with titles
// in the page's language:
//
//   selected_intent: { title, intent_token }
//   selectable_intents: [{ title, intent_token }, ...]   Most relevant, Newest, All comments
//
// The order menu shows them in that same order. Picking one is the only thing that makes
// Facebook ask for comments in another order (CommentListComponentsRootQuery with
// commentsIntentToken, seen live 2026-10-11): a post's first comments arrive with the page or
// the post's own query, which have no order setting. So the order is changed through the menu.

import { walk } from '../../core/json-walk.js';
import { normalizeText } from '../../core/dom/visible-text.js';

export const ORDERS = [
  { value: 'relevant', token: 'RANKED_FILTERED_INTENT_V1', english: 'Most relevant' },
  { value: 'newest', token: 'REVERSE_CHRONOLOGICAL_UNFILTERED_INTENT_V1', english: 'Newest' },
  { value: 'all', token: 'RANKED_UNFILTERED_CHRONOLOGICAL_REPLIES_INTENT_V1', english: 'All comments' },
];
export const DEFAULT_ORDER = ORDERS[0];
export const ORDER_MARKERS = ['"selectable_intents"'];

// The titles Facebook uses on this page, learned from its data. English until then, which is
// all content mode has.
export function createOrderTitles() {
  const learned = new Map(); // token -> title
  return {
    learn(doc) {
      walk(doc, (value) => {
        if (Array.isArray(value) || !Array.isArray(value.selectable_intents)) return;
        for (const intent of value.selectable_intents) {
          const title = normalizeText(intent?.title);
          if (title && typeof intent.intent_token === 'string') learned.set(intent.intent_token, title);
        }
      });
    },
    title: (order) => learned.get(order.token) ?? order.english,
    size: () => learned.size,
  };
}
