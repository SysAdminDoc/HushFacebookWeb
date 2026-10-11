// Hide tabs, as on Android: the top bar tabs you pick, and the Find friends button beside the
// Menu. Home always stays. CSS only, so it works in content mode and switches off at once.
// Where each tab is found is in declutter-table.js.

import { FIND_FRIENDS, hide, place, TAB_ROWS } from './declutter-table.js';

const ON_BY_DEFAULT = new Set(['video', 'marketplace', 'gaming']);

export function tabsCss(get) {
  const links = TAB_ROWS.filter(({ option }) => get(`hideTabs.${option}`)).map(({ link }) => place.tab(link));
  if (get('hideTabs.findFriends')) links.push(FIND_FRIENDS);
  return links.length ? hide(links.join(',\n')) : '';
}

export default {
  id: 'hideTabs',
  section: 'appearance',
  android: 'Hide tabs',
  title: 'Hide tabs',
  description: "Takes the top bar tabs you pick off Facebook, and the Find friends button. Home always stays, and the tabs' pages still open from the left column.",
  default: false,
  options: [
    ...TAB_ROWS.map(({ option, label }) => ({ key: option, type: 'toggle', label: `Hide ${label}`, default: ON_BY_DEFAULT.has(option) })),
    { key: 'findFriends', type: 'toggle', label: 'Hide the Find friends button', default: true },
  ],
  css: tabsCss,
};
