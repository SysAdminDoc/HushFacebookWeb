// Hide typing indicator, as Hushfacebook's patch does on Android. While you type, Facebook
// sends an unqueued task (label 3) saying is_typing 1. The script turns it into is_typing 0
// rather than dropping it, so the request still goes out and nothing waits on a missing one.

import { readJson, writeJson } from '../../core/net/lightspeed.js';
import { chatSocketRow } from './shared.js';

export const PRESENCE = '3';

export default {
  id: 'hideTyping',
  section: 'chats',
  android: 'Hide typing indicator',
  title: 'Hide typing indicator',
  description: "People you chat with don't see the dots while you type. End-to-end encrypted chats aren't covered.",
  default: false,
  needsPage: true,

  setup(ctx) {
    const { net, diagnostics, enabled } = ctx;
    let quieted = 0;
    const quiet = (task) => {
      if (String(task?.label) !== PRESENCE || typeof task.payload !== 'string') return false;
      const presence = readJson(task.payload);
      if (!presence || presence.is_typing !== 1) return false;
      presence.is_typing = 0;
      task.payload = writeJson(presence);
      quieted++;
      return true;
    };
    if (net) {
      net.editChatRequests({
        id: 'hideTyping',
        startupPrivacy: true,
        enabled,
        edit(request) {
          // Unqueued as mautrix-meta sends it (type 4), or among queued tasks (type 3).
          const tasks = request.type === 4 ? [request.payload] : request.type === 3 ? request.payload.tasks : null;
          if (!Array.isArray(tasks)) return false;
          const changed = tasks.map(quiet).some(Boolean);
          if (changed) diagnostics?.changed();
          return changed;
        },
      });
    }
    diagnostics?.add('Typing signals turned off', () => (net ? String(quieted) : "Off: the script can't reach the page's chat"));
    chatSocketRow(ctx);
  },
};
