import { startSave } from '../../../src/core/download.js';
import { check } from './helpers.js';

export async function boundedDownload() {
  const signals = [];
  const lengths = [];
  let handoffs = 0;
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { handoffs++; };
  let failure;
  try {
    await startSave({
      parts: ['/download-picture', '/download-sound'], name: 'fixture.mp4',
      byteLimit: 120, deadline: 2500, doc: document,
      win: {
        AbortController,
        fetch(url, options) {
          signals.push(options.signal);
          return window.fetch(url, options).then((response) => {
            lengths.push(response.headers.get('content-length'));
            return response;
          });
        },
      },
    }).done;
  } catch (error) {
    failure = error.message;
  } finally {
    HTMLAnchorElement.prototype.click = click;
  }
  check(/transfer limit/i.test(failure ?? ''), 'The native stream did not enforce its aggregate transfer limit');
  check(signals.length === 2 && signals.every((signal) => signal instanceof AbortSignal && signal.aborted), 'Both native transfers must be aborted');
  check(lengths.length === 2 && lengths.every((length) => length === null), 'The fixture must exercise bodies without Content-Length');
  check(handoffs === 0, 'An oversized transfer reached the download handoff');
  return { failure, aborted: signals.map((signal) => signal.aborted), lengths, handoffs };
}
