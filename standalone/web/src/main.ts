/**
 * Starts the standalone app: reads the configuration from the backend, builds the `hass`
 * stand-in, and mounts the card.
 */

import { installDialogHost } from './dialog-host';
import { defineHaElements } from './ha-elements';
import { createHass, type StandaloneConfig } from './hass';

const CARD_TAG = 'calendar-card-pro';

interface CardElement extends HTMLElement {
  setConfig(config: Record<string, unknown>): void;
  hass?: unknown;
}

async function start(): Promise<void> {
  const root = document.getElementById('app')!;
  defineHaElements();

  const response = await fetch('api/config');
  if (!response.ok) throw new Error(`Could not read the configuration (${response.status})`);
  const config = (await response.json()) as StandaloneConfig;
  document.documentElement.lang = config.locale.language;

  const hass = createHass(config);
  installDialogHost(() => hass);

  await customElements.whenDefined(CARD_TAG);
  const card = document.createElement(CARD_TAG) as CardElement;
  // Home Assistant calls setConfig before it hands over hass.
  card.setConfig({ type: `custom:${CARD_TAG}`, ...config.card });
  card.hass = hass;
  root.replaceChildren(card);
}

start().catch((error: Error) => {
  const root = document.getElementById('app')!;
  const box = document.createElement('div');
  box.className = 'standalone-error';
  box.textContent = error.message;
  root.replaceChildren(box);
  console.error(error);
});
