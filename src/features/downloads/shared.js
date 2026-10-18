// What the four download switches share: one index of the photos and videos in Facebook's
// data, one Download button, and the save. Each switch adds itself, and the button only offers
// what a switch that's on covers.

import { createDownloadButton } from './button.js';
import { findMedia, planSave } from './find.js';
import { saveFile } from '../../core/download.js';
import { gmApi } from '../../core/env.js';
import { createMediaIndex, MEDIA_MARKERS } from '../../core/media-index.js';

const instances = new WeakMap();

export const QUALITY_OPTION = {
  key: 'quality', type: 'select', label: 'Video quality', default: 'best',
  choices: [{ value: 'best', label: 'Best (HD when there is one)' }, { value: 'sd', label: 'Smaller file (SD)' }],
};

function create({ win, doc, net, router, diagnostics, log, toast, api = gmApi() }) {
  const index = createMediaIndex();
  const switches = new Map(); // feature id -> { enabled(), quality() } (quality only on switches with that option)
  const anyOn = () => [...switches.values()].some((s) => s.enabled());
  let saved = 0;
  let failed = 0;

  // Read off Facebook's own JSON.parse, which every GraphQL answer and inline page blob goes
  // through, so the answers aren't parsed a second time. Nothing is changed, and it reads what
  // the page gets, after the other rules.
  net?.transformResponses({
    id: 'mediaIndex',
    enabled: anyOn,
    markers: MEDIA_MARKERS,
    match: (ctx) => ctx.transport === 'json-parse',
    observe: true,
    transform(data) {
      index.scan(data);
      return false;
    },
  });

  diagnostics?.add('Downloads', () => {
    const known = net ? `${index.size()} photos and videos known` : 'Photos only: the script can\'t reach the page\'s data';
    return `${known}, ${saved} saved, ${failed} failed this visit`;
  });

  async function run(found, container) {
    const settings = switches.get(found.feature);
    const plan = planSave(found, { quality: settings?.quality?.() });
    if (plan.error) {
      toast?.(plan.error, { tone: 'error' });
      return;
    }
    try {
      const how = await saveFile({ url: plan.url, name: plan.name, api, doc, win, container });
      saved++;
      toast?.(how === 'manager' ? `Saving ${plan.name}` : `Saved ${plan.name}`);
    } catch (error) {
      if (error.cancelled) {
        toast?.(`Cancelled ${plan.name}`);
        return;
      }
      failed++;
      // The file name carries the poster's name, so it stays out of the message.
      log?.error("Couldn't save a photo or video", error);
      toast?.(`Couldn't save it: ${error.message}.`, { tone: 'error' });
    } finally {
      diagnostics?.changed();
    }
  }

  const button = createDownloadButton({
    doc, win, log, run, active: anyOn,
    onMissing: () => toast?.("There's nothing to save there now. Go back to the photo or video and try again."),
    find(element) {
      const found = findMedia(element, { href: router?.current()?.href ?? win.location.href, index });
      return found && switches.get(found.feature)?.enabled() ? found : null;
    },
  });

  return {
    index,
    button,
    run,
    add(featureId, { enabled, quality = null }) {
      switches.set(featureId, { enabled, quality });
    },
  };
}

// The shared part for this page, made by whichever switch sets up first.
export function downloads(ctx) {
  const key = ctx.doc ?? globalThis.document;
  let shared = instances.get(key);
  if (!shared) {
    shared = create(ctx);
    instances.set(key, shared);
  }
  return shared;
}
