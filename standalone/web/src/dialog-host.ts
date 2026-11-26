/**
 * Stands in for Home Assistant's dialog manager.
 *
 * The card opens its event popover, day panel and search panel by firing `show-dialog` with the
 * element's tag and its parameters. Home Assistant creates the element, gives it `hass`, calls
 * `showDialog(params)` before attaching it, and removes it when it fires `dialog-closed`. This
 * does the same. It also shows `hass-notification` messages as a toast.
 */

interface ShowDialogDetail {
  dialogTag: string;
  dialogImport?: () => Promise<unknown>;
  dialogParams?: unknown;
}

interface DialogElement extends HTMLElement {
  hass?: unknown;
  showDialog?: (params: unknown) => void;
  closeDialog?: () => boolean;
}

export function installDialogHost(getHass: () => unknown): void {
  const open = new Map<string, DialogElement>();

  window.addEventListener('show-dialog', async (event) => {
    const detail = (event as CustomEvent<ShowDialogDetail>).detail;
    if (!detail?.dialogTag) return;
    await detail.dialogImport?.();
    // One of each, as Home Assistant: opening a panel that is open reuses it.
    let dialog = open.get(detail.dialogTag);
    if (!dialog) {
      dialog = document.createElement(detail.dialogTag) as DialogElement;
      open.set(detail.dialogTag, dialog);
    }
    dialog.hass = getHass();
    dialog.showDialog?.(detail.dialogParams);
    if (!dialog.isConnected) document.body.appendChild(dialog);
  });

  window.addEventListener('dialog-closed', (event) => {
    const tag = (event as CustomEvent<{ dialog?: string }>).detail?.dialog;
    const dialog = tag ? open.get(tag) : undefined;
    if (!dialog) return;
    open.delete(tag!);
    dialog.remove();
  });

  // Back in the browser closes the top panel, as Home Assistant's Back does.
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || open.size === 0) return;
    // The panels handle Escape themselves; this only matters if focus left them.
    if ([...open.values()].some((dialog) => dialog.contains(document.activeElement))) return;
    [...open.values()].at(-1)?.closeDialog?.();
  });

  let toastTimer: number | undefined;
  window.addEventListener('hass-notification', (event) => {
    const message = (event as CustomEvent<{ message?: string }>).detail?.message;
    if (!message) return;
    let toast = document.querySelector<HTMLElement>('.standalone-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'standalone-toast';
      toast.setAttribute('role', 'status');
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast?.remove(), 4000);
  });

  // Tap and hold actions that only make sense inside Home Assistant (more-info, navigate,
  // call-service) arrive here and are logged rather than lost silently.
  window.addEventListener('hass-action', (event) => {
    console.info('[standalone] Ignored Home Assistant action', (event as CustomEvent).detail);
  });
}
