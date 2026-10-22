// -----------------------------------------------------------------------------
// The scenarios of review 1, inverted: each one checks the corrected
// behaviour (B1, I1 to I5, M1 to M13).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IglooClient, expiryOf } from '../src/client.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  BRIDGE,
  CLIENT_SECRET,
  LOCK,
  LOCK_NO_BRIDGE,
  fakeClock,
  fakeIgloo,
} from './helpers/fakeIgloo.js';
import { BASE, createAll, lastText, press, settle, setup, status } from './helpers/setup.js';

const MIN = 60_000;
const UNLOCK = { config: { allow_unlock: true } };

test('B1a: a job still pending at 140 s is not "expired"; the guard holds until igloohome says it expired', async (t) => {
  const clock = fakeClock();
  const cloud = fakeIgloo({ clock });
  cloud.jobLife = 10 * MIN;
  const env = await setup(t, { clock, cloud, ...UNLOCK });
  await createAll(env.gladys);
  await press(env.gladys, LOCK, 'unlock');
  await env.advance(150_000);
  assert.doesNotMatch(lastText(env.gladys, LOCK), /expiré/);
  assert.equal(env.store.data.guards.length, 1);
  const again = await press(env.gladys, LOCK, 'unlock');
  assert.match(again.error, /attend encore son bridge/);
  assert.equal(cloud.of('job').length, 1, 'never a second unlock job');
  await env.advance(10 * MIN);
  assert.match(lastText(env.gladys, LOCK), /igloohome indique que la tâche a expiré/);
  assert.equal(env.store.data.guards.length, 0);
});

test('B1b: processed at 2 s, a 429 on the status read: never "expired"; read again after the pause', async (t) => {
  const env = await setup(t, UNLOCK);
  const { gladys, cloud } = env;
  await createAll(gladys);
  await press(gladys, LOCK, 'unlock');
  const job = cloud.of('job')[0];
  cloud.jobs.get(job.jobId).completed = true;
  cloud.httpStatus.status = 429;
  cloud.headers = { 'retry-after': '600' };
  await env.advance(5_500);
  delete cloud.httpStatus.status;
  cloud.headers = {};
  await env.advance(140_000);
  assert.doesNotMatch(lastText(gladys, LOCK), /expiré/);
  await env.advance(10 * MIN);
  assert.match(lastText(gladys, LOCK), /traitée par le bridge/);
});

test('B1c: every status read times out: "result unknown" at the end of the watch, never "expired"', async (t) => {
  const env = await setup(t, UNLOCK);
  const { gladys, cloud } = env;
  await createAll(gladys);
  await press(gladys, LOCK, 'unlock');
  cloud.failure.status = 'silent';
  await env.advance(5 * MIN);
  assert.equal(env.store.data.guards.length, 1, 'the guard holds');
  await env.advance(11 * MIN);
  assert.match(lastText(gladys, LOCK), /résultat inconnu/);
  assert.doesNotMatch(lastText(gladys, LOCK), /expiré/);
});

test('I1: a lock job "completed" is never a success: "processed (result not read)"', async (t) => {
  const env = await setup(t);
  const { gladys, cloud } = env;
  cloud.completeAtOnce = true;
  cloud.jobResponse = { success: false, error: 'LOCK_NOT_IN_RANGE' };
  await createAll(gladys);
  const ack = await press(gladys, LOCK, 'lock');
  assert.equal(ack.success, false);
  assert.match(ack.error, /envoyée, sans confirmation/);
  await env.advance(6_000);
  assert.match(
    lastText(gladys, LOCK),
    /Verrouillage : tâche traitée par le bridge \(résultat non lu/,
  );
  assert.ok(env.logs.some((l) => l.includes('jobResponse keys: success,error')));
  assert.ok(!env.logs.some((l) => l.includes('LOCK_NOT_IN_RANGE')), 'keys only, never values');
});

test('I2: an unlock processed after a later lock raises an alert', async (t) => {
  const env = await setup(t, UNLOCK);
  const { gladys, cloud } = env;
  await createAll(gladys);
  await press(gladys, LOCK, 'unlock');
  await env.advance(2_000);
  await press(gladys, LOCK, 'lock');
  const [unlockJob, lockJob] = cloud.of('job');
  cloud.jobs.get(lockJob.jobId).completed = true;
  await env.advance(6_000);
  assert.match(lastText(gladys, LOCK), /Verrouillage : tâche traitée/);
  cloud.jobs.get(unlockJob.jobId).completed = true;
  await env.advance(30_000);
  assert.match(lastText(gladys, LOCK), /Un déverrouillage envoyé avant le verrouillage/);
});

test('I3: a restart 10 s after a successful read: connected, Discovery and badges at once, no old value as new', async (t) => {
  const clock = fakeClock();
  const store = memoryStore();
  const cloud = fakeIgloo({ clock });
  const first = await setup(t, { clock, cloud, store });
  await createAll(first.gladys);
  const created = first.gladys.fake.devices;
  await first.app.stop();
  clock.advance(10_000);
  const second = await setup(t, { clock, cloud, store, devices: created, read: false });
  const reads = cloud.of('devices').length;
  assert.equal(status(second.gladys).connected, true);
  assert.match(status(second.gladys).message.fr, /dernière lecture réussie il y a/);
  assert.equal(second.gladys.fake.discoveredDevices.length, 3);
  assert.ok(second.gladys.fake.transports.some((e) => e.transport === 'cloud'));
  await second.app.publisher.flush();
  assert.equal(second.gladys.fake.states.length, 0, 'no stale value republished');
  assert.equal(cloud.of('devices').length, reads);
});

for (const [name, setupCloud] of [
  ['invalid_client', (cloud) => (cloud.clientSecret = 'another')],
  ['invalid_request', (cloud) => (cloud.tokenError = 'invalid_request')],
  ['403 without a code', (cloud) => (cloud.tokenStatus = 403)],
]) {
  test(`I4: token refused (${name}): a final stop, no automatic request in 7 days, restart included`, async (t) => {
    const clock = fakeClock();
    const store = memoryStore();
    const cloud = fakeIgloo({ clock });
    setupCloud(cloud);
    const env = await setup(t, { clock, cloud, store });
    assert.equal(store.data.block.kind, 'refused');
    assert.match(status(env.gladys).message.fr, /Pas de nouvel essai automatique/);
    assert.ok(!JSON.stringify(store.data).includes(CLIENT_SECRET));
    const tokens = cloud.of('token').length;
    await env.advance(7 * 24 * 60 * MIN);
    await env.app.stop();
    const again = await setup(t, { clock, cloud, store, read: false });
    await again.advance(24 * 60 * MIN);
    assert.equal(cloud.of('token').length, tokens);
  });
}

test('I4: the test button tries once, keeps the stop on failure, lifts it on success; other credentials lift it', async (t) => {
  const clock = fakeClock();
  const store = memoryStore();
  const cloud = fakeIgloo({ clock });
  cloud.clientSecret = 'another';
  const env = await setup(t, { clock, cloud, store });
  clock.advance(TIMINGS.backoff.at(-1) * 2);
  const answer = await env.app.testConnection();
  assert.match(answer.fr, /l'arrêt reste/);
  assert.ok(store.data.block);
  cloud.clientSecret = CLIENT_SECRET;
  clock.advance(TIMINGS.backoff.at(-1) * 2);
  await env.app.testConnection();
  assert.equal(store.data.block, null);
  assert.equal(status(env.gladys).connected, true);
  // Other credentials refused, then lifted by saving new ones.
  await env.gladys.fake.configUpdated({ ...BASE, client_secret: 'wrong' });
  await env.app.tick({ scheduled: true });
  assert.ok(store.data.block);
  await env.gladys.fake.configUpdated(BASE);
  assert.equal(store.data.block, null);
});

test('I4: Lock keeps its one try during a stop', async (t) => {
  const clock = fakeClock();
  const store = memoryStore();
  const cloud = fakeIgloo({ clock });
  const first = await setup(t, { clock, cloud, store });
  await createAll(first.gladys);
  const created = first.gladys.fake.devices;
  await first.app.stop();
  cloud.clientSecret = 'rotated';
  clock.advance(TIMINGS.backoff.at(-1) * 2);
  const env = await setup(t, { clock, cloud, store, devices: created });
  assert.ok(store.data.block);
  const tokens = cloud.of('token').length;
  const ack = await press(env.gladys, LOCK, 'lock');
  assert.match(ack.error, /non envoyée/);
  assert.equal(cloud.of('token').length, tokens + 1, 'one try');
  assert.ok(store.data.block, 'the stop unchanged');
});

test('I5: an API client without the unlock right works when unlocking is off', async (t) => {
  const clock = fakeClock();
  const cloud = fakeIgloo({ clock });
  cloud.granted.delete('igloohomeapi/unlock-bridge-proxied-job');
  const env = await setup(t, { clock, cloud });
  assert.equal(status(env.gladys).connected, true);
  await createAll(env.gladys);
  const ack = await press(env.gladys, LOCK, 'lock');
  assert.match(ack.error, /envoyée, sans confirmation/);
});

test('I5: unlocking allowed but the right missing: the rest works, unlocking refused, said in the status', async (t) => {
  const clock = fakeClock();
  const cloud = fakeIgloo({ clock });
  cloud.granted.delete('igloohomeapi/unlock-bridge-proxied-job');
  const env = await setup(t, { clock, cloud, ...UNLOCK });
  assert.equal(status(env.gladys).connected, true);
  assert.match(status(env.gladys).message.fr, /pas le droit de déverrouiller/);
  await createAll(env.gladys);
  const ack = await press(env.gladys, LOCK, 'unlock');
  assert.match(ack.error, /pas le droit de déverrouiller/);
  assert.equal(cloud.of('job').length, 0);
  assert.equal(env.store.data.block, null);
});

test('I5: turning unlocking on drops the token; the next one asks the unlock scope', async (t) => {
  const env = await setup(t);
  await createAll(env.gladys);
  await env.gladys.fake.configUpdated({ ...BASE, allow_unlock: true });
  await settle();
  assert.match(env.cloud.of('token').at(-1).scope, /unlock-bridge-proxied-job/);
  assert.equal(env.cloud.of('token').length, 2);
});

test('M1: new credentials saved during an unlock read: nothing sent', async (t) => {
  const env = await setup(t, UNLOCK);
  const { gladys, cloud } = env;
  await createAll(gladys);
  let release;
  cloud.gate.devices = new Promise((resolve) => {
    release = resolve;
  });
  const pending = press(gladys, LOCK, 'unlock');
  while (cloud.of('devices').length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  cloud.clientSecret = 'new-secret';
  const saved = gladys.fake.configUpdated({
    ...BASE,
    client_secret: 'new-secret',
    allow_unlock: true,
  });
  delete cloud.gate.devices;
  release();
  await saved;
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.equal(cloud.of('job').length, 0);
});

test('M1: the late answer of a job of older credentials writes no text and watches nothing', async (t) => {
  const env = await setup(t);
  const { gladys, cloud, app } = env;
  await createAll(gladys);
  let release;
  cloud.gate.job = new Promise((resolve) => {
    release = resolve;
  });
  const pending = press(gladys, LOCK, 'lock');
  while (cloud.of('job').length < 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const restarted = app.start({ ...BASE, client_secret: 'new-secret' });
  delete cloud.gate.job;
  release();
  await restarted;
  const ack = await pending;
  assert.match(ack.error, /envoyée, sans confirmation/);
  assert.equal(app.jobs.size, 0);
  assert.equal(app.lastTexts.size, 0);
});

test('M2: two locks of one bridge, two unlocks together: one job, the other refused', async (t) => {
  const clock = fakeClock();
  const cloud = fakeIgloo({ clock });
  cloud.devices.push({
    id: 'uuid-5',
    type: 'Lock',
    deviceId: 'IGM3second',
    deviceName: 'Back door',
    linkedDevices: [],
    batteryLevel: 90,
    lastSync: new Date(clock.now()).toISOString(),
  });
  cloud.devices[3].linkedDevices.push({ type: 'Lock', deviceId: 'IGM3second' });
  const env = await setup(t, { clock, cloud, ...UNLOCK });
  await createAll(env.gladys);
  const acks = await Promise.all([
    press(env.gladys, LOCK, 'unlock'),
    press(env.gladys, 'IGM3second', 'unlock'),
  ]);
  assert.equal(cloud.of('job').length, 1);
  assert.ok(acks.some((a) => /moins de 30 s/.test(a.error)));
});

test('M3: within 30 s of a job on its bridge, an unlock asks nothing', async (t) => {
  const env = await setup(t, UNLOCK);
  await createAll(env.gladys);
  await press(env.gladys, LOCK, 'lock');
  const calls = env.cloud.calls.length;
  for (let i = 0; i < 5; i += 1) {
    const ack = await press(env.gladys, LOCK, 'unlock');
    assert.match(ack.error, /moins de 30 s/);
  }
  assert.equal(env.cloud.calls.length, calls);
});

test('M4: the test button during a stop says so, not "next read"', async (t) => {
  const clock = fakeClock();
  const cloud = fakeIgloo({ clock });
  cloud.tokenError = 'invalid_scope';
  const env = await setup(t, { clock, cloud });
  clock.advance(5 * MIN);
  const answer = await env.app.testConnection();
  assert.match(
    answer.fr,
    /Arrêt : dernier essai il y a 5 min ; nouvel essai possible avec ce bouton/,
  );
});

test('M5: expires_in of 30 s is taken as is', () => {
  const now = 1_000_000;
  assert.equal(expiryOf({ expires_in: 30 }, 'opaque', now), now + 30_000);
  assert.equal(expiryOf({ expires_in: 10 ** 9 }, 'opaque', now), now + 86_400_000);
  assert.equal(expiryOf({}, 'opaque', now), now + 3_600_000);
});

test('M6: a 503 on the job status does not pause the account', async (t) => {
  const env = await setup(t, UNLOCK);
  await createAll(env.gladys);
  await press(env.gladys, LOCK, 'lock');
  env.cloud.httpStatus.status = 503;
  await env.advance(6_000);
  assert.equal(env.app.paused, false);
});

test('M7: a restart during the watch of a job resumes it', async (t) => {
  const clock = fakeClock();
  const store = memoryStore();
  const cloud = fakeIgloo({ clock });
  const first = await setup(t, { clock, cloud, store });
  await createAll(first.gladys);
  await press(first.gladys, LOCK, 'lock');
  const created = first.gladys.fake.devices;
  await first.app.stop();
  cloud.jobs.get(cloud.of('job')[0].jobId).completed = true;
  const second = await setup(t, { clock, cloud, store, devices: created, read: false });
  await second.advance(10_000);
  assert.match(lastText(second.gladys, LOCK), /Verrouillage : tâche traitée/);
});

test('M8: stop() waits for the writes of /data', async (t) => {
  const store = memoryStore();
  let flushed = false;
  store.flush = () =>
    new Promise((resolve) =>
      setImmediate(() => {
        flushed = true;
        resolve();
      }),
    );
  const env = await setup(t, { store });
  await env.app.stop();
  assert.equal(flushed, true);
});

test('M9: a client id changed while stopped: the new account is read at once', async (t) => {
  const clock = fakeClock();
  const store = memoryStore();
  const cloud = fakeIgloo({ clock });
  const first = await setup(t, { clock, cloud, store });
  await first.app.stop();
  clock.advance(10_000);
  cloud.clientId = 'other-client';
  const second = await setup(t, {
    clock,
    cloud,
    store,
    read: false,
    config: { client_id: 'other-client' },
  });
  const reads = cloud.of('devices').length;
  await second.advance(1);
  assert.equal(cloud.of('devices').length, reads + 1);
});

test('M10: a status about another job id is ignored', async (t) => {
  const env = await setup(t);
  await createAll(env.gladys);
  await press(env.gladys, LOCK, 'lock');
  env.cloud.wrongJobId = true;
  await env.advance(60_000);
  assert.doesNotMatch(lastText(env.gladys, LOCK), /traitée/);
});

test('M11: Lock on a lock without a bridge says so', async (t) => {
  const env = await setup(t);
  await createAll(env.gladys);
  const ack = await env.app
    .setValue(null, { external_id: `ext:igloohome:igloohome:${LOCK_NO_BRIDGE}:lock` }, 1)
    .catch((err) => err);
  assert.match(ack.message, /reliée à aucun bridge/);
});

test('M12: a failed configuration read at the start is asked again, spaced and bounded', async () => {
  const handlers = {};
  let fails = 10;
  const gladys = {
    onScanRequest() {},
    onDeviceCreated() {},
    onDeviceUpdated() {},
    onDeviceDeleted() {},
    onSetValue() {},
    onAction() {},
    onConfigUpdated() {},
    on(event, fn) {
      handlers[event] = fn;
    },
    getConfig: () =>
      fails-- > 0 ? Promise.reject(new Error('Gladys busy')) : Promise.resolve(BASE),
  };
  const started = [];
  const app = { connected: async (config) => started.push(config) };
  const delays = [];
  const pending = [];
  const timers = {
    setTimeout: (fn, ms) => {
      delays.push(ms);
      pending.push(fn);
      return delays.length;
    },
    clearTimeout() {},
  };
  registerHandlers(gladys, app, { error() {} }, timers);
  await handlers.connected();
  while (pending.length > 0) {
    await pending.shift()();
  }
  assert.deepEqual(delays, TIMINGS.configRetries, 'one try per delay, then none');
  assert.equal(started.length, 0, 'still failing: no loop');
  fails = 1;
  await handlers.connected();
  await pending.shift()();
  assert.deepEqual(started, [BASE]);
});

test('M13: Lock never waits behind an old token request of a read', async (t) => {
  const env = await setup(t);
  await createAll(env.gladys);
  const client = env.app.client;
  client.dropToken();
  client.pending = new Promise(() => {});
  client.pendingAt = env.clock.now() - 5_000;
  const tokens = env.cloud.of('token').length;
  const ack = await press(env.gladys, LOCK, 'lock');
  assert.match(ack.error, /envoyée, sans confirmation/);
  assert.equal(env.cloud.of('token').length, tokens + 1);
  assert.equal(env.cloud.of('job').at(-1).bridge, BRIDGE);
});

test('M13: the client joins a token request only within its first second', () => {
  const clock = fakeClock();
  const client = new IglooClient({ request: fakeIgloo({ clock }).request, now: clock.now });
  client.configure({ clientId: 'a', clientSecret: 'b' });
  const pending = Promise.resolve('x');
  client.pending = pending;
  client.pendingAt = clock.now();
  assert.equal(client.lockToken({ timeout: 100 }), pending);
  clock.advance(2_000);
  const own = client.lockToken({ timeout: 100 });
  assert.notEqual(own, pending);
  own.catch(() => {});
});
