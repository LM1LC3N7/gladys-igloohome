// -----------------------------------------------------------------------------
// A fake igloohome cloud behind the client's `request`: the OAuth2 token
// endpoint (client credentials in HTTP Basic), `GET /devices`, the bridge
// jobs and their status, as igloohome-api reads them. A clock the tests
// drive: connecting and answering take the time they say.
// -----------------------------------------------------------------------------

import { API } from '../../src/constants.js';
import { IglooError } from '../../src/http.js';

export const CLIENT_ID = 'client-id-1';
export const CLIENT_SECRET = 'S3cr3t-Value-x9';
export const LOCK = 'IGM3abc123';
export const LOCK_NO_BRIDGE = 'IGP2def456';
export const KEYPAD = 'IGK1ghi789';
export const BRIDGE = 'IGB4bridge01';

export function fakeClock(start = 1_800_000_000_000) {
  const clock = { t: start };
  clock.now = () => clock.t;
  clock.advance = (ms) => {
    clock.t += ms;
  };
  return clock;
}

const json = (status, value, headers = {}) => ({
  status,
  headers,
  body: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'),
});

export function fakeIgloo({ clock = fakeClock() } = {}) {
  const cloud = {
    clock,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    expiresIn: 3600,
    devices: [
      {
        id: 'uuid-1',
        type: 'Lock',
        deviceId: LOCK,
        deviceName: 'Front door',
        pairedAt: '2026-01-01T00:00:00.000Z',
        homeId: [],
        linkedDevices: [],
        batteryLevel: 80,
        lastSync: new Date(clock.now() - 3 * 3600_000).toISOString(),
      },
      {
        id: 'uuid-2',
        type: 'Lock',
        deviceId: LOCK_NO_BRIDGE,
        deviceName: 'Padlock',
        pairedAt: '2026-01-01T00:00:00.000Z',
        homeId: [],
        linkedDevices: [],
        batteryLevel: 55,
        lastSync: new Date(clock.now() - 30 * 3600_000).toISOString(),
      },
      {
        id: 'uuid-3',
        type: 'Keypad',
        deviceId: KEYPAD,
        deviceName: 'Keypad',
        pairedAt: '2026-01-01T00:00:00.000Z',
        homeId: [],
        linkedDevices: [],
        batteryLevel: 40,
        lastSync: new Date(clock.now() - 3600_000).toISOString(),
      },
      {
        id: 'uuid-4',
        type: 'Bridge',
        deviceId: BRIDGE,
        deviceName: 'Bridge',
        pairedAt: '2026-01-01T00:00:00.000Z',
        homeId: [],
        linkedDevices: [{ type: 'Lock', deviceId: LOCK }],
        batteryLevel: null,
        lastSync: new Date(clock.now()).toISOString(),
      },
    ],
    nextCursor: '',
    /** Every request: { kind: 'token'|'devices'|'job'|'status', ... }. */
    calls: [],
    /** jobId -> { type, device, bridge, completed, expiry } */
    jobs: new Map(),
    /** A job is completed at its creation. */
    completeAtOnce: false,
    /** ms to connect, ms to answer, per kind (default for all). */
    connectDelay: 10,
    answerDelay: 10,
    delays: {},
    /** 'down' (no connection), 'silent' (connected, no answer), per kind or for all. */
    failure: {},
    /** An HTTP status to answer instead, per kind: { devices: 429 }, and its headers. */
    httpStatus: {},
    headers: {},
    /** An OAuth error code of the token endpoint ('invalid_client', 'invalid_scope'). */
    tokenError: undefined,
    /** Called once a request has left (beforeSend passed): (call) => void. */
    onSent: undefined,
    /** A promise per kind: the answer waits for it. */
    gate: {},
    issued: new Set(),
  };
  let tokens = 0;
  let jobs = 0;

  const kindOf = (method, url) => {
    if (url === API.tokenUrl) return 'token';
    const path = url.slice(API.baseUrl.length);
    if (method === 'GET' && path === '/devices') return 'devices';
    if (method === 'POST' && /^\/devices\/[^/]+\/jobs\/bridges\/[^/]+$/.test(path)) return 'job';
    if (method === 'GET' && /^\/jobs\/[^/]+$/.test(path)) return 'status';
    return 'other';
  };

  cloud.request = async ({ method, url, headers, body, timeout, sendWithin, beforeSend }) => {
    const kind = kindOf(method, url);
    const call = { kind, method, url, headers, body };
    const delay = cloud.delays[kind] ?? {};
    const connectDelay = delay.connect ?? cloud.connectDelay;
    const answerDelay = delay.answer ?? cloud.answerDelay;
    const failure = cloud.failure[kind] ?? cloud.failure.all;
    if (failure === 'down') {
      clock.advance(connectDelay);
      cloud.calls.push({ ...call, failed: true });
      throw new IglooError('unreachable');
    }
    clock.advance(connectDelay);
    if (sendWithin !== undefined && connectDelay > sendWithin) {
      throw new IglooError('late');
    }
    if (beforeSend) {
      try {
        beforeSend();
      } catch (err) {
        err.beforeSend = true;
        err.sent = false;
        throw err;
      }
    }
    cloud.calls.push(call);
    cloud.onSent?.(call);
    if (cloud.gate[kind]) {
      // Held until the test releases it (the answer arrives later).
      await cloud.gate[kind];
    }
    if (connectDelay + answerDelay > timeout) {
      clock.advance(Math.max(0, timeout - connectDelay));
      throw new IglooError('timeout', { sent: true });
    }
    clock.advance(answerDelay);
    if (failure === 'silent') {
      throw new IglooError('timeout', { sent: true });
    }
    if (cloud.httpStatus[kind]) {
      return json(cloud.httpStatus[kind], '', cloud.headers);
    }
    if (kind === 'token') {
      const expected = `Basic ${Buffer.from(`${cloud.clientId}:${cloud.clientSecret}`).toString('base64')}`;
      call.scope = new URLSearchParams(body).get('scope');
      if (cloud.tokenError) {
        return json(400, { error: cloud.tokenError });
      }
      if (headers.authorization !== expected) {
        return json(400, { error: 'invalid_client' });
      }
      tokens += 1;
      const token = `token-${tokens}`;
      cloud.issued.add(token);
      return json(200, { access_token: token, expires_in: cloud.expiresIn, token_type: 'Bearer' });
    }
    const token = headers.authorization?.replace(/^Bearer /, '');
    if (!cloud.issued.has(token)) {
      return json(401, { message: 'Unauthorized' });
    }
    if (kind === 'devices') {
      return json(200, { nextCursor: cloud.nextCursor, payload: cloud.devices });
    }
    if (kind === 'job') {
      const [, device, bridge] = /\/devices\/([^/]+)\/jobs\/bridges\/([^/]+)$/.exec(url);
      const payload = JSON.parse(body);
      jobs += 1;
      const jobId = `job-${jobs}`;
      call.jobType = payload.jobType;
      call.device = device;
      call.bridge = bridge;
      call.jobId = jobId;
      cloud.jobs.set(jobId, {
        type: payload.jobType,
        device,
        bridge,
        completed: cloud.completeAtOnce,
        expiry: new Date(clock.now() + 120_000).toISOString(),
      });
      return json(200, { jobId });
    }
    if (kind === 'status') {
      const jobId = url.split('/').at(-1);
      const job = cloud.jobs.get(jobId);
      if (!job) {
        return json(404, { message: 'not found' });
      }
      return json(200, {
        jobId,
        expiryDate: job.expiry,
        completed: job.completed,
        jobType: String(job.type),
        jobResponse: {},
      });
    }
    return json(404, {});
  };

  cloud.of = (kind) => cloud.calls.filter((c) => c.kind === kind);
  return cloud;
}
