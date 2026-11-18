// The chat socket: gateway frames, lightspeed requests, and the two chat switches. The
// fixture holds one scrubbed outgoing message of each kind seen live on 2026-10-10. The read and
// typing requests and the server's replies are built in the shapes seen live on 2026-11-18.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureLines } from './helpers/fixtures.js';
import { readFrames, readJson, readRequest, writeFrames, writeJson, writeRequest } from '../src/core/net/lightspeed.js';
import { patchWebSocket } from '../src/core/net/websocket.js';
import hideReadReceipts from '../src/features/chats/hide-read-receipts.js';
import hideTyping from '../src/features/chats/hide-typing.js';

const LIGHTSPEED = 'wss://gateway.facebook.com/ws/lightspeed?x-dgw-appid=1&x-dgw-version=5';
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const captured = (await fixtureLines('lightspeed-out.jsonl')).map((line) => {
  const { kind, b64 } = JSON.parse(line);
  return { kind, bytes: new Uint8Array(Buffer.from(b64, 'base64')) };
});
const message = (kind) => captured.find((m) => m.kind === kind).bytes;

// Frames read by hand, independent of the code under test.
function frames(bytes) {
  const out = [];
  let at = 0;
  while (at < bytes.length) {
    const type = bytes[at];
    if (type === 0x09 || type === 0x0a) { out.push({ type }); at += 1; continue; }
    if (type === 0x0e) { out.push({ type, stream: bytes[at + 1] | (bytes[at + 2] << 8) }); at += 3; continue; }
    const length = bytes[at + 3] | (bytes[at + 4] << 8) | (bytes[at + 5] << 16);
    const body = bytes.subarray(at + 6, at + 6 + length);
    assert.ok(at + 6 + length <= bytes.length, 'the length fits the message');
    out.push({ type, stream: bytes[at + 1] | (bytes[at + 2] << 8), seq: [...body.subarray(0, 2)], json: body[2] === 0x7b ? decoder.decode(body.subarray(2)) : null });
    at += 6 + length;
  }
  return out;
}

// A queued-task request like the captured ones, with the tasks given.
function taskMessage(tasks, { stream = 7, seq = [0x00, 0x80], epoch = '7514831369484259021' } = {}) {
  const payload = `{"epoch_id":${epoch},"tasks":[${tasks.join(',')}],"version_id":"28807723308890973"}`;
  const json = JSON.stringify({ app_id: '1234567890123456', payload, request_id: 9, type: 3 });
  return message2([[0x0f, stream, encoder.encode('{}')], [0x0d, stream, new Uint8Array([...seq, ...encoder.encode(json)])]]);
}

function message2(list) {
  const parts = list.map(([type, stream, body]) => {
    const head = [type, stream & 0xff, stream >> 8, body.length & 0xff, (body.length >> 8) & 0xff, body.length >> 16];
    return new Uint8Array([...head, ...body]);
  });
  return new Uint8Array(parts.flatMap((p) => [...p]));
}

const task = (label, payload, queue, id) =>
  JSON.stringify({ failure_count: null, label, payload: JSON.stringify(payload).replace(/"(\d{16,})"/g, '$1'), queue_name: queue, task_id: id });
const markRead = (id = 3) => task('21', { thread_id: '10987654321098765', last_read_watermark_ts: 1791675618820, sync_group: 1, offline_threading_id: '7400000000000000001' }, '10987654321098765', id);
const contact = (id) => task('207', { contact_id: 40680124264414 }, 'cpq_v2', id);

function socketWindow() {
  const sent = [];
  class WebSocket extends EventTarget {
    constructor(url) { super(); this.url = url; }
    send(data) { sent.push(data); }
  }
  return { win: { WebSocket, TextDecoder, TextEncoder, MessageEvent, Uint8Array }, sent };
}

function setup(features, on = {}, startup) {
  const { win, sent } = socketWindow();
  const errors = [];
  const log = { error: (...args) => errors.push(args), warn() {}, info() {} };
  const sockets = patchWebSocket(win, { log, startup });
  const net = { editChatRequests: sockets.editChatRequests, chatStats: sockets.stats };
  const rows = new Map();
  const diagnostics = { add: (label, read) => rows.set(label, read), changed() {} };
  for (const feature of features) feature.setup({ net, diagnostics, enabled: () => on[feature.id] !== false });
  const socket = new win.WebSocket(LIGHTSPEED);
  return { win, sent, errors, socket, rows, sockets };
}

function startupControl() {
  let state = 'loading';
  return {
    startup: { state: () => state },
    ready: () => { state = 'ready'; },
  };
}

// What the page hears on a socket, and the server starting its reply on a stream: it opens its
// side and acknowledges the request, as every reply seen live began.
function listen(socket) {
  const heard = [];
  socket.addEventListener('message', (event) => heard.push(event.data));
  return heard;
}
const serverOpens = (socket, stream) => socket.dispatchEvent(new MessageEvent('message', {
  data: message2([[0x0f, stream, encoder.encode('{}')], [0x0c, stream, new Uint8Array([0, 0])]]).slice().buffer,
}));
const doneStep = (id) => `[4,0,1,[5,"taskExists",[19,"${id}"]]],[23,[2,0],[1,[5,"removeTask",[19,"${id}"],[9]]]]`;
const hasReceipt = (bytes) => /label\\":\\"21/.test(frames(bytes)[1].json);

test('every captured message reads into frames and writes back byte for byte', () => {
  assert.ok(captured.length >= 8);
  for (const { kind, bytes } of captured) {
    const read = readFrames(bytes);
    assert.ok(read, kind);
    assert.deepEqual([...writeFrames(read)], [...bytes], kind);
  }
});

test('requests keep ids too big for a JavaScript number exactly as they were', () => {
  for (const { kind, bytes } of captured) {
    for (const frame of frames(bytes)) {
      if (!frame.json) continue;
      const request = readRequest(frame.json);
      assert.ok(request, kind);
      assert.equal(writeRequest(request), frame.json, kind);
      const epoch = frame.json.match(/epoch_id\\":(\d+)/)?.[1];
      if (epoch) assert.ok(epoch.length >= 18 && !Number.isSafeInteger(Number(epoch)), 'the fixture has a 19 digit epoch');
    }
  }
  assert.equal(writeJson(readJson('{"a":12345678901234567890,"b":"12345678901234567890","c":[-98765432109876543]}')), '{"a":12345678901234567890,"b":"12345678901234567890","c":[-98765432109876543]}');
  assert.equal(readJson('{"a": 1}'), null, 'text JSON.stringify would write differently is left alone');
  assert.equal(readJson('{"a":"x\\"12345678901234567890"}').a, 'x"12345678901234567890', 'digits inside a string stay text');
});

test('a message that is not a run of known frames is not read', () => {
  const bytes = message('task 207');
  assert.equal(readFrames(bytes.subarray(0, bytes.length - 1)), null, 'cut short');
  assert.equal(readFrames(new Uint8Array([0x42, 0, 0, 0, 0, 0])), null, 'unknown type');
  assert.deepEqual(readFrames(new Uint8Array([0x09])).map((f) => f.type), [0x09]);
});

test('Hide read receipts takes the mark-read task out and leaves the rest of the request as it was', () => {
  const { sent, socket, rows } = setup([hideReadReceipts]);
  const original = taskMessage([contact(1), markRead(2), contact(3)], { stream: 0x0102, seq: [0x05, 0x80] });
  socket.send(original);
  assert.equal(sent.length, 1);
  const before = frames(original);
  const after = frames(sent[0]);
  assert.equal(after.length, before.length, 'no frame is dropped');
  assert.deepEqual(after[0], before[0], 'the stream opens the same way');
  assert.equal(after[1].stream, 0x0102);
  assert.deepEqual(after[1].seq, [0x05, 0x80], 'same sequence number');
  assert.ok(!/label\\":\\"21/.test(after[1].json), 'no mark-read task');
  assert.deepEqual([...after[1].json.matchAll(/task_id\\":(\d+)/g)].map((m) => m[1]), ['1', '3']);
  assert.match(after[1].json, /epoch_id\\":7514831369484259021,/);
  assert.equal(after[1].json, before[1].json.replace(`,${JSON.stringify(markRead(2)).slice(1, -1)}`, ''), 'only the task is gone');
  assert.equal(rows.get('Read receipts held back')(), '1');
});

test('a request that only marks a thread read still goes out, with no tasks', () => {
  const { sent, socket } = setup([hideReadReceipts]);
  socket.send(taskMessage([markRead(4)]));
  const [, data] = frames(sent[0]);
  assert.match(data.json, /\\"tasks\\":\[\],/);
});

test('the page hears a held receipt is done, word for word as Facebook says it, and Facebook hears nothing', () => {
  const { sent, socket } = setup([hideReadReceipts]);
  const heard = listen(socket);
  socket.send(taskMessage([markRead(16)], { stream: 0x0102 }));
  assert.equal(heard.length, 0, 'the stream has to be open on the page first');
  serverOpens(socket, 0x0102);
  assert.equal(heard.length, 2);
  assert.equal(Object.prototype.toString.call(heard[1]), '[object ArrayBuffer]');
  const [frame, ...rest] = frames(new Uint8Array(heard[1]));
  assert.equal(rest.length, 0);
  assert.equal(frame.type, 0x0d);
  assert.equal(frame.stream, 0x0102);
  assert.deepEqual(frame.seq, [0, 0], 'a number the page does not acknowledge to the server');
  const reply = JSON.parse(frame.json);
  assert.equal(reply.request_id, 9);
  assert.equal(reply.payload, '{"name":null,"step":[1,[4,0,1,[5,"taskExists",[19,"16"]]],[23,[2,0],[1,[5,"removeTask",[19,"16"],[9]]]]]}');
  assert.deepEqual(reply.sp, ['taskExists', 'removeTask']);
  assert.equal(reply.target, 3);
  assert.equal(sent.length, 1, 'only the request itself went out');
});

test('several held receipts in a request are answered together, once, on their own stream', () => {
  const { socket } = setup([hideReadReceipts]);
  const heard = listen(socket);
  socket.send(taskMessage([contact(1), markRead(38), markRead(39)], { stream: 5 }));
  socket.dispatchEvent(new MessageEvent('message', { data: new Blob(['x']) }));
  serverOpens(socket, 6);
  assert.equal(heard.length, 2, 'another stream starting says nothing about this one');
  serverOpens(socket, 5);
  assert.equal(heard.length, 4);
  const reply = JSON.parse(frames(new Uint8Array(heard[3]))[0].json);
  assert.equal(reply.payload, `{"name":null,"step":[1,[1,${doneStep(38)}],[1,${doneStep(39)}]]}`, 'only the held tasks, the server answers for the rest');
  serverOpens(socket, 5);
  assert.equal(heard.length, 5, 'answered once');
});

test('a task number too big for JavaScript is answered exactly, and one with no number is only held', () => {
  const { sent, socket } = setup([hideReadReceipts]);
  const heard = listen(socket);
  const big = markRead(1).replace('"task_id":1', '"task_id":12345678901234567890');
  socket.send(taskMessage([big, markRead(null)], { stream: 3 }));
  assert.ok(!hasReceipt(sent[0]));
  serverOpens(socket, 3);
  assert.equal(JSON.parse(frames(new Uint8Array(heard[1]))[0].json).payload, `{"name":null,"step":[1,${doneStep('12345678901234567890')}]}`);
  socket.send(taskMessage([markRead(null)], { stream: 4 }));
  serverOpens(socket, 4);
  assert.equal(heard.length, 3, 'nothing to answer');
});

test('a receipt held only until the settings load is not answered, so it can still go out', () => {
  const control = startupControl();
  const { sent, socket } = setup([hideReadReceipts], { hideReadReceipts: false }, control.startup);
  const heard = listen(socket);
  socket.send(taskMessage([markRead(2)], { stream: 8 }));
  assert.ok(!hasReceipt(sent[0]), 'held while the choice is unknown');
  serverOpens(socket, 8);
  assert.equal(heard.length, 1, 'the page keeps the task and sends it again');
  control.ready();
  const again = taskMessage([markRead(2)], { stream: 9 });
  socket.send(again);
  assert.ok(sent[1] === again, 'the switch is off, so this time it goes');
  serverOpens(socket, 9);
  assert.equal(heard.length, 2);
});

test('a message that goes out unchanged gets no answer, and a socket that can not listen still sends', () => {
  const failing = setup([hideReadReceipts]);
  failing.sockets.editChatRequests({ id: 'broken', enabled: () => true, edit() { throw new Error('boom'); } });
  const heard = listen(failing.socket);
  const original = taskMessage([markRead(2)], { stream: 2 });
  failing.socket.send(original);
  assert.ok(failing.sent[0] === original);
  serverOpens(failing.socket, 2);
  assert.equal(heard.length, 1);

  const deaf = setup([hideReadReceipts]);
  deaf.socket.addEventListener = () => { throw new Error('no'); };
  deaf.socket.send(taskMessage([markRead(2)]));
  assert.equal(deaf.sent.length, 1, 'never sent a second time');
  assert.ok(!hasReceipt(deaf.sent[0]), 'and the receipt stayed out');
  assert.equal(deaf.errors.length, 1);
});

test('with the switch off, or on other sockets, the message is the very same one', () => {
  const off = setup([hideReadReceipts], { hideReadReceipts: false });
  const original = taskMessage([markRead(1)]);
  off.socket.send(original);
  assert.equal(off.sent[0], original);
  const on = setup([hideReadReceipts]);
  const realtime = new on.win.WebSocket('wss://gateway.facebook.com/ws/realtime?x=1');
  realtime.send(original);
  on.socket.send('{"label":"21"}');
  assert.equal(on.sent[0], original);
  assert.equal(on.sent[1], '{"label":"21"}');
  for (const { bytes } of captured) on.socket.send(bytes);
  assert.deepEqual(on.sent.slice(2), captured.map((m) => m.bytes), 'requests with nothing to take out go as they were');
});

test('unconfirmed chat choices edit only recognized tasks and never hold a mixed socket frame', () => {
  const control = startupControl();
  const { sent, socket } = setup(
    [hideReadReceipts, hideTyping],
    { hideReadReceipts: false, hideTyping: false },
    control.startup,
  );
  const original = new Uint8Array([0x09, ...taskMessage([contact(1), markRead(2), contact(3)])]);
  socket.send(original);
  const before = frames(original);
  const pending = frames(sent[0]);
  assert.equal(sent.length, 1, 'the frame is sent synchronously');
  assert.deepEqual(pending.slice(0, 2), before.slice(0, 2), 'the keepalive and stream setup are untouched');
  assert.deepEqual([...pending[2].json.matchAll(/task_id\\":(\d+)/g)].map((match) => match[1]), ['1', '3']);

  control.ready();
  socket.send(original);
  assert.equal(sent[1], original, 'saved off switches leave the frame byte for byte');
  const unreadable = new Uint8Array([0x42, 1, 2]);
  const uncertain = setup([hideReadReceipts], { hideReadReceipts: false }, startupControl().startup);
  uncertain.socket.send(unreadable);
  assert.equal(uncertain.sent[0], unreadable, 'unknown chat traffic is never suppressed');
});

test('an ArrayBuffer goes out as an ArrayBuffer, and a view into a bigger buffer is read where it sits', () => {
  const { sent, socket } = setup([hideReadReceipts]);
  const bytes = taskMessage([contact(1), markRead(2)]);
  socket.send(bytes.slice().buffer);
  assert.equal(Object.prototype.toString.call(sent[0]), '[object ArrayBuffer]');
  assert.ok(!/label\\":\\"21/.test(frames(new Uint8Array(sent[0]))[1].json));
  const padded = new Uint8Array(bytes.length + 8);
  padded.set(bytes, 4);
  socket.send(padded.subarray(4, 4 + bytes.length));
  assert.ok(!/label\\":\\"21/.test(frames(sent[1])[1].json));
});

test('Hide typing indicator turns typing into not typing, queued or not, and keeps big thread keys', () => {
  const { sent, socket, rows } = setup([hideTyping]);
  const presence = (typing) => `{"thread_key":10987654321098765,"is_group_thread":0,"is_typing":${typing},"attribution":0,"sync_group":1,"thread_type":1}`;
  const unqueued = (typing) => {
    const json = JSON.stringify({ app_id: '1', payload: JSON.stringify({ label: '3', payload: presence(typing), version: '28807723308890973' }), request_id: 4, type: 4 });
    return message2([[0x0d, 2, new Uint8Array([0x03, 0x80, ...encoder.encode(json)])]]);
  };
  socket.send(unqueued(1));
  const [data] = frames(sent[0]);
  assert.match(data.json, /is_typing\\\\\\":0/);
  assert.match(data.json, /thread_key\\\\\\":10987654321098765,/);
  assert.deepEqual(data.seq, [0x03, 0x80]);
  const stopped = unqueued(0);
  socket.send(stopped);
  assert.equal(sent[1], stopped, 'stopping is sent as it was');
  socket.send(taskMessage([task('3', JSON.parse(presence(1)), '', 1)]));
  assert.match(frames(sent[2])[1].json, /is_typing\\\\\\":0/);
  assert.equal(rows.get('Typing signals turned off')(), '2');
});

test('a rule that fails lets the message go out unchanged, and Diagnostics counts what it could not read', () => {
  const { win, sent, socket, errors, rows, sockets } = setup([]);
  sockets.editChatRequests({ id: 'broken', enabled: () => true, edit() { throw new Error('boom'); } });
  const original = taskMessage([markRead(1)]);
  socket.send(original);
  socket.send(original);
  assert.deepEqual(sent, [original, original]);
  assert.equal(errors.length, 1, 'logged once');
  socket.send(new Uint8Array([0x42, 1, 2]));
  assert.equal(sockets.stats.unreadable, 1);
  assert.equal(rows.size, 0);
  assert.equal(win.WebSocket.prototype.send.name, 'send');
});

test('both switches add one Chat socket row between them', () => {
  const { socket, rows } = setup([hideReadReceipts, hideTyping]);
  assert.match(rows.get('Chat socket')(), /hasn't sent anything/);
  socket.send(message('task 145'));
  assert.equal(rows.get('Chat socket')(), '1 message sent');
  assert.ok(hideReadReceipts.needsPage && hideTyping.needsPage);
  assert.equal(hideReadReceipts.default, false);
  assert.equal(hideTyping.default, false);
});
