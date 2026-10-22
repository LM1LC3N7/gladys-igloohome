// -----------------------------------------------------------------------------
// The igloohome API client, ported from keithle888/igloohome-api (MIT): an
// OAuth2 "client credentials" token from auth.igloohome.co (the client id and
// secret of the iglooaccess portal, HTTP Basic), then Bearer requests to
// api.igloodeveloper.co: the device list, the bridge jobs (lock, unlock),
// the status of a job.
//
// The token is kept in memory only (never in /data, never logged); one token
// request at a time (a second caller joins it); the app renews it ahead of
// its expiry by a timer, so a command never waits for it. igloohome-api asks
// a new token whenever the JWT cannot be decoded; here the expiry comes from
// `expires_in` (else the `exp` of the JWT, else one hour), counted on our
// clock.
// -----------------------------------------------------------------------------

import { API, LIMITS, SECOND, TIMINGS } from './constants.js';
import { IglooError, httpsRequest } from './http.js';
import { parseDevices, parseJob, parseJobCreated } from './igloo.js';

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
    this.credentials = undefined;
    /** { value, expiresAt } or undefined: memory only. */
    this.token = undefined;
    this.pending = undefined;
  }

  /** New credentials (or none): the token of the previous ones is dropped. */
  configure(credentials) {
    this.credentials = credentials;
    this.token = undefined;
    this.tokenAt = undefined;
    this.pending = undefined;
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
        }
      });
      this.pending = pending;
    }
    return this.pending;
  }

  async requestToken(credentials, { timeout = TIMINGS.readTimeout, sendWithin } = {}) {
    if (!credentials) {
      throw new IglooError('auth');
    }
    // As igloohome-api (aiohttp BasicAuth): the id and the secret as typed
    // (src/config.js refuses a colon in the id and control characters).
    const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString(
      'base64',
    );
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: API.scope,
    }).toString();
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
      // OAuth2 errors (RFC 6749 5.2): only the code is read, never shown as is.
      let code;
      try {
        code = JSON.parse(response.body.toString('utf8'))?.error;
      } catch {
        code = undefined;
      }
      if (code === 'invalid_scope' || code === 'unauthorized_client') {
        throw new IglooError('scope', { status: response.status, sent: true });
      }
      if (code === 'invalid_client' || response.status === 401) {
        throw new IglooError('auth', { status: response.status, sent: true });
      }
      throw new IglooError('http', { status: response.status, sent: true });
    }
    const json = jsonOf(response);
    const value = json?.access_token;
    if (typeof value !== 'string' || value.length === 0 || value.length > 8192) {
      throw new IglooError('invalid', { status: 200, sent: true });
    }
    const now = this.now();
    const expiresIn = json.expires_in;
    let expiresAt;
    if (Number.isFinite(expiresIn) && expiresIn >= 60 && expiresIn <= 86400) {
      expiresAt = now + expiresIn * SECOND;
    } else {
      const exp = jwtExpiry(value);
      expiresAt =
        exp !== undefined && exp > now + 60 * SECOND && exp <= now + 86400 * SECOND
          ? exp
          : now + TIMINGS.tokenDefaultLifetime;
    }
    // Only for the credentials it was asked with (they may have changed meanwhile).
    if (credentials === this.credentials) {
      this.token = { value, expiresAt };
      /** When the current token was given (a refusal right after it means a scope). */
      this.tokenAt = now;
    }
    return value;
  }

  /** One Bearer request; a 401 drops the token (the next call asks a new one). */
  async api(method, path, token, { body, timeout, sendWithin, beforeSend } = {}) {
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
    return jsonOf(response);
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

  /** `GET /jobs/{id}` -> `{ id, completed, expiry? }`. */
  async job(token, jobId, { timeout }) {
    const json = await this.api('GET', `/jobs/${encodeURIComponent(jobId)}`, token, { timeout });
    try {
      return parseJob(json);
    } catch {
      throw new IglooError('invalid', { status: 200, sent: true });
    }
  }
}
