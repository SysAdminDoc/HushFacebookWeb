// Wraps WebSocket.prototype.send in Facebook's window so features can edit what the chat
// socket sends (see lightspeed.js for the format) and the log batches the realtime socket sends
// (realtime.js). Only messages a rule changes are rewritten. Anything the script can't read goes
// out untouched, and so does everything when a rule fails.

import { DATA, frameJson, readFrames, readJson, readRequest, withJson, writeFrames, writeJson, writeRequest } from './lightspeed.js';
import { readBatchBody, withBatchText } from './realtime.js';

const LIGHTSPEED = /^wss:\/\/gateway\.facebook\.com\/ws\/lightspeed(?:[/?]|$)/;
const REALTIME = /^wss:\/\/gateway\.facebook\.com\/ws\/realtime(?:[/?]|$)/;

function bytesOf(data) {
  if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export function patchWebSocket(win, { log, startup, replace = (object, key, value) => { object[key] = value; } }) {
  const rules = [];
  const logRules = [];
  const failed = new Set();
  const stats = { messages: 0, unreadable: 0 };
  const logStats = { messages: 0, unreadable: 0 };
  const proto = win.WebSocket?.prototype;
  const original = proto?.send;
  const decoder = new (win.TextDecoder ?? TextDecoder)();
  const encoder = new (win.TextEncoder ?? TextEncoder)();

  const fail = (rule, error) => {
    if (failed.has(rule.id)) return;
    failed.add(rule.id);
    log.error(`Socket rule "${rule.id}" failed, so Facebook's message went out unchanged`, error);
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

  // The same for the realtime socket's log batches: the edited bytes, or null.
  function rewriteBatches(bytes, active) {
    const frames = readFrames(bytes);
    if (!frames) {
      logStats.unreadable++;
      return null;
    }
    let changed = false;
    const out = frames.map((frame) => {
      if (frame.type !== DATA) return frame;
      const read = readBatchBody(frame.body, decoder);
      const batch = read ? readJson(read.text) : null;
      if (!batch) {
        logStats.unreadable++;
        return frame;
      }
      if (!Array.isArray(batch.events)) return frame;
      let edited = false;
      for (const rule of active) {
        try {
          if (rule.edit(batch)) edited = true;
        } catch (error) {
          fail(rule, error);
          return frame;
        }
      }
      if (!edited) return frame;
      changed = true;
      return withBatchText(frame, read, writeJson(batch), encoder);
    });
    return changed ? writeFrames(out) : null;
  }

  const activeRules = (list) => {
    const startupState = startup?.state?.() ?? 'ready';
    return list.filter((rule) => {
      try {
        return startupState === 'ready' ? rule.enabled() : rule.startupPrivacy === true;
      } catch (error) {
        fail(rule, error);
        return false;
      }
    });
  };

  if (typeof original === 'function') {
    replace(proto, 'send', function send(data) {
      try {
        const chat = LIGHTSPEED.test(this.url);
        if (chat || REALTIME.test(this.url)) {
          (chat ? stats : logStats).messages++;
          const active = activeRules(chat ? rules : logRules);
          const bytes = active.length ? bytesOf(data) : null;
          const edited = bytes && (chat ? rewrite : rewriteBatches)(bytes, active);
          if (edited) {
            const isBuffer = Object.prototype.toString.call(data) === '[object ArrayBuffer]';
            return original.call(this, isBuffer ? edited.buffer : edited);
          }
        }
      } catch (error) {
        log.error("Couldn't read a chat or log message, so it went out unchanged", error);
      }
      return original.apply(this, arguments);
    });
  }

  return {
    installed: typeof original === 'function',
    stats,
    logStats,
    // rule: { id, enabled(), startupPrivacy?, edit(request) -> true when it changed request.payload }
    // request: { type, payload } with payload parsed (3: tasks, 4: one unqueued task).
    editChatRequests(rule) {
      rules.push(rule);
    },
    // rule: { id, enabled(), startupPrivacy?, edit(batch) -> true when it changed batch.events }
    // batch: the parsed log batch, { events: [{ name, extra (a JSON string), ... }] }.
    editLogBatches(rule) {
      logRules.push(rule);
    },
  };
}
