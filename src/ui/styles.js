// Shared colors also keep floating media controls in step with settings.
export const uiTokens = `
  --base: #191b24; --mantle: #14161e; --crust: #101218;
  --surface0: #252733; --surface1: #383b4b;
  --text: #f2f3fa; --subtext: #bec4dc; --accent: #cba6f7; --accent-ink: #171220;
  --border: #343744; --selected: #342b47;
  --green: #a6e3a1; --red: #f38ba8; --peach: #fab387;
`;

export const panelCss = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  ${uiTokens}
  color-scheme: dark;
  font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
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
  width: 38px; height: 38px; border-radius: 50%; border: 1px solid var(--surface1);
  background: var(--base); display: grid; place-items: center; box-shadow: 0 4px 14px #0004;
  opacity: 0.6; transition: background 0.15s ease, transform 0.15s ease, opacity 0.15s ease;
}
.launcher:hover, .launcher:focus-visible { opacity: 1; background: var(--selected); transform: translateY(-2px); }
.launcher svg { width: 20px; height: 20px; fill: var(--accent); }
.launcher[hidden] { display: none; }
.dialog {
  width: min(1100px, calc(100vw - 32px)); height: min(920px, calc(100dvh - 32px));
  max-width: none; max-height: none; padding: 0; margin: auto; overflow: hidden;
  display: grid; grid-template-rows: 80px minmax(0, 1fr) 54px;
  font: inherit; color: inherit; color-scheme: dark;
  background: var(--base); border: 1px solid var(--surface1); border-radius: 16px;
  box-shadow: 0 24px 80px #0006;
}
.dialog:not([open]) { display: none; }
.dialog::backdrop { background: #101218b8; backdrop-filter: blur(6px); }
header { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 12px 22px; border-bottom: 1px solid var(--border); }
.brand { min-width: 0; display: flex; align-items: center; gap: 18px; }
.brand-icon { width: 52px; height: 52px; flex: none; display: grid; place-items: center; border-radius: 13px; background: var(--selected); }
.brand-icon svg { width: 28px; height: 28px; fill: var(--accent); }
header h2 { margin: 0; font-size: 24px; line-height: 1.2; font-weight: 650; letter-spacing: -0.5px; }
.chip { flex: none; font-size: 13px; padding: 3px 10px; border-radius: 10px; background: var(--surface0); color: var(--subtext); }
.header-actions { flex: none; display: flex; align-items: center; gap: 18px; }
.power-state { font-size: 14px; min-width: 18px; }
.icon-button { border: 1px solid var(--surface1); background: transparent; width: 46px; height: 46px; border-radius: 10px; display: grid; place-items: center; }
.icon-button:hover { background: var(--surface0); }
.icon-button svg { width: 20px; height: 20px; fill: var(--subtext); }
.body { display: grid; grid-template-columns: 260px minmax(0, 1fr); min-height: 0; }
nav { padding: 20px 8px 20px 0; border-right: 1px solid var(--border); overflow: auto; overscroll-behavior: contain; }
.nav-label { margin: 0 22px 14px; color: var(--subtext); font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; }
nav button {
  position: relative; display: block; width: 100%; min-height: 37px; text-align: left;
  border: 0; background: transparent; padding: 7px 14px 7px 26px;
  border-radius: 0 7px 7px 0; color: var(--subtext); font-size: 15px; line-height: 23px;
}
nav button:hover { background: var(--surface0); color: var(--text); }
nav button[aria-current="page"] { background: var(--selected); color: var(--text); font-weight: 600; }
nav button[aria-current="page"]::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--accent); }
nav button:focus-visible { outline-offset: -3px; }
nav hr { border: 0; border-top: 1px solid var(--border); margin: 16px 14px 12px 22px; }
.search {
  display: block; box-sizing: border-box; width: calc(100% - 22px); margin: 0 0 18px 22px; padding: 8px 12px;
  background: var(--mantle); border: 1px solid var(--surface1); border-radius: 8px; font-size: 14px;
}
.search::placeholder { color: var(--subtext); opacity: 0.85; }
.result { border-top: 1px solid var(--border); }
.result > .card { border-top: 0; padding-top: 6px; }
.result-section {
  display: block; margin: 16px 0 0; padding: 0; border: 0; background: none; cursor: pointer;
  color: var(--accent); font-size: 12px; font-weight: 600; letter-spacing: 0.6px; text-transform: uppercase;
}
.result-section:hover { text-decoration: underline; }
main { min-width: 0; overflow: auto; overscroll-behavior: contain; padding: 24px 40px 32px; scrollbar-gutter: stable; overflow-wrap: anywhere; }
.page-heading { margin-bottom: 20px; }
.page-heading h3 { margin: 0; font-size: 32px; line-height: 40px; font-weight: 700; letter-spacing: -0.7px; }
.page-heading p { margin: 4px 0 0; color: var(--subtext); font-size: 16px; line-height: 24px; }
.card { padding: 18px 0; border-top: 1px solid var(--border); }
.card:last-child { border-bottom: 1px solid var(--border); }
.row { display: flex; align-items: flex-start; gap: 24px; }
.row .text { flex: 1; min-width: 0; }
.title { font-size: 16px; line-height: 23px; font-weight: 600; }
.desc { color: var(--subtext); font-size: 15px; line-height: 21px; margin-top: 4px; }
.note { color: var(--peach); font-size: 13px; line-height: 20px; margin-top: 8px; }
.unavailable .title { color: var(--subtext); }
.options { margin: 16px 0 0 6px; padding-left: 18px; border-left: 1px solid var(--surface1); display: grid; gap: 12px; }
.options label { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; min-width: 0; color: var(--subtext); font-size: 15px; line-height: 21px; }
.options .option-toggle { flex-wrap: nowrap; gap: 14px; }
.option-toggle span { min-width: 0; }
.field { min-width: 0; }
.field-error { color: var(--red); font-size: 14px; margin: 8px 0 0; }
.options [aria-invalid="true"] { border-color: var(--red); }
.button[aria-busy="true"] { cursor: progress; }
.options select, .options input[type="text"], .options input[type="number"], .options textarea {
  min-width: 0; max-width: 100%; background: var(--mantle); border: 1px solid var(--surface1); border-radius: 8px; padding: 9px 12px;
}
.options select { flex: 0 1 auto; width: auto; min-width: min(128px, 100%); max-width: min(360px, 100%); text-overflow: ellipsis; }
.options input[type="text"] { width: min(100%, 260px); }
.options input[type="text"][maxlength="7"] { width: min(100%, 128px); }
.options input[type="number"] { width: 110px; }
.options label:has(> textarea) { flex-direction: column; align-items: stretch; gap: 8px; }
.options textarea { display: block; width: 100%; resize: vertical; min-height: 88px; line-height: 1.5; }
.options textarea.code { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 13px; white-space: pre; tab-size: 2; }
.switch { appearance: none; flex: none; width: 48px; height: 26px; margin: 2px 0 0; border: 1px solid var(--surface1); border-radius: 999px; background: var(--surface1); position: relative; cursor: pointer; transition: background 0.15s ease; }
.switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--subtext); transition: transform 0.15s ease; }
.switch:checked { background: var(--accent); border-color: var(--accent); }
.switch:checked::after { transform: translateX(22px); background: var(--accent-ink); }
.switch:disabled { opacity: 0.55; cursor: not-allowed; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; }
.button { min-height: 40px; max-width: 100%; border: 1px solid var(--surface1); background: var(--surface0); padding: 9px 16px; border-radius: 8px; transition: background 0.15s ease; }
.button:hover { background: var(--surface1); }
.button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
.button.primary:hover { filter: brightness(1.08); }
footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 26px; border-top: 1px solid var(--border); color: var(--subtext); font-size: 15px; }
.diagnostic-summary { padding: 20px 0; border-block: 1px solid var(--border); }
.summary-title { margin: 0 0 14px; font-size: 16px; line-height: 22px; font-weight: 600; }
dl { display: grid; grid-template-columns: minmax(160px, 0.8fr) minmax(0, 1.2fr); gap: 8px 24px; margin: 0; font-size: 15px; line-height: 21px; }
dt { color: var(--subtext); }
dd { margin: 0; overflow-wrap: anywhere; }
.subheading { margin: 26px 0 10px; font-size: 17px; font-weight: 600; }
.log { font: 12px/1.6 ui-monospace, "Cascadia Code", Consolas, monospace; background: var(--crust); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; max-height: 300px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.log .warn { color: var(--peach); }
.log .error { color: var(--red); }
.empty { margin: 12px 0 0; padding: 16px; border: 1px solid var(--border); border-radius: 10px; color: var(--subtext); background: var(--mantle); font-size: 14px; }
.toasts { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); width: max-content; max-width: calc(100vw - 32px); z-index: 2147483002; display: grid; gap: 8px; justify-items: center; }
.toast { display: flex; align-items: center; gap: 16px; max-width: 100%; padding: 14px 18px; border-radius: 12px; background: var(--base); border: 1px solid var(--surface1); box-shadow: 0 10px 30px #0005; font-size: 14px; overflow-wrap: anywhere; animation: rise 0.18s ease-out; }
.toast span { min-width: 0; }
.toast.error { border-color: var(--red); }
.toast button { flex: none; min-height: 32px; border: 0; background: transparent; color: var(--accent); font-weight: 600; padding: 4px; }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
nav, main, .log, textarea { scrollbar-width: thin; scrollbar-color: var(--surface1) transparent; }
@media (max-width: 900px) {
  .body { grid-template-columns: 220px minmax(0, 1fr); }
  main { padding-inline: 24px; }
  header h2 { font-size: 21px; }
  .brand { gap: 12px; }
  .brand-icon { width: 44px; height: 44px; }
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
  .icon-button { width: 36px; height: 36px; }
  .header-actions .switch { width: 40px; height: 24px; }
  .header-actions .switch::after { width: 16px; height: 16px; }
  .header-actions .switch:checked::after { transform: translateX(16px); }
  .body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  nav { display: flex; align-items: center; gap: 4px; padding: 8px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  .nav-label { display: none; }
  .search { flex: none; width: 150px; margin: 0 4px 0 0; padding: 7px 10px; font-size: 13px; }
  nav button { flex: none; white-space: nowrap; width: auto; min-height: 38px; padding: 7px 12px; border-radius: 7px; font-size: 13px; }
  nav button[aria-current="page"]::before { inset: auto 10px 0; width: auto; height: 2px; }
  nav hr { display: none; }
  main { padding: 20px 18px 24px; }
  .page-heading h3 { font-size: 26px; line-height: 34px; }
  .page-heading p { font-size: 14px; line-height: 21px; }
  .row { gap: 14px; }
  .title { font-size: 15px; line-height: 22px; }
  .desc { font-size: 13px; line-height: 20px; }
  .options { margin-left: 0; padding-left: 12px; }
  .options label { font-size: 13px; }
  .options select, .options input[type="text"] { width: 100%; }
  .actions { gap: 8px; }
  .button { font-size: 13px; }
  dl { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  dd { margin-bottom: 12px; }
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
