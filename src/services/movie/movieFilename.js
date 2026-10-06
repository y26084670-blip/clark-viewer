const QUANTITY_FILENAME_SYMBOLS = Object.freeze({
  M: "M", H: "H", J: "J", E: "E", Bs: "B", Bv: "B", As: "A", Av: "A",
  MHdot: "MH", JEdot: "JE",
});

/** Capture the actual configured 3D quantities, in group/line order, once.
 * Empty/disabled groups are skipped; B/A in two groups are not repeated.
 */
export function movie3DFilenamePrefix(layers = [], lines = []) {
  const symbols = new Set();
  for (const layer of layers) {
    if (layer?.quantityKey === "none" || (Array.isArray(layer?.selected) && !layer.selected.length)) continue;
    const symbol = QUANTITY_FILENAME_SYMBOLS[layer?.quantityKey];
    if (symbol) symbols.add(symbol);
  }
  for (const line of lines) {
    const symbol = QUANTITY_FILENAME_SYMBOLS[line?.quantityKey];
    if (symbol) symbols.add(symbol);
  }
  return [...symbols, "3d"].join("_");
}

// Use the browser's local wall clock, as in the task owner's file manager.
// The short prefix is supplied by the tab independently of its translated title.
export function movieFilename(prefix, date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("Некорректная дата создания GIF");
  const term = /^[a-z0-9_-]{1,32}$/i.test(String(prefix ?? "")) ? String(prefix) : "movie";
  const pad = value => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `${term}_${day}_${time}.gif`;
}
