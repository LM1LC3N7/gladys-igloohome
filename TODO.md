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
- [x] **Review 1 fixes** (2026-10-22): B1 (no "expired" without a read
      after the expiry date, watch and guard until then), I1 (never "done"),
      I2 (every job watched to its end, late-unlock alert), I3 (restart from
      the last success), I4 (final stops), I5 (unlock scope only when
      allowed), M1 to M13.
- [x] **Approval 1 fixes** (2026-10-22): R1 (expiry compared with
      igloohome's Date header), R2 (late-unlock alert whatever the order,
      kept in /data), R3 (a failed last read not restored as connected), R4
      ("result unknown" for a command whose watch ended while stopped).
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
  `get-job-status`, and `unlock-bridge-proxied-job` while unlocking is
  allowed (igloohome-api asks every scope, PIN creation included).
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
- **Never "done" before milestone 2** (review 1, I1): what `completed` means
  (succeeded, or only processed) and the form of `jobResponse` are unknown.
  Every command is acked "sent, without confirmation", even a job completed
  at once; a completed job reads "processed by the bridge (result not read:
  check the lock)". Only the key names of `jobResponse` are logged (at most
  10, never the values), for milestone 2. Then only: success when
  `jobResponse` says so.
- **Job watch** (review 1, B1, I2, M6, M7, M10): every job accepted is
  watched to its own end, whatever the commands after it: status reads at 5,
  15, 30, 60, 100, 140 s, then every minute; "expired" only when a read made
  after its `expiryDate` gives `completed` false; the watch ends after an
  answered read past the expiry date (+1 min), or 15 min after the job left
  ("result unknown: check the lock"; the 2-minute life of igloohome support
  is not trusted). A read that does not happen (pause, stop) or fails goes on
  until the 15 min, after the pause. A status about another job id is
  ignored. A 429 there pauses the account; a 5xx only skips that read. The
  jobs watched are kept in /data (20 at most, 15 min at most) and resumed
  after a restart. The text follows the latest command of the lock; an unlock
  processed after a lock sent later raises an alert ("press Lock again"),
  never a resend.
- **igloohome's time for the expiry** (approval 1, R1): `expiryDate` is
  compared with the `Date` header of the same answer (a date more than a day
  from our clock is ignored), never with the clock of Gladys; without a
  readable Date, never "expired" (the watch runs its 15 min). The expiry is
  turned into our clock with that answer's offset for the end of the watch.
- **Late-unlock alert** (approval 1, R2): when a lock leaves, the unlock jobs
  of that lock still watched are marked `beforeLock` (in /data); if one ends
  processed, the lock gets an alert (in /data) shown with every last-command
  text until the next command of the lock, whatever the order of the reads
  and across a restart.
- **Restart** (approval 1, R3, R4): "connected" and cloud badges are restored
  only when `okAt >= lastAttemptAt` (the last read succeeded; `okAt` written
  at every success); else "the last read before a restart failed". A job
  whose 15-minute watch ended while stopped, when it was the latest command
  of its lock, shows "result unknown".
- **Unlock guard**: set in `beforeSend`, before the first byte, written to
  /data right after (a stop waits for the writes), bounded by the watch
  (15.5 min); lifted only by the end of its own job. While any unlock job of
  the lock is watched, no other unlock. An answered refusal (4xx, 429) lifts
  it at once (no job); a request that may have arrived (timeout, 5xx, answer
  not understood) keeps it until its bound.
- **Bridge spacing**: igloohome support says a bridge takes about 2 jobs a
  minute: an unlock is refused within 30 s of the last job on its bridge
  (kept in /data), checked on the known bridge before the read (no read for
  nothing), on the bridge read, and again in `beforeSend` (two locks of one
  bridge); a lock always gets its one try.
- **Lock without a read**: protective, so never behind a read nor a queue; it
  uses the bridge of the last read, or of /data after a restart. Its token:
  the current one if valid 10 s more, else its own request within the
  deadline (it joins a request under way only when it left less than 1 s
  ago: an older one may hang). A failed lock is not resent by itself (each
  job costs bridge time): the user presses again. A job igloohome accepted
  cannot be cancelled (no API): said in the guides.
- **Unlock and the token**: refused when the token is not valid 60 s more (a
  token request inside 3.5 s would leave too little time); a renewal starts in
  the background (at most one a minute). The renewal timer renews 5 min
  before the expiry, only while a lock with its buttons is created (no
  traffic otherwise).
- **Stops** (review 1, I4, lesson of lot 12: "any authentication error not
  clearly transient is final and persisted; never an automatic new try; the
  test button lifts the refusal only after a success"): every refusal of the
  token endpoint but 429/5xx/network (`invalid_client`, 400 whatever the
  code, 401, 403) -> credentials refused; `invalid_scope`,
  `unauthorized_client`, or a 401/403 of the API right after a fresh token ->
  rights missing. Both final: no timer, a restart included; lifted by other
  credentials (even saved while stopped) or a success of the test button
  (one try; within an interval of the last try it says so). Lock keeps its
  one try. Commands never set a stop (the reads decide). The former spaced
  tries (1 h, 6 h, 24 h, from gladys-schlage) were dropped: they bring
  nothing (a rotated secret is fixed by saving the new one).
- **Unlock scope only when allowed** (review 1, I5): `unlock-bridge-proxied-job`
  is asked only while "Allow unlocking" is on; changing the option drops the
  token and asks a new one in the background. A client lacking that right
  with the option on: the token is asked once more without it, the status
  says "unlock right missing", unlocks are refused, reads and locks work.
  The test button asks the right again.
- **Restart** (review 1, I3): the last success (`okAt`) and a bounded summary
  of the device list (ids, types, names, battery, sync, bridge: no secret)
  are kept in /data, so the status ("connected, last successful read N ago"),
  the Discovery tab and the badges come back at once; its values are never
  republished as new states. A client id changed while stopped reads at once
  (M9). A start reconfigures the client before any await, and a new
  generation after them (M1): a command or answer of the old credentials
  writes nothing.
- **Token expiry** (M5): a finite `expires_in` > 0 is taken as is (bounded to
  a day), else a future `exp`, else 1 h.
- **Configuration read at the start** (M12): asked again after 5 s, 30 s,
  2 min, 10 min, then no more (a reconnection asks again).
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
