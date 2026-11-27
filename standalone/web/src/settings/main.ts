/**
 * The settings page: everything config.yaml holds, in sections.
 *
 * - Calendars: where events come from (ICS feeds and CalDAV accounts, with their passwords)
 * - Region and time: language, time zone, time format, first day of the week, country
 * - Notifications: desktop notifications for upcoming events, and which calendars get them
 * - Card: every option the card has, through the card's own visual editor, with a preview
 * - Data and server: how often calendars are fetched, the port, and the file itself
 * - YAML: the whole file as text, for anything the forms do not cover
 *
 * Changes are held as a draft until Save, which sends the whole configuration to the backend.
 * The backend checks it, writes the file (keeping its comments) and applies it straight away.
 */

import { css, html, LitElement, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { parse, stringify } from 'yaml';
import { CARD_LANGUAGES } from '../../../../src/translations/language-codes';
import { installDialogHost } from '../dialog-host';
import { defineHaElements } from '../ha-elements';
import { createHass, type StandaloneConfig } from '../hass';
import { loadCard, useConfiguredTimeZone } from '../load-card';
import { defineHaForm } from './ha-form';

type Plain = Record<string, unknown>;

interface Calendar {
  id: string;
  name?: string;
  type: 'ics' | 'caldav';
  url?: string;
  server_url?: string;
  username?: string;
  password_env?: string;
  calendar?: string;
  /** False to leave this calendar's events out of notifications. */
  notify?: boolean;
  [key: string]: unknown;
}

interface SettingsResponse {
  config: Plain | null;
  path: string;
  error: string | null;
  passwords: Record<string, 'typed' | 'environment' | 'missing'>;
  server_time_zone: string;
  port: number;
  port_from_environment: boolean;
  /** Whether the server runs inside the desktop app, which shows notifications. */
  notifications_available?: boolean;
}

interface CheckResult {
  ok: boolean;
  message: string;
  calendars?: string[];
  feed_name?: string;
}

type Section = 'calendars' | 'region' | 'notifications' | 'card' | 'data' | 'yaml';

const SECTIONS: ReadonlyArray<{ id: Section; title: string; summary: string }> = [
  { id: 'calendars', title: 'Calendars', summary: 'ICS feeds and CalDAV accounts' },
  { id: 'region', title: 'Region and time', summary: 'Language, time zone, formats' },
  { id: 'notifications', title: 'Notifications', summary: 'Reminders for upcoming events' },
  { id: 'card', title: 'Card', summary: 'Views, layout, events, colours, toolbar' },
  { id: 'data', title: 'Data and server', summary: 'Refresh, port, the file' },
  { id: 'yaml', title: 'YAML', summary: 'The whole file as text' },
];

/** CalDAV addresses for common providers, offered as suggestions. */
const CALDAV_SERVERS: ReadonlyArray<{ label: string; url: string; note: string }> = [
  {
    label: 'Fastmail',
    url: 'https://caldav.fastmail.com/dav/',
    note: 'Use an app password with CalDAV access (Settings, Privacy & Security, App passwords).',
  },
  {
    label: 'iCloud',
    url: 'https://caldav.icloud.com/',
    note: 'Use your Apple ID and an app-specific password from account.apple.com.',
  },
  {
    label: 'Nextcloud',
    url: 'https://your-server/remote.php/dav/',
    note: 'Replace your-server with your Nextcloud address. An app password is recommended.',
  },
];

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** Two-letter region codes, for the country list. */
const REGIONS = (() => {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const codes: Array<{ code: string; name: string }> = [];
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = names.of(code);
      if (name && name !== code) codes.push({ code, name });
    }
  }
  return codes.sort((x, y) => x.name.localeCompare(y.name));
})();

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'calendar'
  );
}

/** The calendar ids an `entities` list names, whichever form each entry takes. */
function entityIds(entities: unknown): string[] {
  if (!Array.isArray(entities)) return [];
  return entities
    .map((entry) => (typeof entry === 'string' ? entry : (entry as { entity?: unknown })?.entity))
    .filter((id): id is string => typeof id === 'string');
}

interface CardEditor extends HTMLElement {
  hass?: unknown;
  setConfig(config: Plain): void;
}

interface CardElement extends HTMLElement {
  hass?: unknown;
  setConfig(config: Plain): void;
}

interface CardConstructor {
  getConfigElement(): Promise<HTMLElement>;
}

declare global {
  interface Window {
    __TAURI__?: { core?: { invoke(command: string, args?: unknown): Promise<unknown> } };
  }
}

class StandaloneSettings extends LitElement {
  static override properties = {
    _loaded: { state: true },
    _section: { state: true },
    _draft: { state: true },
    _saving: { state: true },
    _status: { state: true },
    _checks: { state: true },
    _yamlText: { state: true },
    _yamlError: { state: true },
    _cardError: { state: true },
    _expanded: { state: true },
    _testStatus: { state: true },
  };

  private _loaded = false;
  private _info: SettingsResponse | null = null;
  private _saved: Plain = {};
  private _draft: Plain = {};
  /** Passwords typed since the last save, by `password_env`. Never shown again once typed. */
  private _passwords: Record<string, string> = {};
  private _section: Section = 'calendars';
  private _saving = false;
  private _status: { kind: 'ok' | 'error' | 'info'; text: string } | null = null;
  private _checks: Record<number, CheckResult | 'checking'> = {};
  private _yamlText = '';
  private _yamlError = '';
  private _cardError = '';
  /** Calendar rows open for editing, by position. */
  private _expanded = new Set<number>();
  /** What the test notification button last reported. */
  private _testStatus: { kind: 'ok' | 'error' | 'info'; text: string } | null = null;
  private _editor: CardEditor | null = null;
  private _preview: CardElement | null = null;
  private _liveConfig: StandaloneConfig | null = null;
  private _resolveReady: () => void = () => {};
  /** Settled once loading is done and the page keeps time in the configured zone. */
  private _ready: Promise<void> = new Promise((resolve) => (this._resolveReady = resolve));
  /** The `hass` stand-in last handed to the editor and preview, for the preview's popovers. */
  currentHass: Record<string, unknown> | null = null;

  static override styles = css`
    :host {
      display: block;
      min-height: 100vh;
      color: var(--primary-text-color);
      font-family: var(--ha-font-family-body);
      font-size: 14px;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 3;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 20px;
      background: var(--card-background-color);
      border-bottom: 1px solid var(--divider-color);
    }
    header h1 {
      font-size: 18px;
      font-weight: 500;
      margin: 0;
      flex: 1;
    }
    a {
      color: var(--primary-color);
    }
    header a {
      text-decoration: none;
    }
    .dirty {
      color: var(--secondary-text-color);
      font-size: 13px;
    }
    .layout {
      display: grid;
      grid-template-columns: 220px minmax(0, 1fr);
      max-width: 1400px;
      margin: 0 auto;
    }
    nav {
      position: sticky;
      top: 57px;
      align-self: start;
      padding: 16px 8px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    nav button {
      text-align: left;
      border: none;
      background: transparent;
      padding: 8px 12px;
      border-radius: 8px;
      cursor: pointer;
      color: inherit;
      font: inherit;
    }
    nav button small {
      display: block;
      color: var(--secondary-text-color);
      font-size: 12px;
    }
    nav button[aria-current='page'] {
      background: rgba(var(--rgb-primary-color), 0.12);
      color: var(--primary-color);
    }
    main {
      padding: 20px 24px 80px;
      min-width: 0;
    }
    h2 {
      font-size: 20px;
      font-weight: 500;
      margin: 0 0 4px;
    }
    h3 {
      font-size: 15px;
      font-weight: 500;
      margin: 0 0 8px;
    }
    .lead {
      color: var(--secondary-text-color);
      margin: 0 0 20px;
      max-width: 70ch;
    }
    .group {
      background: var(--card-background-color);
      border: 1px solid var(--divider-color);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .fields {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 14px 16px;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .field > span:first-child {
      font-size: 13px;
      color: var(--secondary-text-color);
    }
    .hint {
      font-size: 12px;
      color: var(--secondary-text-color);
    }
    input,
    select,
    textarea {
      font: inherit;
      color: var(--primary-text-color);
      background: var(--primary-background-color);
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      padding: 7px 9px;
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
    }
    textarea {
      font-family: var(--code-font-family);
      font-size: 13px;
      min-height: 60vh;
      resize: vertical;
    }
    button.action,
    button.primary {
      font: inherit;
      border: 1px solid var(--divider-color);
      background: transparent;
      color: var(--primary-text-color);
      border-radius: 8px;
      padding: 7px 14px;
      cursor: pointer;
    }
    button.primary {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: var(--text-primary-color);
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    label.check {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }
    label.check input {
      width: auto;
      margin: 0;
    }
    .calendar {
      border: 1px solid var(--divider-color);
      border-radius: 10px;
      margin-bottom: 10px;
      background: var(--card-background-color);
    }
    .calendar-head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      cursor: pointer;
    }
    .calendar-head .name {
      font-weight: 500;
    }
    .calendar-head .meta {
      color: var(--secondary-text-color);
      font-size: 12px;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .badge {
      font-size: 11px;
      border: 1px solid var(--divider-color);
      border-radius: 999px;
      padding: 1px 8px;
      color: var(--secondary-text-color);
    }
    .calendar-body {
      padding: 4px 12px 14px;
      border-top: 1px solid var(--divider-color);
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .segmented {
      display: inline-flex;
      border: 1px solid var(--divider-color);
      border-radius: 8px;
      overflow: hidden;
    }
    .segmented button {
      font: inherit;
      border: none;
      background: transparent;
      color: inherit;
      padding: 6px 14px;
      cursor: pointer;
    }
    .segmented button[aria-pressed='true'] {
      background: rgba(var(--rgb-primary-color), 0.14);
      color: var(--primary-color);
    }
    .message {
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 13px;
    }
    .message.ok {
      background: rgba(67, 160, 71, 0.12);
    }
    .message.error {
      background: rgba(219, 68, 55, 0.12);
    }
    .message.info {
      background: rgba(var(--rgb-primary-color), 0.1);
    }
    details.advanced summary {
      cursor: pointer;
      color: var(--secondary-text-color);
      font-size: 13px;
    }
    details.advanced[open] summary {
      margin-bottom: 10px;
    }
    .card-layout {
      display: grid;
      grid-template-columns: minmax(340px, 1fr) minmax(300px, 1fr);
      gap: 20px;
      align-items: start;
    }
    .preview {
      position: sticky;
      top: 77px;
    }
    .editor-host {
      background: var(--card-background-color);
      border: 1px solid var(--divider-color);
      border-radius: 12px;
      padding: 8px;
      min-height: 200px;
    }
    footer {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 3;
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 10px;
      padding: 10px 20px;
      background: var(--card-background-color);
      border-top: 1px solid var(--divider-color);
    }
    footer .status {
      flex: 1;
      font-size: 13px;
    }
    footer .status.error {
      color: var(--error-color);
    }
    @media (max-width: 1000px) {
      .card-layout {
        grid-template-columns: minmax(0, 1fr);
      }
      .preview {
        position: static;
      }
    }
    @media (max-width: 700px) {
      .layout {
        grid-template-columns: minmax(0, 1fr);
      }
      nav {
        position: static;
        flex-direction: row;
        overflow-x: auto;
        padding: 8px;
      }
      nav button small {
        display: none;
      }
      main {
        padding: 12px 16px 90px;
      }
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    const fromHash = window.location.hash.slice(1) as Section;
    if (SECTIONS.some((section) => section.id === fromHash)) this._section = fromHash;
    window.addEventListener('beforeunload', this._warnUnsaved);
    void this._load();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('beforeunload', this._warnUnsaved);
  }

  private _warnUnsaved = (event: BeforeUnloadEvent): void => {
    if (this._dirty) event.preventDefault();
  };

  private get _dirty(): boolean {
    return !same(this._draft, this._saved) || Object.keys(this._passwords).length > 0;
  }

  private get _calendars(): Calendar[] {
    return (Array.isArray(this._draft.calendars) ? this._draft.calendars : []) as Calendar[];
  }

  private get _locale(): Plain {
    return (this._draft.locale as Plain | undefined) ?? {};
  }

  private get _card(): Plain {
    return (this._draft.card as Plain | undefined) ?? {};
  }

  private get _notifications(): Plain {
    return (this._draft.notifications as Plain | undefined) ?? {};
  }

  //---------------------------------------------------------------------------
  // LOADING AND SAVING
  //---------------------------------------------------------------------------

  private async _load(): Promise<void> {
    const response = await fetch('api/settings');
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      this._status = {
        kind: 'error',
        text: body.message ?? `Settings answered ${response.status}`,
      };
      this._loaded = true;
      this._resolveReady();
      return;
    }
    this._info = body as SettingsResponse;
    this._saved = this._info.config ?? {};
    this._draft = clone(this._saved);
    if (this._info.error) {
      this._status = {
        kind: 'error',
        text: `The configuration file has a problem: ${this._info.error}`,
      };
    } else if (!this._info.config) {
      this._status = { kind: 'info', text: 'No configuration yet. Add a calendar to begin.' };
      this._expanded = new Set();
    }
    this._loaded = true;

    // The calendar page's view of the saved configuration, for the card's editor and preview.
    const live = await fetch('api/config');
    if (live.ok) {
      this._liveConfig = (await live.json()) as StandaloneConfig;
      useConfiguredTimeZone(this._liveConfig.locale);
    }
    this._resolveReady();
  }

  private _setDraft(next: Plain): void {
    this._draft = next;
    if (this._status?.kind === 'ok') this._status = null;
  }

  private _discard(): void {
    this._draft = clone(this._saved);
    this._passwords = {};
    this._status = null;
    this._checks = {};
    this._syncEditor(true);
  }

  private async _save(): Promise<void> {
    if (this._section === 'yaml' && !this._applyYaml()) return;
    this._saving = true;
    this._status = { kind: 'info', text: 'Saving…' };
    const passwords = { ...this._passwords };
    try {
      // In the desktop app, passwords go to the OS credential store, where it reads them next
      // time it starts. Elsewhere the server keeps them until it stops.
      const invoke = window.__TAURI__?.core?.invoke;
      if (invoke && Object.keys(passwords).length > 0) {
        await invoke('save_passwords', { passwords });
      }
      const response = await fetch('api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: this._draft, passwords }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        this._status = {
          kind: 'error',
          text: body.message ?? `Saving answered ${response.status}`,
        };
        return;
      }
      const timeZoneChanged = !same(
        (this._saved.locale as Plain | undefined)?.time_zone,
        this._locale.time_zone,
      );
      this._saved = clone(this._draft);
      this._passwords = {};
      const kept = invoke
        ? 'Passwords are saved in the keychain.'
        : Object.keys(passwords).length > 0
          ? 'Typed passwords last until the server stops; set their environment variables to keep them.'
          : '';
      this._status = {
        kind: 'ok',
        text: [
          'Saved.',
          body.restart_needed ? 'Restart the server for the new port.' : '',
          timeZoneChanged ? 'Reload the page for the new time zone.' : '',
          kept,
        ]
          .filter(Boolean)
          .join(' '),
      };
      await this._refreshLive();
    } catch (error) {
      this._status = { kind: 'error', text: (error as Error).message };
    } finally {
      this._saving = false;
    }
  }

  /** Reads the saved configuration again, so the card's editor and preview see new calendars. */
  private async _refreshLive(): Promise<void> {
    const [settings, live] = await Promise.all([fetch('api/settings'), fetch('api/config')]);
    if (settings.ok) this._info = (await settings.json()) as SettingsResponse;
    if (live.ok) this._liveConfig = (await live.json()) as StandaloneConfig;
    this._syncEditor(true);
    this.requestUpdate();
  }

  //---------------------------------------------------------------------------
  // RENDERING
  //---------------------------------------------------------------------------

  protected override render(): TemplateResult {
    if (!this._loaded) return html`<p style="padding:20px">Loading settings…</p>`;
    return html`
      <header>
        <h1>Settings</h1>
        ${this._dirty ? html`<span class="dirty">Unsaved changes</span>` : nothing}
        <a href="./">Back to calendar</a>
      </header>
      <div class="layout">
        <nav aria-label="Settings sections">
          ${SECTIONS.map(
            (section) =>
              html`<button
                type="button"
                aria-current=${section.id === this._section ? 'page' : 'false'}
                @click=${() => this._go(section.id)}
              >
                ${section.title}<small>${section.summary}</small>
              </button>`,
          )}
        </nav>
        <main>${this._renderSection()}</main>
      </div>
      <footer>
        <span class="status ${this._status?.kind ?? ''}" role="status"
          >${this._status?.text ?? ''}</span
        >
        <button
          class="action"
          type="button"
          ?disabled=${!this._dirty || this._saving}
          @click=${this._discard}
        >
          Discard
        </button>
        <button
          class="primary"
          type="button"
          ?disabled=${!this._dirty || this._saving}
          @click=${this._save}
        >
          Save
        </button>
      </footer>
    `;
  }

  private _go(section: Section): void {
    if (this._section === 'yaml' && section !== 'yaml' && !this._applyYaml()) return;
    this._section = section;
    history.replaceState(null, '', `#${section}`);
    if (section === 'yaml') {
      this._yamlText = stringify(this._draft, { lineWidth: 0 });
      this._yamlError = '';
    }
  }

  private _renderSection(): TemplateResult {
    switch (this._section) {
      case 'calendars':
        return this._renderCalendars();
      case 'region':
        return this._renderRegion();
      case 'notifications':
        return this._renderNotifications();
      case 'card':
        return this._renderCard();
      case 'data':
        return this._renderData();
      case 'yaml':
        return this._renderYaml();
    }
  }

  //---------------------------------------------------------------------------
  // CALENDARS
  //---------------------------------------------------------------------------

  private _renderCalendars(): TemplateResult {
    const calendars = this._calendars;
    return html`
      <h2>Calendars</h2>
      <p class="lead">
        Where events come from. Each calendar is an ICS feed or a calendar on a CalDAV server. How
        each one looks on the card (colour, icon, label, which ones show) is under
        <a href="#card" @click=${(e: Event) => (e.preventDefault(), this._go('card'))}>Card</a>.
      </p>
      ${calendars.map((calendar, index) => this._renderCalendar(calendar, index))}
      <div class="row">
        <button class="action" type="button" @click=${() => this._addCalendar('ics')}>
          Add ICS feed
        </button>
        <button class="action" type="button" @click=${() => this._addCalendar('caldav')}>
          Add CalDAV calendar
        </button>
      </div>
    `;
  }

  private _renderCalendar(calendar: Calendar, index: number): TemplateResult {
    const open = this._expanded.has(index);
    const where =
      calendar.type === 'ics'
        ? (calendar.url ?? '')
        : [calendar.username, calendar.calendar].filter(Boolean).join(' · ');
    const check = this._checks[index];
    return html`<div class="calendar">
      <div
        class="calendar-head"
        role="button"
        tabindex="0"
        aria-expanded=${open}
        @click=${() => this._toggle(index)}
        @keydown=${(e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && this._toggle(index)}
      >
        <span class="name">${calendar.name || calendar.id}</span>
        <span class="badge">${calendar.type === 'ics' ? 'ICS' : 'CalDAV'}</span>
        <span class="meta">${where}</span>
        <span aria-hidden="true">${open ? '▾' : '▸'}</span>
      </div>
      ${
        open
          ? html`<div class="calendar-body">
              <div class="fields">
                ${this._input(
                  'Name',
                  calendar.name ?? '',
                  (value) => this._renameCalendar(index, value),
                  'Shown in the legend and the event popover.',
                )}
                <div class="field">
                  <span>Source</span>
                  <div class="segmented" role="group" aria-label="Source">
                    ${(['ics', 'caldav'] as const).map(
                      (type) =>
                        html`<button
                          type="button"
                          aria-pressed=${calendar.type === type}
                          @click=${() => this._changeType(index, type)}
                        >
                          ${type === 'ics' ? 'ICS feed' : 'CalDAV'}
                        </button>`,
                    )}
                  </div>
                </div>
              </div>
              ${calendar.type === 'ics' ? this._renderIcs(calendar, index) : this._renderCaldav(calendar, index)}
              ${
                check
                  ? html`<div
                      class="message ${check === 'checking' ? 'info' : check.ok ? 'ok' : 'error'}"
                    >
                      ${check === 'checking' ? 'Checking…' : check.message}
                    </div>`
                  : nothing
              }
              <details class="advanced">
                <summary>Advanced</summary>
                <div class="fields">
                  ${this._input(
                    'Calendar id',
                    calendar.id,
                    (value) => this._changeId(index, value),
                    'How the card refers to it: calendar. followed by lowercase letters, digits and _. Changing it updates the card configuration too.',
                  )}
                  ${
                    calendar.type === 'caldav'
                      ? this._input(
                          'Password variable',
                          calendar.password_env ?? '',
                          (value) => this._updateCalendar(index, { password_env: value }),
                          'The environment variable (or keychain entry, in the desktop app) that holds the password. Calendars on one account can share it.',
                        )
                      : nothing
                  }
                </div>
              </details>
              <div class="row">
                <button class="action" type="button" @click=${() => this._check(index)}>
                  ${calendar.type === 'ics' ? 'Test feed' : 'Connect and list calendars'}
                </button>
                <span style="flex:1"></span>
                <button
                  class="action"
                  type="button"
                  ?disabled=${index === 0}
                  @click=${() => this._move(index, -1)}
                >
                  Move up
                </button>
                <button
                  class="action"
                  type="button"
                  ?disabled=${index === this._calendars.length - 1}
                  @click=${() => this._move(index, 1)}
                >
                  Move down
                </button>
                <button class="action" type="button" @click=${() => this._removeCalendar(index)}>
                  Remove
                </button>
              </div>
            </div>`
          : nothing
      }
    </div>`;
  }

  private _renderIcs(calendar: Calendar, index: number): TemplateResult {
    return html`<div class="fields">
      ${this._input(
        'Feed address',
        calendar.url ?? '',
        (value) => this._updateCalendar(index, { url: value }),
        'An https:// or webcal:// address, such as Google’s secret address in iCal format or a published Outlook calendar. Read-only.',
        'url',
      )}
    </div>`;
  }

  private _renderCaldav(calendar: Calendar, index: number): TemplateResult {
    const env = calendar.password_env ?? '';
    const typed = env in this._passwords;
    const source = this._info?.passwords[env];
    const inDesktop = !!window.__TAURI__;
    const passwordState = typed
      ? 'New password, saved when you press Save.'
      : source === 'typed'
        ? 'Set in this session.'
        : source === 'environment'
          ? inDesktop
            ? 'Saved in the keychain.'
            : `Read from the environment variable ${env}.`
          : 'Not set yet.';
    const provider = CALDAV_SERVERS.find((each) => each.url === calendar.server_url);
    const check = this._checks[index];
    const found = check && check !== 'checking' ? check.calendars : undefined;
    return html`<div class="fields">
      <label class="field">
        <span>Server address</span>
        <input
          type="url"
          list="caldav-servers"
          .value=${calendar.server_url ?? ''}
          @change=${(e: Event) =>
            this._updateCalendar(index, { server_url: (e.target as HTMLInputElement).value })}
        />
        <datalist id="caldav-servers">
          ${CALDAV_SERVERS.map((each) => html`<option value=${each.url}>${each.label}</option>`)}
        </datalist>
        <span class="hint"
          >${provider?.note ?? 'Pick a provider or type your server’s CalDAV address.'}</span
        >
      </label>
      ${this._input(
        'User name',
        calendar.username ?? '',
        (value) => this._updateCalendar(index, { username: value }),
        'Usually your email address.',
        'text',
        'username',
      )}
      <label class="field">
        <span>Password</span>
        <input
          type="password"
          autocomplete="new-password"
          placeholder=${source && source !== 'missing' ? '••••••••' : ''}
          .value=${this._passwords[env] ?? ''}
          @change=${(e: Event) => this._typePassword(index, (e.target as HTMLInputElement).value)}
        />
        <span class="hint"
          >${passwordState} The password is never written to the configuration file.</span
        >
      </label>
      <label class="field">
        <span>Calendar on the server</span>
        ${
          found?.length
            ? html`<select
                @change=${(e: Event) =>
                  this._updateCalendar(index, { calendar: (e.target as HTMLSelectElement).value })}
              >
                ${
                  calendar.calendar && !found.includes(calendar.calendar)
                    ? html`<option selected value=${calendar.calendar}>
                        ${calendar.calendar} (not found)
                      </option>`
                    : nothing
                }
                ${!calendar.calendar ? html`<option selected value="">Choose a calendar</option>` : nothing}
                ${found.map(
                  (name) =>
                    html`<option value=${name} ?selected=${name === calendar.calendar}>
                      ${name}
                    </option>`,
                )}
              </select>`
            : html`<input
                .value=${calendar.calendar ?? ''}
                @change=${(e: Event) =>
                  this._updateCalendar(index, { calendar: (e.target as HTMLInputElement).value })}
              />`
        }
        <span class="hint">Its name as the server shows it. Connect to choose from a list.</span>
      </label>
    </div>`;
  }

  private _input(
    label: string,
    value: string,
    change: (value: string) => void,
    hint?: string,
    type = 'text',
    autocomplete = 'off',
  ): TemplateResult {
    return html`<label class="field">
      <span>${label}</span>
      <input
        type=${type}
        autocomplete=${autocomplete}
        .value=${value}
        @change=${(e: Event) => change((e.target as HTMLInputElement).value.trim())}
      />
      ${hint ? html`<span class="hint">${hint}</span>` : nothing}
    </label>`;
  }

  private _toggle(index: number): void {
    const next = new Set(this._expanded);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    this._expanded = next;
  }

  private _writeCalendars(calendars: Calendar[], card?: Plain): void {
    const next: Plain = { ...this._draft, calendars };
    if (card) next.card = card;
    this._setDraft(next);
    this._syncEditor(false);
  }

  private _updateCalendar(index: number, patch: Partial<Calendar>): void {
    const calendars = [...this._calendars];
    const updated = { ...calendars[index], ...patch } as Calendar;
    for (const [key, value] of Object.entries(patch)) {
      if (value === '' || value === undefined) delete updated[key];
    }
    calendars[index] = updated;
    const checks = { ...this._checks };
    delete checks[index];
    this._checks = checks;
    this._writeCalendars(calendars);
  }

  private _uniqueId(base: string, except?: number): string {
    const taken = new Set(this._calendars.filter((_, at) => at !== except).map((each) => each.id));
    let id = `calendar.${base}`;
    for (let n = 2; taken.has(id); n++) id = `calendar.${base}_${n}`;
    return id;
  }

  private _addCalendar(type: 'ics' | 'caldav'): void {
    const index = this._calendars.length;
    const name = type === 'ics' ? 'New feed' : 'New calendar';
    const calendar: Calendar = { id: this._uniqueId(slug(name)), name, type };
    if (type === 'caldav') {
      // A second calendar on an account already listed shares its login.
      const previous = [...this._calendars].reverse().find((each) => each.type === 'caldav');
      if (previous) {
        calendar.server_url = previous.server_url;
        calendar.username = previous.username;
        calendar.password_env = previous.password_env;
      } else {
        calendar.server_url = CALDAV_SERVERS[0].url;
        calendar.password_env = this._passwordName(calendar.id);
      }
    }
    this._expanded = new Set([...this._expanded, index]);
    this._writeCalendars([...this._calendars, calendar], this._withEntity(calendar.id));
  }

  /** The card's `entities` with a new calendar added, when the card lists them explicitly. */
  private _withEntity(id: string): Plain | undefined {
    const card = this._card;
    if (!Array.isArray(card.entities)) return undefined;
    return { ...card, entities: [...card.entities, id] };
  }

  private _passwordName(id: string): string {
    return `CALDAV_${id.slice('calendar.'.length).toUpperCase()}_PASSWORD`;
  }

  private _renameCalendar(index: number, name: string): void {
    const calendar = this._calendars[index];
    const isNew = !((this._saved.calendars as Calendar[] | undefined) ?? []).some(
      (each) => each.id === calendar.id,
    );
    // A calendar not saved yet takes its id from its name; a saved one keeps its id, which the
    // card's configuration and saved device state refer to.
    if (isNew && name) {
      this._updateCalendar(index, { name });
      this._changeId(index, this._uniqueId(slug(name), index));
    } else {
      this._updateCalendar(index, { name });
    }
  }

  private _changeId(index: number, id: string): void {
    const calendars = [...this._calendars];
    const old = calendars[index].id;
    if (id === old || !id) return;
    const updated: Calendar = { ...calendars[index], id };
    // A password variable named after the old id follows it.
    if (updated.password_env === this._passwordName(old)) {
      const shared = calendars.some(
        (each, at) => at !== index && each.password_env === updated.password_env,
      );
      if (!shared) {
        updated.password_env = this._passwordName(id);
        if (old && this._passwords[this._passwordName(old)] !== undefined) {
          this._passwords[updated.password_env] = this._passwords[this._passwordName(old)];
          delete this._passwords[this._passwordName(old)];
        }
      }
    }
    calendars[index] = updated;
    const card = this._card;
    const entities = Array.isArray(card.entities)
      ? card.entities.map((entry) =>
          entry === old
            ? id
            : entry && typeof entry === 'object' && (entry as Plain).entity === old
              ? { ...(entry as Plain), entity: id }
              : entry,
        )
      : undefined;
    this._writeCalendars(calendars, entities ? { ...card, entities } : undefined);
  }

  private _changeType(index: number, type: 'ics' | 'caldav'): void {
    const calendar = this._calendars[index];
    if (calendar.type === type) return;
    const { url, server_url, username, password_env, calendar: remote, ...rest } = calendar;
    void url;
    void server_url;
    void username;
    void password_env;
    void remote;
    const next: Calendar = { ...rest, type };
    if (type === 'caldav') {
      next.server_url = CALDAV_SERVERS[0].url;
      next.password_env = this._passwordName(calendar.id);
    }
    const calendars = [...this._calendars];
    calendars[index] = next;
    this._writeCalendars(calendars);
  }

  private _typePassword(index: number, password: string): void {
    const calendar = this._calendars[index];
    let env = calendar.password_env;
    if (!env) {
      env = this._passwordName(calendar.id);
      this._updateCalendar(index, { password_env: env });
    }
    const next = { ...this._passwords };
    if (password) next[env] = password;
    else delete next[env];
    this._passwords = next;
    this.requestUpdate();
  }

  private _move(index: number, by: number): void {
    const calendars = [...this._calendars];
    const [item] = calendars.splice(index, 1);
    calendars.splice(index + by, 0, item);
    const expanded = new Set<number>();
    for (const at of this._expanded) {
      expanded.add(at === index ? index + by : at === index + by ? index : at);
    }
    this._expanded = expanded;
    this._checks = {};
    this._writeCalendars(calendars);
  }

  private _removeCalendar(index: number): void {
    const calendar = this._calendars[index];
    if (!confirm(`Remove ${calendar.name || calendar.id}?`)) return;
    const calendars = this._calendars.filter((_, at) => at !== index);
    const card = this._card;
    const entities = Array.isArray(card.entities)
      ? card.entities.filter((entry) => !entityIds([entry]).includes(calendar.id))
      : undefined;
    this._expanded = new Set(
      [...this._expanded].filter((at) => at !== index).map((at) => (at > index ? at - 1 : at)),
    );
    this._checks = {};
    this._writeCalendars(calendars, entities ? { ...card, entities } : undefined);
  }

  private async _check(index: number): Promise<void> {
    const calendar = this._calendars[index];
    this._checks = { ...this._checks, [index]: 'checking' };
    try {
      const response = await fetch('api/settings/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          calendar,
          password: calendar.password_env ? this._passwords[calendar.password_env] : undefined,
        }),
      });
      const result = (await response.json()) as CheckResult;
      this._checks = { ...this._checks, [index]: result };
      // A feed's own name replaces the placeholder name of a new feed.
      if (result.feed_name && calendar.name === 'New feed') {
        this._renameCalendar(index, result.feed_name);
        this._checks = { ...this._checks, [index]: result };
      }
    } catch (error) {
      this._checks = { ...this._checks, [index]: { ok: false, message: (error as Error).message } };
    }
  }

  //---------------------------------------------------------------------------
  // REGION AND TIME
  //---------------------------------------------------------------------------

  private _setLocale(key: string, value: string | null): void {
    const locale = { ...this._locale };
    if (value === null || value === '') delete locale[key];
    else locale[key] = value;
    const next = { ...this._draft };
    if (Object.keys(locale).length) next.locale = locale;
    else delete next.locale;
    this._setDraft(next);
  }

  private _renderRegion(): TemplateResult {
    const locale = this._locale;
    const zones = Intl.supportedValuesOf('timeZone');
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const serverZone = this._info?.server_time_zone ?? browserZone;
    const zone = typeof locale.time_zone === 'string' ? locale.time_zone : '';
    const languages = new Intl.DisplayNames(['en'], { type: 'language' });
    const now = new Date();
    const example = (timeZone: string) =>
      new Intl.DateTimeFormat('en-AU', {
        timeZone,
        hour: 'numeric',
        minute: '2-digit',
        weekday: 'short',
      }).format(now);
    const select = (
      key: string,
      label: string,
      options: Array<{ value: string; label: string }>,
      hint: string,
      fallback: string,
    ) => {
      const value = typeof locale[key] === 'string' ? (locale[key] as string) : '';
      return html`<label class="field">
        <span>${label}</span>
        <select
          @change=${(e: Event) => this._setLocale(key, (e.target as HTMLSelectElement).value)}
        >
          <option value="" ?selected=${value === ''}>${fallback}</option>
          ${
            value && !options.some((option) => option.value === value)
              ? html`<option selected value=${value}>${value}</option>`
              : nothing
          }
          ${options.map(
            (option) =>
              html`<option value=${option.value} ?selected=${option.value === value}>
                ${option.label}
              </option>`,
          )}
        </select>
        <span class="hint">${hint}</span>
      </label>`;
    };
    return html`
      <h2>Region and time</h2>
      <p class="lead">
        How dates and times read, for every view. The card can override the language under Card.
      </p>
      <div class="group">
        <h3>Time zone</h3>
        <div class="fields">
          <label class="field">
            <span>Show times in</span>
            <select
              @change=${(e: Event) => this._setLocale('time_zone', (e.target as HTMLSelectElement).value)}
            >
              <option value="" ?selected=${zone === ''}>
                This computer’s time zone (${browserZone})
              </option>
              ${zones.map(
                (each) =>
                  html`<option value=${each} ?selected=${each === zone}>
                    ${each.replace(/_/g, ' ')}
                  </option>`,
              )}
            </select>
            <span class="hint">
              ${
                zone
                  ? `Now ${example(zone)} there. Events, the current-time line and "today" follow this zone.`
                  : `Events follow the zone of the computer showing the page.`
              }
              ${
                !zone && serverZone !== browserZone
                  ? ` Events without a zone of their own are read in the server’s zone, ${serverZone}.`
                  : ''
              }
            </span>
          </label>
        </div>
      </div>
      <div class="group">
        <h3>Language and formats</h3>
        <div class="fields">
          ${select(
            'language',
            'Language',
            CARD_LANGUAGES.map((code) => ({
              value: code,
              label: `${languages.of(code) ?? code} (${code})`,
            })),
            'The card’s words, and the default for dates and times.',
            'English (en), the default',
          )}
          ${select(
            'time_format',
            'Time format',
            [
              { value: 'language', label: 'As the language writes it' },
              { value: '12', label: '12-hour (2:30 pm)' },
              { value: '24', label: '24-hour (14:30)' },
            ],
            'As Home Assistant’s profile setting.',
            'As the language writes it (default)',
          )}
          ${select(
            'first_weekday',
            'First day of the week',
            [
              { value: 'language', label: 'As the language has it' },
              ...WEEKDAYS.map((day) => ({
                value: day,
                label: day[0].toUpperCase() + day.slice(1),
              })),
            ],
            'For the month view, week numbers and “this week”. The card’s own First day of week, under Card, can override it.',
            'As the language has it (default)',
          )}
          ${select(
            'country',
            'Country',
            REGIONS.map((region) => ({
              value: region.code,
              label: `${region.name} (${region.code})`,
            })),
            'Used by the card where it needs a country, such as for regional defaults.',
            'None',
          )}
        </div>
      </div>
    `;
  }

  //---------------------------------------------------------------------------
  // NOTIFICATIONS
  //---------------------------------------------------------------------------

  /** Sets one key of `notifications`; undefined removes it, and the mapping when it is empty. */
  private _setNotification(key: string, value: unknown): void {
    const notifications = { ...this._notifications };
    if (value === undefined) delete notifications[key];
    else notifications[key] = value;
    const next = { ...this._draft };
    if (Object.keys(notifications).length) next.notifications = notifications;
    else delete next.notifications;
    this._setDraft(next);
  }

  private _renderNotifications(): TemplateResult {
    const notifications = this._notifications;
    const enabled = notifications.enabled === true;
    const minutes = notifications.minutes_before;
    const allDayAt = typeof notifications.all_day_at === 'string' ? notifications.all_day_at : '';
    const available = !!this._info?.notifications_available;
    const zone =
      typeof this._locale.time_zone === 'string'
        ? this._locale.time_zone
        : (this._info?.server_time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    const calendars = this._calendars;
    return html`
      <h2>Notifications</h2>
      <p class="lead">
        A desktop notification before each event starts. Times follow the time zone under
        <a href="#region" @click=${(e: Event) => (e.preventDefault(), this._go('region'))}
          >Region and time</a
        >, now ${zone.replace(/_/g, ' ')}. Clicking a notification brings the calendar forward.
      </p>
      ${
        available
          ? nothing
          : html`<div class="message info" style="margin-bottom:16px">
              Notifications are shown by the desktop app. This server is not running inside it, so
              these settings are saved but nothing is shown.
            </div>`
      }
      <div class="group">
        <h3>When</h3>
        <div class="fields">
          <label class="check">
            <input
              type="checkbox"
              .checked=${enabled}
              @change=${(e: Event) =>
                this._setNotification(
                  'enabled',
                  (e.target as HTMLInputElement).checked ? true : undefined,
                )}
            />
            <span>Notify me about upcoming events</span>
          </label>
        </div>
        <div class="fields" style="margin-top:14px">
          <label class="field">
            <span>Minutes before a timed event</span>
            <input
              type="number"
              min="0"
              max="1440"
              step="1"
              placeholder="10"
              ?disabled=${!enabled}
              .value=${minutes === undefined ? '' : String(minutes)}
              @change=${(e: Event) => {
                const value = (e.target as HTMLInputElement).value;
                this._setNotification('minutes_before', value === '' ? undefined : Number(value));
              }}
            />
            <span class="hint"
              >Default 10. 0 notifies as the event starts; at most 1440 (a day).</span
            >
          </label>
          <div class="field">
            <label class="check">
              <input
                type="checkbox"
                ?disabled=${!enabled}
                .checked=${allDayAt !== ''}
                @change=${(e: Event) =>
                  this._setNotification(
                    'all_day_at',
                    (e.target as HTMLInputElement).checked ? '09:00' : undefined,
                  )}
              />
              <span>Notify about all-day events, at</span>
            </label>
            <input
              type="time"
              ?disabled=${!enabled || allDayAt === ''}
              .value=${allDayAt}
              @change=${(e: Event) => {
                const value = (e.target as HTMLInputElement).value;
                this._setNotification('all_day_at', value === '' ? undefined : value);
              }}
            />
            <span class="hint">On the day the event starts.</span>
          </div>
        </div>
      </div>
      <div class="group">
        <h3>Calendars</h3>
        ${
          calendars.length === 0
            ? html`<p class="hint" style="margin:0">No calendars yet.</p>`
            : html`<div class="fields">
                ${calendars.map(
                  (calendar, index) =>
                    html`<label class="check">
                      <input
                        type="checkbox"
                        ?disabled=${!enabled}
                        .checked=${calendar.notify !== false}
                        @change=${(e: Event) =>
                          this._updateCalendar(index, {
                            notify: (e.target as HTMLInputElement).checked ? undefined : false,
                          })}
                      />
                      <span>${calendar.name || calendar.id}</span>
                    </label>`,
                )}
              </div>`
        }
      </div>
      <div class="group">
        <h3>Check</h3>
        <div class="row">
          <button
            class="action"
            type="button"
            ?disabled=${!available || this._testStatus?.kind === 'info'}
            @click=${this._testNotification}
          >
            Send a test notification
          </button>
          ${
            this._testStatus
              ? html`<span class="message ${this._testStatus.kind}">${this._testStatus.text}</span>`
              : nothing
          }
        </div>
        <p class="hint">
          If nothing appears, allow notifications for Calendar Pro in the system’s settings (on
          macOS, System Settings, Notifications). Changes here take effect when you save.
        </p>
      </div>
    `;
  }

  private async _testNotification(): Promise<void> {
    this._testStatus = { kind: 'info', text: 'Sending…' };
    try {
      const response = await fetch('api/settings/notifications/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const body = await response.json().catch(() => ({}));
      this._testStatus = response.ok
        ? { kind: 'ok', text: 'Sent.' }
        : { kind: 'error', text: body.message ?? `The test answered ${response.status}` };
    } catch (error) {
      this._testStatus = { kind: 'error', text: (error as Error).message };
    }
  }

  //---------------------------------------------------------------------------
  // CARD
  //---------------------------------------------------------------------------

  private _renderCard(): TemplateResult {
    return html`
      <h2>Card</h2>
      <p class="lead">
        Every option the card has, through the card’s own editor: views (list, columns, grid,
        month), the calendars it shows and how each looks, events, dates, colours, the toolbar and
        actions. The preview shows saved calendars; save to see new ones. The options are documented
        at
        <a href="https://calendar-card-pro.alexpfau.com" target="_blank" rel="noopener"
          >calendar-card-pro.alexpfau.com</a
        >.
      </p>
      ${this._cardError ? html`<div class="message error">${this._cardError}</div>` : nothing}
      <div class="card-layout">
        <div class="editor-host" id="editor-host"></div>
        <div class="preview" id="preview-host"></div>
      </div>
    `;
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    if (this._section === 'card') void this._mountCard();
  }

  /** The `hass` stand-in for the editor and preview: the draft's calendars and locale. */
  private _hass(): Record<string, unknown> {
    const calendars = this._calendars.map((calendar) => ({
      entity_id: calendar.id,
      name: calendar.name ?? calendar.id,
      supported_features: 0,
    }));
    const locale = {
      language: (this._locale.language as string) ?? 'en',
      time_zone: (this._locale.time_zone as string) ?? this._info?.server_time_zone ?? 'UTC',
      time_zone_set: !!this._locale.time_zone,
      time_format: (this._locale.time_format as string) ?? 'language',
      first_weekday: (this._locale.first_weekday as string) ?? 'language',
      country: (this._locale.country as string) ?? null,
    };
    this.currentHass = createHass({ locale, card: this._card, calendars });
    return this.currentHass;
  }

  /** The card configuration as the card reads it: every calendar when it names none. */
  private _effectiveCard(): Plain {
    const card = this._card;
    return {
      type: 'custom:calendar-card-pro',
      ...card,
      entities: card.entities ?? this._calendars.map((calendar) => calendar.id),
    };
  }

  private async _mountCard(): Promise<void> {
    const editorHost = this.renderRoot.querySelector('#editor-host');
    const previewHost = this.renderRoot.querySelector('#preview-host');
    if (!editorHost || !previewHost) return;
    if (this._editor && editorHost.contains(this._editor)) return;
    try {
      // The card must load after the time zone is set.
      await this._ready;
      await loadCard();
      await customElements.whenDefined('calendar-card-pro');
      const Card = customElements.get('calendar-card-pro') as unknown as CardConstructor;
      if (!this._editor) {
        this._editor = (await Card.getConfigElement()) as CardEditor;
        this._editor.addEventListener('config-changed', (event) => {
          event.stopPropagation();
          this._cardChanged((event as CustomEvent).detail.config as Plain);
        });
      }
      if (!this._preview) {
        this._preview = document.createElement('calendar-card-pro') as CardElement;
      }
      editorHost.replaceChildren(this._editor);
      previewHost.replaceChildren(this._preview);
      this._syncEditor(true);
    } catch (error) {
      this._cardError = (error as Error).message;
    }
  }

  /** Hands the editor and the preview the draft. */
  private _syncEditor(configToo: boolean): void {
    const hass = this._hass();
    const config = this._effectiveCard();
    try {
      if (this._editor) {
        if (configToo) this._editor.setConfig(clone(config));
        this._editor.hass = hass;
      }
      if (this._preview) {
        this._preview.setConfig(clone(config));
        this._preview.hass = hass;
      }
      this._cardError = '';
    } catch (error) {
      this._cardError = (error as Error).message;
    }
  }

  private _cardChanged(config: Plain): void {
    const { type, ...card } = config;
    void type;
    // An `entities` list that is every calendar, in order, is what no list means; keep the file
    // without one if it had none, so new calendars keep showing.
    if (
      this._card.entities === undefined &&
      same(
        card.entities,
        this._calendars.map((calendar) => calendar.id),
      )
    ) {
      delete card.entities;
    }
    this._setDraft({ ...this._draft, card });
    if (this._preview) {
      try {
        this._preview.setConfig(clone(this._effectiveCard()));
        this._cardError = '';
      } catch (error) {
        this._cardError = (error as Error).message;
      }
    }
  }

  //---------------------------------------------------------------------------
  // DATA AND SERVER
  //---------------------------------------------------------------------------

  private _renderData(): TemplateResult {
    const refresh = this._draft.refresh_minutes;
    const inDesktop = !!window.__TAURI__;
    const portLocked = inDesktop || !!this._info?.port_from_environment;
    const setNumber = (key: string, value: string) => {
      const next = { ...this._draft };
      if (value === '') delete next[key];
      else next[key] = Number(value);
      this._setDraft(next);
    };
    return html`
      <h2>Data and server</h2>
      <p class="lead">How often calendars are fetched, and how the server runs.</p>
      <div class="group">
        <h3>Refreshing</h3>
        <div class="fields">
          <label class="field">
            <span>Fetch calendars every (minutes)</span>
            <input
              type="number"
              min="1"
              step="1"
              placeholder="5"
              .value=${refresh === undefined ? '' : String(refresh)}
              @change=${(e: Event) => setNumber('refresh_minutes', (e.target as HTMLInputElement).value)}
            />
            <span class="hint">
              How long the server keeps a fetched calendar before fetching it again. Default 5. The
              card’s own Refresh interval, under Card, sets how often the page asks the server.
            </span>
          </label>
        </div>
      </div>
      <div class="group">
        <h3>Server</h3>
        <div class="fields">
          <label class="field">
            <span>Port</span>
            <input
              type="number"
              min="1"
              max="65535"
              placeholder="8080"
              ?disabled=${portLocked}
              .value=${this._draft.port === undefined ? '' : String(this._draft.port)}
              @change=${(e: Event) => setNumber('port', (e.target as HTMLInputElement).value)}
            />
            <span class="hint">
              ${
                inDesktop
                  ? 'The desktop app picks its own port, so this is not used here.'
                  : this._info?.port_from_environment
                    ? 'Set by the PORT environment variable, which wins over this.'
                    : `Listening on ${this._info?.port}. A new port takes effect when the server restarts.`
              }
            </span>
          </label>
        </div>
      </div>
      <div class="group">
        <h3>Configuration file</h3>
        <p class="hint" style="margin:0 0 6px">Settings are saved to</p>
        <code>${this._info?.path}</code>
        <p class="hint">
          Comments in the file are kept where the values beside them stay. The previous version is
          kept as config.yaml.bak. Passwords are never written to it.
        </p>
      </div>
    `;
  }

  //---------------------------------------------------------------------------
  // YAML
  //---------------------------------------------------------------------------

  private _renderYaml(): TemplateResult {
    return html`
      <h2>YAML</h2>
      <p class="lead">
        The whole configuration as text. Changes here apply to the other sections when you leave
        this one, and are saved with Save.
      </p>
      ${this._yamlError ? html`<div class="message error">${this._yamlError}</div>` : nothing}
      <textarea
        spellcheck="false"
        aria-label="Configuration YAML"
        .value=${this._yamlText}
        @input=${(e: Event) => {
          this._yamlText = (e.target as HTMLTextAreaElement).value;
        }}
        @change=${() => this._applyYaml()}
      ></textarea>
    `;
  }

  /** Reads the YAML text into the draft. False when it does not parse. */
  private _applyYaml(): boolean {
    try {
      const value = parse(this._yamlText) ?? {};
      if (typeof value !== 'object' || Array.isArray(value))
        throw new Error('The file must be a mapping');
      this._yamlError = '';
      if (!same(value, this._draft)) {
        this._setDraft(value as Plain);
        this._expanded = new Set();
        this._checks = {};
        this._syncEditor(true);
      }
      return true;
    } catch (error) {
      this._yamlError = (error as Error).message;
      return false;
    }
  }
}

defineHaElements();
defineHaForm();
customElements.define('standalone-settings', StandaloneSettings);
installDialogHost(
  () => document.querySelector<StandaloneSettings>('standalone-settings')?.currentHass ?? null,
);
