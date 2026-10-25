import { channelNames, connectBridge, createBridgeStorage, HELLO_ISOLATED, HELLO_MAIN } from '../../../src/core/bridge.js';
import { createSettings } from '../../../src/core/settings.js';
import { applyObjectMutation } from '../../../src/core/storage.js';
import { check, delay, quietLog } from './helpers.js';

export async function delayedBridge() {
  const requests = [];
  const errors = [];
  const data = { settings: { other: true } };
  let names;
  let started = false;
  let loadAnswered = false;
  const reply = (message) => document.dispatchEvent(new CustomEvent(names.toMain, { detail: JSON.stringify(message) }));
  document.addEventListener(HELLO_MAIN, (event) => {
    if (!names) {
      names = channelNames(event.detail);
      document.addEventListener(names.toIsolated, async (request) => {
        const message = JSON.parse(request.detail);
        requests.push(message.type);
        if (message.type === 'storage:load') {
          await delay(30);
          loadAnswered = true;
          reply({ id: message.id, ok: true, result: structuredClone(data) });
        } else if (message.type === 'storage:mutate') {
          check(loadAnswered, 'A preference mutation ran before saved choices loaded');
          const { key, mutation } = message.payload;
          data[key] = applyObjectMutation(data[key], mutation);
          reply({ id: message.id, ok: true, result: structuredClone(data[key]) });
        } else reply({ id: message.id, ok: false, error: 'Unexpected fixture request' });
      });
    }
    if (started) reply({ ready: true });
  });
  const bridge = connectBridge({ doc: document, win: window });
  const storage = createBridgeStorage(bridge, { log: quietLog(errors) });
  const features = [
    { id: 'demo', title: 'Demo', default: false },
    { id: 'other', title: 'Other', default: false },
  ];
  const settings = createSettings({ storage, features, migrations: [] });
  const saving = settings.set('demo', true);
  check(settings.display('demo') === true && settings.get('demo') === false, 'Pending preferences ran before acknowledgement');
  await delay(20);
  check(requests.length === 0, 'The bridge sent before the delayed handshake');
  started = true;
  document.dispatchEvent(new CustomEvent(HELLO_ISOLATED));
  await saving;
  check(requests.join(',') === 'storage:load,storage:mutate', 'Delayed startup lost request ordering');
  check(settings.get('demo') === true && settings.get('other') === true, 'Startup lost saved or early choices');
  check(storage.getAtLoad('settings', {}).other === true, 'The page-load snapshot was lost');
  check(storage.status().state === 'ready' && errors.length === 0, 'The delayed bridge did not recover');
  return { requests, settings: settings.snapshot() };
}
