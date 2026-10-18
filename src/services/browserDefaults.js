// Bubble after application handlers: lists and 3D keep their own Ctrl+A,
// charts keep their menus and right-button gestures, including portal content.
export function installBrowserDefaults(target) {
  const contextmenu = event => event.preventDefault();
  const keydown = event => {
    if (event.defaultPrevented || event.isComposing || event.code !== "KeyA"
      || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    const element = event.target;
    // Selecting text inside an input is local editing, not page selection.
    const input = element?.closest?.("input");
    if (element?.isContentEditable || element?.closest?.('textarea, [contenteditable]:not([contenteditable="false"])')
      || (input && !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(input.type))) return;
    event.preventDefault();
  };
  target.addEventListener("contextmenu", contextmenu);
  target.addEventListener("keydown", keydown);
  return () => {
    target.removeEventListener("contextmenu", contextmenu);
    target.removeEventListener("keydown", keydown);
  };
}
