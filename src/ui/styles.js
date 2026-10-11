// Panel styles, scoped by the shadow root. Catppuccin Mocha with a mauve accent.

export const panelCss = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  --base: #1e1e2e; --mantle: #181825; --crust: #11111b;
  --surface0: #313244; --surface1: #45475a; --overlay0: #6c7086;
  --text: #cdd6f4; --subtext: #a6adc8; --accent: #cba6f7; --accent-ink: #11111b;
  --green: #a6e3a1; --red: #f38ba8; --peach: #fab387;
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--text);
}
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.launcher {
  position: fixed; left: 16px; bottom: 16px; z-index: 2147483000;
  width: 40px; height: 40px; border-radius: 50%; border: 1px solid rgba(203, 166, 247, 0.35);
  background: rgba(30, 30, 46, 0.82); backdrop-filter: blur(10px);
  display: grid; place-items: center; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.launcher:hover { transform: translateY(-2px); box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45); }
.launcher svg { width: 20px; height: 20px; fill: var(--accent); }
.launcher[hidden] { display: none; }

.overlay {
  position: fixed; inset: 0; z-index: 2147483001; display: grid; place-items: center;
  background: rgba(17, 17, 27, 0.55); backdrop-filter: blur(6px);
}
.overlay[hidden] { display: none; }
.dialog {
  width: min(900px, calc(100vw - 32px)); height: min(660px, calc(100vh - 32px));
  display: grid; grid-template-rows: auto 1fr; overflow: hidden;
  background: linear-gradient(160deg, rgba(49, 50, 68, 0.55), rgba(30, 30, 46, 0.96) 40%);
  border: 1px solid rgba(203, 166, 247, 0.22); border-radius: 16px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
}
header { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--surface0); }
header h2 { margin: 0; font-size: 17px; font-weight: 650; }
.chip { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--surface0); color: var(--subtext); }
.spacer { flex: 1; }
.icon-button { border: 0; background: transparent; width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; }
.icon-button:hover { background: var(--surface0); }
.icon-button svg { width: 18px; height: 18px; fill: var(--subtext); }

.body { display: grid; grid-template-columns: 210px 1fr; min-height: 0; }
nav { padding: 10px; border-right: 1px solid var(--surface0); overflow-y: auto; background: rgba(17, 17, 27, 0.35); }
nav button {
  display: block; width: 100%; text-align: left; border: 0; background: transparent;
  padding: 8px 12px; border-radius: 8px; color: var(--subtext);
}
nav button:hover { background: var(--surface0); color: var(--text); }
nav button[aria-current="page"] { background: rgba(203, 166, 247, 0.16); color: var(--accent); font-weight: 600; }
nav hr { border: 0; border-top: 1px solid var(--surface0); margin: 8px 4px; }

main { overflow-y: auto; padding: 18px 20px 28px; }
main h3 { margin: 0 0 12px; font-size: 15px; }
.card {
  padding: 14px 16px; margin-bottom: 10px; border-radius: 12px;
  background: rgba(49, 50, 68, 0.45); border: 1px solid transparent;
  transition: transform 0.15s ease, border-color 0.15s ease;
}
.card:hover { transform: translateY(-1px); border-color: rgba(203, 166, 247, 0.25); }
.row { display: flex; align-items: flex-start; gap: 14px; }
.row .text { flex: 1; }
.title { font-weight: 600; }
.desc { color: var(--subtext); font-size: 13px; margin-top: 2px; }
.note { color: var(--peach); font-size: 12px; margin-top: 6px; }
.options { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--surface0); display: grid; gap: 8px; }
.options label { display: flex; align-items: center; gap: 10px; color: var(--subtext); font-size: 13px; }
.options select, .options input[type="text"], .options input[type="number"], .options textarea {
  background: var(--mantle); border: 1px solid var(--surface1); border-radius: 8px; padding: 5px 8px;
}
.options label:has(> textarea.code) { flex-direction: column; align-items: stretch; gap: 6px; }
.options textarea.code { font-family: ui-monospace, Consolas, Menlo, monospace; font-size: 12px; line-height: 1.5; resize: vertical; white-space: pre; tab-size: 2; }

.switch { appearance: none; flex: none; width: 40px; height: 22px; margin: 2px 0 0; border-radius: 999px; background: var(--surface1); position: relative; cursor: pointer; transition: background 0.15s ease; }
.switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--text); transition: transform 0.15s ease; }
.switch:checked { background: var(--accent); }
.switch:checked::after { transform: translateX(18px); background: var(--accent-ink); }
.switch:disabled { opacity: 0.45; cursor: not-allowed; }

.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.button { border: 1px solid var(--surface1); background: var(--surface0); padding: 7px 14px; border-radius: 8px; transition: transform 0.15s ease, background 0.15s ease; }
.button:hover { transform: translateY(-1px); background: var(--surface1); }
.button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }

dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0 0 14px; font-size: 13px; }
dt { color: var(--subtext); }
dd { margin: 0; }
.log { font: 12px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace; background: var(--crust); border-radius: 10px; padding: 10px 12px; max-height: 300px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
.log .warn { color: var(--peach); }
.log .error { color: var(--red); }
.empty { color: var(--subtext); }

.toasts { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483002; display: grid; gap: 8px; justify-items: center; }
.toast {
  display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 10px;
  background: rgba(30, 30, 46, 0.94); border: 1px solid var(--surface1); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  animation: rise 0.18s ease-out;
}
.toast.error { border-color: rgba(243, 139, 168, 0.6); }
.toast button { border: 0; background: transparent; color: var(--accent); font-weight: 600; }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

@media (max-width: 640px) {
  .body { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  nav { display: flex; gap: 4px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--surface0); }
  nav button { white-space: nowrap; width: auto; }
  nav hr { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`;
