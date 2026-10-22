# TODO — igloohome v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own, no forum post from a module session.

## Status

- [x] **Milestone 1 — core** (2026-10-22): OAuth2 client credentials (token
      in memory, renewal timer, one request at a time), device list every
      15 min (300 s–1 day), devices battery/sync age/lock/unlock/last command,
      bridge jobs with their status read back, safety rules, stops and
      pauses in /data, badges, test button, en/fr, docs, cover. Tested
      against a fake igloohome cloud only. The store validator was not run
      by the dev agent (it cannot: to run in the real terminal).
- [ ] **Milestone 2 — real account**: run against a real iglooaccess client,
      lock and bridge (see "To check"); turn the answers (anonymized) into
      fixtures.
- [ ] **Milestone 3 — more**: the lock state through `BRIDGE_JOB_GET_DEVICE_STATUS`
      (10) and the access logs through `BRIDGE_JOB_GET_ACTIVITY_LOGS` (15) once
      their `jobResponse` is known (each costs a bridge job: 2 a minute);
      the further pages of `GET /devices` once the cursor parameter is known;
      PIN codes (algoPIN) if asked.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public.

## To check on a real account

- The token: `expires_in` (assumed present, else the JWT `exp`, else 1 h);
  the error codes of `auth.igloohome.co` (Cognito-like `invalid_client`,
  `invalid_scope`); whether an API client gets the four scopes asked.
- `GET /devices`: the fields (batteryLevel null for a bridge, lastSync
  format), `nextCursor` and the name of the cursor parameter, whether a
  padlock or a key box is `type: "Lock"`.
- A job: how fast `completed` turns true, whether `completed` also means
  "succeeded" (a lock out of reach: completed with an error in `jobResponse`,
  or never completed?), the `expiryDate`, the answer when the bridge is
  offline (HTTP status?).
- Rate limits and billing: none documented beyond "2 jobs a minute per
  bridge"; a 429 may come.

## Decisions

- **Not a duplicate** (checked 2026-10-22, lot 13 proposal): no igloohome
  service in the Gladys core, none in the store, the forum thread 10385 or on
  GitHub.
- **Reference reused: keithle888/igloohome-api** (MIT, 0.1.2, the library of
  Home Assistant), with the Home Assistant integration (Apache-2.0) for the
  entity choices. Python: ported, credited in the README and
  `THIRD_PARTY_NOTICES.md` (full MIT notice, copied into the image). Only
  runtime dependency: the SDK.
- **Official API, no app imitation**: an API client of the iglooaccess portal,
  its own client id and secret, no User-Agent or key of an app.
- **Least scopes**: only `get-devices`, `lock-bridge-proxied-job`,
  `unlock-bridge-proxied-job`, `get-job-status` are asked (igloohome-api asks
  every scope, PIN creation included).
- **Identity rule** (frozen, sets the external ids): the `deviceId` of
  igloohome (the one Home Assistant keys on), never the `id` nor the name. A
  device without a valid deviceId (`[A-Za-z0-9_-]{1,64}`) is skipped; a
  missing name shows `igloohome <deviceId>`.
- **No lock state**: igloohome gives none without a bridge job (Home
  Assistant shows an assumed state). None is invented: Gladys shows the
  last command and its read-back result. So the unlock decision rests on the
  fresh read of the device list (the lock still listed, as a `Lock`, linked to
  a bridge), not on a lock position.
- **Buttons, never a switch nor a commandable lock/binary**: `button/push` for
  Lock and Unlock, so a "turn everything off" (voice assistants, scenes) never
  reaches them; `text/text` read only for the last command.
- **Hours since the last sync** (`duration/integer`, unit `hours`, a unit the
  core lists for the category) instead of a date: usable in a scene. Battery
  `battery/integer` in `percent`.
- **"Sent, without confirmation"** for a job accepted by igloohome: the bridge
  has 2 minutes to run it; the ack is a success only when one status read
  inside the ack (if 500 ms are left) shows it completed. Then the status is
  read at 5, 15, 30, 60, 100 and 140 s (none during a pause or a stop); the
  last-command text says completed or expired.
- **Unlock guard**: set in `beforeSend`, before the first byte, kept in /data
  (2.5 min at most), lifted only by the end of its own job (completed or
  expired) or its expiry; an answered refusal (4xx, 429) lifts it at once (no
  job). A request that may have arrived (timeout, 5xx, answer not understood)
  keeps it.
- **Bridge spacing**: igloohome support says a bridge takes about 2 jobs a
  minute: an unlock is refused within 30 s of the last job on its bridge
  (kept in /data); a lock always gets its one try.
- **Lock without a read**: protective, so never behind a read nor a queue; it
  uses the bridge of the last read, or of /data after a restart. Its token:
  the current one if valid 10 s more, else one request within the deadline
  (joined if a renewal is under way, never waited for past it). A failed lock
  is not resent by itself (each job costs bridge time): the user presses
  again.
- **Unlock and the token**: refused when the token is not valid 60 s more (a
  token request inside 3.5 s would leave too little time); a renewal starts in
  the background (at most one a minute). The renewal timer renews 5 min
  before the expiry, only while a lock with its buttons is created (no
  traffic otherwise).
- **Stops**: `invalid_client` or a 401 of the token endpoint -> credentials
  refused, spaced tries 1 h, 6 h, 24 h; `invalid_scope`, `unauthorized_client`,
  or a 401/403 of the API right after a fresh token -> a final stop (no
  automatic try; the test button or other credentials). The test button tries
  once through a stop, which is lifted only by a success. Commands never set
  a stop (the reads decide).
- **Interval 15 min** (300 s–1 day): battery and sync change slowly, and
  igloohome may bill the API use; Home Assistant reads hourly.
- **Only the first page** of `GET /devices`: the name of the cursor parameter
  is not documented in the reference; a wrong guess could loop on the same
  page. The status says when `nextCursor` is set.
- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (the template's 1.0.0 replaced); the
  first patch release gives 0.1.1.
- **LICENSE**: the standard Apache-2.0 text, appendix placeholder, no personal
  name; `THIRD_PARTY_NOTICES.md` with the full MIT notice of igloohome-api;
  both copied into the image.
