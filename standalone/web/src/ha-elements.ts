/**
 * Minimal versions of the Home Assistant elements the card renders: `ha-card`, `ha-icon` and
 * `ha-ripple`. Each is defined only if nothing else has defined it.
 */

type IconSet = Record<string, string>;
let iconSet: Promise<IconSet> | null = null;

/** Material Design Icons' paths, loaded on first use since the set is large. */
function loadIcons(): Promise<IconSet> {
  iconSet ??= import('@mdi/js') as unknown as Promise<IconSet>;
  return iconSet;
}

/** `mdi:calendar-clock` to `mdiCalendarClock`, the name `@mdi/js` exports. */
function exportName(icon: string): string | null {
  const match = /^mdi:([a-z0-9-]+)$/.exec(icon.trim());
  if (!match) return null;
  return 'mdi' + match[1].replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
}

class HaCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>
        :host {
          display: block;
          position: relative;
          box-sizing: border-box;
          background: var(--ha-card-background, var(--card-background-color, #fff));
          border-radius: var(--ha-card-border-radius, 12px);
          border: var(--ha-card-border-width, 1px) solid
            var(--ha-card-border-color, var(--divider-color, #e0e0e0));
          box-shadow: var(--ha-card-box-shadow, none);
          color: var(--primary-text-color);
          font-family: var(--ha-font-family-body);
        }
      </style>
      <slot></slot>`;
  }
}

class HaIcon extends HTMLElement {
  static observedAttributes = ['icon'];
  private _icon = '';
  private _drawn = '';

  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>
        :host {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          vertical-align: middle;
          width: var(--mdc-icon-size, 24px);
          height: var(--mdc-icon-size, 24px);
          fill: currentColor;
        }
        svg { width: 100%; height: 100%; display: block; }
      </style>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path></path></svg>`;
  }

  get icon(): string {
    return this._icon;
  }

  set icon(value: string) {
    this._icon = value ?? '';
    void this._draw();
  }

  attributeChangedCallback(_name: string, _old: string | null, value: string | null): void {
    this.icon = value ?? '';
  }

  private async _draw(): Promise<void> {
    const wanted = this._icon;
    const name = exportName(wanted);
    const path = name ? ((await loadIcons())[name] ?? '') : '';
    // A later icon set while this one loaded wins.
    if (wanted !== this._icon || this._drawn === wanted) return;
    this._drawn = wanted;
    this.shadowRoot!.querySelector('path')!.setAttribute('d', path);
    if (name && !path) console.warn(`[standalone] Unknown icon ${wanted}`);
  }
}

/** Home Assistant's press feedback. The card draws its own hold indicator, so this is empty. */
class HaRipple extends HTMLElement {}

export function defineHaElements(): void {
  const define = (tag: string, element: CustomElementConstructor): void => {
    if (!customElements.get(tag)) customElements.define(tag, element);
  };
  define('ha-card', HaCard);
  define('ha-icon', HaIcon);
  define('ha-ripple', HaRipple);
}
