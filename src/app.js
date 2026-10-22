// -----------------------------------------------------------------------------
// The integration: the igloohome account of an iglooaccess API client (client
// id and secret), one read of its device list every poll interval, one Gladys
// device per lock, padlock, key box or keypad, the transport badges, the
// "Test the connection" button, and the two commands of a lock linked to a
// bridge (lock, unlock). index.js only wires the SDK handlers to it.
//
// igloohome commands a lock only through its bridge, as a "job" the bridge
// runs later; it gives no locked/unlocked state, and what a "completed" job
// means (succeeded, or only processed) is not known yet. So:
//   - a lock is never a switch: two buttons, and a read-only text of the last
//     command and what igloohome says of its job;
//   - a command is never answered "done": a job accepted is "sent, without
//     confirmation"; every job is watched until igloohome says it was
//     processed, or a read made after its expiry date says it was not, or
//     15 min (then "result unknown"); an unlock processed after a later lock
//     raises an alert in the last-command text;
//   - unlocking is refused unless "Allow unlocking" is on (and only then is
//     its scope asked), checked on arrival, after the fresh read and right
//     before the request leaves (beforeSend); it is decided on the device
//     list read just now (the lock still listed as a lock of the account,
//     linked to a bridge), never on memory; one unlock at a time per lock,
//     none while an unlock job of that lock is watched (a guard kept in
//     /data), none within 30 s of another job on the same bridge (checked
//     before the read and again in beforeSend);
//   - locking (protective) never waits behind the unlocks (no queue, no
//     read), goes through a 429/5xx pause or a stop (one try), works before
//     the first read after a restart (the bridge of each lock is kept in
//     /data), and cancels at once every unlock of that lock not sent yet,
//     even when it is refused itself (a job igloohome accepted cannot be
//     cancelled);
//   - sent within 3.5 s of the click or refused unsent; answered by 4.3 s; a
//     request that may have reached igloohome is never answered "not sent";
//     never retried;
//   - the ack never waits for a publication to Gladys.
//
// Reads: never sooner than the interval (the test button, a scan, a
// reconnection, a configuration saved unchanged, a restart: the time of the
// last read is written to /data before it); one read at a time; a read or an
// answer of older credentials publishes nothing (generation checked after
// every await). After a restart, the last successful read kept in /data
// gives the status, the Discovery tab and the badges until the next read
// (its values are never republished as new).
// Failures: any refusal of the token endpoint but 429/5xx -> a final stop
// persisted (credentials refused, or a scope missing; lifted by other
// credentials or a success of the test button, never by itself); 429/5xx ->
// a pause of 1 min to 6 h persisted; anything else -> a new try never sooner
// than the interval. A reconnection to Gladys clears none of them.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { IglooClient } from './client.js';
import { accountKey, credentialsKey, normalizeConfig } from './config.js';
import {
  COMMAND_KEYS,
  DEVICE_TYPES,
  FEATURES,
  GUARD_MAX,
  JOB_TYPES,
  SECOND,
  TIMINGS,
} from './constants.js';
import { buildDevice, deviceIds, featuresOf, parseExternalId, valuesOf } from './devices.js';
import { reasonOf } from './http.js';
import { ERRORS, LAST, T, age, join, word } from './i18n.js';
import { isCommandable, isShown } from './igloo.js';
import { StatePublisher } from './publisher.js';
import { fileStore, fingerprintOf, normalizeMemory } from './store.js';

/** The fields kept from a feature created in Gladys, when it is published again as it is. */
const KEPT_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'min',
  'max',
  'unit',
  'read_only',
  'has_feedback',
  'keep_history',
];

/** Command errors where igloohome answered a refusal: nothing was done. */
const ANSWERED = new Set(['http', 'unauthorized', 'forbidden', 'notFound']);

export class IglooApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'igloohome' }),
    client = new IglooClient(),
    store = fileStore(),
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.client = client;
    this.store = store;
    this.now = now;
    this.timers = timers;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.credKey = undefined;
    this.memory = undefined;
    this.generation = 0;
    this.started = false;
    this.resetRead();
    /** When the device list was last asked by this process (exact). */
    this.lastAttemptAt = -Infinity;
    this.timer = undefined;
    this.renewTimer = undefined;
    this.lastRenewAt = -Infinity;
    this.running = undefined;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badges = undefined;
    /** lock -> bridge: from the last read, or /data before it. */
    this.bridges = new Map();
    /** lock -> tail of its queue of unlocks (locking never waits here). */
    this.queues = new Map();
    /** lock -> tickets of the unlocks not sent yet (a lock command cancels them). */
    this.tickets = new Map();
    /** lock -> { until, jobId? }: after an unlock that may have left. */
    this.guards = new Map();
    /** bridge -> when its last job left. */
    this.bridgeJobs = new Map();
    /** jobId -> { id, lock, action, sentAt, expiry?, reads, timer? }: the jobs watched. */
    this.jobs = new Map();
    /** lock -> the jobId of its latest command (only it writes the last-command text). */
    this.latestJob = new Map();
    /** lock -> when its last lock job left (an unlock processed before it raises an alert). */
    this.lastLockSentAt = new Map();
    /** lock -> { en, fr }: the last-command text. */
    this.lastTexts = new Map();
  }

  resetRead() {
    /** The last device list read: Map deviceId -> device, or undefined. */
    this.devices = undefined;
    this.more = false;
    this.readAt = undefined;
    /** The device list comes from /data (before a restart): its values are not republished. */
    this.stale = false;
    /** undefined: not read since the start; true: answered; false: failing. */
    this.online = undefined;
    this.failures = 0;
    this.nextRetryAt = -Infinity;
    this.wait = undefined;
    this.error = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    const generation = this.generation;
    const previousKey = this.credKey;
    this.config = normalizeConfig(raw);
    this.credKey = credentialsKey(this.config);
    // Before any await: a command arriving meanwhile meets the new client
    // (no token yet) and none of the old account's bridges.
    this.client.configure(this.config.auth, { unlock: this.config.allowUnlock });
    if (previousKey !== this.credKey) {
      this.bridges = new Map();
      this.latestJob.clear();
      this.lastTexts.clear();
    }
    if (!this.memory) {
      this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
      // Written at most once a minute: the real last read may be up to a
      // minute later than the one kept.
      if (this.memory.lastAttemptAt > 0) {
        this.lastAttemptAt = Math.min(
          this.now(),
          this.memory.lastAttemptAt + TIMINGS.attemptPersistEvery,
        );
      }
    }
    if (generation !== this.generation) {
      return;
    }
    const otherAccount = await this.adoptAccount();
    if (generation !== this.generation) {
      return;
    }
    // A new generation once settled: a command or an answer begun during the
    // awaits above belongs to the previous one.
    this.generation += 1;
    this.resetRead();
    this.restore();
    this.published = undefined;
    this.badges = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!this.config.auth) {
      await this.publishAll();
      return;
    }
    for (const job of this.jobs.values()) {
      this.scheduleJobRead(job);
    }
    await this.publishAll();
    // New credentials or another account: read at once (a pause or a block
    // still holds). Otherwise never sooner than the interval.
    const changed = otherAccount || (previousKey !== undefined && previousKey !== this.credKey);
    this.schedule(changed ? Math.max(0, this.holdUntil() - this.now()) : undefined);
  }

  /** Stops the timers; resolves once /data is written (a shutdown waits for it). */
  stop() {
    this.generation += 1;
    this.clearTimer();
    this.clearRenewTimer();
    for (const job of this.jobs.values()) {
      if (job.timer) {
        this.timers.clearTimeout(job.timer);
        job.timer = undefined;
      }
    }
    this.publisher.stop();
    if (!this.memory) {
      return Promise.resolve();
    }
    let save = Promise.resolve();
    if (this.lastAttemptAt > this.memory.lastAttemptAt) {
      this.memory.lastAttemptAt = this.lastAttemptAt;
      save = this.saveMemory();
    }
    return save.then(() => this.store.flush?.()).catch(() => {});
  }

  clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  clearRenewTimer() {
    if (this.renewTimer) {
      this.timers.clearTimeout(this.renewTimer);
      this.renewTimer = undefined;
    }
  }

  /**
   * /data belongs to one client id: another one drops its locks, guards,
   * jobs and summary (returns true then). Other credentials than the refused
   * ones lift the block.
   */
  async adoptAccount() {
    let changed = false;
    let other = false;
    const account = accountKey(this.config);
    if (account) {
      const fp = fingerprintOf(this.memory.salt, account);
      if (this.memory.account !== fp) {
        this.memory.account = fp;
        this.memory.locks = [];
        this.memory.guards = [];
        this.memory.jobs = [];
        this.memory.bridgeJobs = [];
        this.memory.summary = null;
        this.memory.okAt = 0;
        changed = true;
        other = true;
      }
    }
    const block = this.memory.block;
    if (block && block.fp !== fingerprintOf(this.memory.salt, this.credKey)) {
      this.memory.block = null;
      changed = true;
    }
    if (changed) {
      await this.saveMemory();
    }
    return other;
  }

  /** The bridges, guards, jobs, bridge jobs and last device list kept in /data. */
  restore() {
    const now = this.now();
    this.bridges = new Map(this.memory.locks.map((l) => [l.id, l.bridge]));
    this.guards = new Map(
      this.memory.guards.map((g) => [
        g.lock,
        { until: g.until, ...(g.jobId ? { jobId: g.jobId } : {}) },
      ]),
    );
    this.bridgeJobs = new Map(this.memory.bridgeJobs.map((j) => [j.bridge, j.at]));
    this.jobs = new Map();
    for (const job of this.memory.jobs) {
      const reads = TIMINGS.jobFollowUps.filter((d) => job.sentAt + d <= now).length;
      this.jobs.set(job.id, { ...job, reads });
      const latest = this.jobs.get(this.latestJob.get(job.lock));
      if (!latest || latest.sentAt <= job.sentAt) {
        this.latestJob.set(job.lock, job.id);
      }
    }
    const summary = this.memory.summary;
    if (this.config.auth && summary && this.memory.okAt > 0) {
      this.devices = new Map(summary.devices.map((d) => [d.id, d]));
      this.more = summary.more;
      this.readAt = this.memory.okAt;
      this.online = true;
      this.stale = true;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection, resend
   * what Gladys keeps in memory only (status, Discovery tab, badges) and the
   * last states, without reading igloohome again. Pauses, blocks and guards
   * stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw, { republish: true });
  }

  /**
   * A configuration saved. New credentials start over; anything else
   * (interval, option, language) applies at once, without a read.
   */
  async configUpdated(raw = {}, { republish = false } = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    const next = normalizeConfig(raw);
    if (credentialsKey(next) !== this.credKey || Boolean(next.auth) !== Boolean(this.config.auth)) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = next;
    if (previous.allowUnlock !== next.allowUnlock) {
      this.logger.info(`Unlocking ${next.allowUnlock ? 'allowed' : 'disabled'}`);
      // Other scopes: the token goes; the next one is asked now (in the background).
      this.client.setUnlock(next.allowUnlock);
      if (next.auth && !this.blocked && !this.paused && this.hasCreatedLock()) {
        this.renew();
      }
    }
    if (previous.pollInterval !== next.pollInterval && this.timer && !this.running) {
      this.schedule();
    }
    if (republish) {
      this.published = undefined;
      this.badges = undefined;
      this.lastStatus = undefined;
    } else if (previous.language !== next.language) {
      this.published = undefined;
    }
    await this.publishAll();
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  // --- Pauses and blocks -----------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  get paused() {
    return Boolean(this.memory?.pause) && this.now() < this.memory.pause.until;
  }

  /** Credentials refused or a scope missing: final until other credentials or a test success. */
  get blocked() {
    return Boolean(this.memory?.block);
  }

  /** The end of a pause, or now; a block: never (Infinity). */
  holdUntil() {
    if (this.blocked) {
      return Infinity;
    }
    return Math.max(this.now(), this.paused ? this.memory.pause.until : 0);
  }

  /** The earliest periodic read: the interval after the last one, a pause, a block. */
  earliestRead() {
    return Math.max(this.lastAttemptAt + this.interval, this.holdUntil());
  }

  /** 429 or 5xx: every read and every unlock waits, kept in /data. */
  async pause(err) {
    const failures = (this.memory.pause?.failures ?? 0) + 1;
    const asked = err.retryAfter ?? TIMINGS.pauseMin * 2 ** Math.min(failures - 1, 10);
    const wait = Math.min(TIMINGS.pauseMax, Math.max(TIMINGS.pauseMin, asked));
    this.memory.pause = { until: this.now() + wait, failures };
    await this.saveMemory();
    this.logger.warn(`igloohome: ${reasonOf(err)}, paused for ${age(wait)}`);
  }

  /** Credentials refused or a scope missing: a final stop, kept with the refused pair's fingerprint. */
  async block(kind) {
    this.memory.block = {
      kind,
      failures: (this.memory.block?.failures ?? 0) + 1,
      fp: fingerprintOf(this.memory.salt, this.credKey),
    };
    this.clearRenewTimer();
    this.clearTimer();
    await this.saveMemory();
    this.logger.warn(
      kind === 'scope'
        ? 'igloohome: a scope is missing; no automatic new try'
        : 'igloohome: credentials refused; no automatic new try',
    );
  }

  // --- Token renewal ---------------------------------------------------------

  /** Whether a lock of the account is created in Gladys with its buttons. */
  hasCreatedLock() {
    const created = this.createdFeatures();
    for (const id of this.bridges.keys()) {
      if (created.has(deviceIds(this.gladys, id).feature(FEATURES.UNLOCK))) {
        return true;
      }
    }
    return false;
  }

  /**
   * The renewal of the token, at its expiry minus 5 min, so an unlock never
   * waits for one: only while a lock with its buttons is created, never
   * during a block, after a pause, at most once a minute.
   */
  scheduleRenew(delay) {
    this.clearRenewTimer();
    const renewAt = this.client.renewAt;
    if (!this.config.auth || this.blocked || renewAt === undefined || !this.hasCreatedLock()) {
      return;
    }
    let at = delay === undefined ? renewAt : this.now() + delay;
    at = Math.max(at, this.lastRenewAt + TIMINGS.renewRetry);
    if (this.paused) {
      at = Math.max(at, this.memory.pause.until);
    }
    const generation = this.generation;
    this.renewTimer = this.timers.setTimeout(
      () => {
        this.renewTimer = undefined;
        if (generation !== this.generation || this.blocked) {
          return;
        }
        if (this.paused || this.now() < (this.client.renewAt ?? Infinity) - SECOND) {
          this.scheduleRenew();
          return;
        }
        this.renew(generation);
      },
      Math.max(0, at - this.now()),
    );
  }

  renew(generation = this.generation) {
    this.lastRenewAt = this.now();
    return this.client
      .fetchToken()
      .then(() => {
        if (generation === this.generation) {
          this.scheduleRenew();
          this.updateStatus().catch(() => {});
        }
      })
      .catch((err) => this.renewFailed(err, generation));
  }

  /** A renewal outside a read failed: a block, a pause, or a new try later. */
  async renewFailed(err, generation = this.generation) {
    if (generation !== this.generation) {
      return;
    }
    this.logger.info(`igloohome: token renewal failed (${reasonOf(err)})`);
    if (err.kind === 'auth' || err.kind === 'scope') {
      await this.block(err.kind === 'scope' ? 'scope' : 'refused');
      await this.updateStatus();
      return;
    }
    if (err.kind === 'busy') {
      await this.pause(err);
      await this.updateStatus();
    }
    this.scheduleRenew(Math.max(TIMINGS.renewRetry, this.interval));
  }

  // --- Polling ---------------------------------------------------------------

  /** The next read: the interval, a pause or the backoff, whichever is later; none in a block. */
  schedule(delay) {
    this.clearTimer();
    let at = this.earliestRead();
    if (this.online === false) {
      at = Math.max(at, this.nextRetryAt);
    }
    if (!Number.isFinite(at)) {
      // A final block: only the test button or other credentials read again.
      return;
    }
    const wait = delay ?? at - this.now();
    const generation = this.generation;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.tick({ scheduled: true }).catch(() => this.logger.error('Refresh failed'));
        }
      },
      Math.max(0, Math.min(wait, 2 ** 31 - 1)),
    );
  }

  /**
   * One read at a time: a tick during a read joins it (a reconnection never
   * starts a second one). `scheduled`: the timer, or a start after new
   * credentials. `test`: the test button (one try through a block).
   */
  tick(options = {}) {
    if (!this.running) {
      this.running = this.run(options).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async run({ scheduled = false, test = false } = {}) {
    const generation = this.generation;
    if (!this.config.auth) {
      return;
    }
    const now = this.now();
    const early = !scheduled && !test && now < this.earliestRead();
    const backingOff = !test && this.online === false && now < this.nextRetryAt;
    if (this.paused || (this.blocked && !test) || early || backingOff) {
      await this.updateStatus();
      if (generation === this.generation && !this.timer) {
        this.schedule();
      }
      return;
    }
    // Whatever happens below, the next read is scheduled: the chain of reads
    // never dies on an error (an answer not understood, a publication failing).
    try {
      await this.noteAttempt(now);
      if (generation !== this.generation) {
        return;
      }
      const startedAt = this.now();
      try {
        const result = await this.client.devices({ timeout: TIMINGS.readTimeout });
        if (generation !== this.generation) {
          return;
        }
        this.online = true;
        this.failures = 0;
        this.wait = undefined;
        this.error = undefined;
        if (this.memory.block || this.memory.pause) {
          this.memory.block = null;
          this.memory.pause = null;
        }
        await this.applyRead(result, { save: true });
        if (generation !== this.generation) {
          return;
        }
        this.scheduleRenew();
      } catch (err) {
        if (generation !== this.generation) {
          return;
        }
        await this.failed(err, startedAt);
      }
      if (generation !== this.generation) {
        return;
      }
      await this.publishAll();
    } catch (err) {
      this.logger.error(`Refresh failed: ${err?.message ?? 'error'}`);
    } finally {
      if (generation === this.generation) {
        this.schedule();
      }
    }
  }

  /** The time of a read, BEFORE it: exact in memory, in /data at most once a minute. */
  async noteAttempt(now) {
    this.lastAttemptAt = now;
    if (now - this.memory.lastAttemptAt >= TIMINGS.attemptPersistEvery) {
      this.memory.lastAttemptAt = now;
      await this.saveMemory();
    }
  }

  /**
   * A device list read: the devices, the bridge of each commandable lock,
   * and (`save`, a read of the polling) the success and a bounded summary
   * kept in /data for a restart.
   */
  async applyRead({ devices, more }, { save = false } = {}) {
    this.devices = devices;
    this.more = more;
    this.readAt = this.now();
    this.stale = false;
    const locks = [...devices.values()]
      .filter(isCommandable)
      .map((d) => ({ id: d.id, bridge: d.bridge }));
    this.bridges = new Map(locks.map((l) => [l.id, l.bridge]));
    let dirty = false;
    if (JSON.stringify(locks) !== JSON.stringify(this.memory.locks)) {
      this.memory.locks = locks;
      dirty = true;
    }
    if (save) {
      const summary = { devices: [...devices.values()], more };
      if (JSON.stringify(summary) !== JSON.stringify(this.memory.summary)) {
        this.memory.summary = summary;
        dirty = true;
      }
      if (this.now() - this.memory.okAt >= TIMINGS.attemptPersistEvery || dirty) {
        this.memory.okAt = this.now();
        dirty = true;
      }
    }
    if (dirty || save) {
      await this.saveMemory();
    }
  }

  /** A failed read. `startedAt`: a token asked during it and refused at once means a scope. */
  async failed(err, startedAt) {
    if (err.kind === 'auth' || err.kind === 'scope') {
      this.online = false;
      this.error = err.kind;
      await this.block(err.kind === 'scope' ? 'scope' : 'refused');
      return;
    }
    if (
      (err.kind === 'unauthorized' || err.kind === 'forbidden') &&
      this.client.tokenAt !== undefined &&
      this.client.tokenAt >= startedAt
    ) {
      // A token just given, refused at once: the API client is not allowed.
      this.online = false;
      this.error = err.kind;
      await this.block('scope');
      return;
    }
    if (err.kind === 'busy') {
      await this.pause(err);
      return;
    }
    if (err.kind === 'unauthorized') {
      // An older token refused: dropped by the client, a new one next time.
      this.client.dropToken();
    }
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
    );
    this.failures += 1;
    this.online = false;
    this.stale = false;
    this.wait = wait;
    this.nextRetryAt = this.now() + wait;
    this.error = reasonOf(err);
    this.logger.warn(`igloohome: ${reasonOf(err)}; next try in ${age(wait)}`);
  }

  // --- Status ----------------------------------------------------------------

  /** `[connected, message]`. */
  status() {
    const config = this.config;
    if (!config.auth) {
      return [false, config.badAuth === 'invalid' ? T.invalidCredentials : T.noCredentials];
    }
    if (this.blocked) {
      return [false, this.memory.block.kind === 'scope' ? T.scopeMissing : T.authRefused];
    }
    if (this.paused) {
      return [false, T.paused(age(this.memory.pause.until - this.now()))];
    }
    if (this.online === false) {
      return [false, T.unreachable(this.error ?? 'error', age(this.wait ?? this.interval))];
    }
    if (this.online === undefined || !this.devices) {
      return [false, T.connecting];
    }
    const shown = [...this.devices.values()].filter(isShown);
    const parts = [T.connected(T.summary(shown.length, shown.filter(isCommandable).length))];
    if (this.stale) {
      parts.push(
        T.restored(
          age(this.now() - this.readAt),
          age(Math.max(0, this.earliestRead() - this.now())),
        ),
      );
    }
    parts.push(T.unlocking(config.allowUnlock));
    if (config.allowUnlock && this.client.unlockDenied) {
      parts.push(T.unlockScopeMissing);
    }
    if (this.more) {
      parts.push(T.morePages);
    }
    return [true, join(...parts)];
  }

  async updateStatus() {
    let connected;
    let message;
    try {
      [connected, message] = this.status();
    } catch (err) {
      this.logger.error(`Status failed: ${err?.message ?? 'error'}`);
      [connected, message] = [false, T.unreachable('status', age(this.interval))];
    }
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Gladys ----------------------------------------------------------------

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  async publishAll() {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) {
      return;
    }
    this.queueStates();
    await this.flush();
    await this.publishBadges();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /**
   * The Discovery tab: one device per device of the account but the bridges.
   * A created device never loses a feature: the features it has that the
   * device no longer gives (a lock unlinked from its bridge, a battery no
   * longer read) are published as they are (Gladys would otherwise mark it
   * changed, and "Update" would drop their history).
   */
  async publishDevices() {
    if (!this.devices) {
      return;
    }
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    const measures = new Set();
    const devices = [];
    for (const device of this.devices.values()) {
      if (!isShown(device)) {
        continue;
      }
      const built = buildDevice(this.gladys, device, { language: this.config.language });
      const ids = deviceIds(this.gladys, device.id);
      for (const { key, measure } of featuresOf(device)) {
        if (measure) {
          measures.add(ids.feature(key));
        }
      }
      const published = new Set(built.features.map((f) => f.external_id));
      for (const feature of created.get(built.external_id)?.features ?? []) {
        if (!published.has(feature.external_id)) {
          const kept = {};
          for (const field of KEPT_FIELDS) {
            if (feature[field] !== undefined && feature[field] !== null) {
              kept[field] = feature[field];
            }
          }
          built.features.push(kept);
        }
      }
      devices.push(built);
    }
    this.publisher.configure({ throttled: measures, events: new Set() });
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /**
   * The last values, for the created features only (the ack never waits for
   * it). A device list kept from before a restart publishes no value: it
   * would show old values as new.
   */
  queueStates(created = this.createdFeatures()) {
    const now = this.now();
    if (!this.stale) {
      for (const device of this.devices?.values() ?? []) {
        if (!isShown(device)) {
          continue;
        }
        const ids = deviceIds(this.gladys, device.id);
        for (const { key, value } of valuesOf(device, now)) {
          const id = ids.feature(key);
          if (created.has(id)) {
            this.publisher.push(id, { state: value });
          }
        }
      }
    }
    for (const lock of this.lastTexts.keys()) {
      this.queueLastText(lock, created);
    }
  }

  queueLastText(lock, created = this.createdFeatures()) {
    const text = this.lastTexts.get(lock);
    const id = deviceIds(this.gladys, lock).feature(FEATURES.LAST_COMMAND);
    if (text && created.has(id)) {
      this.publisher.push(id, { text: word(text, this.config.language) });
    }
  }

  async publishBadges() {
    const entries = [];
    const online = this.online === true && !this.blocked && !this.paused;
    for (const device of this.gladys.devices ?? []) {
      const target = parseExternalId(this.gladys, device?.external_id);
      if (!target || target.key !== undefined) {
        continue;
      }
      const listed = this.devices?.has(target.deviceId);
      if (this.online === undefined && !this.blocked) {
        continue;
      }
      entries.push({
        external_id: device.external_id,
        transport:
          online && (listed || !this.devices)
            ? DEVICE_TRANSPORTS.CLOUD
            : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badges) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badges = json;
    } catch (err) {
      this.logger.warn(`Transport badges failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): its last values and its badge at once. */
  async deviceCreated(device) {
    this.badges = undefined;
    const created = this.createdFeatures();
    for (const feature of device?.features ?? []) {
      created.add(feature.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadges();
    if (!this.renewTimer) {
      this.scheduleRenew();
    }
  }

  async deviceDeleted(device) {
    this.badges = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the devices of the last read, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button --------------------------------------------------

  /**
   * "Test the connection": a read now, unless one was made less than an
   * interval ago (then its result). Through a stop (one try): the stop is
   * lifted only by a success. A pause asked by igloohome holds.
   */
  async testConnection() {
    const last = () => JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? this.status()[1];
    if (!this.config.auth || this.paused) {
      return this.status()[1];
    }
    const now = this.now();
    if (now < this.lastAttemptAt + this.interval) {
      await this.updateStatus();
      const wait = age(this.lastAttemptAt + this.interval - now);
      if (this.blocked) {
        return join(T.test.stopped(age(now - this.lastAttemptAt), wait), last());
      }
      return join(T.test.recent(wait), last());
    }
    // The unlock scope refused before: asked again (the user may have given it).
    if (this.client.unlockDenied) {
      this.client.setUnlock(this.config.allowUnlock);
    }
    const wasBlocked = Boolean(this.memory.block);
    await this.tick({ test: true });
    if (wasBlocked && this.memory.block) {
      return join(T.test.stillRefused, last());
    }
    return last();
  }

  // --- Commands --------------------------------------------------------------

  refusal(text) {
    const error = new Error(word(text, this.config.language));
    error.refusal = true;
    return error;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseExternalId(this.gladys, feature?.external_id);
    if (!target || !COMMAND_KEYS.includes(target.key)) {
      throw this.refusal(ERRORS.readOnly);
    }
    if (value !== 1 && value !== '1') {
      throw this.refusal(ERRORS.badValue);
    }
    const lock = target.deviceId;
    if (target.key === FEATURES.LOCK) {
      // Every unlock of this lock not sent yet is cancelled at once, the
      // queued ones included, even when this lock command is refused below:
      // cancelling never sends anything.
      for (const pending of this.tickets.get(lock) ?? []) {
        if (!pending.sent) {
          pending.cancelled = true;
        }
      }
      return this.lockCommand(lock, received);
    }
    if (!this.memory || !this.config.auth) {
      throw this.refusal(ERRORS.notConfigured);
    }
    if (!this.config.allowUnlock) {
      throw this.refusal(ERRORS.unlockDisabled);
    }
    const ticket = { lock, generation: this.generation, cancelled: false, sent: false };
    if (!this.tickets.has(lock)) {
      this.tickets.set(lock, new Set());
    }
    this.tickets.get(lock).add(ticket);
    // One queue per lock: an unlock of another lock never waits for this one.
    const previous = this.queues.get(lock) ?? Promise.resolve();
    const run = previous.then(() => this.unlockCommand(ticket, received));
    const tail = run.catch(() => {});
    this.queues.set(lock, tail);
    try {
      return await run;
    } finally {
      this.tickets.get(lock)?.delete(ticket);
      if (this.queues.get(lock) === tail) {
        this.queues.delete(lock);
      }
    }
  }

  /** The checks of an unlock, on the latest configuration: on arrival, after the read, before sending. */
  checkUnlock(ticket, sendBy) {
    if (ticket.cancelled) {
      throw this.refusal(ERRORS.cancelled);
    }
    if (ticket.generation !== this.generation || !this.config.auth) {
      // New credentials since: nothing for the old ones.
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (!this.config.allowUnlock) {
      throw this.refusal(ERRORS.unlockDisabled);
    }
    if (this.blocked) {
      throw this.refusal(ERRORS.blocked);
    }
    if (this.paused) {
      throw this.refusal(ERRORS.paused(age(this.memory.pause.until - this.now())));
    }
    if (this.now() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
  }

  /** The 30 s spacing of the jobs of a bridge (2 a minute). */
  checkSpacing(bridge) {
    const lastJob = this.bridgeJobs.get(bridge);
    if (lastJob !== undefined && this.now() - lastJob < TIMINGS.bridgeSpacing) {
      throw this.refusal(ERRORS.bridgeBusy(age(lastJob + TIMINGS.bridgeSpacing - this.now())));
    }
  }

  /** An unlock of this lock may still run: its guard, or an unlock job watched. */
  unlockPending(lock) {
    for (const job of this.jobs.values()) {
      if (job.lock === lock && job.action === 'unlock') {
        return true;
      }
    }
    const guard = this.guards.get(lock);
    if (guard && this.now() >= guard.until) {
      this.guards.delete(lock);
      this.persistGuards();
      return false;
    }
    return Boolean(guard);
  }

  persistGuards() {
    if (!this.memory) {
      return;
    }
    this.memory.guards = [...this.guards].map(([lock, g]) => ({
      lock,
      until: g.until,
      ...(g.jobId ? { jobId: g.jobId } : {}),
    }));
    this.saveMemory().catch(() => {});
  }

  noteBridgeJob(bridge) {
    const now = this.now();
    this.bridgeJobs.set(bridge, now);
    this.memory.bridgeJobs = [...this.bridgeJobs]
      .filter(([, at]) => at > now - TIMINGS.bridgeSpacing)
      .map(([b, at]) => ({ bridge: b, at }));
    this.saveMemory().catch(() => {});
  }

  /** One unlock: the token, the fresh read (the lock, its bridge), the checks, the job. */
  async unlockCommand(ticket, received) {
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const check = () => this.checkUnlock(ticket, sendBy);
    check();
    if (this.unlockPending(ticket.lock)) {
      throw this.refusal(ERRORS.justCommanded);
    }
    if (this.client.unlockDenied) {
      throw this.refusal(ERRORS.unlockScopeMissing);
    }
    // Before the read: a press within 30 s of a job on the known bridge asks nothing.
    const knownBridge = this.bridges.get(ticket.lock);
    if (knownBridge) {
      this.checkSpacing(knownBridge);
    }
    if (!this.client.canUnlock || !this.client.tokenValidFor(TIMINGS.commandTokenValidity)) {
      // A token request inside the 3.5 s would leave too little time: asked
      // now in the background (no loop: at most one a minute), refused.
      if (this.now() - this.lastRenewAt >= TIMINGS.renewRetry) {
        this.renew();
      }
      throw this.refusal(ERRORS.session);
    }
    const token = this.client.token.value;
    const left = () => sendBy - TIMINGS.commandSendMargin - this.now();
    if (left() <= 0) {
      throw this.refusal(ERRORS.tooSlow);
    }
    // The lock just before acting, never the one in memory.
    let result;
    try {
      result = await this.client.devices({ timeout: left() });
    } catch (err) {
      if (ticket.generation !== this.generation) {
        throw this.refusal(ERRORS.unknownDevice);
      }
      if (err.kind === 'busy') {
        await this.pause(err);
        this.updateStatus().catch(() => {});
      }
      if (err.kind === 'timeout' && left() <= 0) {
        throw this.refusal(ERRORS.tooSlow);
      }
      throw this.refusal(ERRORS.unknownState(reasonOf(err)));
    }
    // Cancelled, no longer allowed or other credentials while it read.
    check();
    // Shown in the background: the ack never waits for Gladys.
    const generation = this.generation;
    this.applyRead(result)
      .then(() => (generation === this.generation ? this.publishAll() : undefined))
      .catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
    const device = result.devices.get(ticket.lock);
    if (!device || device.type !== DEVICE_TYPES.LOCK) {
      throw this.refusal(ERRORS.notALock);
    }
    if (!device.bridge) {
      throw this.refusal(ERRORS.noBridge);
    }
    if (this.unlockPending(ticket.lock)) {
      throw this.refusal(ERRORS.justCommanded);
    }
    this.checkSpacing(device.bridge);
    return this.sendJob(ticket.lock, device.bridge, 'unlock', token, {
      sendBy,
      answerBy,
      check: () => {
        check();
        // Again right before the first byte: another lock of this bridge may just have sent.
        this.checkSpacing(device.bridge);
        ticket.sent = true;
      },
    });
  }

  /**
   * One lock command: no queue, no read, through a pause or a stop (one
   * try); the bridge of the last read or of /data; a token asked within the
   * deadline when the one in memory is too old.
   */
  async lockCommand(lock, received) {
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const generation = this.generation;
    if (!this.memory || !this.config.auth) {
      throw this.refusal(ERRORS.notConfigured);
    }
    const bridge = this.bridges.get(lock);
    if (!bridge) {
      const listed = this.devices?.get(lock);
      throw this.refusal(
        listed?.type === DEVICE_TYPES.LOCK ? ERRORS.noBridge : ERRORS.unknownDevice,
      );
    }
    const check = () => {
      if (generation !== this.generation || !this.config.auth) {
        throw this.refusal(ERRORS.unknownDevice);
      }
      if (this.now() > sendBy) {
        throw this.refusal(ERRORS.tooSlow);
      }
    };
    let token;
    if (this.client.tokenValidFor(10 * SECOND)) {
      token = this.client.token.value;
    } else {
      const left = Math.max(0, sendBy - TIMINGS.commandSendMargin - this.now());
      let timer;
      try {
        // A token request of a read is joined only when it left just now
        // (src/client.js), and never waited for past the deadline.
        token = await Promise.race([
          this.client.lockToken({ timeout: Math.max(200, left), sendWithin: left }),
          new Promise((_, reject) => {
            timer = this.timers.setTimeout(
              () => reject(Object.assign(new Error('late'), { kind: 'late' })),
              left,
            );
          }),
        ]);
      } catch (err) {
        // Never a block from a command: the reads decide that.
        if (err.kind === 'late' || err.kind === 'timeout') {
          throw this.refusal(ERRORS.tooSlow);
        }
        throw this.refusal(ERRORS.notSent(reasonOf(err)));
      } finally {
        this.timers.clearTimeout(timer);
      }
    }
    check();
    return this.sendJob(lock, bridge, 'lock', token, {
      sendBy,
      answerBy,
      check: () => {
        check();
        this.lastLockSentAt.set(lock, this.now());
      },
    });
  }

  /** The job request, its answer, the guard (unlock), the watch of its status. */
  async sendJob(lock, bridge, action, token, { sendBy, answerBy, check }) {
    const unlock = action === 'unlock';
    const generation = this.generation;
    const name = `${lock}: ${action} job`;
    this.logger.info(name);
    let jobId;
    let sentAt;
    try {
      jobId = await this.client.createJob(
        token,
        lock,
        bridge,
        unlock ? JOB_TYPES.UNLOCK : JOB_TYPES.LOCK,
        {
          timeout: Math.max(200, answerBy - this.now()),
          sendWithin: Math.max(0, sendBy - this.now()),
          // The very last check, right before the request leaves.
          beforeSend: () => {
            check();
            sentAt = this.now();
            this.noteBridgeJob(bridge);
            if (unlock) {
              // Set before the first byte (written to /data right after):
              // a restart never lets a second unlock through.
              this.guards.set(lock, { until: sentAt + GUARD_MAX });
              this.persistGuards();
            }
          },
        },
      );
    } catch (err) {
      if (err.beforeSend) {
        throw err;
      }
      const reason = reasonOf(err);
      if (!err.sent) {
        this.logger.warn(`${name} NOT sent (${reason})`);
        if (unlock && sentAt !== undefined) {
          // Its guard was set in beforeSend, but nothing left.
          this.guards.delete(lock);
          this.persistGuards();
        }
        throw this.refusal(err.kind === 'late' ? ERRORS.tooSlow : ERRORS.notSent(reason));
      }
      const answered = ANSWERED.has(err.kind) || (err.kind === 'busy' && err.status === 429);
      if (generation !== this.generation) {
        // Other credentials since: nothing written for this one's account.
        throw this.refusal(answered ? ERRORS.refused(reason) : ERRORS.sentUnconfirmed(reason));
      }
      if (err.kind === 'busy') {
        await this.pause(err);
        this.updateStatus().catch(() => {});
      }
      if (answered) {
        // igloohome answered with a refusal: no job. Never a credentials
        // block from a command (the reads decide that).
        if (unlock) {
          this.guards.delete(lock);
          this.persistGuards();
        }
        this.latestJob.delete(lock);
        this.setLastText(lock, LAST.refused(action, reason));
        this.logger.warn(`${name} refused (${reason})`);
        throw this.refusal(ERRORS.refused(reason));
      }
      // A silence, a dropped connection, a 5xx, an answer not understood: the
      // job may have been created. The guard of an unlock stays (its bound).
      this.latestJob.delete(lock);
      this.setLastText(lock, LAST.unconfirmed(action, reason));
      this.logger.warn(`${name} sent, NOT confirmed (${reason})`);
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    if (generation !== this.generation) {
      // The answer of the previous credentials: exact ack, nothing else.
      throw this.refusal(ERRORS.accepted);
    }
    if (unlock) {
      const guard = this.guards.get(lock);
      if (guard) {
        guard.jobId = jobId;
        this.persistGuards();
      }
    }
    this.latestJob.set(lock, jobId);
    this.setLastText(lock, LAST.accepted(action));
    this.logger.info(`${name} accepted by igloohome`);
    this.trackJob({ id: jobId, lock, action, sentAt: sentAt ?? this.now(), reads: 0 });
    // Never "done": what a processed job means is not known yet.
    throw this.refusal(ERRORS.accepted);
  }

  /** The last-command text of a lock, shown in the background. */
  setLastText(lock, text) {
    this.lastTexts.set(lock, text);
    this.queueLastText(lock);
    this.flush().catch(() => {});
  }

  // --- Jobs ------------------------------------------------------------------

  persistJobs() {
    if (!this.memory) {
      return;
    }
    this.memory.jobs = [...this.jobs.values()].map(({ id, lock, action, sentAt, expiry }) => ({
      id,
      lock,
      action,
      sentAt,
      ...(expiry !== undefined ? { expiry } : {}),
    }));
    this.saveMemory().catch(() => {});
  }

  /** A job accepted: watched to its end (bounded in count: the oldest end "unknown"). */
  trackJob(job) {
    this.jobs.set(job.id, job);
    while (this.jobs.size > TIMINGS.jobsMax) {
      const oldest = this.jobs.values().next().value;
      this.jobEnded(oldest, 'unknown');
    }
    this.persistJobs();
    this.scheduleJobRead(job);
  }

  /**
   * The end of the watch: a read after the expiry date igloohome gave (when
   * it gave one), and 15 min after the job left at most.
   */
  jobEnd(job) {
    const max = job.sentAt + TIMINGS.jobWatchMax;
    if (job.expiry === undefined) {
      return max;
    }
    return Math.min(max, Math.max(job.expiry + TIMINGS.jobReadEvery, job.sentAt));
  }

  /** The next read of a job: 5, 15, 30, 60, 100, 140 s, then every minute; after a pause. */
  scheduleJobRead(job, { afterEnd = false } = {}) {
    if (job.timer) {
      this.timers.clearTimeout(job.timer);
    }
    const now = this.now();
    const planned = TIMINGS.jobFollowUps[job.reads];
    let at = planned !== undefined ? job.sentAt + planned : now + TIMINGS.jobReadEvery;
    if (this.paused) {
      at = Math.max(at, this.memory.pause.until);
    }
    const end = afterEnd ? job.sentAt + TIMINGS.jobWatchMax : this.jobEnd(job);
    at = Math.min(Math.max(at, now), Math.max(now, end));
    const generation = this.generation;
    job.timer = this.timers.setTimeout(() => {
      job.timer = undefined;
      if (generation === this.generation) {
        this.readJob(job.id).catch((err) =>
          this.logger.warn(`Job status failed: ${err?.message ?? 'error'}`),
        );
      }
    }, at - now);
  }

  /**
   * One read of a job. Processed -> its end; not processed, read after its
   * expiry date -> "expired"; anything else (a failure, a pause, a stop) ->
   * the next read, or "unknown" at the end of the watch. A 429 pauses the
   * account; a 5xx of this secondary endpoint only skips this read.
   */
  async readJob(id) {
    const job = this.jobs.get(id);
    if (!job) {
      return;
    }
    const generation = this.generation;
    job.reads += 1;
    let answered = false;
    if (!this.blocked && !this.paused && this.config.auth) {
      const startedAt = this.now();
      let result;
      try {
        const token = await this.client.validToken({ validity: 10 * SECOND });
        if (generation !== this.generation) {
          return;
        }
        result = await this.client.job(token, id, { timeout: TIMINGS.readTimeout });
      } catch (err) {
        if (generation !== this.generation) {
          return;
        }
        if (err.kind === 'busy' && err.status === 429) {
          await this.pause(err);
          await this.updateStatus();
        }
        this.logger.info(`${job.lock}: ${job.action} job status not read (${reasonOf(err)})`);
      }
      if (generation !== this.generation || this.jobs.get(id) !== job) {
        return;
      }
      // Only the answer about this job counts.
      if (result && result.id === id) {
        answered = true;
        if (result.expiry !== undefined && result.expiry !== job.expiry) {
          job.expiry = result.expiry;
          this.persistJobs();
        }
        if (result.completed) {
          this.jobEnded(job, 'processed', result);
          return;
        }
        if (result.expiry !== undefined && startedAt > result.expiry) {
          this.jobEnded(job, 'expired');
          return;
        }
      }
    }
    // Past the expiry date, the watch ends after an answer; a read that did
    // not happen (a pause, a stop, a failure) goes on until the 15 min.
    const now = this.now();
    if (now >= job.sentAt + TIMINGS.jobWatchMax || (answered && now >= this.jobEnd(job))) {
      this.jobEnded(job, 'unknown');
      return;
    }
    this.scheduleJobRead(job, { afterEnd: !answered && now >= this.jobEnd(job) });
  }

  /**
   * The end of a job: 'processed', 'expired' or 'unknown'. Its text when it
   * is the latest command of the lock; an alert when an unlock is processed
   * after a lock sent later; the guard of its unlock lifted.
   */
  jobEnded(job, outcome, result) {
    if (job.timer) {
      this.timers.clearTimeout(job.timer);
      job.timer = undefined;
    }
    this.jobs.delete(job.id);
    this.persistJobs();
    const guard = this.guards.get(job.lock);
    if (job.action === 'unlock' && guard && guard.jobId === job.id) {
      this.guards.delete(job.lock);
      this.persistGuards();
    }
    if (outcome === 'processed') {
      this.logger.info(
        `${job.lock}: ${job.action} job processed (jobResponse keys: ${result?.responseKeys?.join(',') || 'none'})`,
      );
    } else {
      this.logger.info(`${job.lock}: ${job.action} job ${outcome}`);
    }
    if (this.latestJob.get(job.lock) === job.id) {
      this.latestJob.delete(job.lock);
      this.setLastText(job.lock, LAST[outcome](job.action));
      return;
    }
    if (
      job.action === 'unlock' &&
      outcome === 'processed' &&
      (this.lastLockSentAt.get(job.lock) ?? -Infinity) > job.sentAt
    ) {
      this.logger.warn(`${job.lock}: an unlock sent before a lock was processed after it`);
      this.setLastText(job.lock, LAST.lateUnlock);
    }
  }
}
