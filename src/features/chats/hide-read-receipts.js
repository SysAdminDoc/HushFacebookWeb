// Hide read receipts, as Hushfacebook's patch does on Android. Opening a chat queues a task
// that tells Facebook you've read it (label 21, see core/net/lightspeed.js). The task is taken
// out of the request before it leaves the page, and the rest of the request goes as it was.
// End-to-end encrypted chats send their receipts encrypted, so they aren't covered.

import { chatSocketRow } from './shared.js';

export const MARK_READ = '21';

export default {
  id: 'hideReadReceipts',
  section: 'chats',
  android: 'Hide read receipts',
  title: 'Hide read receipts',
  description: "People you chat with don't see that you've read their messages, and the chat stays unread in your other apps. When you reply they'll know anyway. End-to-end encrypted chats, which most one-to-one chats are now, aren't covered, because their receipts are encrypted before the script can see them.",
  default: false,
  needsPage: true,

  setup(ctx) {
    const { net, diagnostics, enabled } = ctx;
    let held = 0;
    if (net) {
      net.editChatRequests({
        id: 'hideReadReceipts',
        enabled,
        edit(request) {
          const tasks = request.type === 3 ? request.payload.tasks : null;
          if (!Array.isArray(tasks)) return false;
          const kept = tasks.filter((task) => String(task?.label) !== MARK_READ);
          if (kept.length === tasks.length) return false;
          held += tasks.length - kept.length;
          request.payload.tasks = kept;
          diagnostics?.changed();
          return true;
        },
      });
    }
    diagnostics?.add('Read receipts held back', () => (net ? String(held) : "Off: the script can't reach the page's chat"));
    chatSocketRow(ctx);
  },
};
