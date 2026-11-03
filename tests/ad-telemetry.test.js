// Block ad telemetry and the realtime socket's log batches. The frames are built in the shape seen
// live on Home on 2026-11-03 (a gateway data frame, the 2 byte sequence, then a Thrift compact
// struct field with an i64 and the batch JSON), with the event keys seen then and every id and
// token made up.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchWebSocket } from '../src/core/net/websocket.js';
import { readBatchBody } from '../src/core/net/realtime.js';
import blockAdTelemetry, { AD_EVENTS } from '../src/features/privacy/ad-telemetry.js';

const REALTIME = 'wss://gateway.facebook.com/ws/realtime?x-dgw-appid=2220391788200892&x-dgw-appversion=0';
const LIGHTSPEED = 'wss://gateway.facebook.com/ws/lightspeed?x-dgw-appid=1&x-dgw-version=5';
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const varint = (value) => {
  const out = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
};

const event = (name, extra) => ({
  name,
  extra: JSON.stringify(extra),
  rate: 1,
  time: 1762189000.214,
  tag: '',
  tags: [],
  shouldAddState: true,
  identity: { appScopedIdentity: '100000000000001', claim: '' },
  sessionID: '1a2b3c',
  deviceID: 'd-0001',
});
const impression = (adId = '120200000000000001') => event('comet_ads_product_logging', {
  ad_id: adId, ad_request_id: '7400000000000000001', csp: '1', endpoint: 'comet.home', event: 'impression', feed_order_id: '0', hba: false,
  is_ad_eligible_for_ad_pod: false, isv: '1', min_gap_shape: { min_gap_rule: '0', min_gap_type: 'SPONSORED' }, session_key: 'abc:def:ghi',
  surface_session_id: '1', timestamp: '1762189000', tracking: 'AZ' + 'x'.repeat(180), vp: '1',
});
const slot = () => event('brand_safety_opportunity_loss_rate', {
  ad_insertion_status: 'INSERTED', ad_insertion_sub_status: 'NOT_APPLICABLE_1', ad_inventory_filter: '10', adjacent_edges_info: { above: 'post', below: 'post' },
  client_token: 'ct' + 'y'.repeat(89), feed_session_id: '', impression_original_timestamp_ms: '1762189000123', slot_position: '3',
});
const perf = () => event('perf', { marker_id: 1, duration_ns: 2000, points: [] });
const viewable = () => event('comet_metrics_viewable_impression', { aidv2: 'v'.repeat(79), hba: false, isv: '1', csp: '12' });

// One socket message: a gateway data frame on stream 0 carrying the batch.
function batchMessage(events, { seq = [0x3a, 0x80], id = 57, raw } = {}) {
  const json = encoder.encode(raw ?? JSON.stringify({ events }));
  const body = [...seq, 0x3c, 0x16, ...varint(id * 2), 0x18, ...varint(json.length), ...json, 0x00, 0x00];
  return Uint8Array.from([0x0d, 0x00, 0x00, body.length & 0xff, (body.length >> 8) & 0xff, body.length >> 16, ...body]);
}

// Read back by hand, independent of the code under test.
function readMessage(bytes) {
  assert.equal(bytes[0], 0x0d);
  const length = bytes[3] | (bytes[4] << 8) | (bytes[5] << 16);
  assert.equal(6 + length, bytes.length, 'the frame length covers the message exactly');
  const body = bytes.subarray(6);
  assert.equal(body[2], 0x3c);
  let at = 3;
  assert.equal(body[at++], 0x16);
  while (body[at] & 0x80) at++;
  at++;
  assert.equal(body[at++], 0x18);
  let size = 0;
  let scale = 1;
  while (true) {
    const byte = body[at++];
    size += (byte & 0x7f) * scale;
    scale *= 128;
    if (!(byte & 0x80)) break;
  }
  assert.equal(at + size + 2, body.length, 'the JSON length and the two stop bytes fill the body');
  assert.deepEqual([...body.subarray(at + size)], [0, 0]);
  return { seq: [...body.subarray(0, 2)], batch: JSON.parse(decoder.decode(body.subarray(at, at + size))) };
}

function setup(on = true, startup) {
  const sent = [];
  class WebSocket {
    constructor(url) { this.url = url; }
    send(data) { sent.push(data); }
  }
  const win = { WebSocket, TextDecoder, TextEncoder };
  const errors = [];
  const log = { error: (...args) => errors.push(args), warn() {}, info() {} };
  const sockets = patchWebSocket(win, { log, startup });
  const net = { editLogBatches: sockets.editLogBatches, logStats: sockets.logStats, editChatRequests: sockets.editChatRequests, chatStats: sockets.stats };
  const rows = new Map();
  let changes = 0;
  const diagnostics = { add: (label, read) => rows.set(label, read), changed: () => changes++ };
  const state = { on };
  blockAdTelemetry.setup({ net, diagnostics, enabled: () => state.on });
  return { win, sent, errors, rows, sockets, state, socket: new win.WebSocket(REALTIME), changes: () => changes };
}

test('a batch read in the live shape gives the JSON and where it sits', () => {
  const bytes = batchMessage([perf()]);
  const read = readBatchBody(bytes.subarray(6), decoder);
  assert.ok(read);
  assert.deepEqual(JSON.parse(read.text), { events: [perf()] });
  assert.equal(read.end, bytes.length - 6 - 2);
});

test('ad views and ad slots come out of a batch, and everything else stays as it was', () => {
  const { socket, sent, rows, changes } = setup();
  socket.send(batchMessage([perf(), impression(), viewable(), slot()], { seq: [0x5d, 0x80], id: 300 }));
  const { seq, batch } = readMessage(sent[0]);
  assert.deepEqual(seq, [0x5d, 0x80], 'the sequence number is kept');
  assert.deepEqual(batch.events.map((e) => e.name), ['perf', 'comet_metrics_viewable_impression']);
  assert.deepEqual(batch.events, [perf(), viewable()]);
  assert.equal(rows.get('Ad reports held back')(), '1 ad view, 1 ad slot');
  assert.equal(changes(), 1);
});

test('a batch holding only an ad report still goes out, empty, so the server acknowledges it as before', () => {
  const { socket, sent, rows } = setup();
  socket.send(batchMessage([impression('120200000000000001')]));
  socket.send(batchMessage([impression('120200000000000002'), impression('120200000000000003')]));
  assert.equal(sent.length, 2);
  assert.deepEqual(readMessage(sent[0]).batch, { events: [] });
  assert.deepEqual(readMessage(sent[1]).batch, { events: [] });
  assert.equal(rows.get('Ad reports held back')(), '3 ad views, 0 ad slots');
});

test('both lengths are rewritten when the JSON crosses a varint byte, down and up', () => {
  const { socket, sent } = setup();
  // Over 127 bytes with the ad, under 128 without: the JSON length shrinks from two bytes to one.
  socket.send(batchMessage([impression(), event('ghl_nfm', { event: 'x' })]));
  const { batch } = readMessage(sent[0]);
  assert.deepEqual(batch.events.map((e) => e.name), ['ghl_nfm']);
  // A 70 KB batch: three-byte lengths stay right too.
  const big = event('perf', { points: 'p'.repeat(70000) });
  socket.send(batchMessage([big, slot()]));
  assert.deepEqual(readMessage(sent[1]).batch.events, [big]);
});

test('with the switch off, or no ad report in the batch, the very same message goes out', () => {
  const { socket, sent, state, rows } = setup(false);
  const withAd = batchMessage([impression(), perf()]);
  socket.send(withAd);
  assert.equal(sent[0], withAd);
  state.on = true;
  const plain = batchMessage([perf(), viewable()]);
  socket.send(plain);
  assert.equal(sent[1], plain);
  assert.equal(rows.get('Ad reports held back')(), '0 ad views, 0 ad slots');
});

test('while settings load the reports are held back anyway, as the other privacy switches do', () => {
  let state = 'loading';
  const { socket, sent } = setup(false, { state: () => state });
  socket.send(batchMessage([impression(), perf()]));
  assert.deepEqual(readMessage(sent[0]).batch.events.map((e) => e.name), ['perf']);
  state = 'ready';
  const later = batchMessage([impression(), perf()]);
  socket.send(later);
  assert.equal(sent[1], later, 'once settings say off, nothing is touched');
});

test('anything not in the live shape goes out untouched and is counted', () => {
  const { socket, sent, sockets, errors } = setup();
  const odd = [
    // The chat format on this socket: JSON straight after the sequence number.
    Uint8Array.from([0x0d, 0, 0, 4, 0, 0, 0x00, 0x80, 0x7b, 0x7d]),
    // A long-form field header (zero delta).
    (() => { const m = batchMessage([impression()]); m[6 + 3] = 0x06; return m; })(),
    // Bytes after the stop byte.
    (() => { const m = batchMessage([impression()]); const out = Uint8Array.from([...m, 0x00]); out[3] += 1; return out; })(),
    // JSON that wouldn't write back the same (a 1.0 would come back as 1).
    batchMessage(null, { raw: `{"events":[${JSON.stringify(impression())}],"rate":1.0}` }),
    // Not a run of gateway frames at all.
    Uint8Array.from([0x42, 1, 2]),
  ];
  for (const message of odd) socket.send(message);
  assert.deepEqual(sent, odd);
  assert.equal(sockets.logStats.unreadable, 5);
  assert.equal(sockets.logStats.messages, 5);
  assert.equal(errors.length, 0);
});

test('a batch that holds something other than events, like the socket handshake, passes', () => {
  const { socket, sent, sockets } = setup();
  const hello = batchMessage(null, { raw: '{"deviceId":"d-0001","appId":"2220391788200892"}' });
  socket.send(hello);
  assert.equal(sent[0], hello);
  assert.equal(sockets.logStats.unreadable, 0);
});

test('log rules leave the chat socket alone, and an ArrayBuffer goes back as one', () => {
  const { win, sent } = setup();
  const chat = new win.WebSocket(LIGHTSPEED);
  const bytes = batchMessage([impression(), perf()]);
  chat.send(bytes);
  assert.equal(sent[0], bytes);
  const socket = new win.WebSocket(REALTIME);
  socket.send(bytes.slice().buffer);
  assert.equal(Object.prototype.toString.call(sent[1]), '[object ArrayBuffer]');
  assert.deepEqual(readMessage(new Uint8Array(sent[1])).batch.events.map((e) => e.name), ['perf']);
});

test('a rule that fails lets the batch go out unchanged and is logged once', () => {
  const { socket, sent, sockets, errors } = setup(false);
  sockets.editLogBatches({ id: 'broken', enabled: () => true, edit() { throw new Error('boom'); } });
  const bytes = batchMessage([impression()]);
  socket.send(bytes);
  socket.send(bytes);
  assert.deepEqual(sent, [bytes, bytes]);
  assert.equal(errors.length, 1);
});

test('the switch: Android name, privacy section, off by default, page only, and the two event names', () => {
  assert.equal(blockAdTelemetry.android, 'Block ad telemetry');
  assert.equal(blockAdTelemetry.section, 'privacy');
  assert.equal(blockAdTelemetry.default, false);
  assert.equal(blockAdTelemetry.needsPage, true);
  assert.deepEqual([...AD_EVENTS], ['comet_ads_product_logging', 'brand_safety_opportunity_loss_rate']);
  const rows = new Map();
  blockAdTelemetry.setup({ net: null, diagnostics: { add: (label, read) => rows.set(label, read) }, enabled: () => true });
  assert.match(rows.get('Ad reports held back')(), /can't reach/);
});
