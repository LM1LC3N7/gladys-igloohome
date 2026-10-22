// -----------------------------------------------------------------------------
// IglooApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a fake igloohome cloud behind the client's `request`, a
// fake clock and a memory store. No network; the timers are recorded, never
// fired by themselves.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { IglooApp } from '../src/app.js';
import { IglooClient } from '../src/client.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  BRIDGE,
  CLIENT_ID,
  CLIENT_SECRET,
  KEYPAD,
  LOCK,
  LOCK_NO_BRIDGE,
  fakeClock,
  fakeIgloo,
} from './helpers/fakeIgloo.js';

const SELECTOR = 'igloohome';
const id = (device, key) => `ext:${SELECTOR}:igloohome:${device}${key ? `:${key}` : ''}`;
const BASE = { client_id: CLIENT_ID, client_secret: CLIENT_SECRET };

async function setup(
  t,
  {
    config = {},
    clock = fakeClock(),
    cloud = fakeIgloo({ clock }),
    store = memoryStore(),
    devices = [],
    read = true,
  } = {},
) {
  const gladys = createFakeGladys({ selector: SELECTOR, config: { ...BASE, ...config }, devices });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const timeouts = [];
  const timers = {
    setTimeout: (fn, ms) => {
      timeouts.push({ fn, ms, at: clock.now() });
      return timeouts.length;
    },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  };
  const app = new IglooApp({
    gladys,
    logger,
    client: new IglooClient({ request: cloud.request, now: clock.now }),
    store,
    now: clock.now,
    timers,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  if (read) {
    await app.tick({ scheduled: true });
  }
  t.after(() => app.stop());
  return { gladys, app, cloud, logs, store, clock, timeouts };
}

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

const deviceOf = (gladys, device) =>
  gladys.fake.devices.find((d) => d.external_id === id(device)) ??
  gladys.fake.discoveredDevices.find((d) => d.external_id === id(device));
const featureOf = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));

async function press(gladys, device, key, value = 1) {
  const d = deviceOf(gladys, device);
  return gladys.fake.setValue(d, featureOf(d, key), value);
}

const status = (gladys) => gladys.fake.connectionStatus;

/** Runs the recorded timers whose delay is one of `delays` (job status reads). */
async function fireJobReads(timeouts, clock, app) {
  for (const delay of TIMINGS.jobFollowUps) {
    const entry = timeouts.find((e) => e.ms === delay && !e.fired);
    if (entry) {
      entry.fired = true;
      clock.advance(delay);
      entry.fn();
      await new Promise((resolve) => setImmediate(resolve));
      await app.publisher.flush();
    }
  }
}

test('the devices of the account become the devices of the Discovery tab (bridges left out)', async (t) => {
  const { gladys, cloud } = await setup(t);
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.name, d.external_id]),
    [
      ['Front door', id(LOCK)],
      ['Padlock', id(LOCK_NO_BRIDGE)],
      ['Keypad', id(KEYPAD)],
    ],
  );
  const keys = (device) =>
    deviceOf(gladys, device).features.map((f) => f.external_id.split(':').at(-1));
  assert.deepEqual(keys(LOCK), ['battery', 'sync_age', 'lock', 'unlock', 'last_command']);
  assert.deepEqual(keys(LOCK_NO_BRIDGE), ['battery', 'sync_age'], 'no bridge: no button');
  for (const feature of deviceOf(gladys, LOCK).features) {
    assert.notEqual(feature.category, 'switch');
    if (!feature.read_only) {
      assert.deepEqual([feature.category, feature.type], ['button', 'push']);
    }
  }
  assert.equal(status(gladys).connected, true);
  assert.match(status(gladys).message.fr, /3 appareil\(s\), 1 serrure\(s\)/);
  assert.match(status(gladys).message.fr, /Déverrouillage désactivé/);
  // Only the scopes the integration needs.
  assert.equal(
    cloud.of('token')[0].scope,
    'igloohomeapi/get-devices igloohomeapi/lock-bridge-proxied-job igloohomeapi/unlock-bridge-proxied-job igloohomeapi/get-job-status',
  );
});

test('states and badges: only for the created devices', async (t) => {
  const { gladys, app } = await setup(t);
  await app.publisher.flush();
  assert.equal(gladys.fake.states.length, 0);
  await createAll(gladys);
  await app.publisher.flush();
  assert.equal(gladys.fake.lastState(id(LOCK, 'battery')), 80);
  assert.equal(gladys.fake.lastState(id(LOCK, 'sync_age')), 3);
  assert.equal(gladys.fake.lastState(id(LOCK_NO_BRIDGE, 'sync_age')), 30);
  const badge = gladys.fake.transports.filter((e) => e.device_external_id === id(LOCK)).at(-1);
  assert.equal(badge.transport, 'cloud');
});

test('unlocking is refused by default: nothing read, nothing sent', async (t) => {
  const { gladys, cloud } = await setup(t);
  await createAll(gladys);
  const calls = cloud.calls.length;
  const ack = await press(gladys, LOCK, 'unlock');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Autoriser le déverrouillage/);
  assert.equal(cloud.calls.length, calls);
});

test('a value other than 1 is refused; a read-only feature too', async (t) => {
  const { gladys, cloud } = await setup(t, { config: { allow_unlock: true } });
  await createAll(gladys);
  const calls = cloud.calls.length;
  for (const value of [0, '', null, '0', 2]) {
    const ack = await press(gladys, LOCK, 'unlock', value);
    assert.equal(ack.success, false, String(value));
  }
  const ack = await press(gladys, LOCK, 'battery', 1);
  assert.equal(ack.success, false);
  assert.equal(cloud.calls.length, calls);
});

test('unlock once allowed: a fresh read, one job through the bridge, "sent, without confirmation", a guard, then the job status', async (t) => {
  const { gladys, app, cloud, clock, timeouts, store } = await setup(t, {
    config: { allow_unlock: true },
  });
  await createAll(gladys);
  const reads = cloud.of('devices').length;
  const ack = await press(gladys, LOCK, 'unlock');
  assert.equal(ack.success, false);
  assert.match(ack.error, /envoyée, sans confirmation/);
  assert.equal(cloud.of('devices').length, reads + 1, 'read just before');
  const [job] = cloud.of('job');
  assert.deepEqual([job.jobType, job.device, job.bridge], [2, LOCK, BRIDGE]);
  assert.equal(store.data.guards.length, 1, 'the guard is kept in /data');
  await app.publisher.flush();
  assert.match(gladys.fake.lastState(id(LOCK, 'last_command')), /en attente/);

  // A second unlock while the first may still run: refused, nothing sent.
  clock.advance(TIMINGS.bridgeSpacing);
  const again = await press(gladys, LOCK, 'unlock');
  assert.match(again.error, /attend encore son bridge/);
  assert.equal(cloud.of('job').length, 1);

  // The bridge runs it: the status read back ends the guard.
  cloud.jobs.get(job.jobId).completed = true;
  await fireJobReads(timeouts, clock, app);
  assert.match(gladys.fake.lastState(id(LOCK, 'last_command')), /tâche terminée/);
  assert.equal(store.data.guards.length, 0);
});

test('a job completed at once is confirmed in the ack', async (t) => {
  const { gladys, cloud } = await setup(t, { config: { allow_unlock: true } });
  cloud.completeAtOnce = true;
  await createAll(gladys);
  const ack = await press(gladys, LOCK, 'unlock');
  assert.equal(ack.success, true, ack.error);
  assert.equal(cloud.of('status').length, 1);
});

test('a job never completed: "not confirmed" when it expires, the guard lifted', async (t) => {
  const { gladys, app, clock, timeouts, store } = await setup(t, {
    config: { allow_unlock: true },
  });
  await createAll(gladys);
  await press(gladys, LOCK, 'unlock');
  await fireJobReads(timeouts, clock, app);
  assert.match(gladys.fake.lastState(id(LOCK, 'last_command')), /non confirmé, la tâche a expiré/);
  assert.equal(store.data.guards.length, 0);
});

test('unlock: the option turned off during the read stops it before sending', async (t) => {
  const { gladys, app, cloud } = await setup(t, { config: { allow_unlock: true } });
  await createAll(gladys);
  cloud.onSent = (call) => {
    if (call.kind === 'devices') {
      app.config = { ...app.config, allowUnlock: false };
    }
  };
  const ack = await press(gladys, LOCK, 'unlock');
  assert.match(ack.error, /désactivé/);
  assert.equal(cloud.of('job').length, 0);
});

test('unlock: a slow fresh read is refused unsent within 3.5 s', async (t) => {
  const { gladys, cloud } = await setup(t, { config: { allow_unlock: true } });
  await createAll(gladys);
  cloud.delays.devices = { connect: 100, answer: 3500 };
  const ack = await press(gladys, LOCK, 'unlock');
  assert.match(ack.error, /rien n'a été envoyé/);
  assert.equal(cloud.of('job').length, 0);
});

test('unlock: a job request that may have arrived is never "not sent"; the guard stays', async (t) => {
  const { gladys, cloud, store } = await setup(t, { config: { allow_unlock: true } });
  await createAll(gladys);
  cloud.failure.job = 'silent';
  const ack = await press(gladys, LOCK, 'unlock');
  assert.match(ack.error, /envoyée, sans confirmation \(timeout\)/);
  assert.equal(store.data.guards.length, 1);
});

test('unlock: a refusal answered by igloohome sends nothing and lifts the guard', async (t) => {
  const { gladys, cloud, store } = await setup(t, { config: { allow_unlock: true } });
  await createAll(gladys);
  cloud.httpStatus.job = 400;
  const ack = await press(gladys, LOCK, 'unlock');
  assert.match(ack.error, /igloohome a refusé la commande \(http \(HTTP 400\)\)/);
  assert.equal(store.data.guards.length, 0);
});

test('unlock: a lock no longer linked or listed is refused after the fresh read', async (t) => {
  const { gladys, cloud } = await setup(t, { config: { allow_unlock: true } });
  await createAll(gladys);
  cloud.devices[3].linkedDevices = [];
  let ack = await press(gladys, LOCK, 'unlock');
  assert.match(ack.error, /reliée à aucun bridge/);
  cloud.devices.shift();
  ack = await press(gladys, LOCK, 'unlock');
  assert.match(ack.error, /ne liste plus cet appareil/);
  assert.equal(cloud.of('job').length, 0);
});

test('lock: no read, never blocked by a 429 pause (one try), never behind an unlock', async (t) => {
  const { gladys, app, cloud, clock } = await setup(t, { config: { allow_unlock: true } });
  await createAll(gladys);
  cloud.httpStatus.devices = 429;
  cloud.headers = { 'retry-after': '600' };
  clock.advance(TIMINGS.backoff[0] * 20);
  await app.tick({ scheduled: true });
  assert.equal(app.paused, true);
  delete cloud.httpStatus.devices;
  const unlock = await press(gladys, LOCK, 'unlock');
  assert.match(unlock.error, /demandé d'attendre/);
  const reads = cloud.of('devices').length;
  const ack = await press(gladys, LOCK, 'lock');
  assert.match(ack.error, /envoyée, sans confirmation/);
  assert.equal(cloud.of('devices').length, reads, 'no read before locking');
  assert.equal(cloud.of('job').at(-1).jobType, 1);
});

test('lock cancels an unlock waiting in the queue of that lock', async (t) => {
  const { gladys, cloud } = await setup(t, { config: { allow_unlock: true } });
  await createAll(gladys);
  // The unlock's fresh read is held; a second unlock waits behind it; a lock arrives.
  let release;
  cloud.gate.devices = new Promise((resolve) => {
    release = resolve;
  });
  const first = press(gladys, LOCK, 'unlock');
  const second = press(gladys, LOCK, 'unlock');
  while (cloud.of('devices').length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const lockAck = await press(gladys, LOCK, 'lock');
  assert.match(lockAck.error, /envoyée, sans confirmation/, 'never behind the unlocks');
  delete cloud.gate.devices;
  release();
  const [ack1, ack2] = await Promise.all([first, second]);
  assert.match(ack1.error, /Annulée par une commande de verrouillage/);
  assert.match(ack2.error, /Annulée par une commande de verrouillage/);
  assert.deepEqual(
    cloud.of('job').map((j) => j.jobType),
    [1],
    'only the lock job left',
  );
});

test('lock works after a restart before the first read (the bridge kept in /data)', async (t) => {
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
  // Restarted within the interval: no read.
  await second.app.tick();
  assert.equal(cloud.of('devices').length, reads);
  const ack = await press(second.gladys, LOCK, 'lock');
  assert.match(ack.error, /envoyée, sans confirmation/);
  assert.equal(cloud.of('job').at(-1).bridge, BRIDGE);
});

test('the guard of an unlock survives a restart', async (t) => {
  const clock = fakeClock();
  const store = memoryStore();
  const cloud = fakeIgloo({ clock });
  const first = await setup(t, { clock, cloud, store, config: { allow_unlock: true } });
  await createAll(first.gladys);
  await press(first.gladys, LOCK, 'unlock');
  const created = first.gladys.fake.devices;
  await first.app.stop();
  clock.advance(TIMINGS.bridgeSpacing);
  const second = await setup(t, {
    clock,
    cloud,
    store,
    devices: created,
    read: false,
    config: { allow_unlock: true },
  });
  const ack = await press(second.gladys, LOCK, 'unlock');
  assert.match(ack.error, /attend encore son bridge/);
  assert.equal(cloud.of('job').length, 1);
});

test('refused credentials: a stop kept in /data, spaced tries, lifted by other credentials only', async (t) => {
  const clock = fakeClock();
  const store = memoryStore();
  const cloud = fakeIgloo({ clock });
  cloud.clientSecret = 'another';
  const { gladys, app, timeouts } = await setup(t, { clock, cloud, store });
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /refusé l'identifiant ou le secret client/);
  assert.equal(store.data.block.kind, 'refused');
  assert.ok(!JSON.stringify(store.data).includes(CLIENT_SECRET), 'no secret in /data');
  const next = timeouts.at(-1);
  assert.ok(next.ms >= TIMINGS.authRetries[0] - 1000, 'next try in 1 h');
  // The test button tries once; still refused: the stop stays.
  clock.advance(TIMINGS.authRetries[0] / 2);
  const answer = await app.testConnection();
  assert.match(answer.fr, /l'arrêt reste/);
  assert.equal(store.data.block.failures, 2);
  // Other credentials lift it.
  cloud.clientSecret = 'new-secret';
  await gladys.fake.configUpdated({ ...BASE, client_secret: 'new-secret' });
  // The read at once of new credentials (the timer set by the start).
  assert.equal(timeouts.at(-1).ms, 0);
  await app.tick({ scheduled: true });
  assert.equal(store.data.block, null);
  assert.equal(status(gladys).connected, true);
});

test('a missing scope is a final stop: no automatic try', async (t) => {
  const cloud = fakeIgloo();
  cloud.tokenError = 'invalid_scope';
  const { gladys, app, store } = await setup(t, { cloud });
  assert.equal(store.data.block.kind, 'scope');
  assert.match(status(gladys).message.fr, /pas de nouvel essai automatique/i);
  assert.equal(app.timer, undefined);
});

test('429 on the read: a pause kept in /data, never read sooner', async (t) => {
  const clock = fakeClock();
  const store = memoryStore();
  const cloud = fakeIgloo({ clock });
  cloud.httpStatus.devices = 503;
  const { gladys, app } = await setup(t, { clock, cloud, store });
  assert.ok(store.data.pause.until > clock.now());
  assert.match(status(gladys).message.fr, /HTTP 429 ou 5xx/);
  const reads = cloud.of('devices').length;
  await app.tick({ scheduled: true });
  await app.testConnection();
  assert.equal(cloud.of('devices').length, reads);
});

test('reads never sooner than the interval: test button, scan, reconnection', async (t) => {
  const { gladys, app, cloud } = await setup(t);
  const reads = cloud.of('devices').length;
  const answer = await app.testConnection();
  assert.match(answer.fr, /moins d'un intervalle/);
  await gladys.fake.scanRequest();
  await app.connected(BASE);
  await app.configUpdated(BASE);
  assert.equal(cloud.of('devices').length, reads);
});

test('a reconnection to Gladys sends the status and the Discovery list again', async (t) => {
  const { gladys, app } = await setup(t);
  const statuses = gladys.fake.connectionStatuses.length;
  const discovered = gladys.fake.requests.length;
  await app.connected(BASE);
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.ok(gladys.fake.requests.length > discovered);
});

test('the attempt time is written to /data before the read', async (t) => {
  const clock = fakeClock();
  const store = memoryStore();
  const cloud = fakeIgloo({ clock });
  let kept;
  cloud.onSent = (call) => {
    if (call.kind === 'devices' && kept === undefined) {
      kept = store.data?.lastAttemptAt;
    }
  };
  await setup(t, { clock, cloud, store });
  assert.ok(kept > 0);
});

test('a read of older credentials publishes nothing', async (t) => {
  const { gladys, app, cloud } = await setup(t, { read: false });
  cloud.onSent = (call) => {
    if (call.kind === 'devices') {
      app.stop();
    }
  };
  await app.tick({ scheduled: true });
  assert.equal(gladys.fake.discoveredDevices.length, 0);
});

test('two unlocks on the same bridge within 30 s: the second is refused', async (t) => {
  const { gladys, cloud } = await setup(t, { config: { allow_unlock: true } });
  await createAll(gladys);
  cloud.httpStatus.job = 400;
  await press(gladys, LOCK, 'unlock');
  delete cloud.httpStatus.job;
  const ack = await press(gladys, LOCK, 'unlock');
  assert.match(ack.error, /moins de 30 s/);
});

test('the secret and the token never reach the logs, the statuses or /data', async (t) => {
  const { gladys, logs, store } = await setup(t, { config: { allow_unlock: true } });
  await createAll(gladys);
  await press(gladys, LOCK, 'unlock');
  const everything = JSON.stringify([logs, gladys.fake.connectionStatuses, store.data]);
  assert.ok(!everything.includes(CLIENT_SECRET));
  assert.ok(!everything.includes('token-1'));
});

test('no credentials: a status that says so, nothing asked', async (t) => {
  const { gladys, cloud } = await setup(t, { config: { client_secret: '' } });
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /Saisissez l'identifiant client/);
  assert.equal(cloud.calls.length, 0);
});

test('a republished device keeps a feature it no longer gives', async (t) => {
  const { gladys, app, cloud, clock } = await setup(t);
  await createAll(gladys);
  cloud.devices[3].linkedDevices = [];
  clock.advance(TIMINGS.backoff.at(-1) * 100);
  await app.tick({ scheduled: true });
  const lock = gladys.fake.discoveredDevices.find((d) => d.external_id === id(LOCK));
  assert.deepEqual(
    lock.features.map((f) => f.external_id.split(':').at(-1)),
    ['battery', 'sync_age', 'lock', 'unlock', 'last_command'],
  );
});
