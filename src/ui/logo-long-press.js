const LOGO_SELECTOR = '[role="banner"] a[aria-label="Facebook"]';
const HOLD_MS = 500;

const logoFor = (target) => target?.closest?.(LOGO_SELECTOR) ?? null;

// Facebook redraws its top bar, so this stays on the document instead of binding to one logo.
// A normal click remains Facebook's. Only the click produced by a completed hold is consumed.
export function installLogoLongPress({
  doc = globalThis.document,
  openSettings,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let press = null;
  let completion = null;

  function cancelPress() {
    if (press?.timer != null) clearTimer(press.timer);
    press = null;
  }

  function pointerdown(event) {
    cancelPress();
    // A reused pointer id, or any new pointer after release, starts a new sequence.
    if (completion && (completion.released || completion.pointerId === event.pointerId)) completion = null;
    const logo = logoFor(event.target);
    if (!logo || !['mouse', 'touch'].includes(event.pointerType) || event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const started = {
      logo,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      x: event.clientX,
      y: event.clientY,
      timer: null,
    };
    started.timer = setTimer(() => {
      if (press !== started) return;
      press = null;
      completion = {
        pointerId: started.pointerId,
        pointerType: started.pointerType,
        clickHandled: false,
        contextMenuHandled: false,
        released: false,
      };
      openSettings();
    }, HOLD_MS);
    press = started;
  }

  function pointermove(event) {
    if (!press || event.pointerId !== press.pointerId) return;
    if (event.clientX !== press.x || event.clientY !== press.y) cancelPress();
  }

  function pointerend(event) {
    if (press && event.pointerId === press.pointerId) cancelPress();
    if (completion?.pointerId === event.pointerId) completion.released = true;
  }

  function pointerleave(event) {
    if (press && event.pointerId === press.pointerId && event.target === press.logo) cancelPress();
  }

  function click(event) {
    if (!completion || completion.clickHandled || event.pointerId !== completion.pointerId || event.pointerType !== completion.pointerType) return;
    completion.clickHandled = true;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function contextmenu(event) {
    if (!completion || completion.pointerType !== 'touch' || completion.contextMenuHandled || event.pointerId !== completion.pointerId || event.pointerType !== 'touch') return;
    completion.contextMenuHandled = true;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  const listeners = [
    ['pointerdown', pointerdown],
    ['pointermove', pointermove],
    ['pointerup', pointerend],
    ['pointercancel', pointerend],
    ['pointerleave', pointerleave],
    ['click', click],
    ['contextmenu', contextmenu],
  ];
  for (const [type, listener] of listeners) doc.addEventListener(type, listener, true);

  return () => {
    cancelPress();
    for (const [type, listener] of listeners) doc.removeEventListener(type, listener, true);
  };
}
