import messengerPage from '../../../src/features/opening/messenger-page.js';

const went = [];
let seen = 0;

// The top bar's Messenger button (live 2026-10-11) with Open Messenger as a full page on. Where
// it would go is written down instead of followed. Facebook's own listeners sit below the
// document, so a press that reaches the body would open its list of chats.
export function prepareMessenger() {
  document.body.innerHTML = '<div role="banner"><div role="navigation"><div id="messenger" role="button" aria-label="Messenger" aria-haspopup="dialog" tabindex="0" style="width:80px;height:80px;background:#08f">M</div></div></div>';
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    document.body.addEventListener(type, () => { seen++; });
  }
  messengerPage.setup({
    doc: document,
    win: { location: { assign: (path) => went.push(`here ${path}`) }, open: (path) => went.push(`tab ${path}`) },
    enabled: () => true,
  });
  return true;
}

export const messengerState = () => ({ went: went.splice(0), seen });
