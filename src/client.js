// -----------------------------------------------------------------------------
// The igloohome API client, ported from keithle888/igloohome-api (MIT): an
// OAuth2 "client credentials" token from auth.igloohome.co (the client id and
// secret of the iglooaccess portal, HTTP Basic), then Bearer requests to
// api.igloodeveloper.co: the device list, the bridge jobs (lock, unlock),
// the status of a job.
//
// The token is kept in memory only (never in /data, never logged); one token
// request at a time for the reads (a second caller joins it), a lock command
// joins it only when it left just now (else its own request, within its
// deadline). The scopes asked are the least: the unlock scope only while
// "Allow unlocking" is on; when the API client lacks it, the token is asked
// once more without it, and unlocking is said impossible (the rest works).
// The expiry comes from `expires_in` (else the `exp` of the JWT, else one
// hour), counted on our clock.
// -----------------------------------------------------------------------------

import { API, LIMITS, SECOND, TIMINGS } from './constants.js';
import { IglooError, httpsRequest } from './http.js';
import { parseDevices, parseJob, parseJobCreated } from './igloo.js';

const DAY = 86400 * SECOND;

/** Retry-After in seconds (0 to 1 day) -> ms; a date or anything else -> undefined. */
export function retryAfterOf(headers) {
  const value = headers?.['retry-after'];
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text === 'string' && /^\s*\d{1,5}\s*$/.test(text)) {
    const seconds = Number(text);
    return seconds <= 86400 ? seconds * SECOND : undefined;
  }
  return undefined;
}

function jsonOf(response) {
  try {
    return JSON.parse(response.body.toString('utf8'));
  } catch {
    throw new IglooError('invalid', { status: response.status, sent: true });
  }
}

/** The `exp` of a JWT (seconds) -> ms, or undefined. Never verified: only a hint. */
export function jwtExpiry(token) {
  const part = token.split('.')[1];
  if (!part || part.length > 4096) {
    return undefined;
  }
  try {
    const exp = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))?.exp;
    return Number.isFinite(exp) ? exp * SECOND : undefined;
  } catch {
    return undefined;
  }
}

/** The expiry of a token given at `now`: `expires_in` if finite and > 0, else `exp`, else 1 h. */
export function expiryOf(json, value, now) {
  const expiresIn = json?.expires_in;
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    return now + Math.min(expiresIn * SECOND, DAY);
  }
  const exp = jwtExpiry(value);
  if (exp !== undefined && exp > now) {
    return Math.min(exp, now + DAY);
  }
  return now + TIMINGS.tokenDefaultLifetime;
}

/**
 * igloohome's time from the Date header of an answer (ms), or undefined:
 * missing, not a date, or more than a day away from our clock (not trusted).
 */
export function serverTimeOf(headers, now) {
  const value = headers?.date;
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string' || text.length > 64) {
    return undefined;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) && Math.abs(ms - now) <= DAY ? ms : undefined;
}

/** An HTTP status of the API -> an IglooError (the answer reached igloohome). */
function apiError(response) {
  const { status } = response;
  if (status === 429 || status >= 500) {
    return new IglooError('busy', {
      status,
      sent: true,
      retryAfter: retryAfterOf(response.headers),
    });
  }
  const kind =
    status === 401
      ? 'unauthorized'
      : status === 403
        ? 'forbidden'
        : status === 404
          ? 'notFound'
          : 'http';
  return new IglooError(kind, { status, sent: true });
}

export class IglooClient {
  constructor({ request = httpsRequest, now = Date.now } = {}) {
    this.request = request;
    this.now = now;
    this.configure(undefined);
  }

  /** New credentials (or none): the token of the previous ones is dropped. */
  configure(credentials, { unlock = false } = {}) {
    this.credentials = credentials;
    this.unlock = unlock;
    /** The API client was refused the unlock scope (asked again after a reset). */
    this.unlockDenied = false;
    this.dropToken();
  }

  /** "Allow unlocking" changed (or a new try of its scope): the token goes. */
  setUnlock(unlock) {
    if (unlock !== this.unlock || this.unlockDenied) {
      this.unlock = unlock;
      this.unlockDenied = false;
      this.dropToken();
    }
  }

  /** The scopes to ask now. */
  get scope() {
    const scopes = [...API.scopes];
    if (this.canUnlock) {
      scopes.push(API.unlockScope);
    }
    return scopes.join(' ');
  }

  /** Whether the token is asked (and given) with the unlock scope. */
  get canUnlock() {
    return this.unlock && !this.unlockDenied;
  }

  /** Whether the token stays valid `ms` more. */
  tokenValidFor(ms) {
    return Boolean(this.token) && this.token.expiresAt - this.now() >= ms;
  }

  /** When the timer should renew the token, or undefined without one. */
  get renewAt() {
    return this.token ? this.token.expiresAt - TIMINGS.tokenMargin : undefined;
  }

  dropToken() {
    this.token = undefined;
    this.tokenAt = undefined;
    this.pending = undefined;
    this.pendingAt = undefined;
  }

  /**
   * A valid token: the current one when it stays valid `validity` more, else
   * a new one (one request at a time: a caller during it joins it).
   */
  async validToken({ validity = TIMINGS.commandTokenValidity, ...options } = {}) {
    if (this.tokenValidFor(validity)) {
      return this.token.value;
    }
    return this.fetchToken(options);
  }

  fetchToken(options = {}) {
    if (!this.pending) {
      const pending = this.requestToken(this.credentials, options).finally(() => {
        if (this.pending === pending) {
          this.pending = undefined;
          this.pendingAt = undefined;
        }
      });
      this.pending = pending;
      this.pendingAt = this.now();
    }
    return this.pending;
  }

  /**
   * The token of a lock command: the request under way only when it left
   * less than a second ago (an older one may hang); else its own, bounded by
   * the command's deadline.
   */
  lockToken(options) {
    if (this.pending && this.now() - this.pendingAt < TIMINGS.tokenJoinWindow) {
      return this.pending;
    }
    return this.requestToken(this.credentials, options);
  }

  async requestToken(credentials, options = {}) {
    const scope = this.scope;
    try {
      return await this.askToken(credentials, scope, options);
    } catch (err) {
      if (
        err.kind === 'scope' &&
        scope.includes(API.unlockScope) &&
        credentials === this.credentials &&
        this.canUnlock
      ) {
        // The API client lacks the unlock scope: once more without it.
        this.unlockDenied = true;
        return this.askToken(credentials, this.scope, options);
      }
      throw err;
    }
  }

  async askToken(credentials, scope, { timeout = TIMINGS.readTimeout, sendWithin } = {}) {
    if (!credentials) {
      throw new IglooError('auth');
    }
    // As igloohome-api (aiohttp BasicAuth): the id and the secret as typed
    // (src/config.js refuses a colon in the id and control characters).
    const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString(
      'base64',
    );
    const body = new URLSearchParams({ grant_type: 'client_credentials', scope }).toString();
    const response = await this.request({
      method: 'POST',
      url: API.tokenUrl,
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      timeout,
      sendWithin,
      maxBytes: LIMITS.tokenBytes,
    });
    if (response.status === 429 || response.status >= 500) {
      throw apiError(response);
    }
    if (response.status !== 200) {
      // Any other refusal of the token endpoint is final (lesson of lot 12):
      // a scope missing, or the credentials (whatever the code: 400, 401, 403).
      let code;
      try {
        code = JSON.parse(response.body.toString('utf8'))?.error;
      } catch {
        code = undefined;
      }
      if (code === 'invalid_scope' || code === 'unauthorized_client') {
        throw new IglooError('scope', { status: response.status, sent: true });
      }
      throw new IglooError('auth', { status: response.status, sent: true });
    }
    const json = jsonOf(response);
    const value = json?.access_token;
    if (typeof value !== 'string' || value.length === 0 || value.length > 8192) {
      throw new IglooError('invalid', { status: 200, sent: true });
    }
    const now = this.now();
    // Kept only for the credentials and the scope it was asked with (they may have changed).
    if (credentials === this.credentials && scope === this.scope) {
      this.token = { value, expiresAt: expiryOf(json, value, now) };
      /** When the current token was given (a refusal right after it means a scope). */
      this.tokenAt = now;
    }
    return value;
  }

  /** One Bearer request -> its JSON; a 401 drops the token (the next call asks a new one). */
  async api(method, path, token, options = {}) {
    return jsonOf(await this.call(method, path, token, options));
  }

  async call(method, path, token, { body, timeout, sendWithin, beforeSend } = {}) {
    const response = await this.request({
      method,
      url: `${API.baseUrl}${path}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body,
      timeout,
      sendWithin,
      beforeSend,
      maxBytes: LIMITS.responseBytes,
    });
    if (response.status !== 200) {
      if (response.status === 401 && this.token?.value === token) {
        this.dropToken();
      }
      throw apiError(response);
    }
    return response;
  }

  /** `GET /devices` (the token asked first if needed). */
  async devices({ timeout = TIMINGS.readTimeout } = {}) {
    const token = await this.validToken({ validity: TIMINGS.commandTokenValidity, timeout });
    const json = await this.api('GET', '/devices', token, { timeout });
    try {
      return parseDevices(json);
    } catch {
      throw new IglooError('invalid', { status: 200, sent: true });
    }
  }

  /** `POST /devices/{id}/jobs/bridges/{bridge}` -> the jobId. */
  async createJob(token, deviceId, bridgeId, jobType, options) {
    const json = await this.api(
      'POST',
      `/devices/${encodeURIComponent(deviceId)}/jobs/bridges/${encodeURIComponent(bridgeId)}`,
      token,
      { ...options, body: JSON.stringify({ jobType, jobData: null }) },
    );
    try {
      return parseJobCreated(json);
    } catch {
      throw new IglooError('invalid', { status: 200, sent: true });
    }
  }

  /**
   * `GET /jobs/{id}` -> `{ id, completed, expiry?, responseKeys, serverNow? }`,
   * `serverNow` being igloohome's time (the Date header of the answer).
   */
  async job(token, jobId, { timeout }) {
    const response = await this.call('GET', `/jobs/${encodeURIComponent(jobId)}`, token, {
      timeout,
    });
    const json = jsonOf(response);
    let job;
    try {
      job = parseJob(json);
    } catch {
      throw new IglooError('invalid', { status: 200, sent: true });
    }
    const serverNow = serverTimeOf(response.headers, this.now());
    return serverNow === undefined ? job : { ...job, serverNow };
  }
}
