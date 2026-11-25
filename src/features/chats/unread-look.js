// Keeps a chat you opened looking unread while Hide read receipts holds its receipt back (#5).
// Facebook never hears that you read it, but the page flips the row to read as soon as the chat
// has focus, and a reload then shows it unread again.
//
// Live 2026-11-18, on a chat without end-to-end encryption, script off: focusing the chat queues
// label 21 tasks whose queue_name is the thread id, and the row drops its dot and bold text at
// once. An unread row has a name and preview at weight 600, the preview in the main text color,
// and a 12 px dot in the row's last column, which is 12 px wider then. The time keeps its look.
//
// Live 2026-11-25, on an end-to-end encrypted chat, script off: focusing it queues a label 21
// task on the same socket, in sync group 95, whose queue_name and body carry the number from the
// chat's /messages/e2ee/t/ link. The row flips to read the same way.
//
// Rows are matched by the thread number in their link, so this works in any language. A plain
// chat and an encrypted one can share a number, so an encrypted chat's key is "e2ee:" plus it.
// The list is kept for this tab only: after a reload Facebook shows these chats unread itself.

export const UNREAD_MARK = 'data-hfw-unread';
// Sending a message, the label the open source mautrix-meta bridge names for it. Replying tells
// Facebook you've read the chat whatever happens to the receipt.
export const SEND_MESSAGE = '46';

const ROW_LINK = '[role="gridcell"] a[href*="/messages/t/"], [role="gridcell"] a[href*="/messages/e2ee/t/"]';
const OWN_DOT = '[aria-hidden="true"][role="button"]';
const THREAD_PATH = /\/messages\/(e2ee\/)?t\/(\d+)(?:[/?#]|$)/;
const ENCRYPTED_GROUP = /"sync_group":"?95(?!\d)/;
const key = (encrypted, number) => (encrypted ? `e2ee:${number}` : number);

const LINK = `a[${UNREAD_MARK}]`;
export const UNREAD_LOOK_CSS = `${LINK} span { font-weight: 600 !important; color: var(--primary-text) !important; }
${LINK} div > span ~ span, ${LINK} div > span ~ span span { font-weight: 400 !important; color: var(--secondary-text) !important; }
${LINK} > div > div > div:last-child { min-width: 24px !important; }
${LINK}::after { content: ""; position: absolute; top: 50%; inset-inline-end: 8px; width: 12px; height: 12px; margin-top: -6px; border-radius: 50%; background: var(--blue-link); pointer-events: none; }`;

// The thread a queued task belongs to, as digits ("e2ee:" first for an encrypted chat), or null.
// Never throws: this runs while a receipt is being held back, and a failing rule would let the
// receipt go out.
export function taskThread(task) {
  const payload = typeof task?.payload === 'string' ? task.payload : '';
  const queue = task?.queue_name;
  const number = typeof queue === 'string' && /^\d+$/.test(queue) ? queue : /"thread_(?:id|key)":"?(\d+)/.exec(payload)?.[1];
  return number ? key(ENCRYPTED_GROUP.test(payload), number) : null;
}

const linkThread = (link) => {
  const found = THREAD_PATH.exec(link.getAttribute('href') ?? '');
  return found ? key(Boolean(found[1]), found[2]) : null;
};

// active() says the look is wanted. Nothing watches the page until a chat is held.
export function watchUnreadLook({ doc, active }) {
  const threads = new Set();
  const view = doc.defaultView;
  // Before the browser paints the change, once however many changes came in.
  const frame = view?.requestAnimationFrame ? (fn) => view.requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16);
  const Observer = view?.MutationObserver ?? globalThis.MutationObserver;
  let queued = false;
  let watching = false;

  const sync = () => {
    queued = false;
    const root = doc.documentElement;
    if (!root) return;
    const wanted = new Set();
    const on = active() && threads.size > 0;
    if (on) {
      for (const link of doc.querySelectorAll(ROW_LINK)) {
        // A row with Facebook's own dot already looks unread.
        if (threads.has(linkThread(link)) && !link.querySelector(OWN_DOT)) wanted.add(link);
      }
    }
    for (const marked of doc.querySelectorAll(`[${UNREAD_MARK}]`)) {
      if (!wanted.has(marked)) marked.removeAttribute(UNREAD_MARK);
    }
    for (const link of wanted) {
      if (!link.hasAttribute(UNREAD_MARK)) link.setAttribute(UNREAD_MARK, '');
    }
    if (on !== watching) {
      watching = on;
      // The list reuses rows for other chats, so a changed link counts too. The mark itself isn't
      // watched, so these writes never come back here.
      if (on) observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
      else observer.disconnect();
    }
  };

  const schedule = () => {
    if (queued) return;
    queued = true;
    frame(sync);
  };
  const observer = new Observer(schedule);

  return {
    sync,
    size: () => threads.size,
    hold(thread) {
      if (!thread || threads.has(thread)) return;
      threads.add(thread);
      schedule();
    },
    release(thread) {
      if (threads.delete(thread)) schedule();
    },
    forget: () => threads.clear(),
  };
}
