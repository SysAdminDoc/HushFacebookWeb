// Hide read receipts keeps a chat you opened looking unread (#5). Facebook flips the row to read
// on the page as soon as the chat has focus, though the server never heard it, and a reload shows
// it unread again. The rows below follow the chat list as drawn on 2026-11-18 (script off), with
// the text and pictures left out. They're built detached and inserted whole, as React does.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { patchWebSocket } from '../src/core/net/websocket.js';
import { renderFeatureCss } from '../src/core/style.js';
import hideReadReceipts from '../src/features/chats/hide-read-receipts.js';

const MARK = 'data-hfw-unread';
const LIGHTSPEED = 'wss://gateway.facebook.com/ws/lightspeed?x-dgw-appid=1&x-dgw-version=5';
const OPENED = '100000000000001';
const OTHER = '100000000000002';
// Past what a JavaScript number holds.
const BIG = '10987654321098765';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

const task = (label, payload, queue, id = 1) =>
  JSON.stringify({ failure_count: null, label, payload: JSON.stringify(payload).replace(/"(\d{16,})"/g, '$1'), queue_name: queue, task_id: id });
const markRead = (thread, id, syncGroup = 1) => task('21', { thread_id: thread, last_read_watermark_ts: 1791675618820, sync_group: syncGroup, offline_threading_id: '7400000000000000001' }, thread, id);
const reply = (thread, id, syncGroup = 1) => task('46', { thread_id: thread, otid: '7400000000000000002', source: 65537, send_type: 1, sync_group: syncGroup, text: 'hi' }, thread, id);
// Live 2026-11-25: opening an end-to-end encrypted chat queues its mark-read task on the same
// socket, in sync group 95, with the number from the chat's /messages/e2ee/t/ link.
const ENCRYPTED = 95;

function taskMessage(tasks) {
  const payload = `{"epoch_id":7514831369484259021,"tasks":[${tasks.join(',')}],"version_id":"28807723308890973"}`;
  const json = encoder.encode(JSON.stringify({ app_id: '1234567890123456', payload, request_id: 9, type: 3 }));
  const body = new Uint8Array([0x00, 0x80, ...json]);
  return new Uint8Array([0x0d, 7, 0, body.length & 0xff, (body.length >> 8) & 0xff, body.length >> 16, ...body]);
}

const sentText = (bytes) => decoder.decode(bytes.subarray(8));

// A chat row: picture, name and preview, and the end column that holds Facebook's own dot.
function row(doc, href, { dot = false } = {}) {
  const box = doc.createElement('div');
  box.setAttribute('role', 'row');
  box.innerHTML = `<div role="gridcell"><div><div><div><a role="link" href="${href}"><div><div>
    <div class="picture"></div><div class="text"><span><span>Name</span></span><span><span>Preview</span></span><abbr><span>1h</span></abbr></div>
    <div class="end"><div><div>${dot ? '<div aria-hidden="true" role="button"><span></span><div role="none"></div></div>' : ''}</div></div></div>
  </div></div></a></div></div></div></div>`;
  return box;
}

function page({ keepUnread = true, on = true } = {}) {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  const doc = win.document;
  const list = doc.createElement('div');
  list.setAttribute('role', 'grid');
  list.append(row(doc, `/messages/t/${OPENED}/`), row(doc, `/messages/t/${OTHER}/`), row(doc, `/messages/e2ee/t/${OPENED}/`));
  doc.body.append(list);

  const sent = [];
  class WebSocket {
    constructor(url) { this.url = url; }
    send(data) { sent.push(data); }
  }
  const socketWin = { WebSocket, TextDecoder, TextEncoder };
  const log = { error() {}, warn() {}, info() {} };
  const sockets = patchWebSocket(socketWin, { log });
  const net = { editChatRequests: sockets.editChatRequests, chatStats: sockets.stats };
  const values = { hideReadReceipts: on, 'hideReadReceipts.keepUnread': keepUnread };
  const listeners = [];
  const settings = {
    get: (key) => values[key],
    enabled: (id) => values[id] === true,
    subscribe: (fn) => listeners.push(fn),
  };
  const rows = new Map();
  const diagnostics = { add: (label, read) => rows.set(label, read), changed() {} };
  hideReadReceipts.setup({
    doc, net, settings, diagnostics,
    enabled: () => values.hideReadReceipts === true,
    option: (key) => values[`hideReadReceipts.${key}`],
  });
  const socket = new socketWin.WebSocket(LIGHTSPEED);
  const link = (thread, path = 'messages/t') => doc.querySelector(`a[href="/${path}/${thread}/"]`);
  const set = (key, value) => {
    values[key] = value;
    for (const fn of listeners) fn();
  };
  return { win, doc, list, socket, sent, link, set, settings, rows };
}

test('a chat whose read receipt was held keeps looking unread, and no other row changes', async () => {
  const { socket, sent, link, rows } = page();
  socket.send(taskMessage([markRead(OPENED)]));
  await tick();
  assert.ok(!/label\\":\\"21/.test(sentText(sent[0])), 'the receipt still stays back');
  assert.equal(link(OPENED).hasAttribute(MARK), true);
  assert.equal(link(OTHER).hasAttribute(MARK), false);
  assert.equal(link(OPENED, 'messages/e2ee/t').hasAttribute(MARK), false, 'an encrypted chat with the same number is another chat');
  assert.equal(rows.get('Chats kept looking unread')(), '1');
});

test('an encrypted chat whose receipt was held keeps looking unread, and the plain chat with its number doesn\'t', async () => {
  const { socket, sent, link, rows } = page();
  socket.send(taskMessage([markRead(OPENED, 1, ENCRYPTED)]));
  await tick();
  assert.ok(!/label\\":\\"21/.test(sentText(sent[0])), 'the receipt still stays back');
  assert.equal(link(OPENED, 'messages/e2ee/t').hasAttribute(MARK), true);
  assert.equal(link(OPENED).hasAttribute(MARK), false);
  assert.equal(rows.get('Chats kept looking unread')(), '1');
});

test('an encrypted chat reads its number from the task body too, and a reply there ends it', async () => {
  const { socket, link } = page();
  socket.send(taskMessage([task('21', { thread_id: OPENED, last_read_watermark_ts: 1, sync_group: ENCRYPTED }, 'mrq.1'), markRead(OTHER, 2)]));
  await tick();
  assert.equal(link(OPENED, 'messages/e2ee/t').hasAttribute(MARK), true);
  socket.send(taskMessage([reply(OPENED, 3, ENCRYPTED)]));
  await tick();
  assert.equal(link(OPENED, 'messages/e2ee/t').hasAttribute(MARK), false);
  assert.equal(link(OTHER).hasAttribute(MARK), true, 'a reply in the encrypted chat leaves the plain one alone');
});

test('a full link to an encrypted chat is matched the same way', async () => {
  const { doc, list, socket } = page();
  list.append(row(doc, `https://www.facebook.com/messages/e2ee/t/${OTHER}/?x=1`));
  socket.send(taskMessage([markRead(OTHER, 1, ENCRYPTED)]));
  await tick();
  assert.equal(doc.querySelector(`a[href^="https://"]`).hasAttribute(MARK), true);
  assert.equal(doc.querySelector(`a[href="/messages/t/${OTHER}/"]`).hasAttribute(MARK), false);
});

test('a thread id too big for a JavaScript number still finds its row', async () => {
  const { doc, list, socket, link } = page();
  list.append(row(doc, `/messages/t/${BIG}/`), row(doc, `/messages/t/${BIG.slice(0, -1)}6/`));
  socket.send(taskMessage([markRead(BIG)]));
  await tick();
  assert.equal(link(BIG).hasAttribute(MARK), true);
  assert.equal(link(`${BIG.slice(0, -1)}6`).hasAttribute(MARK), false);
});

test('the thread comes from the task body when the queue name has none', async () => {
  const { socket, sent, link } = page();
  socket.send(taskMessage([task('21', { thread_id: OPENED, last_read_watermark_ts: 1, sync_group: 1 }, 'mrq.1')]));
  await tick();
  assert.equal(link(OPENED).hasAttribute(MARK), true);
  assert.ok(!/label\\":\\"21/.test(sentText(sent[0])));
});

test('a mark-read task with nothing readable in it is still held back', async () => {
  const { socket, sent, doc } = page();
  socket.send(taskMessage(['{"label":"21","payload":7,"queue_name":null,"task_id":1}', '{"label":"21","task_id":2}']));
  await tick();
  assert.ok(!/label\\":\\"21/.test(sentText(sent[0])));
  assert.ok(!doc.querySelector(`[${MARK}]`));
});

test('a row showing Facebook\'s own unread dot is left alone until the dot goes', async () => {
  const { doc, list, socket, link } = page();
  link(OPENED).closest('[role="row"]').remove();
  list.prepend(row(doc, `/messages/t/${OPENED}/`, { dot: true }));
  socket.send(taskMessage([markRead(OPENED)]));
  await tick();
  assert.equal(link(OPENED).hasAttribute(MARK), false, 'no second dot beside Facebook\'s');
  link(OPENED).querySelector('[aria-hidden="true"][role="button"]').remove();
  await tick();
  assert.equal(link(OPENED).hasAttribute(MARK), true, 'the look takes over when Facebook drops its dot');
  link(OPENED).querySelector('.end > div > div').append(row(doc, '/x', { dot: true }).querySelector('[aria-hidden="true"]'));
  await tick();
  assert.equal(link(OPENED).hasAttribute(MARK), false, 'a new message brings Facebook\'s dot back');
});

test('the look follows the chat when the list redraws or reuses a row', async () => {
  const { doc, list, socket, link } = page();
  socket.send(taskMessage([markRead(OPENED)]));
  await tick();
  const reused = link(OPENED);
  reused.setAttribute('href', `/messages/t/${OTHER}9/`);
  await tick();
  assert.equal(reused.hasAttribute(MARK), false, 'the row now shows another chat');
  list.append(row(doc, `/messages/t/${OPENED}/`));
  await tick();
  assert.equal(link(OPENED).hasAttribute(MARK), true, 'the chat\'s new row has it');
});

test('replying ends it, since a reply tells Facebook you read the chat anyway', async () => {
  const { socket, sent, link } = page();
  socket.send(taskMessage([markRead(OPENED), markRead(OTHER, 2)]));
  await tick();
  socket.send(taskMessage([reply(OPENED), markRead(OPENED, 2)]));
  await tick();
  assert.match(sentText(sent[1]), /label\\":\\"46/, 'the reply goes out');
  assert.equal(link(OPENED).hasAttribute(MARK), false);
  assert.equal(link(OTHER).hasAttribute(MARK), true, 'other chats keep it');
});

test('the option and the switch both turn it off, and the option starts on', async () => {
  const option = hideReadReceipts.options?.find((o) => o.key === 'keepUnread');
  assert.equal(option?.default, true);
  assert.equal(option?.type, 'toggle');

  const held = page();
  assert.match(renderFeatureCss([hideReadReceipts], held.settings), new RegExp(`\\[${MARK}\\]`));
  held.socket.send(taskMessage([markRead(OPENED)]));
  await tick();
  held.set('hideReadReceipts.keepUnread', false);
  await tick();
  assert.equal(held.link(OPENED).hasAttribute(MARK), false);
  assert.ok(!renderFeatureCss([hideReadReceipts], held.settings).includes(MARK), 'no rule while the option is off');
  held.set('hideReadReceipts.keepUnread', true);
  await tick();
  assert.equal(held.link(OPENED).hasAttribute(MARK), true, 'still held, so it comes back');

  held.set('hideReadReceipts', false);
  await tick();
  assert.equal(held.link(OPENED).hasAttribute(MARK), false);
  held.set('hideReadReceipts', true);
  await tick();
  assert.equal(held.link(OPENED).hasAttribute(MARK), false, 'turning the switch off forgets the chats');
});

test('with the option off a held receipt marks nothing', async () => {
  const { socket, sent, doc } = page({ keepUnread: false });
  socket.send(taskMessage([markRead(OPENED)]));
  await tick();
  assert.ok(!/label\\":\\"21/.test(sentText(sent[0])));
  assert.ok(!doc.querySelector(`[${MARK}]`));
});
