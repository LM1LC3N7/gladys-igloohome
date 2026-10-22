// -----------------------------------------------------------------------------
// IglooApp end to end against the fake Gladys and the fake igloohome cloud
// (test/helpers/setup.js): Discovery, states, commands and their safety
// rules, stops, pauses, reads never sooner than the interval.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMINGS } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import {
  BRIDGE,
  CLIENT_SECRET,
  KEYPAD,
  LOCK,
  LOCK_NO_BRIDGE,
  fakeClock,
  fakeIgloo,
} from './helpers/fakeIgloo.js';
import { BASE, createAll, deviceOf, id, lastText, press, setup, status } from './helpers/setup.js';

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
  // Only the scopes the integration needs; the unlock one only when allowed.
  assert.equal(
    cloud.of('token')[0].scope,
    'igloohomeapi/get-devices igloohomeapi/lock-bridge-proxied-job igloohomeapi/get-job-status',
  );
});

test('with unlocking allowed, the token asks the unlock scope too', async (t) => {
  const { cloud } = await setup(t, { config: { allow_unlock: true } });
  assert.match(cloud.of('token')[0].scope, /igloohomeapi\/unlock-bridge-proxied-job/);
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

test('unlock once allowed: a fresh read, one job, "sent, without confirmation", a guard, then "processed (result not read)"', async (t) => {
  const env = await setup(t, { config: { allow_unlock: true } });
  const { gladys, cloud, store } = env;
  await createAll(gladys);
  const reads = cloud.of('devices').length;
  const ack = await press(gladys, LOCK, 'unlock');
  assert.equal(ack.success, false);
  assert.match(ack.error, /envoyée, sans confirmation/);
  assert.equal(cloud.of('devices').length, reads + 1, 'read just before');
  const [job] = cloud.of('job');
  assert.deepEqual([job.jobType, job.device, job.bridge], [2, LOCK, BRIDGE]);
  assert.equal(store.data.guards.length, 1, 'the guard is kept in /data');
  assert.equal(store.data.jobs.length, 1, 'the job watched is kept in /data');
  await env.app.publisher.flush();
  assert.match(lastText(gladys, LOCK), /accepté par igloohome, en attente du bridge/);

  // A second unlock while the first may still run: refused, nothing sent.
  await env.advance(TIMINGS.bridgeSpacing);
  const again = await press(gladys, LOCK, 'unlock');
  assert.match(again.error, /attend encore son bridge/);
  assert.equal(cloud.of('job').length, 1);

  // The bridge processes it: never "done", the guard lifted.
  cloud.jobs.get(job.jobId).completed = true;
  await env.advance(60_000);
  assert.match(lastText(gladys, LOCK), /traitée par le bridge \(résultat non lu/);
  assert.equal(store.data.guards.length, 0);
  assert.equal(store.data.jobs.length, 0);
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
  const env = await setup(t, { config: { allow_unlock: true } });
  const { gladys, app, cloud, clock } = env;
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
  await second.app.tick();
  assert.equal(cloud.of('devices').length, reads, 'restarted within the interval: no read');
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
