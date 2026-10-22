# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the projects below. The ported parts were
rewritten in JavaScript; they are changed from the originals (another
language, another structure, only what this integration needs). None of the
original code is copied as is.

## igloohome-api

- Project: [keithle888/igloohome-api](https://github.com/keithle888/igloohome-api),
  the Python library for the igloohome API (version 0.1.2), the one of the
  Home Assistant integration.
- What is ported (in `src/constants.js`, `src/client.js` and `src/igloo.js`):
  the OAuth2 token endpoint (`auth.igloohome.co/oauth2/token`, client
  credentials in HTTP Basic, the scope names), the API base URL
  (`api.igloodeveloper.co/igloohome`), the device list (`GET /devices`) and
  its fields, the bridge jobs (`POST /devices/{id}/jobs/bridges/{bridge}`,
  job types 1 lock and 2 unlock), the job status (`GET /jobs/{id}`) and its
  fields, the device types (`Bridge`, `Lock`, `Keypad`).
- Licence: MIT. Its notice, as in its `LICENSE` file:

```text
MIT License

Copyright (c) 2024 Keith Leow

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Home Assistant — igloohome integration

- Project: [home-assistant/core](https://github.com/home-assistant/core),
  `homeassistant/components/igloohome`, by the Home Assistant authors.
- What is ported: the choice of entities (a battery for every device that
  gives one, lock and unlock for a `Lock` linked to a bridge), the search of
  the bridge a lock is linked to (`get_linked_bridge`), the deviceId as the
  identity of a device, and the fact that igloohome gives no lock state.
- Licence: Apache License 2.0, the text of the `LICENSE` file shipped with
  this integration (Home Assistant ships no `NOTICE` file).
