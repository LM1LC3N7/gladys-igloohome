// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), so that a restart never asks igloohome again before its time
// nor loops on refused credentials, and so that "Lock" works before the
// first read:
//   - `account`: the salted fingerprint of the client id (not a secret) the
//     rest belongs to; another client id drops the locks and the guards;
//   - `pause`: the end of a pause asked by igloohome (429, 5xx);
//   - `block`: credentials refused ('refused': next try at `until`) or a
//     scope missing ('scope': final, `until` null), the count, and the salted
//     fingerprint of the REFUSED pair (other credentials lift the block, even
//     typed while the container was stopped); cleared at the first success;
//   - `lastAttemptAt`: when igloohome was last asked for the device list
//     (written BEFORE the read, at most once a minute: src/app.js waits that
//     minute more after a restart);
//   - `locks`: the deviceId of each commandable lock and of its bridge (ids
//     of the igloohome cloud, no secret): "Lock" works before the first read;
//   - `guards`: after an unlock that may have left, its end and its job id;
//   - `bridgeJobs`: when the last job was sent to each bridge (2 a minute).
// NO SECRET: neither the client secret, nor the token, nor anything derived
// from a pair igloohome accepted. The file is readable by the container user
// only (0600), written to a temporary file then renamed.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { LIMITS, TIMINGS } from './constants.js';
import { ID_PATTERN } from './igloo.js';

export const STATE_FILE = '/data/igloohome-state.json';

/** The longest guard after an unlock: the life of a job, plus the margin. */
const GUARD_MAX = TIMINGS.jobLifetime + TIMINGS.guardMargin;

export function fileStore(path = process.env.DATA_FILE || STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 256 * 1024 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const finite = (value) => (Number.isFinite(value) ? value : 0);
const isId = (value) => typeof value === 'string' && ID_PATTERN.test(value);
const isFp = (value) => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);

/** A salted fingerprint (the client id; or a pair igloohome REFUSED, never a good one). */
export const fingerprintOf = (salt, text) =>
  createHash('sha256').update(`${salt}:${text}`).digest('hex').slice(0, 32);

/**
 * The persisted state, repaired and bounded: a pause never more than 6 h
 * away, a block never more than the longest new-try delay, a guard never
 * longer than a fresh one, a last attempt never in the future (a clock that
 * jumped, a file edited by hand).
 */
export function normalizeMemory(raw, now) {
  const data = object(raw);
  const pause = object(data.pause);
  const block = object(data.block);
  const failures = Number.isInteger(block.failures) && block.failures > 0 ? block.failures : 1;
  let normalizedBlock = null;
  if (isFp(block.fp) && (block.kind === 'refused' || block.kind === 'scope')) {
    normalizedBlock = {
      kind: block.kind,
      // An expired block is kept (its count spaces the next tries) but no longer waits.
      until:
        block.kind === 'scope'
          ? null
          : Math.min(finite(block.until), now + TIMINGS.authRetries.at(-1)),
      failures: Math.min(failures, 100),
      fp: block.fp,
    };
  }
  return {
    salt:
      typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt)
        ? data.salt
        : randomBytes(16).toString('hex'),
    account: isFp(data.account) ? data.account : null,
    pause:
      Number.isFinite(pause.until) && pause.until > now
        ? {
            until: Math.min(pause.until, now + TIMINGS.pauseMax),
            failures: Math.min(Math.max(1, Math.floor(finite(pause.failures))), 20),
          }
        : null,
    block: normalizedBlock,
    lastAttemptAt: Math.min(Math.max(0, finite(data.lastAttemptAt)), now),
    locks: locksOf(data.locks),
    guards: guardsOf(data.guards, now),
    bridgeJobs: bridgeJobsOf(data.bridgeJobs, now),
  };
}

function locksOf(raw) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw) ? raw.slice(0, LIMITS.devices) : []) {
    const lock = object(entry);
    if (isId(lock.id) && isId(lock.bridge) && !seen.has(lock.id)) {
      seen.add(lock.id);
      out.push({ id: lock.id, bridge: lock.bridge });
    }
  }
  return out;
}

function guardsOf(raw, now) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw) ? raw.slice(0, LIMITS.devices) : []) {
    const guard = object(entry);
    if (
      isId(guard.lock) &&
      Number.isFinite(guard.until) &&
      guard.until > now &&
      !seen.has(guard.lock)
    ) {
      seen.add(guard.lock);
      out.push({
        lock: guard.lock,
        until: Math.min(guard.until, now + GUARD_MAX),
        ...(isId(guard.jobId) ? { jobId: guard.jobId } : {}),
      });
    }
  }
  return out;
}

function bridgeJobsOf(raw, now) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw) ? raw.slice(0, LIMITS.devices) : []) {
    const job = object(entry);
    if (
      isId(job.bridge) &&
      Number.isFinite(job.at) &&
      job.at > now - TIMINGS.bridgeSpacing &&
      !seen.has(job.bridge)
    ) {
      seen.add(job.bridge);
      out.push({ bridge: job.bridge, at: Math.min(job.at, now) });
    }
  }
  return out;
}
