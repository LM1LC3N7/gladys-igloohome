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
  buttons (never a switch) and what igloohome says of the job of the last
  command.
- Unlocking is off by default ("Allow unlocking", and only then is the unlock
  scope asked), checked on arrival, after a fresh read of the device list and
  right before sending; one unlock at a time per lock, none while its job is
  watched (kept in `/data`), none within 30 s of another job on the same
  bridge (checked before the read and right before sending).
- Locking is never blocked: no queue, no read, one try through a pause or a
  stop, possible before the first read after a restart, and it cancels every
  unlock of the lock not sent yet (a job igloohome accepted cannot be
  cancelled: said in the guides).
- Commands sent within 3.5 s or refused unsent, never answered done: a job
  accepted is "sent, without confirmation"; every job is watched until
  igloohome says it was processed ("result not read"), or igloohome's own
  time (the Date header) is past its expiry date, or 15 min ("result
  unknown"); an unlock sent before a lock and processed too raises an alert
  kept until the next command, whatever the order. The jobs watched and the
  alerts survive a restart; a watch that ended while stopped shows "result
  unknown".
- Any refusal of the token endpoint but 429/5xx is a final stop (credentials
  refused or rights missing), lifted by other credentials or a success of
  the test button; a client without the unlock right still reads and locks.
  429/5xx pause from 1 min to 6 h; all kept in `/data`. Reads never sooner
  than the interval (15 min by default).
- After a restart, the last successful read kept in `/data` gives the
  Discovery tab at once, and the "connected" status and the badges when the
  last read before the restart succeeded.
- English and French texts and guides, cover image.
