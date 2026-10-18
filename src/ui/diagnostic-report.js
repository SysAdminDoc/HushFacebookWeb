// What Copy report puts on the clipboard, for pasting into a public issue. Only what the script
// names itself goes in: its version, the manager, which switches are on and which choices are
// picked, the rules that hid posts, counts, and the names of errors. Text the person typed,
// Facebook's own text, addresses, ids and log details stay out, so a report can be pasted as it
// is. Posts get labels made fresh for each report, so two reports can't be matched up by post.
// The backup file is the place for every setting as it is.

import { postTag } from '../core/diagnostics.js';

export const REPORT_LOG_LINES = 150;
// A plain count. Longer runs of digits are ids.
const COUNT = /^\d{1,6}$/;
// Names the script gives things: setting keys, rule ids, reasons, the signals it matched on.
const NAME = /^[A-Za-z][\w .-]{0,59}$/;
const KEY = /^[\w.-]{1,80}$/;

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const shorten = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 12).trimEnd()} [shortened]`);
const named = (value) => (NAME.test(String(value ?? '')) ? String(value) : 'other');

// Log messages are the script's own words, but a page address, an email or an id can still
// end up in one, so those are taken out on the way.
export function scrubText(value, max = 300) {
  const text = oneLine(value)
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\b[a-z][a-z\d+.-]*:\/\/\S+/gi, '[link]')
    .replace(/\b(?:[\w-]+\.)*(?:facebook|fbcdn|fb|messenger|instagram)\.(?:com|net)\b\S*/gi, '[link]')
    .replace(/\b(?:fb\.me|fb\.watch|m\.me)\/\S*/gi, '[link]')
    .replace(/\bpfbid\w+/gi, '[id]')
    .replace(/\d{5,}/g, '[number]');
  return shorten(text, max);
}

// The phone builds name themselves first (EdgA, CriOS), since they also carry Chrome or Safari.
const BROWSERS = [
  ['EdgA', 'Edge'], ['EdgiOS', 'Edge'], ['Edg', 'Edge'], ['OPR', 'Opera'], ['FxiOS', 'Firefox'], ['Firefox', 'Firefox'],
  ['CriOS', 'Chrome'], ['Chrome', 'Chrome'], ['Version', 'Safari'],
];
const SYSTEMS = [['Windows', 'Windows'], ['CrOS', 'ChromeOS'], ['Android', 'Android'], ['iPhone', 'iOS'], ['iPad', 'iOS'], ['Macintosh', 'macOS'], ['Linux', 'Linux']];

// The browser's name, main version and system, not the whole user agent.
export function browserOf(agent) {
  const text = String(agent ?? '');
  let browser = 'Unknown browser';
  for (const [token, name] of BROWSERS) {
    const major = text.match(new RegExp(`\\b${token}/(\\d+)`))?.[1];
    if (major) {
      browser = `${name} ${major}`;
      break;
    }
  }
  const system = SYSTEMS.find(([token]) => text.includes(token))?.[1];
  return system ? `${browser} on ${system}` : browser;
}

function settingLines(settings) {
  const on = [];
  const picked = [];
  const filled = [];
  for (const [key, spec] of settings?.schema ?? []) {
    if (!KEY.test(key)) continue;
    const value = settings.get(key);
    if (spec.type === 'toggle') {
      if (value === true) on.push(key);
    } else if (spec.type === 'select') {
      if (value !== spec.default && KEY.test(String(value)) && spec.choices?.some((choice) => choice.value === value)) picked.push(`${key}=${value}`);
    } else if (spec.type === 'number') {
      if (Number.isFinite(value) && value !== spec.default) picked.push(`${key}=${value}`);
    } else if (spec.type === 'text') {
      if (typeof value === 'string' && value.trim()) filled.push(key);
    }
  }
  return [
    `Switches on: ${on.join(', ') || 'none'}`,
    `Choices changed: ${picked.join(', ') || 'none'}`,
    `Text settings filled in, text left out: ${filled.join(', ') || 'none'}`,
  ];
}

// A fresh salt each time, so the same post has a different label in the next report. A manager
// sandbox without crypto still gets a different one each time.
const freshSalt = () => {
  const words = new Uint32Array(2);
  try {
    globalThis.crypto.getRandomValues(words);
  } catch {
    words[0] = Math.random() * 2 ** 32;
    words[1] = Math.random() * 2 ** 32;
  }
  return `${words[0].toString(36)}.${words[1].toString(36)}`;
};

export function buildDiagnosticReport({
  version, manager, managerVersion, mode, pageAccess, browser,
  settings, unavailable = [], hidden = {}, rows = [], decisions = [], log = [],
  salt = freshSalt(),
}) {
  const labels = new Map();
  const label = (id) => {
    if (id === null || id === undefined || id === '') return 'no id yet';
    if (!labels.has(id)) labels.set(id, postTag(id, salt));
    return labels.get(id);
  };
  const hiddenParts = Object.entries(hidden).filter(([, count]) => COUNT.test(String(count))).map(([reason, count]) => `${named(reason)} ${count}`);
  // A Map of feature id to reason, or a plain list of ids.
  const blocked = [...unavailable].map((entry) => (Array.isArray(entry) ? `${named(entry[0])} (${named(entry[1])})` : named(entry)));
  return [
    `HushFacebook Web ${scrubText(version, 40)}`,
    `Manager: ${scrubText(`${manager ?? ''} ${managerVersion ?? ''}`, 80) || 'none'}, mode ${named(mode)}, page access ${named(pageAccess)}`,
    `Browser: ${browserOf(browser)}`,
    ...settingLines(settings),
    `Unavailable: ${blocked.join(', ') || 'none'}`,
    `Hidden since the page loaded: ${hiddenParts.join(', ') || 'None yet'}`,
    ...rows.map(({ label: name, value, shareable }) => {
      const text = String(value ?? '');
      return `${scrubText(name, 80)}: ${shareable || COUNT.test(text) ? scrubText(text, 200) : 'left out'}`;
    }),
    '',
    'Why posts were hidden, oldest first:',
    ...(decisions.length
      ? decisions.map(({ time, layer, id, rule, signal }) => `${String(time ?? '').slice(0, 8)} ${layer === 'data' ? 'data' : 'page'} ${label(id)} ${named(rule)}${signal ? `: ${named(signal)}` : ''}`)
      : ['nothing yet']),
    '',
    'Log, details left out:',
    ...(log.length
      ? log.slice(-REPORT_LOG_LINES).map(({ time, level, message, code }) => `${String(time ?? '').slice(0, 24)} ${named(level)} ${scrubText(message)}${code ? ` [${named(code)}]` : ''}`)
      : ['nothing yet']),
  ].join('\n');
}
