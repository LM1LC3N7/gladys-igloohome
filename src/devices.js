// -----------------------------------------------------------------------------
// The igloohome devices -> Gladys devices and states (pure).
//
// One Gladys device per lock, padlock, key box or keypad of the account (the
// bridges are not shown): `gladys.externalIds('igloohome', '<deviceId>')`,
// the deviceId being the id igloohome gives the device (the one Home
// Assistant keys it on), never its name. Feature keys are frozen:
//
//   battery       battery / integer, %, read only (when igloohome gives it)
//   sync_age      duration / integer, hours since the last sync, read only
//   lock, unlock  button / push, only on a lock linked to a bridge
//   last_command  text / text, read only: the last command and its result
//
// igloohome gives no locked/unlocked state (Home Assistant shows an assumed
// one): none is invented here. A lock is never a `switch` nor a commandable
// `binary`: a "turn everything off/on" (voice assistants, HomeKit, scenes on
// switches) must never reach it.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { EXTERNAL_ID_TYPE, FEATURES, HOUR } from './constants.js';
import { FEATURE_NAMES, word } from './i18n.js';
import { ID_PATTERN, isCommandable } from './igloo.js';

/** The external ids of one device. */
export const deviceIds = (gladys, deviceId) => gladys.externalIds(EXTERNAL_ID_TYPE, deviceId);

const KEYS = new Set(Object.values(FEATURES));

/**
 * `{ deviceId, key? }` of one of our device or feature external ids, checked
 * against the ids the SDK builds; undefined otherwise.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) {
    return undefined;
  }
  const feature = /:([A-Za-z0-9_-]{1,64}):([a-z_]{1,20})$/.exec(externalId);
  if (
    feature &&
    KEYS.has(feature[2]) &&
    deviceIds(gladys, feature[1]).feature(feature[2]) === externalId
  ) {
    return { deviceId: feature[1], key: feature[2] };
  }
  const device = /:([A-Za-z0-9_-]{1,64})$/.exec(externalId);
  if (device && ID_PATTERN.test(device[1]) && deviceIds(gladys, device[1]).device === externalId) {
    return { deviceId: device[1] };
  }
  return undefined;
}

const sensor = (category, type, min, max, unit) => ({
  category,
  type,
  min,
  max,
  ...(unit ? { unit } : {}),
  read_only: true,
  has_feedback: false,
  keep_history: true,
});
const button = () => ({
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
});
const text = () => ({
  category: C.TEXT,
  type: T.TEXT.TEXT,
  min: 0,
  max: 0,
  read_only: true,
  has_feedback: false,
  keep_history: true,
});

/** The features of a device: `[{ key, spec, name, measure? }]`, in a stable order. */
export function featuresOf(device) {
  const out = [];
  if (device.battery !== undefined) {
    out.push({
      key: FEATURES.BATTERY,
      spec: sensor(C.BATTERY, T.BATTERY.INTEGER, 0, 100, U.PERCENT),
      name: FEATURE_NAMES.battery,
      measure: true,
    });
  }
  if (device.lastSync !== undefined) {
    out.push({
      key: FEATURES.SYNC_AGE,
      spec: sensor(C.DURATION, T.DURATION.INTEGER, 0, 100000, U.HOURS),
      name: FEATURE_NAMES.syncAge,
      measure: true,
    });
  }
  if (isCommandable(device)) {
    out.push(
      { key: FEATURES.LOCK, spec: button(), name: FEATURE_NAMES.lock },
      { key: FEATURES.UNLOCK, spec: button(), name: FEATURE_NAMES.unlock },
      { key: FEATURES.LAST_COMMAND, spec: text(), name: FEATURE_NAMES.lastCommand },
    );
  }
  return out;
}

export const deviceName = (device) => (device.name || `igloohome ${device.id}`).slice(0, 100);

/** The Gladys device of an igloohome device. */
export function buildDevice(gladys, device, { language }) {
  const ids = deviceIds(gladys, device.id);
  const features = featuresOf(device).map(({ key, spec, name }) => ({
    name: word(name, language).slice(0, 100),
    external_id: ids.feature(key),
    ...spec,
  }));
  const params = [
    { name: 'DEVICE_ID', value: device.id },
    { name: 'TYPE', value: device.type },
    { name: 'BRIDGE', value: device.bridge ?? '' },
  ].filter((param) => param.value !== '');
  return {
    name: deviceName(device),
    external_id: ids.device,
    features,
    params,
    should_poll: false,
  };
}

/** `[{ key, value }]` of a device read: only defined, finite values. */
export function valuesOf(device, now) {
  const out = [];
  if (Number.isInteger(device.battery)) {
    out.push({ key: FEATURES.BATTERY, value: device.battery });
  }
  if (Number.isFinite(device.lastSync)) {
    // A sync dated in the future (a clock ahead) counts as now.
    out.push({
      key: FEATURES.SYNC_AGE,
      value: Math.min(100000, Math.max(0, Math.floor((now - device.lastSync) / HOUR))),
    });
  }
  return out;
}
