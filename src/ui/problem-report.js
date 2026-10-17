export const PROBLEM_REPORT_URL = 'https://github.com/SysAdminDoc/HushFacebookWeb/issues/new';
export const MAX_PROBLEM_BODY_LENGTH = 6000;

const oneLine = (value) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
const withoutAccountIds = (value) => value.replace(/\d{6,}/g, '[private number]');
const shorten = (value, maxLength) => {
  const text = oneLine(value);
  if (text.length <= maxLength) return text;
  const marker = ' [shortened]';
  return `${text.slice(0, Math.max(0, maxLength - marker.length)).trimEnd()}${marker}`;
};

function cappedBody(details, footer, maxLength) {
  const safeDetails = withoutAccountIds(details);
  const safeFooter = withoutAccountIds(footer);
  if (safeDetails.length + safeFooter.length <= maxLength) return safeDetails + safeFooter;
  const marker = '\n[details shortened]';
  const available = Math.max(0, maxLength - safeFooter.length - marker.length);
  return `${safeDetails.slice(0, available).trimEnd()}${marker}${safeFooter}`;
}

export function buildProblemReport({ version, browser, manager, managerVersion, features, settings, maxBodyLength = MAX_PROBLEM_BODY_LENGTH }) {
  const switches = settings.schema?.[Symbol.iterator]
    ? [...settings.schema]
    : features.map((feature) => [feature.id, { type: 'toggle', label: feature.title, featureId: feature.id }]);
  const enabled = switches
    .filter(([key, spec]) => spec.type === 'toggle'
      && settings.get(key) === true)
    .map(([, spec]) => `- ${oneLine(spec.label)}`);
  const details = [
    `HushFacebook Web: ${shorten(version, 80)}`,
    `Browser: ${shorten(browser, 500)}`,
    `Userscript manager: ${shorten(manager, 120)} ${shorten(managerVersion, 80)}`.trimEnd(),
    '',
    'Enabled switches:',
    ...(enabled.length ? enabled : ['- None']),
  ].join('\n');
  const footer = '\n\nWhat happened:\n\n\nWhat I expected:\n';
  const body = cappedBody(details, footer, maxBodyLength);
  const title = `HushFacebook Web ${oneLine(version)} problem`;
  const url = new URL(PROBLEM_REPORT_URL);
  url.searchParams.set('title', title);
  url.searchParams.set('body', body);
  return { title, body, url: url.toString() };
}
