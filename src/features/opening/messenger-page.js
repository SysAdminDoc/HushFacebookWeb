// Open Messenger from the top bar, as Hushfacebook does on Android. The top bar's Messenger
// button opens a dropdown of chats, and a chat picked there opens as a small window over the
// page. Live 2026-10-11 (run 50) the button is a div with role="button", aria-label="Messenger"
// and aria-haspopup="dialog" in the banner's account controls, beside a second, zero-sized
// copy Facebook keeps for focus. With this on, the button goes to the full Messages page.
// Ctrl, Cmd or Shift with the click, or the middle button, opens it in a new tab instead.
//
// The handler listens on the document in the capture phase, so it runs before React's own
// listeners on the page root, and stops the press there so the dropdown never opens.

export const MESSAGES_PATH = '/messages/';
export const BUTTON = '[role="banner"] [role="button"][aria-label="Messenger"]';

// Presses that would open the dropdown. Only the click and Enter or Space navigate.
const PRESSES = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchstart'];

export const messengerButton = (target) => (typeof target?.closest === 'function' ? target.closest(BUTTON) : null);

export function messengerTarget(event) {
  if (event.type === 'keydown') return event.key === 'Enter' || event.key === ' ' ? 'here' : null;
  if (event.type === 'auxclick') return event.button === 1 ? 'tab' : null;
  if (event.type !== 'click' || event.button !== 0) return null;
  return event.ctrlKey || event.metaKey || event.shiftKey ? 'tab' : 'here';
}

export default {
  id: 'messengerPage',
  section: 'opening',
  android: 'Open Messenger from the top bar',
  title: 'Open Messenger as a full page',
  description: 'The Messenger button in the top bar goes straight to the Messages page instead of opening the list of chats over Facebook.',
  default: false,
  needsPage: false,

  setup({ doc, win, enabled, log, diagnostics }) {
    let sent = 0;
    const stop = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const go = (where) => {
      sent++;
      diagnostics?.changed();
      try {
        if (where === 'tab') win.open(MESSAGES_PATH, '_blank', 'noopener');
        else win.location.assign(MESSAGES_PATH);
      } catch (error) {
        log?.error("Couldn't open the Messages page", error);
      }
    };
    const onPress = (event) => {
      if (enabled() && messengerButton(event.target)) stop(event);
    };
    const onActivate = (event) => {
      if (!enabled() || !messengerButton(event.target)) return;
      const where = messengerTarget(event);
      if (event.type === 'keydown' && !where) return;
      stop(event);
      if (where) go(where);
    };
    // Not passive: Chrome makes a document's touchstart listeners passive unless told, and
    // ignores preventDefault in them.
    for (const type of PRESSES) doc.addEventListener(type, onPress, { capture: true, passive: false });
    for (const type of ['click', 'auxclick', 'keydown']) doc.addEventListener(type, onActivate, true);
    diagnostics?.add('Messenger button presses sent to Messages', () => String(sent));
  },
};
