// -----------------------------------------------------------------------------
// IglooApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a fake igloohome cloud behind the client's `request`, a
// fake clock and a memory store. No network; the timers are recorded with
// their due time and fired only by `advance()`.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { IglooApp } from '../../src/app.js';
import { IglooClient } from '../../src/client.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { CLIENT_ID, CLIENT_SECRET, fakeClock, fakeIgloo } from './fakeIgloo.js';

export const SELECTOR = 'igloohome';
export const id = (device, key) => `ext:${SELECTOR}:igloohome:${device}${key ? `:${key}` : ''}`;
export const BASE = { client_id: CLIENT_ID, client_secret: CLIENT_SECRET };

export const settle = async () => {
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

export async function setup(
  t,
  {
    config = {},
    clock = fakeClock(),
    cloud = fakeIgloo({ clock }),
    store = memoryStore(),
    devices = [],
    read = true,
    getConfig,
  } = {},
) {
  const gladys = createFakeGladys({ selector: SELECTOR, config: { ...BASE, ...config }, devices });
  if (getConfig) {
    const original = gladys.getConfig.bind(gladys);
    gladys.getConfig = () => getConfig(original);
  }
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
      timeouts.push({ fn, ms, at: clock.now(), due: clock.now() + ms });
      return timeouts.length;
    },
    clearTimeout: (handle) => {
      if (timeouts[handle - 1]) {
        timeouts[handle - 1].cleared = true;
      }
    },
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
  registerHandlers(gladys, app, logger, timers);
  await gladys.connect();
  if (read) {
    await app.tick({ scheduled: true });
  }
  t.after(() => app.stop());
  const env = { gladys, app, cloud, logs, store, clock, timeouts };
  /** Moves the clock by `ms`, firing the timers due meanwhile, in order. */
  env.advance = async (ms) => {
    const end = clock.now() + ms;
    for (let guard = 0; guard < 500; guard += 1) {
      const next = timeouts
        .filter((e) => !e.fired && !e.cleared && e.due <= end)
        .sort((a, b) => a.due - b.due)[0];
      if (!next) {
        break;
      }
      next.fired = true;
      if (next.due > clock.now()) {
        clock.t = next.due;
      }
      next.fn();
      await settle();
      await app.running;
    }
    if (clock.now() < end) {
      clock.t = end;
    }
    await app.publisher.flush();
  };
  return env;
}

export async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

export const deviceOf = (gladys, device) =>
  gladys.fake.devices.find((d) => d.external_id === id(device)) ??
  gladys.fake.discoveredDevices.find((d) => d.external_id === id(device));
export const featureOf = (device, key) =>
  device.features.find((f) => f.external_id.endsWith(`:${key}`));

export async function press(gladys, device, key, value = 1) {
  const d = deviceOf(gladys, device);
  return gladys.fake.setValue(d, featureOf(d, key), value);
}

export const status = (gladys) => gladys.fake.connectionStatus;
export const lastText = (gladys, device) => gladys.fake.lastState(id(device, 'last_command'));
