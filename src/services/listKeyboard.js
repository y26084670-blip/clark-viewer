export function isListShortcutTarget(target) {
  if (target?.isContentEditable) return false;
  const tagName = String(target?.tagName ?? "").toLowerCase();
  if (["input", "textarea", "select"].includes(tagName)) return false;
  return !target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}

// Called only by the focused list's keydown handler, never by a global listener.
export function selectAllListItems(event, { records = [], multiple = true, onSelect } = {}) {
  if (!multiple || !event || event.defaultPrevented || event.isComposing
    || event.code !== "KeyA" || !event.ctrlKey
    || event.altKey || event.metaKey || event.shiftKey
    || !isListShortcutTarget(event.target)) return false;
  event.preventDefault();
  event.stopPropagation();
  // Use the complete data set, including rows outside Tabulator's rendered window.
  onSelect?.(records.map(record => record.id));
  return true;
}
