// -----------------------------------------------------------------------------
// The answers of the igloohome API -> plain values (pure). Ported from
// keithle888/igloohome-api (MIT, the library of Home Assistant): the fields
// of `GET /devices` and `GET /jobs/{id}`, the bridge a lock is linked to
// (Home Assistant `get_linked_bridge`).
//
// Linear in the size of the answer (already capped by src/http.js), bounded
// in count, and safe against hostile keys: only known fields are read, with
// Object.hasOwn, into fresh objects and Maps (no prototype pollution).
// -----------------------------------------------------------------------------

import { DEVICE_TYPES, LIMITS } from './constants.js';

/** An igloohome deviceId (or jobId): letters, digits, `-` and `_`, 1 to 64 characters. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const field = (object, key) =>
  object && typeof object === 'object' && Object.hasOwn(object, key) ? object[key] : undefined;

/** A text from igloohome shown in Gladys: no control characters, trimmed, cut. */
export function cleanText(value, max) {
  if (typeof value !== 'string') {
    return '';
  }
  let out = '';
  for (const char of value.slice(0, max * 2)) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
      out += char;
    }
  }
  return out.trim().slice(0, max);
}

const idOf = (value) => (typeof value === 'string' && ID_PATTERN.test(value) ? value : undefined);

/** A battery level: an integer 0..100, else undefined (null, '', 101, 1.5 are not levels). */
export function batteryOf(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : undefined;
}

/** An ISO date of igloohome -> ms, or undefined. */
export function dateOf(value) {
  if (typeof value !== 'string' || value.length > 40) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * `GET /devices` -> `{ devices: Map<deviceId, device>, more }`.
 * A device: `{ id, type, name, battery?, lastSync?, bridge? }`; `bridge` is
 * the deviceId of the first bridge whose `linkedDevices` holds it. `more`:
 * igloohome gave a `nextCursor` (a further page, not read: said in the status).
 * Throws on an answer that is not a device list.
 */
export function parseDevices(json) {
  const payload = field(json, 'payload');
  if (!Array.isArray(payload)) {
    throw new TypeError('not a device list');
  }
  const devices = new Map();
  /** linked deviceId -> bridge deviceId */
  const bridgeOf = new Map();
  for (const entry of payload.slice(0, LIMITS.devices)) {
    const id = idOf(field(entry, 'deviceId'));
    const type = field(entry, 'type');
    if (!id || typeof type !== 'string' || devices.has(id)) {
      continue;
    }
    const device = {
      id,
      type: cleanText(type, 20),
      name: cleanText(field(entry, 'deviceName'), LIMITS.name),
    };
    const battery = batteryOf(field(entry, 'batteryLevel'));
    if (battery !== undefined) {
      device.battery = battery;
    }
    const lastSync = dateOf(field(entry, 'lastSync'));
    if (lastSync !== undefined) {
      device.lastSync = lastSync;
    }
    devices.set(id, device);
    if (type === DEVICE_TYPES.BRIDGE) {
      const linked = field(entry, 'linkedDevices');
      for (const link of Array.isArray(linked) ? linked.slice(0, LIMITS.linked) : []) {
        const linkedId = idOf(field(link, 'deviceId'));
        if (linkedId && !bridgeOf.has(linkedId)) {
          bridgeOf.set(linkedId, id);
        }
      }
    }
  }
  for (const device of devices.values()) {
    const bridge = bridgeOf.get(device.id);
    if (bridge && device.type !== DEVICE_TYPES.BRIDGE) {
      device.bridge = bridge;
    }
  }
  const cursor = field(json, 'nextCursor');
  return { devices, more: typeof cursor === 'string' && cursor !== '' };
}

/** `POST .../jobs/bridges/{bridge}` -> the jobId. Throws without one. */
export function parseJobCreated(json) {
  const id = idOf(field(json, 'jobId'));
  if (!id) {
    throw new TypeError('no job id');
  }
  return id;
}

/** `GET /jobs/{id}` -> `{ id, completed, expiry? }`. Throws without the fields. */
export function parseJob(json) {
  const id = idOf(field(json, 'jobId'));
  const completed = field(json, 'completed');
  if (!id || typeof completed !== 'boolean') {
    throw new TypeError('not a job');
  }
  const expiry = dateOf(field(json, 'expiryDate'));
  return expiry === undefined ? { id, completed } : { id, completed, expiry };
}

/** The devices Gladys shows: every device but the bridges. */
export const isShown = (device) => device.type !== DEVICE_TYPES.BRIDGE;

/** A lock the bridge can command (Home Assistant: a `Lock` with a linked bridge). */
export const isCommandable = (device) =>
  device.type === DEVICE_TYPES.LOCK && Boolean(device.bridge);
