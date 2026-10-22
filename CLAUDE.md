# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "unlock"  # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # cover.png
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI runs `format:check`, `lint` and `test` on Node 22 and 24, and builds
the Docker image.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js, before connect())
src/handlers.js                   the SDK handlers -> IglooApp
src/app.js                        IglooApp: polling, devices, badges, commands and their safety rules
src/client.js                     igloohome API: OAuth2 token, device list, bridge jobs, job status
src/http.js                       HTTPS transport (bounded answers, beforeSend once TLS is up), IglooError
src/igloo.js                      answers -> devices, jobs (pure, bounded, no prototype pollution)
src/devices.js                    devices -> Gladys devices and states (pure)
src/store.js                      /data: pauses, stops, last read, bridges, guards (bounded when read back)
src/publisher.js                  states to Gladys within 300/min
src/config.js                     DEFAULT_CONFIG (mirror the manifest defaults) + normalization
src/constants.js, src/i18n.js     API constants, timings; en/fr texts
scripts/cover.mjs                 cover.png, plain Node
test/                             node --test: SDK fake Gladys + fake igloohome cloud
```

## Safety rules (locks)

Locking is always allowed and never blocked: no queue, no read before, one try
through a 429/5xx pause or a stop, possible before the first read after a
restart (bridges in /data), and it cancels every unlock of the lock not sent
yet. Unlocking (`allow_unlock`) stays off by default; it is checked on
arrival, after the fresh read of the device list and in `beforeSend`; one at a
time per lock; refused while an unlock job of the lock is watched or its
guard holds (set before the first byte, kept in /data, 15.5 min at most),
within 30 s of another job on the same bridge (before the read, after it and
in `beforeSend`), when the token would need a renewal or lacks the unlock
scope, during a pause or a stop, or past 3.5 s. A command is never acked
done: a job accepted is "sent, without confirmation"; every job is watched to
its own end ("processed, result not read", "expired" only from a read after
its expiry date, else "result unknown" at 15 min), and an unlock processed
after a later lock raises an alert. Never weaken these rules. Never a
`switch` or a commandable `binary` for a lock.

## Account rules

- The client secret and the token are never logged, published, put in an
  error or written to /data; only the salted fingerprint of a REFUSED pair.
- Any refusal of the token endpoint but 429/5xx: a final stop (credentials
  refused or rights missing), no automatic try, lifted by other credentials
  or a success of the test button. The unlock scope is asked only while
  `allow_unlock` is on. 429/5xx: a pause (1 min to 6 h) in /data.
- Reads are never sooner than the interval (the time is written to /data
  before the read). A reconnection to Gladys resends status, Discovery and
  badges, and clears no pause nor stop.

## Rules

- **External ids are forever**: `gladys.externalIds('igloohome', deviceId)`,
  the deviceId igloohome gives the device. Feature keys (`battery`,
  `sync_age`, `lock`, `unlock`, `last_command`), manifest keys: frozen.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release); 0.1.0 was
  set by hand once. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`.
- **User-facing text** is bilingual (English and French), docs in sync.
- **Text files** are UTF-8 without BOM; `test/encoding.test.js` refuses
  mojibake, control bytes, and a secret said encrypted.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
