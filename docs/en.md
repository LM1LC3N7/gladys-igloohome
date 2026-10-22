# igloohome for Gladys Assistant

This integration brings the igloohome devices of your account (locks,
padlocks, key boxes, keypads) into Gladys through the **official igloohome
API** (igloodeveloper), the one Home Assistant uses.

> Unofficial integration, **not affiliated with igloohome**.
>
> Never tested with a real device nor a real account: only against a fake
> igloohome server in the tests. Your feedback is welcome.

## What you get

For each device of the account (the bridges are not shown):

- **Battery** (%), when igloohome gives it;
- **Hours since the last sync**: the age of the last sync of the device with
  igloohome (handy for a "lock silent for 48 h" scene).

And for a **lock linked to a bridge**:

- a **Lock** button (always allowed);
- an **Unlock** button (off by default, see below);
- **Last command**: the result of the last command, read back from igloohome
  ("job completed by the bridge", "not confirmed, the job expired"…).

igloohome **gives no locked/unlocked state** for a lock: the integration does
not invent one (Home Assistant shows an assumed state).

## What you need

1. One or more igloohome locks paired in the igloohome app, and an
   **igloohome bridge** to command them (without a bridge: battery and sync
   only).
2. An **API client** created in the **iglooaccess** portal (an offer mostly
   aimed at businesses): it gives a _client id_ and a _client secret_. The
   client needs the scopes `get-devices`, `lock-bridge-proxied-job`,
   `unlock-bridge-proxied-job` and `get-job-status`. **igloohome may bill the
   use of the API** (for instance per active device and per month): check the
   terms of your offer.

## Configuration

- **Client id** and **Client secret**: those of the API client. The secret is
  kept by Gladys in its database, never shown again, sent only to igloohome
  (`auth.igloohome.co`) to get an access token. The token stays in the memory
  of the container, never written to disk.
- **Allow unlocking the locks from Gladys**: off by default. On, a scene, a
  dashboard or a voice assistant connected to Gladys can open your door.
- **Refresh interval**: 900 s (15 min) by default, from 300 s to 86,400 s.
  One request per read for the whole account.
- **Language of the feature names**.

Save, then add the devices from the **Discovery** tab.

## The commands and their safety

igloohome commands a lock **through its bridge**, as a "job" the bridge runs
within 2 minutes (it takes about 2 a minute).

- **Unlock** is refused while the option is off; the option is checked again
  on arrival, after the read and right before sending. Before acting, the
  device list is **read again from igloohome**: the lock must still be in it,
  as a lock, linked to a bridge. One unlock at a time per lock; none while the
  previous one may still be waiting for its bridge (2 min 30, kept across a
  restart); none within 30 s of another job on the same bridge.
- **Lock** is never blocked: no read before, no queue, one try even during a
  pause asked by igloohome, and possible right after a restart (the bridge of
  each lock is kept in `/data`). It cancels at once every unlock of that lock
  not sent yet.
- A command leaves within 3.5 s of your click, or is refused without sending
  anything. A job accepted by igloohome is answered "Command sent, without
  confirmation": the confirmation then comes from the status of the job, read
  a few times over 2 min 20, and shows in **Last command**. When the job is
  already completed at the answer, the command is confirmed at once.
- The buttons are never switches: a "turn everything off" of a voice assistant
  or a scene cannot reach them.

## Errors and rate limits

- **Credentials refused**: a stop kept in `/data`, a new try in 1 h, 6 h, then
  every 24 h; at once with other credentials; the **Test the connection**
  button tries once and lifts the stop only on a success.
- **Missing scopes**: a final stop, no automatic new try, until the test
  button or other credentials.
- **HTTP 429 or 5xx**: a pause of 1 min to 6 h kept in `/data` (locking still
  gets one try).
- Other errors: a new try in 1, 2, 5, then 15 min, never sooner than the
  interval. The test button, the Discovery tab, a reconnection to Gladys or a
  restart never read sooner than the interval.

## What is kept in `/data`

The file `igloohome-state.json` (readable by the container user only) keeps:
the pauses, the stops (with the salted fingerprint of **refused** credentials,
never of good ones), the time of the last read, the igloohome ids of the locks
and their bridges, the unlock guards. Never the secret nor the token.

## Known limits

- No locked/unlocked state (the API gives none without a bridge job), no
  access log nor PIN code in this version.
- Only the first page of the device list is read (a message says so when
  igloohome gives more).
- The exact meaning of "job completed" (succeeded, or only ended) is still to
  be checked on a real account.

## Credits

Logic ported from [igloohome-api](https://github.com/keithle888/igloohome-api)
(MIT) and from the igloohome integration of Home Assistant (Apache-2.0): see
`THIRD_PARTY_NOTICES.md`.
