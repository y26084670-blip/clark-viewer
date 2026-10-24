export const VIEWPORT_LENS_HINT_KEY = "e3d.viewportLens.spaceHintDismissed";
const DISMISSED_EVENT = "e3d:viewport-lens-hint-dismissed";
const dismissedWindows = new WeakSet();

// Editor and Viewer share this origin-wide preference. The custom event updates
// sibling viewports immediately; storage events update other open app tabs.
export function createViewportLensHintPreference({ window: win = globalThis.window, onChange = () => {} } = {}) {
  let disposed = false, dismissed = Boolean(win && dismissedWindows.has(win));
  try { dismissed ||= win?.localStorage.getItem(VIEWPORT_LENS_HINT_KEY) === "1"; } catch { /* Storage may be disabled. */ }
  const unlisten = () => {
    win?.removeEventListener(DISMISSED_EVENT, hide);
    win?.removeEventListener("storage", storageChanged);
  };
  function hide() {
    if (disposed || dismissed) return;
    dismissed = true;
    if (win) dismissedWindows.add(win);
    unlisten(); onChange(false);
  }
  function storageChanged(event) {
    if (event.key === VIEWPORT_LENS_HINT_KEY && event.newValue === "1") hide();
  }
  if (dismissed && win) dismissedWindows.add(win);
  else {
    win?.addEventListener(DISMISSED_EVENT, hide);
    win?.addEventListener("storage", storageChanged);
  }
  onChange(!dismissed);
  return {
    dismiss() {
      if (disposed || dismissed) return;
      hide();
      try { win?.localStorage.setItem(VIEWPORT_LENS_HINT_KEY, "1"); } catch { /* Retain the in-page acknowledgement. */ }
      if (win) win.dispatchEvent(new win.Event(DISMISSED_EVENT));
    },
    dispose() { disposed = true; unlisten(); },
  };
}
