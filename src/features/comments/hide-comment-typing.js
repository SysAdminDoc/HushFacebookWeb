// Hide that you're writing a comment. While you type in a post's comment box, Facebook tells
// everyone else looking at the post with one GraphQL mutation,
// CometUFILiveTypingBroadcastMutation_StartMutation (live 2026-10-11, captures/2026-10-11-run29:
// sent as soon as a letter went into the box), which they see as "is writing a comment". With
// this on it never leaves the page, and Relay gets an empty success, the way Don't send watch
// history holds back its report. The Stop half goes with it, so nothing is left half sent.

import { EMPTY_SUCCESS } from '../reels/no-watch-history.js';

export const COMMENT_TYPING = /^CometUFILiveTypingBroadcastMutation_(?:Start|Stop)Mutation$/;

export default {
  id: 'hideCommentTyping',
  section: 'comments',
  android: 'Hide typing indicator',
  title: "Hide that you're writing a comment",
  description: "Others looking at the same post don't see that you're writing a comment while you type one.",
  default: false,
  needsPage: true,

  setup({ net, enabled, diagnostics }) {
    let held = 0;
    net.blockRequests({
      id: 'hideCommentTyping',
      enabled,
      match: (ctx) => COMMENT_TYPING.test(ctx.friendlyName),
      fakeResponse: () => {
        held++;
        diagnostics?.changed();
        return EMPTY_SUCCESS;
      },
    });
    diagnostics?.add('Comment typing signals held back', () => String(held));
  },
};
