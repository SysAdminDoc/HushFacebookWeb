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
/* Right to left: start and end swap sides, and a switch's knob slides the other way. The
   launcher stays in Facebook's bottom-left corner. */
.root[dir="rtl"] { --flip: -1; }
button, input, select, textarea { font: inherit; color: inherit; -webkit-tap-highlight-color: transparent; }
button { cursor: pointer; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
svg { flex: none; }
/* Small and faded until pointed at: it sits over the corner of Facebook's left column, where
   the footer links are. */
.launcher {
  position: fixed; left: 12px; bottom: 12px; z-index: 2147483000;
  width: 40px; height: 40px; border-radius: 10px; border: 1px solid var(--surface1);
  background: var(--base); display: grid; place-items: center; box-shadow: 0 4px 14px #0004;
  opacity: 0.8; transition: background 0.15s ease, transform 0.15s ease, opacity 0.15s ease;
}
.launcher:hover, .launcher:focus-visible { opacity: 1; background: var(--selected); transform: translateY(-2px); }
.launcher svg { width: 20px; height: 20px; fill: var(--accent); }
.launcher[hidden] { display: none; }
.dialog {
  width: min(1224px, calc(100vw - 48px)); height: min(960px, calc(100dvh - 64px));
  max-width: none; max-height: none; padding: 0; margin: auto; overflow: hidden;
  display: grid; grid-template-rows: 76px minmax(0, 1fr) 44px;
  font: inherit; color: inherit; color-scheme: dark;
  background: var(--base); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: 0 24px 80px #0006;
}
.dialog:not([open]) { display: none; }
.dialog::backdrop { background: #0b0e13cc; backdrop-filter: blur(6px); }
header { display: flex; align-items: center; justify-content: space-between; gap: 28px; padding: 12px 22px; border-bottom: 1px solid var(--border); background: var(--mantle); }
.brand { min-width: 0; display: flex; align-items: center; gap: 14px; }
.brand-icon { width: 48px; height: 48px; flex: none; display: grid; place-items: center; border-radius: 8px; background: var(--selected); }
.brand-icon svg { width: 26px; height: 26px; fill: var(--accent); }
.brand-copy { min-width: 0; }
header h2 { margin: 0; font-size: 26px; line-height: 32px; font-weight: 650; letter-spacing: -0.4px; }
.brand-subtitle { display: none; }
.chip { flex: none; font-size: 13px; color: var(--subtext); margin-inline-end: 12px; }
.header-actions { flex: none; display: flex; align-items: center; gap: 14px; }
.power-state { font-size: 14px; min-width: 18px; }
.icon-button { border: 1px solid var(--surface1); background: transparent; width: 38px; height: 38px; margin-inline-start: 8px; border-radius: 8px; display: grid; place-items: center; }
.icon-button:hover { background: var(--surface0); }
.icon-button svg { width: 20px; height: 20px; color: var(--subtext); }
.body { display: grid; grid-template-columns: 280px minmax(0, 1fr); min-height: 0; }
nav { padding: 20px 8px 16px; background: var(--mantle); border-inline-end: 1px solid var(--border); overflow: auto; overscroll-behavior: contain; }
.nav-label { margin: 6px 14px 10px; color: var(--subtext); font-size: 11px; font-weight: 650; letter-spacing: 1.6px; text-transform: uppercase; }
.nav-icon { width: 22px; height: 22px; }
nav button {
  position: relative; display: flex; align-items: center; gap: 14px; width: 100%; min-height: 38px; text-align: start;
  border: 0; background: transparent; padding: 8px 14px; margin-block: 2px;
  border-radius: 6px; color: var(--subtext); font-size: 16px; line-height: 22px;
  transition: background 0.15s ease, color 0.15s ease;
}
nav button:hover { background: var(--surface0); color: var(--text); }
nav button[aria-current="page"] { background: var(--selected); color: var(--text); font-weight: 600; }
nav button[aria-current="page"] .nav-icon { color: var(--accent); }
nav button[aria-current="page"]::before { content: ""; position: absolute; inset-block: 0; inset-inline: -8px auto; width: 3px; border-radius: 2px; background: var(--accent); }
nav button:focus-visible { outline-offset: -3px; }
nav hr { border: 0; border-top: 1px solid var(--border); margin: 16px 14px 12px; }
.search-field { position: relative; flex: 1 1 300px; max-width: 404px; min-width: 120px; }
.search-field .nav-icon { position: absolute; inset-inline-start: 12px; top: 12px; pointer-events: none; color: var(--subtext); width: 20px; height: 20px; }
.search {
  display: block; box-sizing: border-box; width: 100%; margin: 0; padding-block: 11px; padding-inline: 44px 12px;
  background: var(--mantle); border: 1px solid var(--control); border-radius: 6px; font-size: 14px; line-height: 20px;
  text-overflow: ellipsis;
}
.search::placeholder { color: var(--subtext); opacity: 0.85; text-overflow: ellipsis; }
.result { padding: 18px 0; border-top: 1px solid var(--border); }
.result:first-child { border-top: 0; }
.result > .card { border: 0; padding: 12px 0 0; }
.result-section {
  display: block; margin: 0; padding: 0; min-height: 24px; border: 0; background: none; cursor: pointer;
  color: var(--accent); font-size: 12px; font-weight: 600; letter-spacing: 0.6px; text-transform: uppercase;
}
.result-section:hover { text-decoration: underline; }
main { min-width: 0; overflow: auto; overscroll-behavior: contain; padding: 28px 32px 32px; scrollbar-gutter: stable; overflow-wrap: anywhere; }
.page-heading { display: flex; align-items: center; gap: 20px; margin: 0; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
.page-icon { display: grid; place-items: center; flex: none; width: 80px; height: 80px; border-radius: 10px; color: var(--accent); background: var(--selected); border: 1px solid #29415c; }
.page-icon .nav-icon { width: 44px; height: 44px; stroke-width: 1.6; }
.page-copy { min-width: 0; flex: 1; }
.page-heading h3 { margin: 0; font-size: 36px; line-height: 44px; font-weight: 650; letter-spacing: -0.7px; }
.page-heading p { margin: 4px 0 0; color: var(--subtext); font-size: 18px; line-height: 26px; }
.setting-count { flex: none; color: var(--subtext); font-size: 13px; }
.reload-card { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin: 20px 0 0; padding: 14px 16px; background: var(--selected); border: 1px solid var(--accent); border-radius: 8px; }
.reload-card .text { min-width: 0; }
.reload-card .button { flex: none; }
.settings-group { padding: 0; }
.card { padding: 20px 2px; border-top: 1px solid var(--border); }
.card:first-child { border-top: 0; }
.card:last-child { border-bottom: 0; }
a.card { display: block; color: inherit; text-decoration: none; }
.link-card:hover .title { color: var(--accent); text-decoration: underline; }
.row { display: flex; align-items: flex-start; gap: 24px; }
.row .text { flex: 1; min-width: 0; }
.title { font-size: 19px; line-height: 26px; font-weight: 600; }
.desc { color: var(--subtext); font-size: 16px; line-height: 24px; margin-top: 5px; }
.note { color: var(--peach); font-size: 13px; line-height: 20px; margin-top: 8px; }
.unavailable .title { color: var(--subtext); }
.options { margin: 16px 0 0; padding-block: 2px; padding-inline: 16px 0; border-inline-start: 2px solid #365675; display: grid; gap: 14px; }
.options label { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; min-width: 0; color: var(--subtext); font-size: 14px; line-height: 22px; }
.options .option-toggle { flex-wrap: nowrap; justify-content: space-between; gap: 14px; }
.option-toggle .switch { order: 1; }
.option-toggle span { min-width: 0; }
.field { min-width: 0; }
.field-error { color: var(--red); font-size: 14px; margin: 8px 0 0; }
.options [aria-invalid="true"] { border-color: var(--red); }
.button[aria-busy="true"] { cursor: progress; }
.options select, .options input[type="text"], .options input[type="number"], .options textarea {
  min-width: 0; max-width: 100%; background: var(--crust); border: 1px solid var(--control); border-radius: 6px; padding: 9px 12px;
}
.options select { flex: 0 1 auto; width: auto; min-width: min(180px, 100%); max-width: min(360px, 100%); text-overflow: ellipsis; }
.options input[type="text"] { width: min(100%, 260px); }
.options input[type="text"][maxlength="7"] { width: min(100%, 128px); }
.options input[type="number"] { width: 110px; }
.options label:has(> textarea) { flex-direction: column; align-items: stretch; gap: 8px; }
.options textarea { display: block; width: 100%; resize: vertical; min-height: 88px; line-height: 1.5; }
.options textarea.code { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 13px; white-space: pre; tab-size: 2; }
/* The knob's dark outline keeps a 3:1 boundary against the blue track. */
.switch { appearance: none; flex: none; width: 60px; height: 34px; margin: 5px 0 0; border: 1px solid var(--control); border-radius: 5px; background: var(--surface1); position: relative; cursor: pointer; transition: background 0.15s ease; }
.switch::after { content: ""; position: absolute; top: 4px; inset-inline-start: 4px; width: 24px; height: 24px; border-radius: 3px; background: var(--subtext); border: 1px solid transparent; transition: transform 0.15s ease; }
.switch:checked { background: var(--accent); border-color: var(--accent); }
.switch:checked::after { transform: translateX(calc(var(--flip) * 26px)); background: #edf5ff; border-color: #264e7f; }
.switch:disabled, .switch[aria-disabled="true"] { opacity: 0.55; cursor: not-allowed; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.new-dot { position: relative; display: inline-block; flex: none; width: 8px; height: 8px; margin-inline-start: 8px; border-radius: 50%; background: var(--accent); vertical-align: middle; }
nav button .new-dot { margin-inline-start: auto; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
.links { list-style: none; margin: 16px 0 0; padding: 0 4px 0 0; max-height: 320px; overflow-y: auto; border-top: 1px solid var(--border); }
.links li { display: flex; flex-direction: column; padding: 8px 0; border-bottom: 1px solid var(--border); min-width: 0; }
.links a { color: var(--accent); text-decoration: none; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.links a:hover { text-decoration: underline; }
.links .detail { color: var(--subtext); font-size: 13px; line-height: 20px; }
.links-empty { color: var(--subtext); font-size: 13px; line-height: 20px; margin-top: 12px; }
.button { min-height: 44px; min-width: min(104px, 100%); max-width: 100%; border: 1px solid var(--control); background: transparent; padding: 10px 18px; border-radius: 6px; font-size: 15px; transition: background 0.15s ease; }
.button:hover { background: var(--surface1); }
a.button { display: inline-flex; align-items: center; text-decoration: none; color: inherit; }
.button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
.button.primary:hover { filter: brightness(1.08); }
footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 22px; border-top: 1px solid var(--border); color: var(--subtext); background: var(--mantle); font-size: 12px; }
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
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
nav, main, .log, textarea { scrollbar-width: thin; scrollbar-color: var(--surface1) transparent; }
@media (max-width: 1100px) {
  header { gap: 18px; }
  header h2 { font-size: 20px; line-height: 26px; }
  .brand { gap: 12px; }
  .brand-icon { width: 40px; height: 40px; }
  .chip { margin-inline-end: 0; }
}
@media (max-width: 900px) {
  .dialog { grid-template-rows: auto minmax(0, 1fr) 44px; }
  header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px 18px; }
  header .search-field { grid-column: 1 / -1; grid-row: 2; width: 100%; max-width: none; }
  .header-actions { grid-column: 2; grid-row: 1; }
  .body { grid-template-columns: 210px minmax(0, 1fr); }
  main { padding-inline: 24px; }
  header h2 { font-size: 18px; }
  .brand { gap: 12px; }
  .brand-icon { width: 40px; height: 40px; }
  .page-icon { width: 56px; height: 56px; }
  .page-icon .nav-icon { width: 32px; height: 32px; }
  .page-heading { gap: 14px; flex-wrap: wrap; }
  .page-heading h3 { font-size: 30px; line-height: 36px; }
  .setting-count { margin-inline-start: 70px; }
}
@media (max-width: 640px) {
  .dialog { width: calc(100vw - 16px); height: calc(100dvh - 16px); grid-template-rows: auto minmax(0, 1fr) auto; border-radius: 12px; }
  header { padding: 12px; gap: 12px; }
  header h2 { font-size: 17px; line-height: 22px; letter-spacing: -0.3px; }
  .brand { gap: 10px; }
  .brand-icon { width: 36px; height: 36px; border-radius: 10px; }
  .brand-icon svg { width: 22px; height: 22px; }
  .chip { display: none; }
  .header-actions { gap: 10px; }
  .power-state { display: none; }
  .icon-button { width: 36px; height: 36px; margin-inline-start: 0; }
  .header-actions .switch { width: 40px; height: 24px; }
  .header-actions .switch::after { top: 3px; inset-inline-start: 3px; width: 16px; height: 16px; }
  .header-actions .switch:checked::after { transform: translateX(calc(var(--flip) * 16px)); }
  .body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  nav { display: flex; align-items: center; gap: 4px; padding: 8px; overflow-x: auto; border-inline-end: 0; border-bottom: 1px solid var(--border); }
  .nav-label { display: none; }
  .search-field { min-width: 0; }
  .search-field .nav-icon { top: 10px; width: 18px; height: 18px; }
  .search { width: 100%; padding-block: 9px; padding-inline: 38px 10px; font-size: 13px; }
  nav button { flex: none; gap: 8px; white-space: nowrap; width: auto; min-height: 38px; padding: 7px 12px; border-radius: 6px; font-size: 13px; }
  nav button[aria-current="page"]::before { inset: auto 10px 0; width: auto; height: 2px; }
  nav hr { display: none; }
  main { padding: 20px 14px 24px; }
  .page-heading { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 8px 12px; padding-bottom: 20px; }
  .page-icon { width: 48px; height: 48px; grid-row: 1 / span 2; align-self: start; border-radius: 8px; }
  .page-icon .nav-icon { width: 28px; height: 28px; }
  .page-copy { grid-column: 2; }
  .setting-count { grid-column: 2; margin: 0; font-size: 12px; }
  .reload-card { gap: 12px; flex-wrap: wrap; }
  .settings-group { padding: 0; }
  .card { padding-block: 18px; }
  .result { padding-block: 14px; }
  .page-heading h3 { font-size: 26px; line-height: 32px; }
  .page-heading p { font-size: 14px; line-height: 21px; }
  .row { gap: 14px; }
  .title { font-size: 15px; line-height: 22px; }
  .desc { font-size: 13px; line-height: 20px; }
  .options { margin-inline-start: 0; padding-inline-start: 12px; }
  .switch { width: 44px; height: 28px; }
  .switch::after { top: 3px; inset-inline-start: 3px; width: 20px; height: 20px; }
  .switch:checked::after { transform: translateX(calc(var(--flip) * 16px)); }
  .options label { font-size: 13px; }
  .options select, .options input[type="text"] { width: 100%; }
  .actions { gap: 8px; }
  .button { font-size: 13px; }
  dl { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  dd { margin-bottom: 12px; }
  dd:not(:first-of-type) { border-top: 0; padding-top: 0; }
  footer { padding: 10px 18px; font-size: 12px; }
  .footer-brand { display: none; }
}
@media (max-width: 380px) { .brand-icon { display: none; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
@media (forced-colors: active) {
  .switch { appearance: auto; }
  .switch::after { display: none; }
  nav button[aria-current="page"] { border: 1px solid Highlight; }
  .new-dot { forced-color-adjust: none; background: Highlight; }
}
`;
