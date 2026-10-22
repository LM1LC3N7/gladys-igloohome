// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS, TIMINGS } from './constants.js';

export function registerHandlers(gladys, app, logger, timers = globalThis) {
  // Discovery: the devices of the last read, sent again (never a read).
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // Commands (buttons only).
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Configuration screen button.
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());

  // Configuration saved by the user.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Connection lifecycle (also after every reconnection to Gladys): the
  // status and the Discovery tab are published again, without a new read.
  // A failed configuration read is asked again, spaced and bounded (5 s,
  // 30 s, 2 min, 10 min): never an integration left unstarted, never a loop.
  let retry;
  const connect = async (attempt) => {
    try {
      await app.connected(await gladys.getConfig());
    } catch (err) {
      logger?.error('Start failed', err?.message ?? 'error');
      const delay = TIMINGS.configRetries[attempt];
      if (delay !== undefined) {
        retry = timers.setTimeout(() => {
          retry = undefined;
          connect(attempt + 1);
        }, delay);
      }
    }
  };
  gladys.on('connected', () => {
    if (retry) {
      timers.clearTimeout(retry);
      retry = undefined;
    }
    return connect(0);
  });
}
