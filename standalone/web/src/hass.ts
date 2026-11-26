/**
 * A stand-in for Home Assistant's `hass` object, holding only what the card reads.
 *
 * Requests the card would send to Home Assistant's REST API go to this app's backend, which
 * answers in the same shape. There is no WebSocket connection, so the card falls back to REST
 * for events and has no live updates; writes are refused until the backend supports them.
 */

export interface StandaloneConfig {
  locale: {
    language: string;
    time_zone: string;
    time_format: string;
    first_weekday: string;
    country: string | null;
  };
  card: Record<string, unknown>;
  calendars: Array<{ entity_id: string; name: string; supported_features: number }>;
}

/**
 * Builds the `hass` object.
 *
 * @param config - What `GET /api/config` returned
 * @returns The object to hand the card and its dialogs
 */
export function createHass(config: StandaloneConfig): Record<string, unknown> {
  const states: Record<string, unknown> = {};
  const entities: Record<string, unknown> = {};
  for (const calendar of config.calendars) {
    states[calendar.entity_id] = {
      entity_id: calendar.entity_id,
      state: 'off',
      attributes: {
        friendly_name: calendar.name,
        supported_features: calendar.supported_features,
      },
      last_changed: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      context: { id: '', parent_id: null, user_id: null },
    };
    entities[calendar.entity_id] = { entity_id: calendar.entity_id, labels: [] };
  }

  const darkMode = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

  return {
    states,
    entities,
    devices: {},
    areas: {},
    services: {},
    language: config.locale.language,
    locale: {
      language: config.locale.language,
      time_format: config.locale.time_format,
      first_weekday: config.locale.first_weekday,
      // Home Assistant's setting: show times in the server's zone, which is `config.time_zone`.
      time_zone: 'server',
    },
    config: {
      time_zone: config.locale.time_zone,
      country: config.locale.country,
    },
    user: { id: 'standalone', name: '', is_admin: false },
    themes: { darkMode },
    translationMetadata: { translations: {} },

    callApi: async (method: string, path: string, parameters?: object): Promise<unknown> => {
      const response = await fetch(`api/${path}`, {
        method,
        headers: parameters ? { 'content-type': 'application/json' } : undefined,
        body: parameters ? JSON.stringify(parameters) : undefined,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message ?? `${method} ${path} answered ${response.status}`);
      }
      return response.json();
    },

    callWS: async (message: { type: string }): Promise<never> => {
      throw new Error(`Not supported in the standalone app yet: ${message.type}`);
    },

    callService: (domain: string, service: string): void => {
      console.info(`[standalone] Ignored Home Assistant service call ${domain}.${service}`);
    },

    // The card passes Home Assistant translation keys through here and falls back to its own
    // strings when the answer is empty.
    localize: (): string => '',
  };
}
