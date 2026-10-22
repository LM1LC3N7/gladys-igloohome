// -----------------------------------------------------------------------------
// Fixed values: manifest keys (frozen: users store them in their scenes and
// configuration), the Gladys core value enums the SDK does not export, the
// values of the igloohome API, limits and timings.
// -----------------------------------------------------------------------------

/** The external id type: `gladys.externalIds('igloohome', '<deviceId>')`. Frozen. */
export const EXTERNAL_ID_TYPE = 'igloohome';

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};

/** Feature keys of a device. Frozen. */
export const FEATURES = {
  BATTERY: 'battery',
  SYNC_AGE: 'sync_age',
  LOCK: 'lock',
  UNLOCK: 'unlock',
  LAST_COMMAND: 'last_command',
};

/** The keys a user can press. */
export const COMMAND_KEYS = [FEATURES.LOCK, FEATURES.UNLOCK];

// Gladys core enums (server/utils/constants.js), not exported by the SDK.
export const BUTTON_PUSH = { PRESSED: 1 };

/** The igloohome cloud (igloohome-api, the library Home Assistant uses). */
export const API = {
  tokenUrl: 'https://auth.igloohome.co/oauth2/token',
  baseUrl: 'https://api.igloodeveloper.co/igloohome',
  /**
   * Only the scopes this integration uses (igloohome-api asks for every
   * scope, PIN creation included: not needed here, so not asked).
   */
  scope: [
    'igloohomeapi/get-devices',
    'igloohomeapi/lock-bridge-proxied-job',
    'igloohomeapi/unlock-bridge-proxied-job',
    'igloohomeapi/get-job-status',
  ].join(' '),
};

/** Device types of `GET /devices` (igloohome-api DEVICE_TYPE_*). */
export const DEVICE_TYPES = { BRIDGE: 'Bridge', LOCK: 'Lock', KEYPAD: 'Keypad' };

/** Bridge job types (igloohome-api BRIDGE_JOB_*). */
export const JOB_TYPES = { LOCK: 1, UNLOCK: 2 };

export const LIMITS = {
  /** Gladys accepts 300 states per minute: keep a margin. */
  statesPerMinute: 250,
  /** Body of an answer (a device list of an account is a few KB). */
  responseBytes: 256 * 1024,
  /** Body of a token answer. */
  tokenBytes: 16 * 1024,
  /** Devices read from one answer, at most. */
  devices: 300,
  /** Linked devices of one bridge, at most. */
  linked: 100,
  /** Texts from igloohome shown in Gladys (device names). */
  name: 60,
  /** The last-command text. */
  text: 200,
  /** Ids: deviceId, jobId. */
  id: 64,
};

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One read of the device list, one token request outside a command. */
  readTimeout: 15 * SECOND,
  /** The pending states are sent at this pace. */
  flushInterval: SECOND,
  /** The battery of a device is spaced by this much. */
  measureInterval: MINUTE,
  /** An unchanged value is re-sent this often, so it stays recently dated in Gladys. */
  stateHeartbeat: 30 * MINUTE,
  /**
   * A command leaves within this many ms of its arrival, or is refused
   * unsent: Gladys gives up waiting for the ack after 5 s.
   */
  commandSendBy: 3500,
  /** The ack is given by then: past it, "sent, without confirmation". */
  commandAnswerBy: 4300,
  /** The fresh read of an unlock leaves at least this much for the job request. */
  commandSendMargin: 400,
  /** An unlock uses the token only when it stays valid this long (no renewal in the 3.5 s). */
  commandTokenValidity: MINUTE,
  /** The token is renewed this long before it expires, by a timer of its own. */
  tokenMargin: 5 * MINUTE,
  /** Token lifetime when igloohome gives none (and no readable `exp`). */
  tokenDefaultLifetime: HOUR,
  /** At most one renewal by the timer per this much (a short token never loops). */
  renewRetry: MINUTE,
  /**
   * A bridge job runs for 2 minutes at most (igloohome support); the guard of
   * an unlock holds that long plus a margin, unless its job ends sooner.
   */
  jobLifetime: 2 * MINUTE,
  guardMargin: 30 * SECOND,
  /** The bridge takes about 2 jobs a minute (igloohome support): an unlock waits this long. */
  bridgeSpacing: 30 * SECOND,
  /** Reads of the job status after a command (none during a pause). */
  jobFollowUps: [5 * SECOND, 15 * SECOND, 30 * SECOND, 60 * SECOND, 100 * SECOND, 140 * SECOND],
  /** One status read of the job inside the ack, only if this much time is left. */
  ackStatusMin: 500,
  /** Transient failures: the next reads, never sooner than the interval. */
  backoff: [MINUTE, 2 * MINUTE, 5 * MINUTE, 15 * MINUTE],
  /** Credentials refused: the next tries, then every 24 h. */
  authRetries: [HOUR, 6 * HOUR, 24 * HOUR],
  /** HTTP 429 or 5xx: a pause within these bounds. */
  pauseMin: MINUTE,
  pauseMax: 6 * HOUR,
  /** The time of the last read is written to /data at most this often. */
  attemptPersistEvery: MINUTE,
};

/** Configuration bounds (mirrored by the manifest), in seconds. */
export const POLL_INTERVAL = { default: 900, min: 300, max: 86400 };
