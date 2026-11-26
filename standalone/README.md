# Calendar Pro Standalone

Runs [Calendar Card Pro](https://github.com/alexpfau/calendar-card-pro) as a web app of its own,
without Home Assistant. A small Node backend reads your calendars from ICS feeds and CalDAV
servers and answers in the shape Home Assistant's calendar API uses, so the card itself is built
from this repository unchanged.

Status: read-only. Events show in every view (List, Columns, Grid, Month), the event popover,
day panel and search work, and calendars refresh every `refresh_minutes`. Adding, editing and
moving events is not wired up yet.

## How it fits together

```text
browser                                         server (Node)
┌──────────────────────────────────────┐        ┌──────────────────────────────────┐
│ calendar-card-pro (upstream, as is)  │        │ GET /api/config                  │
│   ↕ hass stand-in (web/src/hass.ts)  │ ─────▶ │ GET /api/calendars               │
│ dialog host, ha-card/ha-icon stubs   │  HTTP  │ GET /api/calendars/<id>?start&end│
│ theme.css (Home Assistant variables) │        │   ICS feed / CalDAV → expanded   │
└──────────────────────────────────────┘        └──────────────────────────────────┘
```

- `web/` is the page: it loads the card bundle, builds a stand-in for Home Assistant's `hass`
  object, and provides the few Home Assistant pieces the card expects (`ha-card`, `ha-icon`,
  the `show-dialog` handler, theme variables).
- `server/` serves the page and the API. Recurring events are expanded on the server, including
  `EXDATE`, overridden occurrences and cancelled events, as Home Assistant does.

## Running it

Needs Node 22 or later.

```sh
cd standalone
npm install
npm run build          # builds the card (repository root), the page and the server
cp examples/config.example.yaml config.yaml
# edit config.yaml: your calendars, time zone and card options
npm start              # http://localhost:8080
```

`npm test` runs the server's tests after `npm run build:server`.

To try it with the sample calendar, serve `examples/` on port 8099 (for example
`python3 -m http.server 8099` from `examples/`) and start with
`CONFIG=examples/config.example.yaml npm start`.

### Docker

From the repository root:

```sh
docker build -f standalone/Dockerfile -t calendar-pro-standalone .
docker run -p 8080:8080 -v "$PWD/standalone/config.yaml:/config/config.yaml:ro" \
  -e FASTMAIL_APP_PASSWORD=... calendar-pro-standalone
```

`compose.example.yaml` does the same with Docker Compose.

## Configuration

See [`examples/config.example.yaml`](examples/config.example.yaml). In short:

- `calendars`: each has an `id` of the form `calendar.<name>`, a `name`, and a `type`:
  - `ics`: `url` of the feed (`webcal://` works).
  - `caldav`: `server_url`, `username`, `password_env` (the name of the environment variable
    that holds the password; the password itself never goes in the file) and `calendar` (the
    calendar's name on the server). For Fastmail, use `https://caldav.fastmail.com/dav/` and an
    app password with CalDAV access.
- `locale`: `language`, `time_zone` (IANA, such as `Australia/Perth`), `time_format`,
  `first_weekday`, `country`.
- `card`: the card's own options, exactly as in a Home Assistant dashboard. They are documented
  at <https://calendar-card-pro.alexpfau.com>. Calendars are referred to by the `id`s above.

There is no login. Run it on a trusted network, or put it behind a reverse proxy that
authenticates.

## What does not work outside Home Assistant

- Adding, editing, moving and deleting events (needs the backend's write endpoints).
- Live updates: changes appear after `refresh_minutes` or a press of the refresh button.
- The visual editor, which is built on Home Assistant's form component. Edit `config.yaml`.
- Weather, Home Assistant templates and conditions, entity colours from Home Assistant, map
  tiles in the event popover, and tap actions such as `more-info` or `navigate`.

## Credits and licence

Calendar Card Pro is by Alex Pfau and contributors, MIT licensed; see [`LICENSE`](../LICENSE)
and [`NOTICE`](../NOTICE) at the repository root. The standalone backend and shim in this
directory are MIT licensed as well.
