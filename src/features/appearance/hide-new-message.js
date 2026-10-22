// Hide the New message button: the round button Facebook floats in the bottom corner, which
// gets in the way of zoomed-in screenshots (#7). CSS only, so it works in content mode and
// switches off at once. Where the button is found is in declutter-table.js.

import { hide, NEW_MESSAGE } from './declutter-table.js';

export const NEW_MESSAGE_CSS = hide(NEW_MESSAGE);

export default {
  id: 'hideNewMessageButton',
  section: 'appearance',
  android: 'Hide the New message button',
  title: 'Hide the New message button',
  description: 'Takes the round New message button out of the bottom corner of Facebook. Chats you have open stay where they are.',
  default: false,
  css: NEW_MESSAGE_CSS,
};
