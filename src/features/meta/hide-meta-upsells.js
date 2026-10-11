// Hide Meta upsells, as on Android: Meta's other apps and devices in the left column and in
// Facebook's menu. Every one of them leaves Facebook (Meta AI, Meta Quest, Ray-Ban Meta,
// WhatsApp, Instagram, seen live 2026-10-11), which is how they're found, plus Messenger Kids.
// The left column's Messenger row is part of Facebook, so it stays. CSS only, so it works in
// content mode. Where each row is found is in appearance/declutter-table.js.

import { hide, place, UPSELL_LINK } from '../appearance/declutter-table.js';

export const UPSELLS_CSS = hide([place.left(UPSELL_LINK), place.menu(UPSELL_LINK)].join(',\n'));

export default {
  id: 'hideMetaUpsells',
  section: 'meta',
  android: 'Hide Meta upsells',
  title: 'Hide Meta upsells',
  description: "Takes Meta AI, Meta Quest, Ray-Ban Meta, WhatsApp, Instagram and Messenger Kids out of the left column and Facebook's menu.",
  default: false,
  css: UPSELLS_CSS,
};
