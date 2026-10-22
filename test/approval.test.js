// -----------------------------------------------------------------------------
// The points of approval round 1 (R1 to R4), each checked on the corrected
// behaviour.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverTimeOf } from '../src/client.js';
import { memoryStore } from '../src/store.js';
import { LOCK, fakeClock, fakeIgloo } from './helpers/fakeIgloo.js';
import { createAll, id, lastText, press, setup, status } from './helpers/setup.js';

const MIN = 60_000;
const UNLOCK = { config: { allow_unlock: true } };

test('R1: Gladys 3 min ahead of igloohome: never "expired" while igloohome\'s Date is before the expiry', async (t) => {
  const clock = fakeClock();
  const cloud = fakeIgloo({ clock });
  cloud.serverOffset = -3 * MIN;
  const env = await setup(t, { clock, cloud, ...UNLOCK });
  await createAll(env.gladys);
  await press(env.gladys, LOCK, 'unlock');
  await env.advance(100_000);
  assert.doesNotMatch(lastText(env.gladys, LOCK), /expiré/);
  assert.equal(env.store.data.guards.length, 1, 'the guard holds');
  const again = await press(env.gladys, LOCK, 'unlock');
  assert.match(again.error, /attend encore son bridge/);
  assert.equal(cloud.of('job').length, 1);
  // Once igloohome's own time is past the expiry date: expired.
  await env.advance(60_000);
  assert.match(lastText(env.gladys, LOCK), /igloohome indique que la tâche a expiré/);
});

test('R1: without a readable Date header, never "expired": "result unknown" at 15 min', async (t) => {
  const clock = fakeClock();
  const cloud = fakeIgloo({ clock });
  cloud.noDate = true;
  const env = await setup(t, { clock, cloud, ...UNLOCK });
  await createAll(env.gladys);
  await press(env.gladys, LOCK, 'unlock');
  await env.advance(5 * MIN);
  assert.doesNotMatch(lastText(env.gladys, LOCK), /expiré/);
  assert.equal(env.store.data.guards.length, 1);
  await env.advance(11 * MIN);
  assert.match(lastText(env.gladys, LOCK), /résultat inconnu/);
});

test('R1: serverTimeOf reads the Date header, bounded', () => {
  const now = Date.parse('2026-10-22T10:00:00Z');
  assert.equal(serverTimeOf({ date: 'Thu, 22 Oct 2026 10:01:00 GMT' }, now), now + MIN);
  assert.equal(serverTimeOf({ date: 'nonsense' }, now), undefined);
  assert.equal(serverTimeOf({ date: 'Thu, 29 Oct 2026 10:00:00 GMT' }, now), undefined);
  assert.equal(serverTimeOf({}, now), undefined);
  assert.equal(serverTimeOf({ date: 'x'.repeat(100) }, now), undefined);
});

test('R2: unlock then Lock 2 s later, both processed before the reads: the final text keeps the alert', async (t) => {
  const env = await setup(t, UNLOCK);
  const { gladys, cloud } = env;
  await createAll(gladys);
  await press(gladys, LOCK, 'unlock');
  await env.advance(2_000);
  await press(gladys, LOCK, 'lock');
  for (const job of cloud.jobs.values()) {
    job.completed = true;
  }
  await env.advance(60_000);
  const text = lastText(gladys, LOCK);
  assert.match(text, /Verrouillage : tâche traitée/);
  assert.match(text, /un déverrouillage envoyé avant le verrouillage a aussi été traité/);
});

test('R2: the same with a restart between the two reads (the link kept in /data)', async (t) => {
  const clock = fakeClock();
  const store = memoryStore();
  const cloud = fakeIgloo({ clock });
  const first = await setup(t, { clock, cloud, store, ...UNLOCK });
  await createAll(first.gladys);
  await press(first.gladys, LOCK, 'unlock');
  await first.advance(2_000);
  await press(first.gladys, LOCK, 'lock');
  const [unlockJob, lockJob] = cloud.of('job');
  cloud.jobs.get(unlockJob.jobId).completed = true;
  await first.advance(4_000);
  assert.deepEqual(store.data.alerts, [LOCK], 'the alert in /data');
  const created = first.gladys.fake.devices;
  await first.app.stop();
  cloud.jobs.get(lockJob.jobId).completed = true;
  const second = await setup(t, { clock, cloud, store, devices: created, read: false, ...UNLOCK });
  await second.advance(30_000);
  const text = lastText(second.gladys, LOCK);
  assert.match(text, /Verrouillage : tâche traitée/);
  assert.match(text, /a aussi été traité/);
});

test('R2: an unlock watched when a lock leaves is marked in /data before its end', async (t) => {
  const env = await setup(t, UNLOCK);
  await createAll(env.gladys);
  await press(env.gladys, LOCK, 'unlock');
  await env.advance(2_000);
  await press(env.gladys, LOCK, 'lock');
  const unlock = env.store.data.jobs.find((j) => j.action === 'unlock');
  assert.equal(unlock.beforeLock, true);
});

test('R3: a restart after a failed read is not restored as connected', async (t) => {
  const clock = fakeClock();
  const store = memoryStore();
  const cloud = fakeIgloo({ clock });
  const first = await setup(t, { clock, cloud, store });
  await createAll(first.gladys);
  const created = first.gladys.fake.devices;
  cloud.failure.devices = 'silent';
  await first.advance(16 * MIN);
  assert.equal(status(first.gladys).connected, false);
  await first.app.stop();
  clock.advance(10_000);
  const second = await setup(t, { clock, cloud, store, devices: created, read: false });
  assert.equal(status(second.gladys).connected, false);
  assert.match(status(second.gladys).message.fr, /avant un redémarrage a échoué/);
  assert.equal(second.gladys.fake.discoveredDevices.length, 3, 'Discovery from the summary');
  const badge = second.gladys.fake.transports.filter((e) => e.device_external_id === id(LOCK));
  assert.equal(badge.at(-1)?.transport, 'unreachable');
});

test('R4: a restart more than 15 min after a command: "result unknown", never left waiting', async (t) => {
  const clock = fakeClock();
  const store = memoryStore();
  const cloud = fakeIgloo({ clock });
  const first = await setup(t, { clock, cloud, store });
  await createAll(first.gladys);
  await press(first.gladys, LOCK, 'lock');
  const created = first.gladys.fake.devices;
  await first.app.stop();
  clock.advance(20 * MIN);
  const second = await setup(t, { clock, cloud, store, devices: created, read: false });
  await second.app.publisher.flush();
  assert.match(
    lastText(second.gladys, LOCK),
    /Verrouillage : envoyé, sans confirmation \(résultat inconnu/,
  );
  assert.equal(second.app.jobs.size, 0);
  assert.equal(store.data.jobsOver, undefined, 'not written back');
});
