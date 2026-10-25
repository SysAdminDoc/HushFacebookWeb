import { installNetworkHooks } from '../../../src/core/net/hooks.js';
import { DROP } from '../../../src/core/net/payload.js';
import { check, quietLog } from './helpers.js';

function getter(proto, name) {
  for (let node = proto; node; node = Object.getPrototypeOf(node)) {
    const found = Object.getOwnPropertyDescriptor(node, name)?.get;
    if (found) return found;
  }
  throw new Error(`Missing XHR ${name} getter`);
}

function wrapXhr(kind, counts) {
  const Native = window.XMLHttpRequest;
  if (kind === 'native') return;
  if (kind === 'proxy') {
    let Constructor;
    Constructor = new Proxy(Native, {
      construct(target, args, newTarget) {
        counts.constructed++;
        const xhr = Reflect.construct(target, args, newTarget === Constructor ? target : newTarget);
        return new Proxy(xhr, {
          get(object, key) {
            const value = Reflect.get(object, key, object);
            return typeof value === 'function' ? value.bind(object) : value;
          },
          set: (object, key, value) => Reflect.set(object, key, value, object),
        });
      },
    });
    window.XMLHttpRequest = Constructor;
    return;
  }
  const nativeText = getter(Native.prototype, 'responseText');
  let proto = Native.prototype;
  if (kind === 'subclass') {
    const Constructor = class extends Native {
      constructor(...args) { super(...args); counts.constructed++; }
    };
    window.XMLHttpRequest = Constructor;
    proto = Constructor.prototype;
  }
  Object.defineProperty(proto, 'responseText', {
    configurable: true,
    get() {
      counts.read++;
      const value = this.response;
      return typeof value === 'string' ? value : nativeText.call(this);
    },
  });
}

export async function network({ wrapper, order }) {
  const counts = { constructed: 0, read: 0 };
  const errors = [];
  if (order === 'before') wrapXhr(wrapper, counts);
  const net = installNetworkHooks({ win: window, log: quietLog(errors) });
  if (order === 'after') wrapXhr(wrapper, counts);
  net.transformResponses({
    id: 'fixture-drop', enabled: () => true, match: (ctx) => ctx.path === '/xhr',
    transform: (doc) => doc.fixture === 2 ? DROP : undefined,
  });
  const progress = [];
  const result = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.timeout = 2500;
    xhr.onprogress = () => {
      try { progress.push(xhr.responseText); } catch (error) { reject(error); }
    };
    xhr.onerror = () => reject(new Error('Local XHR failed'));
    xhr.ontimeout = () => reject(new Error('Local XHR timed out'));
    xhr.onload = () => {
      try { resolve({ text: xhr.responseText, response: xhr.response, status: xhr.status }); }
      catch (error) { reject(error); }
    };
    xhr.open('GET', '/xhr');
    xhr.send();
  });
  check(result.status === 200, 'XHR status changed');
  check(result.text === '{"fixture":1}\n', 'XHR responseText was not transformed');
  check(result.response === result.text, 'XHR response and responseText disagree');
  check(progress.length > 0 && progress.every((part) => result.text.startsWith(part)), 'Streaming XHR prefixes changed');
  check(errors.length === 0, `Network hook logged ${errors.join(', ')}`);
  if (wrapper === 'subclass' || wrapper === 'proxy') check(counts.constructed > 0, 'Companion constructor did not run');
  if (wrapper === 'getter' && order === 'before') check(counts.read > 0, 'Companion getter did not run');
  net.teardown();
  return { wrapper, order, progressReads: progress.length, ...counts };
}
