// -----------------------------------------------------------------------------
// The pure parts: the answers of igloohome, the configuration, /data, the
// external ids, the token helpers, and the HTTPS transport's refusal to send
// before TLS is up.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { jwtExpiry, retryAfterOf } from '../src/client.js';
import { normalizeConfig } from '../src/config.js';
import { TIMINGS } from '../src/constants.js';
import { buildDevice, parseExternalId, valuesOf } from '../src/devices.js';
import { httpsRequest } from '../src/http.js';
import { batteryOf, cleanText, parseDevices, parseJob } from '../src/igloo.js';
import { normalizeMemory } from '../src/store.js';

test('parseDevices: types, bridge links, bad values dropped, no prototype pollution', () => {
  const json = JSON.parse(
    JSON.stringify({
      nextCursor: 'abc',
      payload: [
        {
          deviceId: 'L1',
          type: 'Lock',
          deviceName: 'Door\u0007',
          batteryLevel: 77,
          lastSync: '2026-10-01T10:00:00Z',
        },
        { deviceId: 'L1', type: 'Lock', deviceName: 'Duplicate' },
        { deviceId: 'bad id!', type: 'Lock' },
        { deviceId: 'L2', type: 'Lock', batteryLevel: 101, lastSync: 'yesterday' },
        { deviceId: 'B1', type: 'Bridge', linkedDevices: [{ deviceId: 'L1' }, { deviceId: 'B1' }] },
      ],
    }),
  );
  json.payload.push(
    JSON.parse('{"__proto__": {"polluted": true}, "deviceId": "K1", "type": "Keypad"}'),
  );
  const { devices, more } = parseDevices(json);
  assert.equal(more, true);
  assert.deepEqual([...devices.keys()], ['L1', 'L2', 'B1', 'K1']);
  assert.deepEqual(devices.get('L1'), {
    id: 'L1',
    type: 'Lock',
    name: 'Door',
    battery: 77,
    lastSync: Date.parse('2026-10-01T10:00:00Z'),
    bridge: 'B1',
  });
  assert.deepEqual(devices.get('L2'), { id: 'L2', type: 'Lock', name: '' });
  assert.equal(devices.get('B1').bridge, undefined);
  assert.equal({}.polluted, undefined);
  assert.throws(() => parseDevices({ payload: 'x' }));
  assert.throws(() => parseDevices(null));
});

test('parseDevices: bounded in count', () => {
  const payload = Array.from({ length: 1000 }, (_, i) => ({ deviceId: `D${i}`, type: 'Lock' }));
  assert.equal(parseDevices({ payload }).devices.size, 300);
});

test('battery levels: integers 0..100 only', () => {
  assert.deepEqual([0, 100, 50, -1, 101, 1.5, null, '50', undefined].map(batteryOf), [
    0,
    100,
    50,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

test('parseJob', () => {
  assert.deepEqual(
    parseJob({ jobId: 'j1', completed: false, expiryDate: '2026-10-01T10:00:00Z' }),
    {
      id: 'j1',
      completed: false,
      expiry: Date.parse('2026-10-01T10:00:00Z'),
      responseKeys: [],
    },
  );
  // jobResponse: its key names only, bounded, never its values.
  const keys = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'secret']));
  const job = parseJob({ jobId: 'j1', completed: true, jobResponse: { 'a b!': 1, ...keys } });
  assert.equal(job.responseKeys.length, 10);
  assert.equal(job.responseKeys[0], 'ab');
  assert.ok(!JSON.stringify(job).includes('secret'));
  assert.throws(() => parseJob({ jobId: 'j1', completed: 'yes' }));
  assert.throws(() => parseJob({ completed: true }));
});

test('cleanText removes control characters and cuts', () => {
  assert.equal(cleanText(' a\u0000b\u009fc ', 10), 'abc');
  assert.equal(cleanText('x'.repeat(100), 5), 'xxxxx');
  assert.equal(cleanText(42, 5), '');
});

test('configuration: strict option, bounded interval, credentials checked', () => {
  const c = normalizeConfig({
    client_id: ' id ',
    client_secret: 's',
    allow_unlock: 'yes',
    poll_interval: '10',
  });
  assert.deepEqual(c.auth, { clientId: 'id', clientSecret: 's' });
  assert.equal(c.allowUnlock, false);
  assert.equal(c.pollInterval, 300);
  assert.equal(normalizeConfig({ allow_unlock: true }).allowUnlock, true);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 900);
  assert.equal(normalizeConfig({ client_id: 'a:b', client_secret: 's' }).badAuth, 'invalid');
  assert.equal(normalizeConfig({ client_id: 'a b', client_secret: 's' }).badAuth, 'invalid');
  assert.equal(normalizeConfig({ client_id: 'a' }).badAuth, 'missing');
  assert.equal(normalizeConfig({ __proto__: { allow_unlock: true } }).allowUnlock, false);
});

test('/data: bounded when read back', () => {
  const now = 1_800_000_000_000;
  const m = normalizeMemory(
    {
      salt: 'zz',
      pause: { until: now + 100 * 3600_000, failures: 3 },
      block: { kind: 'refused', until: now + 999 * 3600_000, failures: 2, fp: 'a'.repeat(32) },
      lastAttemptAt: now + 5000,
      locks: [
        { id: 'L1', bridge: 'B1' },
        { id: 'L1', bridge: 'B2' },
        { id: 'x y', bridge: 'B' },
      ],
      guards: [
        { lock: 'L1', until: now + 3600_000, jobId: 'j1' },
        { lock: 'L2', until: now - 1 },
      ],
      bridgeJobs: [
        { bridge: 'B1', at: now - 1000 },
        { bridge: 'B2', at: now - 3600_000 },
      ],
    },
    now,
  );
  assert.match(m.salt, /^[0-9a-f]{32}$/);
  assert.equal(m.pause.until, now + TIMINGS.pauseMax);
  assert.deepEqual(m.block, { kind: 'refused', failures: 2, fp: 'a'.repeat(32) }, 'final');
  assert.equal(m.lastAttemptAt, now);
  assert.deepEqual(m.locks, [{ id: 'L1', bridge: 'B1' }]);
  assert.deepEqual(m.guards, [
    { lock: 'L1', until: now + TIMINGS.jobWatchMax + TIMINGS.guardMargin, jobId: 'j1' },
  ]);
  assert.deepEqual(m.bridgeJobs, [{ bridge: 'B1', at: now - 1000 }]);
  const scope = normalizeMemory({ block: { kind: 'scope', fp: 'b'.repeat(32), until: 5 } }, now);
  assert.equal(scope.block.kind, 'scope');
  assert.equal(normalizeMemory('garbage', now).block, null);
  // Guards and jobs bounded by the watch; the summary by count and fields.
  const b = normalizeMemory(
    {
      guards: [{ lock: 'L1', until: now + 10 * 3600_000 }],
      jobs: [
        { id: 'j1', lock: 'L1', action: 'unlock', sentAt: now - 1000, expiry: now + 5 },
        { id: 'j2', lock: 'L1', action: 'open', sentAt: now },
        { id: 'j3', lock: 'L1', action: 'lock', sentAt: now - TIMINGS.jobWatchMax - 1 },
      ],
      okAt: now + 99,
      summary: {
        devices: [
          { id: 'L1', type: 'Lock', name: 'x\u0000y', battery: 500, bridge: 'B1', extra: 1 },
          { id: 'bad id', type: 'Lock' },
        ],
        more: 'yes',
      },
    },
    now,
  );
  assert.equal(b.guards[0].until, now + TIMINGS.jobWatchMax + TIMINGS.guardMargin);
  assert.deepEqual(b.jobs, [
    { id: 'j1', lock: 'L1', action: 'unlock', sentAt: now - 1000, expiry: now + 5 },
  ]);
  assert.equal(b.okAt, now);
  assert.deepEqual(b.summary, {
    devices: [{ id: 'L1', type: 'Lock', name: 'xy', bridge: 'B1' }],
    more: false,
  });
});

test('external ids: only ours, checked against the SDK', () => {
  const gladys = createFakeGladys({ selector: 'igloohome' });
  const device = gladys.externalIds('igloohome', 'IGM3abc');
  assert.deepEqual(parseExternalId(gladys, device.device), { deviceId: 'IGM3abc' });
  assert.deepEqual(parseExternalId(gladys, device.feature('unlock')), {
    deviceId: 'IGM3abc',
    key: 'unlock',
  });
  assert.equal(parseExternalId(gladys, device.feature('other')), undefined);
  assert.equal(parseExternalId(gladys, 'ext:other:igloohome:IGM3abc'), undefined);
  assert.equal(parseExternalId(gladys, 42), undefined);
});

test('devices: the sync age in whole hours, never negative', () => {
  const gladys = createFakeGladys({ selector: 'igloohome' });
  const now = 1_800_000_000_000;
  const device = { id: 'L1', type: 'Lock', name: '', battery: 5, lastSync: now + 3600_000 };
  assert.deepEqual(valuesOf(device, now), [
    { key: 'battery', value: 5 },
    { key: 'sync_age', value: 0 },
  ]);
  assert.equal(buildDevice(gladys, device, { language: 'en' }).name, 'igloohome L1');
});

test('token helpers: Retry-After and JWT expiry', () => {
  assert.equal(retryAfterOf({ 'retry-after': '120' }), 120_000);
  assert.equal(retryAfterOf({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }), undefined);
  assert.equal(retryAfterOf({ 'retry-after': '999999' }), undefined);
  assert.equal(retryAfterOf({}), undefined);
  const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url');
  assert.equal(jwtExpiry(`h.${payload}.s`), 2_000_000_000_000);
  assert.equal(jwtExpiry('opaque'), undefined);
});

test('https: an http URL is refused; nothing is sent before TLS is up', async () => {
  await assert.rejects(
    httpsRequest({ method: 'GET', url: 'http://example.invalid/', timeout: 100, maxBytes: 10 }),
    (err) => err.kind === 'unreachable' && err.sent === false,
  );
  // A server that accepts the connection but never answers the TLS handshake.
  const received = [];
  const server = net.createServer((socket) => socket.on('data', (d) => received.push(d)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  let called = false;
  try {
    await assert.rejects(
      httpsRequest({
        method: 'POST',
        url: `https://127.0.0.1:${port}/jobs`,
        body: '{"jobType":2}',
        timeout: 1000,
        sendWithin: 200,
        maxBytes: 100,
        beforeSend: () => {
          called = true;
        },
      }),
      (err) => err.kind === 'late' && err.sent === false,
    );
  } finally {
    server.close();
  }
  assert.equal(called, false);
  assert.ok(!Buffer.concat(received).toString('latin1').includes('jobType'));
});
