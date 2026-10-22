// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The client
// secret is kept here and in the client only: never logged, never in /data
// (only the salted fingerprint of a pair igloohome REFUSED, see
// src/store.js), never in a status or an error.
// -----------------------------------------------------------------------------

import { POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  poll_interval: POLL_INTERVAL.default,
  allow_unlock: false,
  language: 'fr',
};

/** The fields without a default in the manifest (the secret is a secret). */
const OPTIONAL = { client_id: '', client_secret: '' };

/** Printable ASCII without spaces: what an OAuth client id or secret is made of. */
const CREDENTIAL = /^[\x21-\x7e]+$/;

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,6}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

const bounded = (value, { default: fallback, min, max }) => {
  const number = numberOf(value);
  return number === undefined ? fallback : Math.min(max, Math.max(min, Math.round(number)));
};

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG, ...OPTIONAL };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value != null) {
      c[key] = value;
    }
  }
  const clientId = typeof c.client_id === 'string' ? c.client_id.trim() : '';
  const clientSecret = typeof c.client_secret === 'string' ? c.client_secret.trim() : '';
  let badAuth;
  if (clientId === '' || clientSecret === '') {
    badAuth = 'missing';
  } else if (
    clientId.length > 128 ||
    clientSecret.length > 256 ||
    clientId.includes(':') ||
    !CREDENTIAL.test(clientId) ||
    !CREDENTIAL.test(clientSecret)
  ) {
    badAuth = 'invalid';
  }
  return {
    /** `{ clientId, clientSecret }`, or undefined (missing or unusable: said in the status). */
    auth: badAuth ? undefined : { clientId, clientSecret },
    badAuth,
    allowUnlock: strictTrue(c.allow_unlock),
    pollInterval: bounded(c.poll_interval, POLL_INTERVAL),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** What the credentials are (compared in memory only, never stored as is). */
export const credentialsKey = (config) =>
  JSON.stringify([config.auth?.clientId ?? '', config.auth?.clientSecret ?? '']);

/** The account: the client id only (its salted fingerprint ties /data to it). */
export const accountKey = (config) => config.auth?.clientId ?? '';
