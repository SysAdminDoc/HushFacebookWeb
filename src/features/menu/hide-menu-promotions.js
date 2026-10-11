// Hide Menu promotions, as on Android: Facebook pushing its own extras in the left column and
// in Facebook's menu (the grid button). Ads Manager, Your Ad Activity and the Create column's
// Ad are one choice, Gaming Video and Play games the other. CSS only, so it works in content
// mode. Where each row is found is in appearance/declutter-table.js.

import { hide, place, PROMOTION_ROWS } from '../appearance/declutter-table.js';

export function promotionsCss(get) {
  const rows = PROMOTION_ROWS.filter(({ option }) => get(`hideMenuPromotions.${option}`));
  if (!rows.length) return '';
  return hide(rows.flatMap(({ link }) => [place.left(link), place.menu(link)]).join(',\n'));
}

export default {
  id: 'hideMenuPromotions',
  section: 'menu',
  android: 'Hide Menu promotions',
  title: 'Hide Menu promotions',
  description: "Takes Facebook's ad tools and gaming pitches out of the left column and Facebook's menu.",
  default: false,
  options: PROMOTION_ROWS.map(({ option, label }) => ({ key: option, type: 'toggle', label, default: true })),
  css: promotionsCss,
};
