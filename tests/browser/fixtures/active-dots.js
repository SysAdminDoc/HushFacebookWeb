// Hide active status dots in a real engine. happy-dom reads a chain inside :has() as any one of
// its parts, so whether the notch rule leaves a notification's picture alone is only known here.
import { createSettings } from '../../../src/core/settings.js';
import { createMemoryStorage } from '../../../src/core/storage.js';
import { mountFeatureStyles } from '../../../src/core/style.js';
import hideActiveDots from '../../../src/features/appearance/hide-active-dots.js';
import { check } from './helpers.js';

const DRAWN = 'bottom: 5px; right: 5px; transform: translate(50%, 50%);';
const SERVED = 'bottom:6px;right:6px;transform:translate(50%, 50%)';
const DOT = (style) => `<div class="badge" data-visualcompletion="ignore" style="position:absolute;${style}"><div aria-hidden="false"><div><span data-visualcompletion="ignore"><div>Online status indicator</div></span><div role="none" data-visualcompletion="ignore" style="width:10px;height:10px;border-radius:50%;background:#31a24c"></div></div><div>Active</div></div></div>`;
const ICON = (picture) => `<div class="badge" data-visualcompletion="ignore" style="position:absolute;${SERVED}"><div><div aria-hidden="true">${picture}</div><div role="none" data-visualcompletion="ignore"></div></div></div>`;
const DRAWINGS = {
  svg: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><g><path d="M0 0h16v16H0z" fill="#f02849"></path></g></svg>',
  i: '<i data-visualcompletion="css-img" style="display:inline-block;width:16px;height:16px;background:#f02849"></i>',
  img: '<img height="16" width="16" alt="" aria-hidden="true" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
  background: '<div style="width:16px;height:16px;background-image:linear-gradient(#f02849,#f02849)"></div>',
};
const PICTURE = (badge, id) => `<a class="picture" id="${id}" href="#" role="link" style="display:inline-block;margin:8px"><div style="position:relative;width:72px;height:72px"><svg aria-label="Pat Example" role="img" viewBox="0 0 36 36" width="72" height="72"><mask id="m-${id}"><circle cx="18" cy="18" fill="white" r="18"></circle>${badge ? '<circle class="notch" cx="31" cy="31" data-visualcompletion="ignore" fill="black" r="6"></circle>' : ''}</mask><g mask="url(#m-${id})"><rect width="36" height="36" fill="#1877f2"></rect></g></svg><div role="none" data-visualcompletion="ignore"></div>${badge}</div></a>`;

export async function activeDots() {
  const settings = createSettings({ storage: createMemoryStorage(), features: [hideActiveDots], migrations: [] });
  settings.set('hideActiveDots', true);
  mountFeatureStyles({ features: [hideActiveDots], settings, doc: document });
  const main = document.createElement('main');
  main.innerHTML = PICTURE(DOT(DRAWN), 'drawn') + PICTURE(DOT(SERVED), 'served')
    + Object.entries(DRAWINGS).map(([name, drawing]) => PICTURE(ICON(drawing), name)).join('') + PICTURE('', 'plain');
  document.body.append(main);
  const gone = (el) => getComputedStyle(el).display === 'none';
  const parts = (id) => [main.querySelector(`#${id} .badge`), main.querySelector(`#${id} .notch`)];
  for (const id of ['drawn', 'served']) {
    const [badge, notch] = parts(id);
    check(gone(badge) && !badge.checkVisibility(), `${id}: the dot is still shown`);
    check(gone(notch), `${id}: the notch for the dot is still cut`);
  }
  for (const id of Object.keys(DRAWINGS)) {
    const [badge, notch] = parts(id);
    check(!gone(badge) && badge.checkVisibility(), `${id}: a notification's drawing was hidden`);
    check(!gone(notch), `${id}: the notch for a notification's drawing was filled in`);
  }
  check([...main.querySelectorAll('#plain circle')].every((circle) => !gone(circle)), "a picture with no badge lost part of its mask");
  settings.set('hideActiveDots', false);
  check(['drawn', 'served'].every((id) => parts(id).every((el) => !gone(el))), 'switching off left a dot hidden');
  settings.set('hideActiveDots', true);
  return { dotsHidden: 2, drawingsShown: Object.keys(DRAWINGS).length, switchesOff: true };
}
