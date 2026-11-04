// Shared colors also keep floating media controls in step with settings.
export const uiTokens = `
  --base: #15191f; --mantle: #101419; --crust: #0d1117;
  --surface0: #1a2029; --surface1: #303b4b;
  --text: #edf2f8; --subtext: #a6afbd; --accent: #8abfff; --accent-ink: #12263e;
  --border: #2b333f; --selected: #1c3048; --control: #768599;
  --green: #a6e3a1; --red: #f38ba8; --peach: #fab387;
`;

export const panelCss = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.root {
  ${uiTokens}
  color-scheme: dark;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--text);
  --flip: 1;
}
/* Right to left: start and end swap sides, and a switch's knob slides the other way. The gear
   follows Facebook's top bar, which mirrors on its own. */
.root[dir="rtl"] { --flip: -1; }
button, input, select, textarea { font: inherit; color: inherit; -webkit-tap-highlight-color: transparent; }
button { cursor: pointer; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
svg { flex: none; }
/* The gear passes for one of the round buttons in Facebook's top bar: their size, and their
   colors through Facebook's own variables, which reach in here (themes included). The fallbacks
   are for a page that doesn't set them. launcher-place.js puts it beside them. */
.launcher {
  position: fixed; z-index: 2147483000; width: 40px; height: 40px; padding: 0; border: 0; border-radius: 50%;
  display: grid; place-items: center; color: var(--primary-icon, var(--text));
  background: var(--secondary-button-background, var(--surface1));
}
.launcher:hover { background-image: linear-gradient(var(--hover-overlay, #ffffff1a), var(--hover-overlay, #ffffff1a)); }
.launcher:active { background-image: linear-gradient(var(--press-overlay, #ffffff33), var(--press-overlay, #ffffff33)); }
/* 22 px, since the gear leaves more margin in its box than Facebook's icons do in their 20. */
.launcher svg { width: 22px; height: 22px; fill: currentColor; fill-rule: evenodd; }
/* Unseen while a fresh page draws its bar, so it doesn't flash in the corner first. */
.launcher[data-place="wait"] { visibility: hidden; }
/* A page without the bar: floating over the bottom-left corner, like Facebook's own floating
   buttons. */
.launcher[data-place="corner"] { left: 12px; bottom: 12px; background-color: var(--secondary-button-background-floating, var(--base)); box-shadow: 0 2px 12px #0006; }
.launcher[hidden] { display: none; }
.dialog {
  width: min(1180px, calc(100vw - 48px)); height: min(900px, calc(100dvh - 64px));
  max-width: none; max-height: none; padding: 0; margin: auto; overflow: hidden;
  display: grid; grid-template-rows: auto minmax(0, 1fr) auto;
  font: inherit; color: inherit; color-scheme: dark;
  background: var(--base); border: 1px solid var(--border); border-radius: 14px;
  box-shadow: 0 24px 80px #0008;
}
.dialog:not([open]) { display: none; }
.dialog::backdrop { background: #0b0e13cc; backdrop-filter: blur(6px); }
header { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 12px 16px 12px 20px; border-bottom: 1px solid var(--border); background: var(--mantle); }
.brand { min-width: 0; display: flex; align-items: center; gap: 12px; }
.brand-icon { width: 40px; height: 40px; flex: none; display: grid; place-items: center; border-radius: 10px; background: var(--selected); border: 1px solid #29415c; }
.brand-icon svg { width: 22px; height: 22px; fill: var(--accent); }
.brand-copy { min-width: 0; display: grid; }
header h2 { margin: 0; font-size: 18px; line-height: 22px; font-weight: 650; letter-spacing: -0.2px; white-space: nowrap; }
.brand-subtitle { color: var(--subtext); font-size: 12px; line-height: 16px; }
.header-actions { flex: none; display: flex; align-items: center; gap: 10px; }
/* The power switch and its state share one pill: green dot and On, or a peach dot and Paused. */
.power { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 4px 6px 4px 12px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface0); cursor: pointer; }
.power-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 3px #a6e3a126; }
.power[data-state="paused"] { border-color: #6b4f33; }
.power[data-state="paused"] .power-dot { background: var(--peach); box-shadow: 0 0 0 3px #fab38726; }
.power-state { font-size: 13px; font-weight: 600; white-space: nowrap; }
.power .switch { margin: 0; }
.icon-button { border: 1px solid var(--border); background: transparent; width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; }
.icon-button:hover { background: var(--surface0); }
.icon-button svg { width: 20px; height: 20px; color: var(--subtext); }
.body { display: grid; grid-template-columns: 252px minmax(0, 1fr); min-height: 0; }
nav { padding: 16px 10px; background: var(--mantle); border-inline-end: 1px solid var(--border); overflow: auto; overscroll-behavior: contain; }
.nav-label { margin: 4px 12px 8px; color: var(--subtext); font-size: 11px; font-weight: 650; letter-spacing: 1.4px; text-transform: uppercase; }
.nav-icon { width: 20px; height: 20px; }
nav button {
  position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 40px; text-align: start;
  border: 0; background: transparent; padding: 8px 10px 8px 12px; margin-block: 1px;
  border-radius: 8px; color: var(--subtext); font-size: 15px; line-height: 20px;
  transition: background 0.15s ease, color 0.15s ease;
}
nav button:hover { background: var(--surface0); color: var(--text); }
nav button[aria-current="page"] { background: var(--selected); color: var(--text); font-weight: 600; }
nav button[aria-current="page"] .nav-icon { color: var(--accent); }
nav button[aria-current="page"]::before { content: ""; position: absolute; inset-block: 8px; inset-inline: -10px auto; width: 3px; border-radius: 2px; background: var(--accent); }
nav button:focus-visible { outline-offset: -3px; }
.nav-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* How many of the page's switches are on. */
.nav-count { flex: none; min-width: 24px; padding: 0 7px; border-radius: 999px; background: var(--surface1); color: var(--text); font-size: 12px; line-height: 20px; font-weight: 600; text-align: center; }
nav button[aria-current="page"] .nav-count { background: var(--accent); color: var(--accent-ink); }
nav hr { border: 0; border-top: 1px solid var(--border); margin: 12px 12px; }
.search-field { position: relative; flex: 1 1 300px; max-width: 460px; min-width: 120px; }
.search-field .nav-icon { position: absolute; inset-inline-start: 12px; top: 10px; pointer-events: none; color: var(--subtext); width: 20px; height: 20px; }
.search {
  display: block; box-sizing: border-box; width: 100%; margin: 0; padding-block: 9px; padding-inline: 42px 12px;
  background: var(--crust); border: 1px solid var(--control); border-radius: 10px; font-size: 14px; line-height: 20px;
  text-overflow: ellipsis;
}
.search::placeholder { color: var(--subtext); opacity: 0.85; text-overflow: ellipsis; }
.result { padding: 14px 0; border-top: 1px solid var(--border); }
.result:first-child { border-top: 0; }
.result > .card { border: 0; padding: 8px 0 0; }
.result-section {
  display: block; margin: 0; padding: 0; min-height: 24px; border: 0; background: none; cursor: pointer; text-align: start;
  color: var(--accent); font-size: 12px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase;
}
.result-section:hover { text-decoration: underline; }
.results, .page-heading + .empty { margin-top: 20px; }
main { min-width: 0; overflow: auto; overscroll-behavior: contain; padding: 24px 32px 40px; scrollbar-gutter: stable; overflow-wrap: anywhere; }
.page-heading { display: flex; align-items: center; gap: 16px; margin: 0 0 4px; }
.page-icon { display: grid; place-items: center; flex: none; width: 48px; height: 48px; border-radius: 12px; color: var(--accent); background: var(--selected); border: 1px solid #29415c; }
.page-icon .nav-icon { width: 26px; height: 26px; stroke-width: 1.6; }
.page-copy { min-width: 0; flex: 1; }
.page-heading h3 { margin: 0; font-size: 24px; line-height: 30px; font-weight: 650; letter-spacing: -0.4px; }
.page-heading p { margin: 2px 0 0; color: var(--subtext); font-size: 14px; line-height: 21px; }
.setting-count { flex: none; padding: 4px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface0); color: var(--subtext); font-size: 13px; font-weight: 600; white-space: nowrap; }
.setting-count.some { color: var(--accent); border-color: #29415c; }
.reload-card { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin: 20px 0 0; padding: 12px 16px; background: var(--selected); border: 1px solid var(--accent); border-radius: 12px; }
.reload-card .text { min-width: 0; }
.reload-card .button { flex: none; }
/* A page's groups: a small heading over a box of rows. */
.group { margin-top: 24px; }
.group-title { margin: 0 0 8px; padding-inline: 4px; color: var(--subtext); font-size: 12px; line-height: 16px; font-weight: 650; letter-spacing: 0.8px; text-transform: uppercase; }
.group-desc { margin: -2px 0 12px; padding-inline: 4px; color: var(--subtext); font-size: 14px; line-height: 21px; }
.settings-group { padding: 0 20px; background: var(--surface0); border: 1px solid var(--border); border-radius: 12px; }
.card { padding: 16px 0; border-top: 1px solid var(--border); }
.card:first-child { border-top: 0; }
.card:last-child { border-bottom: 0; }
a.card { display: block; color: inherit; text-decoration: none; }
.link-card:hover .title { color: var(--accent); text-decoration: underline; }
.row { display: flex; align-items: flex-start; gap: 24px; }
.row .text { flex: 1; min-width: 0; }
.title { font-size: 15px; line-height: 22px; font-weight: 600; }
.desc { color: var(--subtext); font-size: 13.5px; line-height: 20px; margin-top: 3px; max-width: 72ch; }
.note { color: var(--peach); font-size: 13px; line-height: 19px; margin-top: 6px; }
.unavailable .title { color: var(--subtext); }
.options { margin: 14px 0 2px; padding-block: 2px; padding-inline: 14px 0; border-inline-start: 2px solid #2f4a66; display: grid; gap: 12px; }
.options label { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; min-width: 0; color: var(--subtext); font-size: 14px; line-height: 21px; }
.options .option-toggle { flex-wrap: nowrap; justify-content: space-between; gap: 14px; }
.option-toggle .switch { order: 1; }
.option-toggle span { min-width: 0; }
.field { min-width: 0; }
.field-error { color: var(--red); font-size: 14px; margin: 8px 0 0; }
.options [aria-invalid="true"] { border-color: var(--red); }
.button[aria-busy="true"] { cursor: progress; }
.options select, .options input[type="text"], .options input[type="number"], .options textarea {
  min-width: 0; max-width: 100%; background: var(--crust); border: 1px solid var(--control); border-radius: 8px; padding: 8px 12px;
}
.options select { flex: 0 1 auto; width: auto; min-width: min(180px, 100%); max-width: min(360px, 100%); text-overflow: ellipsis; }
.options input[type="text"] { width: min(100%, 260px); }
.options input[type="text"][maxlength="7"] { width: min(100%, 128px); }
.options input[type="number"] { width: 110px; }
.options label:has(> textarea) { flex-direction: column; align-items: stretch; gap: 8px; }
.options textarea { display: block; width: 100%; resize: vertical; min-height: 88px; line-height: 1.5; }
.options textarea.code { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 13px; white-space: pre; tab-size: 2; }
/* A pill with a round knob. The knob's dark outline keeps a 3:1 boundary against the blue track. */
.switch { appearance: none; flex: none; width: 44px; height: 24px; margin: 0; border: 1px solid var(--control); border-radius: 999px; background: var(--surface1); position: relative; cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease; }
.row > .switch { margin-top: 1px; }
.switch::after { content: ""; position: absolute; top: 2px; inset-inline-start: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--subtext); border: 1px solid transparent; transition: transform 0.15s ease; }
.switch:checked { background: var(--accent); border-color: var(--accent); }
.switch:checked::after { transform: translateX(calc(var(--flip) * 20px)); background: #f4f9ff; border-color: #264e7f; }
.switch:disabled, .switch[aria-disabled="true"] { opacity: 0.55; cursor: not-allowed; }
/* Overview's tiles: Quick setups across the top, then one per page. */
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
.setup-tiles { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.tile { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface0); color: inherit; font: inherit; text-align: start; }
.tile-title { display: flex; align-items: center; font-size: 15px; line-height: 21px; font-weight: 600; }
.tile-desc { color: var(--subtext); font-size: 13px; line-height: 19px; }
.tile-count { color: var(--subtext); font-size: 12px; line-height: 16px; font-weight: 600; }
.tile-count.some { color: var(--accent); }
.setup-tile { background: linear-gradient(180deg, #1c2633, var(--surface0)); }
.setup-tile.reset { background: var(--surface0); }
.setup-tile .tile-desc { flex: 1; }
.tile-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; margin-top: 6px; }
.tile-foot .button { min-height: 36px; min-width: 0; padding: 6px 16px; }
.page-tile { flex-direction: row; align-items: flex-start; gap: 14px; cursor: pointer; transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease; }
.page-tile:hover { border-color: #3b5674; background: #1d2632; transform: translateY(-1px); }
.tile-icon { flex: none; width: 40px; height: 40px; display: grid; place-items: center; border-radius: 10px; background: var(--selected); color: var(--accent); }
.tile-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.new-dot { position: relative; display: inline-block; flex: none; width: 8px; height: 8px; margin-inline-start: 8px; border-radius: 50%; background: var(--accent); vertical-align: middle; }
nav button .new-dot { margin-inline-start: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
.links { list-style: none; margin: 16px 0 0; padding: 0 4px 0 0; max-height: 320px; overflow-y: auto; border-top: 1px solid var(--border); }
.links li { display: flex; flex-direction: column; padding: 8px 0; border-bottom: 1px solid var(--border); min-width: 0; }
.links a { color: var(--accent); text-decoration: none; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.links a:hover { text-decoration: underline; }
.links .detail { color: var(--subtext); font-size: 13px; line-height: 20px; }
.links-empty { color: var(--subtext); font-size: 13px; line-height: 20px; margin-top: 12px; }
.button { min-height: 40px; min-width: min(96px, 100%); max-width: 100%; border: 1px solid var(--control); background: transparent; padding: 8px 18px; border-radius: 8px; font-size: 14px; transition: background 0.15s ease; }
.button:hover { background: var(--surface1); }
a.button { display: inline-flex; align-items: center; text-decoration: none; color: inherit; }
.button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
.button.primary:hover { filter: brightness(1.08); }
footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 40px; padding: 8px 20px; border-top: 1px solid var(--border); color: var(--subtext); background: var(--mantle); font-size: 12px; }
.save-state[data-state="saving"] { color: var(--peach); }
.save-state[data-state="error"] { color: var(--red); font-weight: 600; }
.save-recovery .title { color: var(--red); }
.reset-undo { border-color: var(--accent); }
.diagnostic-summary { padding: 24px 2px; border-bottom: 1px solid var(--border); }
.summary-title { margin: 0 0 14px; font-size: 20px; line-height: 28px; font-weight: 600; }
dl { display: grid; grid-template-columns: minmax(160px, 0.8fr) minmax(0, 1.2fr); gap: 8px 24px; margin: 0; font-size: 16px; line-height: 24px; }
dt:not(:first-of-type), dd:not(:first-of-type) { border-top: 1px solid var(--border); padding-top: 8px; }
dt { color: var(--subtext); }
dd { margin: 0; overflow-wrap: anywhere; }
.subheading { margin: 26px 0 10px; font-size: 20px; line-height: 28px; font-weight: 600; }
.diagnostic-group { padding: 24px 2px; border-bottom: 1px solid var(--border); }
.diagnostic-group .subheading { margin: 0 0 10px; }
.diagnostic-group .empty { margin-top: 20px; padding: 0; border: 0; background: transparent; font-size: 16px; }
.diagnostic-group:last-child { border-bottom: 0; }
.log { font: 12px/1.6 ui-monospace, "Cascadia Code", Consolas, monospace; background: var(--crust); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; max-height: 300px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.log .warn { color: var(--peach); }
.log .error { color: var(--red); }
.empty { margin: 12px 0 0; padding: 20px 22px; border: 1px solid var(--border); border-radius: 8px; color: var(--subtext); background: var(--surface0); font-size: 14px; }
.toasts { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); width: max-content; max-width: calc(100vw - 32px); z-index: 2147483002; display: grid; gap: 8px; justify-items: center; }
.toast { display: flex; align-items: center; gap: 8px 16px; max-width: 100%; padding: 14px 18px; border-radius: 8px; background: var(--surface0); border: 1px solid var(--surface1); box-shadow: 0 10px 30px #0005; font-size: 14px; overflow-wrap: anywhere; flex-wrap: wrap; animation: rise 0.18s ease-out; }
.toast span { min-width: 0; flex: 1 1 12em; }
.toast .actions { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0; margin-inline-start: auto; }
.toast.error { border-color: var(--red); }
.toast button { flex: none; min-height: 32px; border: 0; background: transparent; color: var(--accent); font-weight: 600; padding: 4px; }
/* The corner notices sit in the bottom-left corner, off the feed, one short line each, and make
   room for the gear when it's down there too. */
.toasts.corner { left: 12px; bottom: 14px; transform: none; max-width: calc(100vw - 24px); gap: 6px; justify-items: start; }
.root:has(> .launcher[data-place="corner"]:not([hidden])) .toasts.corner { left: 60px; max-width: calc(100vw - 72px); }
.toast.small { gap: 4px 10px; padding: 5px 8px 5px 12px; font-size: 13px; box-shadow: 0 4px 14px #0004; }
.toast.small span { flex: 0 1 auto; }
.toast.small button { min-height: 24px; padding: 2px 4px; }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
nav, main, .log, textarea { scrollbar-width: thin; scrollbar-color: var(--surface1) transparent; }
@media (max-width: 1100px) {
  header { gap: 16px; }
  .body { grid-template-columns: 224px minmax(0, 1fr); }
  main { padding-inline: 24px; }
}
@media (max-width: 900px) {
  header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px 16px; }
  header .search-field { grid-column: 1 / -1; grid-row: 2; width: 100%; max-width: none; }
  .header-actions { grid-column: 2; grid-row: 1; }
  .body { grid-template-columns: 216px minmax(0, 1fr); }
  nav button { gap: 10px; font-size: 14px; }
  main { padding: 20px 20px 32px; }
  .page-heading { flex-wrap: wrap; }
  .setting-count { margin-inline-start: 64px; }
  .tiles { grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); }
}
@media (max-width: 640px) {
  .dialog { width: calc(100vw - 16px); height: calc(100dvh - 16px); border-radius: 12px; }
  header { padding: 10px 12px; gap: 10px; }
  header h2 { font-size: 16px; line-height: 20px; }
  .brand { gap: 10px; }
  .brand-icon { width: 34px; height: 34px; border-radius: 9px; }
  .brand-icon svg { width: 20px; height: 20px; }
  .brand-subtitle { display: none; }
  .header-actions { gap: 8px; }
  .power { min-height: 36px; padding-inline-start: 10px; }
  .power-state { display: none; }
  .icon-button { width: 36px; height: 36px; }
  .body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  nav { display: flex; align-items: center; gap: 4px; padding: 8px; overflow-x: auto; border-inline-end: 0; border-bottom: 1px solid var(--border); }
  .nav-label, .nav-count { display: none; }
  .search-field { min-width: 0; }
  .search-field .nav-icon { top: 10px; width: 18px; height: 18px; }
  .search { width: 100%; padding-inline: 38px 10px; font-size: 13px; }
  nav button { flex: none; gap: 8px; white-space: nowrap; width: auto; min-height: 38px; padding: 7px 12px; font-size: 13px; }
  nav button[aria-current="page"]::before { inset: auto 10px 0; width: auto; height: 2px; }
  nav hr { display: none; }
  main { padding: 16px 12px 24px; }
  .page-heading { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 8px 12px; }
  .page-icon { width: 40px; height: 40px; grid-row: 1 / span 2; align-self: start; border-radius: 10px; }
  .page-icon .nav-icon { width: 22px; height: 22px; }
  .page-copy { grid-column: 2; }
  .setting-count { grid-column: 2; justify-self: start; margin: 0; padding: 2px 10px; font-size: 12px; }
  .page-heading h3 { font-size: 20px; line-height: 26px; }
  .page-heading p { font-size: 13px; line-height: 19px; }
  .reload-card { gap: 12px; flex-wrap: wrap; }
  .group { margin-top: 20px; }
  .settings-group { padding: 0 14px; }
  .card { padding-block: 14px; }
  .result { padding-block: 12px; }
  .row { gap: 14px; }
  .title { font-size: 14.5px; line-height: 21px; }
  .desc { font-size: 13px; line-height: 19px; }
  .options { padding-inline-start: 12px; }
  .options label { font-size: 13px; }
  .options select, .options input[type="text"] { width: 100%; }
  .tiles, .setup-tiles { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .tile { padding: 14px; }
  .actions { gap: 8px; }
  .button { font-size: 13px; }
  dl { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  dd { margin-bottom: 12px; }
  dd:not(:first-of-type) { border-top: 0; padding-top: 0; }
  footer { padding: 8px 14px; }
  .footer-version { display: none; }
}
@media (max-width: 380px) { .brand-icon { display: none; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }
@media (forced-colors: active) {
  .switch { appearance: auto; }
  .switch::after { display: none; }
  nav button[aria-current="page"], .tile, .settings-group, .power { border: 1px solid CanvasText; }
  nav button[aria-current="page"] { border-color: Highlight; }
  .power-dot { forced-color-adjust: none; background: CanvasText; }
  .new-dot { forced-color-adjust: none; background: Highlight; }
}
`;
