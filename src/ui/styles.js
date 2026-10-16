// Shared colors also keep floating media controls in step with settings.
export const uiTokens = `
  --base: #171923; --mantle: #12141c; --crust: #0e1017;
  --surface0: #1e202c; --surface1: #3d4152;
  --text: #f3f4fb; --subtext: #b3b8cb; --accent: #c4b0ff; --accent-ink: #20192e;
  --border: #343745; --selected: #39304f;
  --green: #a6e3a1; --red: #f38ba8; --peach: #fab387;
`;

export const panelCss = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  ${uiTokens}
  color-scheme: dark;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--text);
}
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
  width: min(1160px, calc(100vw - 48px)); height: min(960px, calc(100dvh - 48px));
  max-width: none; max-height: none; padding: 0; margin: auto; overflow: hidden;
  display: grid; grid-template-rows: 76px minmax(0, 1fr) 44px;
  font: inherit; color: inherit; color-scheme: dark;
  background: var(--base); border: 1px solid var(--border); border-radius: 12px;
  box-shadow: 0 24px 80px #0006;
}
.dialog:not([open]) { display: none; }
.dialog::backdrop { background: #101218b8; backdrop-filter: blur(6px); }
header { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 12px 24px; border-bottom: 1px solid var(--border); }
.brand { min-width: 0; display: flex; align-items: center; gap: 14px; }
.brand-icon { width: 44px; height: 44px; flex: none; display: grid; place-items: center; border-radius: 10px; background: var(--selected); }
.brand-icon svg { width: 26px; height: 26px; fill: var(--accent); }
.brand-copy { min-width: 0; }
header h2 { margin: 0; font-size: 24px; line-height: 30px; font-weight: 650; letter-spacing: -0.4px; }
.brand-subtitle { display: block; color: var(--subtext); font-size: 14px; line-height: 20px; }
.chip { flex: none; font-size: 12px; padding: 2px 8px; border-radius: 6px; background: var(--surface0); color: var(--subtext); }
.header-actions { flex: none; display: flex; align-items: center; gap: 14px; }
.power-state { font-size: 13px; min-width: 18px; }
.icon-button { border: 1px solid var(--surface1); background: transparent; width: 38px; height: 38px; margin-left: 8px; border-radius: 8px; display: grid; place-items: center; }
.icon-button:hover { background: var(--surface0); }
.icon-button svg { width: 20px; height: 20px; color: var(--subtext); }
.body { display: grid; grid-template-columns: 264px minmax(0, 1fr); min-height: 0; }
nav { padding: 20px 12px 16px; background: var(--mantle); border-right: 1px solid var(--border); overflow: auto; overscroll-behavior: contain; }
.nav-label { margin: 18px 10px 8px; color: var(--subtext); font-size: 10px; font-weight: 600; letter-spacing: 1.4px; text-transform: uppercase; }
.nav-icon { width: 22px; height: 22px; }
nav button {
  position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 34px; text-align: left;
  border: 0; background: transparent; padding: 6px 10px; margin-block: 2px;
  border-radius: 6px; color: var(--subtext); font-size: 15px; line-height: 22px;
  transition: background 0.15s ease, color 0.15s ease;
}
nav button:hover { background: var(--surface0); color: var(--text); }
nav button[aria-current="page"] { background: var(--selected); color: var(--text); font-weight: 600; }
nav button[aria-current="page"]::before { content: ""; position: absolute; inset: 8px auto 8px -12px; width: 3px; border-radius: 0 4px 4px 0; background: var(--accent); }
nav button:focus-visible { outline-offset: -3px; }
nav hr { border: 0; border-top: 1px solid var(--border); margin: 14px 10px 10px; }
.search-field { position: relative; }
.search-field .nav-icon { position: absolute; left: 10px; top: 11px; pointer-events: none; color: var(--subtext); width: 16px; height: 16px; }
.search {
  display: block; box-sizing: border-box; width: 100%; margin: 0; padding: 9px 10px 9px 34px;
  background: var(--crust); border: 1px solid var(--surface1); border-radius: 6px; font-size: 13px; line-height: 18px;
}
.search::placeholder { color: var(--subtext); opacity: 0.85; }
.result { padding: 18px 0; border-top: 1px solid var(--border); }
.result:first-child { border-top: 0; }
.result > .card { border: 0; padding: 12px 0 0; }
.result-section {
  display: block; margin: 0; padding: 0; min-height: 24px; border: 0; background: none; cursor: pointer;
  color: var(--accent); font-size: 12px; font-weight: 600; letter-spacing: 0.6px; text-transform: uppercase;
}
.result-section:hover { text-decoration: underline; }
main { min-width: 0; overflow: auto; overscroll-behavior: contain; padding: 24px 32px 32px; scrollbar-gutter: stable; overflow-wrap: anywhere; }
.page-heading { margin: 0 10px 16px; }
.eyebrow { margin-bottom: 6px; color: var(--subtext); font-size: 10px; font-weight: 650; letter-spacing: 1.4px; text-transform: uppercase; }
.page-heading h3 { margin: 0; font-size: 38px; line-height: 46px; font-weight: 700; letter-spacing: -0.7px; }
.page-heading p { margin: 5px 0 0; color: var(--subtext); font-size: 16px; line-height: 24px; }
.setting-count { display: block; margin-top: 10px; color: var(--subtext); font-size: 12px; }
.reload-card { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin: 0 10px 16px; padding: 14px 16px; background: var(--surface0); border: 1px solid var(--accent); border-radius: 10px; }
.reload-card .text { min-width: 0; }
.reload-card .button { flex: none; }
.settings-group { background: var(--surface0); border: 1px solid var(--border); border-radius: 10px; padding: 0 22px; }
.card { padding: 14px 0; border-top: 1px solid var(--border); }
.card:first-child { border-top: 0; }
.card:last-child { border-bottom: 0; }
a.card { display: block; color: inherit; text-decoration: none; }
.link-card:hover .title { color: var(--accent); text-decoration: underline; }
.row { display: flex; align-items: flex-start; gap: 24px; }
.row .text { flex: 1; min-width: 0; }
.title { font-size: 17px; line-height: 24px; font-weight: 600; }
.desc { color: var(--subtext); font-size: 15px; line-height: 22px; margin-top: 5px; }
.note { color: var(--peach); font-size: 13px; line-height: 20px; margin-top: 8px; }
.unavailable .title { color: var(--subtext); }
.options { margin: 16px 0 0; padding: 2px 0 2px 16px; border-left: 2px solid var(--border); display: grid; gap: 14px; }
.options label { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; min-width: 0; color: var(--subtext); font-size: 13px; line-height: 21px; }
.options .option-toggle { flex-wrap: nowrap; justify-content: space-between; gap: 14px; }
.option-toggle .switch { order: 1; }
.option-toggle span { min-width: 0; }
.field { min-width: 0; }
.field-error { color: var(--red); font-size: 14px; margin: 8px 0 0; }
.options [aria-invalid="true"] { border-color: var(--red); }
.button[aria-busy="true"] { cursor: progress; }
.options select, .options input[type="text"], .options input[type="number"], .options textarea {
  min-width: 0; max-width: 100%; background: var(--crust); border: 1px solid var(--surface1); border-radius: 6px; padding: 9px 12px;
}
.options select { flex: 0 1 auto; width: auto; min-width: min(128px, 100%); max-width: min(360px, 100%); text-overflow: ellipsis; }
.options input[type="text"] { width: min(100%, 260px); }
.options input[type="text"][maxlength="7"] { width: min(100%, 128px); }
.options input[type="number"] { width: 110px; }
.options label:has(> textarea) { flex-direction: column; align-items: stretch; gap: 8px; }
.options textarea { display: block; width: 100%; resize: vertical; min-height: 88px; line-height: 1.5; }
.options textarea.code { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 13px; white-space: pre; tab-size: 2; }
.switch { appearance: none; flex: none; width: 54px; height: 30px; margin: 2px 0 0; border: 1px solid var(--surface1); border-radius: 6px; background: var(--surface1); position: relative; cursor: pointer; transition: background 0.15s ease; }
.switch::after { content: ""; position: absolute; top: 4px; left: 4px; width: 20px; height: 20px; border-radius: 4px; background: var(--subtext); transition: transform 0.15s ease; }
.switch:checked { background: var(--accent); border-color: var(--accent); }
.switch:checked::after { transform: translateX(24px); background: var(--text); }
.switch:disabled { opacity: 0.55; cursor: not-allowed; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
.button { min-height: 40px; max-width: 100%; border: 1px solid var(--surface1); background: var(--surface0); padding: 9px 16px; border-radius: 8px; transition: background 0.15s ease; }
.button:hover { background: var(--surface1); }
a.button { display: inline-flex; align-items: center; text-decoration: none; color: inherit; }
.button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
.button.primary:hover { filter: brightness(1.08); }
footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 24px; border-top: 1px solid var(--border); color: var(--subtext); font-size: 12px; }
.diagnostic-summary { padding: 22px; background: var(--surface0); border: 1px solid var(--border); border-radius: 10px; }
.summary-title { margin: 0 0 14px; font-size: 16px; line-height: 22px; font-weight: 600; }
dl { display: grid; grid-template-columns: minmax(160px, 0.8fr) minmax(0, 1.2fr); gap: 8px 24px; margin: 0; font-size: 14px; line-height: 21px; }
dt:not(:first-of-type), dd:not(:first-of-type) { border-top: 1px solid var(--border); padding-top: 8px; }
dt { color: var(--subtext); }
dd { margin: 0; overflow-wrap: anywhere; }
.subheading { margin: 26px 0 10px; font-size: 17px; font-weight: 600; }
.diagnostic-group { margin-top: 18px; padding: 20px 22px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface0); }
.diagnostic-group .subheading { margin: 0 0 10px; }
.diagnostic-group .empty { padding: 0; border: 0; }
.log { font: 12px/1.6 ui-monospace, "Cascadia Code", Consolas, monospace; background: var(--crust); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; max-height: 300px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.log .warn { color: var(--peach); }
.log .error { color: var(--red); }
.empty { margin: 12px 0 0; padding: 20px 22px; border: 1px solid var(--border); border-radius: 8px; color: var(--subtext); background: var(--surface0); font-size: 14px; }
.toasts { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); width: max-content; max-width: calc(100vw - 32px); z-index: 2147483002; display: grid; gap: 8px; justify-items: center; }
.toast { display: flex; align-items: center; gap: 16px; max-width: 100%; padding: 14px 18px; border-radius: 8px; background: var(--surface0); border: 1px solid var(--surface1); box-shadow: 0 10px 30px #0005; font-size: 14px; overflow-wrap: anywhere; animation: rise 0.18s ease-out; }
.toast span { min-width: 0; }
.toast.error { border-color: var(--red); }
.toast button { flex: none; min-height: 32px; border: 0; background: transparent; color: var(--accent); font-weight: 600; padding: 4px; }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
nav, main, .log, textarea { scrollbar-width: thin; scrollbar-color: var(--surface1) transparent; }
@media (max-width: 900px) {
  .body { grid-template-columns: 210px minmax(0, 1fr); }
  main { padding-inline: 24px; }
  header h2 { font-size: 18px; }
  .brand { gap: 12px; }
  .brand-icon { width: 40px; height: 40px; }
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
  .icon-button { width: 36px; height: 36px; margin-left: 0; }
  .header-actions .switch { width: 40px; height: 24px; }
  .header-actions .switch::after { top: 3px; left: 3px; width: 16px; height: 16px; }
  .header-actions .switch:checked::after { transform: translateX(16px); }
  .body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  nav { display: flex; align-items: center; gap: 4px; padding: 8px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  .nav-label { display: none; }
  .search-field { flex: none; width: 160px; margin-right: 4px; }
  .search-field .nav-icon { top: 11px; }
  .search { width: 100%; padding: 9px 10px 9px 32px; font-size: 12px; }
  nav button { flex: none; gap: 8px; white-space: nowrap; width: auto; min-height: 38px; padding: 7px 12px; border-radius: 6px; font-size: 13px; }
  nav button[aria-current="page"]::before { inset: auto 10px 0; width: auto; height: 2px; }
  nav hr { display: none; }
  main { padding: 20px 14px 24px; }
  .page-heading { margin-inline: 4px; }
  .reload-card { margin-inline: 4px; gap: 12px; }
  .settings-group { padding-inline: 14px; }
  .result { padding-block: 14px; }
  .page-heading h3 { font-size: 26px; line-height: 34px; }
  .page-heading p { font-size: 14px; line-height: 21px; }
  .row { gap: 14px; }
  .title { font-size: 15px; line-height: 22px; }
  .desc { font-size: 13px; line-height: 20px; }
  .options { margin-left: 0; padding-left: 12px; }
  .switch { width: 44px; height: 28px; }
  .switch::after { top: 3px; left: 3px; }
  .switch:checked::after { transform: translateX(16px); }
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
}
`;
