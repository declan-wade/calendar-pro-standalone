# Calendar Pro Standalone

Calendar Pro Standalone runs **[Calendar Card Pro](https://github.com/alexpfau/calendar-card-pro)**
without [Home Assistant](https://www.home-assistant.io). You can open it in a browser, run it in
Docker, or use it as a desktop app. It reads your calendars from ICS feeds and CalDAV servers, and
shows them in the card's List, Columns, Grid and Month views.

## Credit

The calendar itself, including its views, editor, translations and design, is
**[Calendar Card Pro](https://github.com/alexpfau/calendar-card-pro) by
[Alex Pfau](https://github.com/alexpfau) and its contributors**. This repository is an unofficial
fork. It adds a backend, a page and a desktop shell around the card, and builds the card's source
as it is.

This project is not affiliated with or endorsed by the Calendar Card Pro project or Home Assistant.
Please report problems with this fork here, not upstream.

- Original project: <https://github.com/alexpfau/calendar-card-pro>
- Its documentation, covering every card option: <https://calendar-card-pro.alexpfau.com>
- Support the original author:
  [Buy Me a Coffee](https://www.buymeacoffee.com/alexpfau) ·
  [GitHub Sponsors](https://github.com/sponsors/alexpfau)
- Upstream's own README is kept unchanged in [`UPSTREAM_README.md`](UPSTREAM_README.md).

Calendar Card Pro credits the following, and so does this fork (details in [`NOTICE`](NOTICE)):

- The original calendar design by [@kdw2060](https://github.com/kdw2060), shared in
  [Calendar Add-on & Calendar Designs](https://community.home-assistant.io/t/calendar-add-on-some-calendar-designs/385790).
- [Home Assistant Frontend](https://github.com/home-assistant/frontend), whose components and Tile
  Card interaction patterns the card draws on.
- [Lit](https://github.com/lit/lit/), which the card is built with.
- The grid view design proposed by [@lenaxia](https://github.com/lenaxia) in
  [issue #339](https://github.com/alexpfau/calendar-card-pro/issues/339).

## What this fork adds

- **A backend for your calendars.** It reads ICS feeds and CalDAV calendars, such as Fastmail,
  iCloud and Nextcloud, and expands recurring events. It answers in the same shape as Home
  Assistant's calendar API, so the card works without changes.
- **A settings page.** It covers calendars, region and time zone, notifications, every card option
  (through the card's own visual editor), the server, and the raw YAML. Changes are saved to
  `config.yaml`, and its comments are kept.
- **A desktop app built with [Tauri 2](https://v2.tauri.app).** The backend is bundled inside it.
  CalDAV passwords are kept in the system keychain. It can notify you before events start.
- **Docker.** There is a Dockerfile and a Compose example for running it on a server.

The app is read-only for now. Adding, editing and moving events is not wired up yet. See
[What does not work outside Home Assistant](standalone/README.md#what-does-not-work-outside-home-assistant).

## Getting started

Everything specific to this fork lives in [`standalone/`](standalone/). Its
[README](standalone/README.md) covers building, configuration, Docker, the desktop app and the
settings page.

```sh
npm install                 # the card's dependencies (repository root)
cd standalone
npm install
npm run build               # builds the card, the page and the server
cp examples/config.example.yaml config.yaml
npm start                   # http://localhost:8080
```

For the desktop app, run `npm run tauri dev` or `npm run tauri build` from `standalone/`. This
needs Rust and Tauri's [prerequisites](https://v2.tauri.app/start/prerequisites/).

Desktop builds for macOS (Apple silicon), Windows and Linux are attached to this repository's
[releases](https://github.com/declan-wade/calendar-pro-standalone/releases), under tags named
`standalone-vX.Y.Z`. They are not signed, so the operating system will warn before the first
launch.

## Repository layout

| Path                                 | What it is                                                      |
| ------------------------------------ | --------------------------------------------------------------- |
| `src/`, `tests/`, `docs/`            | Calendar Card Pro, as upstream has it                           |
| `standalone/server/`                 | The Node backend: ICS, CalDAV, settings API, notifications      |
| `standalone/web/`                    | The page: loads the card, stands in for Home Assistant's `hass` |
| `standalone/src-tauri/`              | The desktop app's Rust shell                                    |
| `standalone/desktop/`                | Desktop start-up page and the sidecar build script              |
| `.github/workflows/standalone-*.yml` | This fork's CI and release workflows                            |

The card's source is left as upstream wrote it, so changes from upstream can be merged in
cleanly. Upstream's workflows, `AGENTS.md` and `CONTRIBUTING.md` describe the card itself.

## Licence

MIT. Calendar Card Pro is copyright (c) 2025 Alex Pfau, and its licence is kept in
[`LICENSE`](LICENSE). Third-party attributions are listed in [`NOTICE`](NOTICE). The standalone
code in `standalone/` is released under the same licence.
