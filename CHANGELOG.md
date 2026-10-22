# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- igloohome locks, padlocks, key boxes and keypads through the official
  igloohome API (an API client of the iglooaccess portal: client id and
  secret, OAuth2 client credentials), ported from igloohome-api (MIT) and the
  Home Assistant integration (Apache-2.0).
- One Gladys device per device of the account (bridges left out): battery and
  hours since the last sync; for a lock linked to a bridge, Lock and Unlock
  buttons (never a switch) and the result of the last command read back from
  the job status.
- Unlocking is off by default ("Allow unlocking"), checked on arrival, after a
  fresh read of the device list and right before sending; one unlock at a
  time per lock, a guard until its job ends (2.5 min at most, kept in
  `/data`), none within 30 s of another job on the same bridge.
- Locking is never blocked: no queue, no read, one try through a pause or a
  stop, possible before the first read after a restart, and it cancels every
  unlock of the lock not sent yet.
- Commands sent within 3.5 s or refused unsent; a job accepted is "sent,
  without confirmation" until its status reads completed.
- Refused credentials stop with spaced tries (1 h, 6 h, 24 h); a missing scope
  is a final stop; 429/5xx pause from 1 min to 6 h; all kept in `/data`.
  Reads never sooner than the interval (15 min by default).
- English and French texts and guides, cover image.
