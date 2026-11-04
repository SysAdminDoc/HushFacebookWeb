// Hide the footer links: Privacy, Terms, Advertising, Cookies and the rest at the bottom of the
// left column. CSS only, so it works in content mode and switches off at once. Where the footer
// is found is in declutter-table.js.

import { FOOTER, hide } from './declutter-table.js';

export const FOOTER_CSS = hide(FOOTER);

export default {
  id: 'hideFooterLinks',
  section: 'layout',
  title: 'Hide the footer links',
  description: "Takes Facebook's Privacy, Terms, Advertising and Cookies links off the bottom of the left column. They're still at the bottom of the menu under your profile picture.",
  default: false,
  webOnly: true,
  css: FOOTER_CSS,
};
