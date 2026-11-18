// Hide read receipts, as Hushfacebook's patch does on Android. Opening a chat queues a task
// that tells Facebook you've read it (label 21, see core/net/lightspeed.js). The task is taken
// out of the request before it leaves the page, and the rest of the request goes as it was.
// End-to-end encrypted chats send their receipts encrypted, so they aren't covered. A chat whose
// receipt was held keeps looking unread in the chat list (unread-look.js).

import { chatSocketRow } from './shared.js';
import { SEND_MESSAGE, taskThread, UNREAD_LOOK_CSS, watchUnreadLook } from './unread-look.js';

export const MARK_READ = '21';

export default {
  id: 'hideReadReceipts',
  section: 'people',
  android: 'Hide read receipts',
  title: 'Hide read receipts',
  description: "People you chat with don't see that you've read their messages, and the chat stays unread in your other apps. When you reply they'll know anyway. End-to-end encrypted chats, which most one-to-one chats are now, aren't covered, because their receipts are encrypted before the script can see them.",
  default: false,
  needsPage: true,
  options: [
    { key: 'keepUnread', type: 'toggle', label: 'Keep chats you open looking unread', default: true },
  ],
  css: (get) => (get('hideReadReceipts.keepUnread') ? UNREAD_LOOK_CSS : ''),

  setup(ctx) {
    const { doc, net, settings, diagnostics, enabled, option } = ctx;
    let held = 0;
    const look = doc && net ? watchUnreadLook({ doc, active: () => enabled() && option('keepUnread') === true }) : null;
    if (net) {
      net.editChatRequests({
        id: 'hideReadReceipts',
        startupPrivacy: true,
        enabled,
        edit(request) {
          const tasks = request.type === 3 ? request.payload.tasks : null;
          if (!Array.isArray(tasks)) return false;
          const kept = tasks.filter((task) => String(task?.label) !== MARK_READ);
          for (const task of tasks) {
            if (String(task?.label) !== MARK_READ) continue;
            look?.hold(taskThread(task));
          }
          // After the holds: a reply goes out with a receipt beside it.
          if (look) {
            for (const task of kept) {
              if (String(task?.label) === SEND_MESSAGE) look.release(taskThread(task));
            }
          }
          if (kept.length === tasks.length) return false;
          held += tasks.length - kept.length;
          request.payload.tasks = kept;
          diagnostics?.changed();
          return true;
        },
      });
    }
    if (look) {
      settings?.subscribe(() => {
        if (!enabled()) look.forget();
        look.sync();
      });
      diagnostics?.add('Chats kept looking unread', () => (option('keepUnread') === true ? String(look.size()) : 'Off'));
    }
    diagnostics?.add('Read receipts held back', () => (net ? String(held) : "Off: the script can't reach the page's chat"));
    chatSocketRow(ctx);
  },
};
