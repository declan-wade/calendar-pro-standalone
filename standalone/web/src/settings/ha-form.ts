/**
 * A stand-in for Home Assistant's `<ha-form>`, enough for the card's own visual editor.
 *
 * The editor describes each setting as an `ha-form` schema node and leaves drawing it to Home
 * Assistant. This draws the node types and selectors the editor uses (see `ha-form.ts` in the
 * card's editor for the list): `grid` and `expandable` groups, `constant`, and the `boolean`,
 * `text`, `number`, `select`, `icon`, `entity`, `ui_action` and `object` selectors.
 *
 * It follows `ha-form`'s contract: it takes `data`, `schema`, `computeLabel`, `computeHelper`
 * and `error`, and fires `value-changed` with the whole new `data` object when a field changes.
 * A group reads and writes its children under its own `name` unless it has none or is
 * flattened, as Home Assistant's does.
 */

import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { parse, stringify } from 'yaml';

type Data = Record<string, unknown>;

interface Node {
  name?: string;
  type?: string;
  title?: string;
  required?: boolean;
  disabled?: boolean;
  flatten?: boolean;
  expanded?: boolean;
  value?: string;
  schema?: Node[];
  selector?: Record<string, Record<string, unknown> | null>;
}

interface Hass {
  states?: Record<string, { attributes?: { friendly_name?: string } }>;
}

type SelectOption = { value: string | number; label: string; disabled?: boolean } | string;

/** Actions the `ui_action` selector offers when the schema names none. */
const DEFAULT_ACTIONS = ['more-info', 'toggle', 'navigate', 'url', 'perform-action', 'none'];

function isGroup(node: Node): boolean {
  return Array.isArray(node.schema);
}

/** Where a node's value lives in its parent's data, as `ha-form`'s `getValue` reads it. */
function valueOf(data: Data | undefined, node: Node): unknown {
  if (!data) return undefined;
  if (!node.name || (isGroup(node) && node.flatten)) return data;
  return data[node.name];
}

function humanize(name: string | undefined): string {
  if (!name) return '';
  const text = name.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export class StandaloneHaForm extends LitElement {
  static override properties = {
    hass: { attribute: false },
    data: { attribute: false },
    schema: { attribute: false },
    error: { attribute: false },
    disabled: { type: Boolean },
    computeLabel: { attribute: false },
    computeHelper: { attribute: false },
    computeError: { attribute: false },
    localizeValue: { attribute: false },
  };

  hass?: Hass;
  data: Data = {};
  schema: Node[] = [];
  error?: Record<string, string>;
  disabled = false;
  computeLabel?: (node: Node, data?: Data) => string | undefined;
  computeHelper?: (node: Node) => string | TemplateResult | undefined;
  computeError?: (error: string, node: Node) => string;
  localizeValue?: (key: string) => string;

  static override styles = css`
    :host {
      display: block;
    }
    .root {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(var(--form-grid-min-width, 160px), 1fr));
      gap: 12px;
    }
    details {
      border: 1px solid var(--divider-color);
      border-radius: 8px;
      padding: 0 12px;
    }
    details[open] {
      padding-bottom: 12px;
    }
    summary {
      cursor: pointer;
      padding: 10px 0;
      font-weight: 500;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    label.title {
      font-size: 0.85em;
      color: var(--secondary-text-color);
    }
    .switch {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 32px;
    }
    .helper {
      font-size: 0.8em;
      color: var(--secondary-text-color);
    }
    .error {
      font-size: 0.85em;
      color: var(--error-color, #db4437);
    }
    input,
    select,
    textarea {
      font: inherit;
      color: var(--primary-text-color);
      background: var(--input-fill-color, transparent);
      border: 1px solid var(--input-outlined-idle-border-color, var(--divider-color));
      border-radius: 6px;
      padding: 7px 9px;
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
    }
    input[type='checkbox'] {
      width: auto;
    }
    input[type='range'] {
      padding: 0;
    }
    textarea {
      font-family: var(--code-font-family, ui-monospace, monospace);
      min-height: 6em;
      resize: vertical;
    }
    .affix {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .affix span {
      color: var(--secondary-text-color);
      font-size: 0.9em;
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .list .row {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    button {
      font: inherit;
      border: 1px solid var(--divider-color);
      background: transparent;
      color: var(--primary-text-color);
      border-radius: 6px;
      padding: 4px 8px;
      cursor: pointer;
    }
    .choices {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 14px;
    }
    .choices label {
      display: flex;
      align-items: center;
      gap: 6px;
    }
  `;

  protected override render(): TemplateResult {
    const base = this.error?.base;
    return html`<div class="root">
      ${base ? html`<div class="error">${base}</div>` : nothing}
      ${this.schema.map((node) => this._node(node, this.data, (value) => this._commit(node, value)))}
    </div>`;
  }

  /** Writes a node's new value into this form's data and announces the whole. */
  private _commit(node: Node, value: unknown): void {
    let next: Data;
    if (!node.name || (isGroup(node) && node.flatten)) {
      next = { ...this.data, ...(value as Data) };
    } else {
      next = { ...this.data, [node.name]: value };
      if (value === undefined) delete next[node.name];
    }
    this.data = next;
    this.dispatchEvent(
      new CustomEvent('value-changed', { detail: { value: next }, bubbles: true, composed: true }),
    );
  }

  private _label(node: Node, data: Data | undefined): string {
    return this.computeLabel?.(node, data) ?? humanize(node.name);
  }

  private _node(
    node: Node,
    data: Data | undefined,
    commit: (value: unknown) => void,
  ): TemplateResult | typeof nothing {
    if (isGroup(node)) return this._group(node, data, commit);
    if (node.type === 'constant') {
      return html`<div class="field">
        <label class="title">${this._label(node, data)}</label>
        <div>${node.value ?? ''}</div>
      </div>`;
    }
    if (!node.selector) return nothing;
    const kind = Object.keys(node.selector)[0];
    const options = node.selector[kind] ?? {};
    const value = valueOf(data, node);
    const label = this._label(node, data);
    const helper = this.computeHelper?.(node);
    const error = node.name ? this.error?.[node.name] : undefined;
    const disabled = this.disabled || !!node.disabled;
    const id = `f-${node.name}`;

    let control: TemplateResult;
    switch (kind) {
      case 'boolean':
        return html`<div class="field">
          <div class="switch">
            <label class="title" for=${id}>${label}</label>
            <input
              id=${id}
              type="checkbox"
              .checked=${value === true}
              ?disabled=${disabled}
              @change=${(e: Event) => commit((e.target as HTMLInputElement).checked)}
            />
          </div>
          ${helper ? html`<div class="helper">${helper}</div>` : nothing}
          ${error ? html`<div class="error">${error}</div>` : nothing}
        </div>`;
      case 'number':
        control = this._number(id, value, options, disabled, commit);
        break;
      case 'select':
        control = this._select(id, value, options, disabled, commit);
        break;
      case 'entity':
        control = this._entity(id, value, options, disabled, commit);
        break;
      case 'ui_action':
        control = this._action(id, value, options, disabled, commit);
        break;
      case 'object':
        control = this._object(id, value, disabled, commit);
        break;
      case 'icon':
        control = html`<input
          id=${id}
          placeholder="mdi:calendar"
          .value=${typeof value === 'string' ? value : ''}
          ?disabled=${disabled}
          @change=${(e: Event) => commit((e.target as HTMLInputElement).value || undefined)}
        />`;
        break;
      default:
        control = this._text(id, value, options, disabled, commit);
    }
    return html`<div class="field">
      <label class="title" for=${id}>${label}${node.required ? ' *' : ''}</label>
      ${control} ${helper ? html`<div class="helper">${helper}</div>` : nothing}
      ${error ? html`<div class="error">${error}</div>` : nothing}
    </div>`;
  }

  private _group(
    node: Node,
    data: Data | undefined,
    commit: (value: unknown) => void,
  ): TemplateResult {
    const own = (valueOf(data, node) as Data | undefined) ?? {};
    const children = node.schema!.map((child) =>
      this._node(child, own, (value) => {
        let next: Data;
        if (!child.name || (isGroup(child) && child.flatten)) next = { ...own, ...(value as Data) };
        else {
          next = { ...own, [child.name]: value };
          if (value === undefined) delete next[child.name];
        }
        commit(next);
      }),
    );
    if (node.type === 'expandable') {
      const title = node.title ?? this._label(node, data);
      return html`<details ?open=${node.expanded}>
        <summary>${title}</summary>
        <div class="root">${children}</div>
      </details>`;
    }
    return html`<div class="grid">${children}</div>`;
  }

  private _text(
    id: string,
    value: unknown,
    options: Record<string, unknown>,
    disabled: boolean,
    commit: (value: unknown) => void,
  ): TemplateResult {
    if (options.multiple) {
      const list = Array.isArray(value) ? (value as unknown[]).map(String) : [];
      const write = (next: string[]) => commit(next.length ? next : undefined);
      return html`<div class="list">
        ${list.map(
          (item, index) =>
            html`<div class="row">
              <input
                .value=${item}
                ?disabled=${disabled}
                @change=${(e: Event) => {
                  const next = [...list];
                  next[index] = (e.target as HTMLInputElement).value;
                  write(next.filter((each) => each !== ''));
                }}
              />
              <button
                type="button"
                aria-label="Remove"
                ?disabled=${disabled}
                @click=${() => write(list.filter((_, at) => at !== index))}
              >
                Remove
              </button>
            </div>`,
        )}
        <input
          id=${id}
          placeholder="Add"
          ?disabled=${disabled}
          @change=${(e: Event) => {
            const input = e.target as HTMLInputElement;
            if (input.value) write([...list, input.value]);
            input.value = '';
          }}
        />
      </div>`;
    }
    const text = value === undefined || value === null ? '' : String(value);
    const input = options.multiline
      ? html`<textarea
          id=${id}
          .value=${text}
          ?disabled=${disabled}
          @change=${(e: Event) => commit((e.target as HTMLTextAreaElement).value || undefined)}
        ></textarea>`
      : html`<input
          id=${id}
          type=${(options.type as string) ?? 'text'}
          .value=${text}
          ?disabled=${disabled}
          @change=${(e: Event) => commit((e.target as HTMLInputElement).value || undefined)}
        />`;
    if (!options.prefix && !options.suffix) return input;
    return html`<div class="affix">
      ${options.prefix ? html`<span>${options.prefix}</span>` : nothing}${input}
      ${options.suffix ? html`<span>${options.suffix}</span>` : nothing}
    </div>`;
  }

  private _number(
    id: string,
    value: unknown,
    options: Record<string, unknown>,
    disabled: boolean,
    commit: (value: unknown) => void,
  ): TemplateResult {
    const read = (e: Event): number | undefined => {
      const raw = (e.target as HTMLInputElement).value;
      return raw === '' ? undefined : Number(raw);
    };
    const step = options.step === undefined ? 'any' : String(options.step);
    const box = html`<input
      id=${id}
      type="number"
      min=${(options.min as number | undefined) ?? nothing}
      max=${(options.max as number | undefined) ?? nothing}
      step=${step}
      .value=${typeof value === 'number' ? String(value) : value == null ? '' : String(value)}
      ?disabled=${disabled}
      @change=${(e: Event) => commit(read(e))}
    />`;
    const unit = options.unit_of_measurement as string | undefined;
    if (options.mode === 'slider' && options.min !== undefined && options.max !== undefined) {
      return html`<div class="affix">
        <input
          type="range"
          min=${options.min as number}
          max=${options.max as number}
          step=${step}
          .value=${typeof value === 'number' ? String(value) : String(options.min)}
          ?disabled=${disabled}
          @change=${(e: Event) => commit(read(e))}
        />
        ${box} ${unit ? html`<span>${unit}</span>` : nothing}
      </div>`;
    }
    return unit ? html`<div class="affix">${box}<span>${unit}</span></div>` : box;
  }

  private _options(options: Record<string, unknown>): Array<{ value: string; label: string }> {
    const list = (options.options as SelectOption[] | undefined) ?? [];
    return list.map((option) =>
      typeof option === 'string'
        ? { value: option, label: option }
        : { value: String(option.value), label: option.label ?? String(option.value) },
    );
  }

  private _select(
    id: string,
    value: unknown,
    options: Record<string, unknown>,
    disabled: boolean,
    commit: (value: unknown) => void,
  ): TemplateResult {
    const list = this._options(options);
    // Values come back in the type the option was written in.
    const raw = (options.options as SelectOption[] | undefined) ?? [];
    const typed = (text: string): unknown => {
      const found = raw.find((option) =>
        typeof option === 'string' ? option === text : String(option.value) === text,
      );
      return typeof found === 'object' ? found.value : text;
    };
    if (options.multiple) {
      const chosen = new Set((Array.isArray(value) ? value : []).map(String));
      return html`<div class="choices" id=${id}>
        ${list.map(
          (option) =>
            html`<label
              ><input
                type="checkbox"
                .checked=${chosen.has(option.value)}
                ?disabled=${disabled}
                @change=${(e: Event) => {
                  const next = list
                    .filter((each) =>
                      each.value === option.value
                        ? (e.target as HTMLInputElement).checked
                        : chosen.has(each.value),
                    )
                    .map((each) => typed(each.value));
                  commit(next.length ? next : undefined);
                }}
              />${option.label}</label
            >`,
        )}
      </div>`;
    }
    const current = value === undefined || value === null ? '' : String(value);
    const known = list.some((option) => option.value === current);
    if (options.custom_value) {
      const listId = `${id}-options`;
      return html`<input
          id=${id}
          list=${listId}
          .value=${current}
          ?disabled=${disabled}
          @change=${(e: Event) => {
            const text = (e.target as HTMLInputElement).value;
            commit(text === '' ? undefined : typed(text));
          }}
        />
        <datalist id=${listId}>
          ${list.map((option) => html`<option value=${option.value}>${option.label}</option>`)}
        </datalist>`;
    }
    return html`<select
      id=${id}
      ?disabled=${disabled}
      @change=${(e: Event) => {
        const text = (e.target as HTMLSelectElement).value;
        commit(text === '' ? undefined : typed(text));
      }}
    >
      <option value="" ?selected=${current === ''}>Default</option>
      ${!known && current ? html`<option value=${current} selected>${current}</option>` : nothing}
      ${list.map(
        (option) =>
          html`<option value=${option.value} ?selected=${option.value === current}>
            ${option.label}
          </option>`,
      )}
    </select>`;
  }

  private _calendars(options: Record<string, unknown>): Array<{ value: string; label: string }> {
    const excluded = new Set((options.exclude_entities as string[] | undefined) ?? []);
    const filter = (options.filter as { domain?: string | string[] } | undefined)?.domain;
    const domains = filter === undefined ? null : Array.isArray(filter) ? filter : [filter];
    return Object.entries(this.hass?.states ?? {})
      .filter(([id]) => !excluded.has(id))
      .filter(([id]) => !domains || domains.includes(id.split('.')[0]))
      .map(([id, state]) => ({ value: id, label: state.attributes?.friendly_name ?? id }));
  }

  private _entity(
    id: string,
    value: unknown,
    options: Record<string, unknown>,
    disabled: boolean,
    commit: (value: unknown) => void,
  ): TemplateResult {
    const all = this._calendars(options);
    const name = (entity: string) => all.find((each) => each.value === entity)?.label ?? entity;
    if (!options.multiple) {
      const current = typeof value === 'string' ? value : '';
      return html`<select
        id=${id}
        ?disabled=${disabled}
        @change=${(e: Event) => commit((e.target as HTMLSelectElement).value || undefined)}
      >
        <option value="" ?selected=${current === ''}>None</option>
        ${
          current && !all.some((each) => each.value === current)
            ? html`<option value=${current} selected>${current}</option>`
            : nothing
        }
        ${all.map(
          (each) =>
            html`<option value=${each.value} ?selected=${each.value === current}>
              ${each.label}
            </option>`,
        )}
      </select>`;
    }
    const list = Array.isArray(value) ? (value as string[]) : [];
    const rest = all.filter((each) => !list.includes(each.value));
    const move = (from: number, to: number) => {
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      commit(next);
    };
    return html`<div class="list">
      ${list.map(
        (entity, index) =>
          html`<div class="row">
            <span style="flex:1">${name(entity)}</span>
            ${
              options.reorder
                ? html`<button
                      type="button"
                      ?disabled=${disabled || index === 0}
                      @click=${() => move(index, index - 1)}
                    >
                      Up</button
                    ><button
                      type="button"
                      ?disabled=${disabled || index === list.length - 1}
                      @click=${() => move(index, index + 1)}
                    >
                      Down
                    </button>`
                : nothing
            }
            <button
              type="button"
              ?disabled=${disabled}
              @click=${() => commit(list.filter((_, at) => at !== index))}
            >
              Remove
            </button>
          </div>`,
      )}
      ${
        rest.length
          ? html`<select
              id=${id}
              ?disabled=${disabled}
              @change=${(e: Event) => {
                const select = e.target as HTMLSelectElement;
                if (select.value) commit([...list, select.value]);
                select.value = '';
              }}
            >
              <option value="">Add a calendar</option>
              ${rest.map((each) => html`<option value=${each.value}>${each.label}</option>`)}
            </select>`
          : nothing
      }
    </div>`;
  }

  private _action(
    id: string,
    value: unknown,
    options: Record<string, unknown>,
    disabled: boolean,
    commit: (value: unknown) => void,
  ): TemplateResult {
    const actions = (options.actions as string[] | undefined) ?? DEFAULT_ACTIONS;
    const current = (value as { action?: string } | undefined)?.action ?? '';
    const label = (action: string) =>
      this.localizeValue?.(action) || humanize(action.replace(/-/g, '_'));
    return html`<select
      id=${id}
      ?disabled=${disabled}
      @change=${(e: Event) => {
        const action = (e.target as HTMLSelectElement).value;
        commit(action ? { action } : undefined);
      }}
    >
      <option value="" ?selected=${current === ''}>
        Default${options.default_action ? ` (${label(String(options.default_action))})` : ''}
      </option>
      ${
        current && !actions.includes(current)
          ? html`<option value=${current} selected>${label(current)}</option>`
          : nothing
      }
      ${actions.map(
        (action) =>
          html`<option value=${action} ?selected=${action === current}>${label(action)}</option>`,
      )}
    </select>`;
  }

  private _object(
    id: string,
    value: unknown,
    disabled: boolean,
    commit: (value: unknown) => void,
  ): TemplateResult {
    const text = value === undefined || value === null ? '' : stringify(value);
    return html`<textarea
      id=${id}
      spellcheck="false"
      .value=${text}
      ?disabled=${disabled}
      @change=${(e: Event) => {
        const area = e.target as HTMLTextAreaElement;
        try {
          commit(area.value.trim() === '' ? undefined : parse(area.value));
          area.setCustomValidity('');
        } catch (error) {
          area.setCustomValidity((error as Error).message);
          area.reportValidity();
        }
      }}
    ></textarea>`;
  }
}

/** Defines `ha-form`, unless something else already has. */
export function defineHaForm(): void {
  if (!customElements.get('ha-form')) customElements.define('ha-form', StandaloneHaForm);
}
