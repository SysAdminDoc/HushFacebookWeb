// Wraps WebSocket.prototype.send in Facebook's window so features can edit what the chat
// socket sends (see lightspeed.js for the format). Only requests a rule changes are rewritten.
// Anything the script can't read goes out untouched, and so does everything when a rule fails.

import { frameJson, readFrames, readRequest, withJson, writeFrames, writeRequest } from './lightspeed.js';

const LIGHTSPEED = /^wss:\/\/gateway\.facebook\.com\/ws\/lightspeed(?:[/?]|$)/;

function bytesOf(data) {
  if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export function patchWebSocket(win, { log, startup }) {
  const rules = [];
  const failed = new Set();
  const stats = { messages: 0, unreadable: 0 };
  const proto = win.WebSocket?.prototype;
  const original = proto?.send;
  const decoder = new (win.TextDecoder ?? TextDecoder)();
  const encoder = new (win.TextEncoder ?? TextEncoder)();

  const fail = (rule, error) => {
    if (failed.has(rule.id)) return;
    failed.add(rule.id);
    log.error(`Chat rule "${rule.id}" failed, so Facebook's message went out unchanged`, error);
  };

  // The edited bytes, or null to send the original.
  function rewrite(bytes, active) {
    const frames = readFrames(bytes);
    if (!frames) {
      stats.unreadable++;
      return null;
    }
    let changed = false;
    const out = frames.map((frame) => {
      const text = frameJson(frame, decoder);
      if (text === null) return frame;
      const request = readRequest(text);
      if (!request) {
        stats.unreadable++;
        return frame;
      }
      let edited = false;
      for (const rule of active) {
        try {
          if (rule.edit(request)) edited = true;
        } catch (error) {
          fail(rule, error);
          return frame;
        }
      }
      if (!edited) return frame;
      changed = true;
      return withJson(frame, writeRequest(request), encoder);
    });
    return changed ? writeFrames(out) : null;
  }

  if (typeof original === 'function') {
    proto.send = function send(data) {
      try {
        if (LIGHTSPEED.test(this.url)) {
          stats.messages++;
          const startupState = startup?.state?.() ?? 'ready';
          const active = rules.filter((rule) => {
            try {
              return startupState === 'ready' ? rule.enabled() : rule.startupPrivacy === true;
            } catch (error) {
              fail(rule, error);
              return false;
            }
          });
          const bytes = active.length ? bytesOf(data) : null;
          const edited = bytes && rewrite(bytes, active);
          if (edited) {
            const isBuffer = Object.prototype.toString.call(data) === '[object ArrayBuffer]';
            return original.call(this, isBuffer ? edited.buffer : edited);
          }
        }
      } catch (error) {
        log.error("Couldn't read a chat message, so it went out unchanged", error);
      }
      return original.apply(this, arguments);
    };
  }

  return {
    installed: typeof original === 'function',
    stats,
    // rule: { id, enabled(), startupPrivacy?, edit(request) -> true when it changed request.payload }
    // request: { type, payload } with payload parsed (3: tasks, 4: one unqueued task).
    editChatRequests(rule) {
      rules.push(rule);
    },
  };
}
