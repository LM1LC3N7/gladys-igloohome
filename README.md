# gladys-igloohome

A [Gladys Assistant](https://gladysassistant.com) external integration for
**igloohome** locks, padlocks, key boxes and keypads, through the official
igloohome API (igloodeveloper, an API client of the iglooaccess portal).

- Battery and hours since the last sync of every device of the account.
- Lock and Unlock buttons for a lock linked to an igloohome bridge, and the
  result of the last command read back from igloohome.
- Unlocking is **off by default**; locking is always allowed.

Unofficial, **not affiliated with igloohome**. **Never tested with a real
device** nor a real account.

User guide: [English](docs/en.md) · [Français](docs/fr.md).

## How it works

- `GET /devices` every 15 minutes by default (300 s to 1 day), one request for
  the whole account, never sooner than the interval.
- The commands are bridge jobs (`POST /devices/{id}/jobs/bridges/{bridge}`),
  confirmed by their status (`GET /jobs/{id}`).
- OAuth2 client credentials: the token stays in memory, renewed by a timer 5
  minutes before it expires (only while a lock with its buttons is created).
- The safety rules of the commands are in [CLAUDE.md](CLAUDE.md) and the
  [guide](docs/en.md#the-commands-and-their-safety).

## Development

```bash
npm install
npm run format:check
npm run lint
npm test
npm run audit
npm run cover        # regenerates cover.png (800×534)
npx --yes github:GladysAssistant/integration-store .
```

The tests run against the fake Gladys of the SDK and a fake igloohome cloud
(`test/helpers/fakeIgloo.js`): no network.

## Credits

Ported from [keithle888/igloohome-api](https://github.com/keithle888/igloohome-api)
(MIT) and the igloohome integration of
[Home Assistant](https://github.com/home-assistant/core) (Apache-2.0). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Licence

[Apache-2.0](LICENSE).
