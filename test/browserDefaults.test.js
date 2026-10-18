import test from "node:test";
import assert from "node:assert/strict";
import { installBrowserDefaults } from "../src/services/browserDefaults.js";
import { selectAllListItems } from "../src/services/listKeyboard.js";

function fixture() {
  const listeners = new Map();
  const dispose = installBrowserDefaults({ addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { assert.equal(listeners.get(name), fn); listeners.delete(name); } });
  return { listeners, dispose, dispatch: (name, event) => listeners.get(name)?.(event) };
}
function event(target = {}, options = {}) {
  return { target, code: "KeyA", ctrlKey: true, defaultPrevented: false, stops: 0,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stops++; }, ...options };
}
test("page Ctrl+A and browser context menu are cancelled without stopping custom handlers", () => {
  const h = fixture();
  for (const e of [event(), event({}, { ctrlKey: false, metaKey: true }), event({ closest: selector => selector === "input" ? { type: "range" } : null })]) {
    h.dispatch("keydown", e); assert.equal(e.defaultPrevented, true); assert.equal(e.stops, 0);
  }
  const menu = event(); h.dispatch("contextmenu", menu); assert.equal(menu.defaultPrevented, true); assert.equal(menu.stops, 0);
  h.dispose(); assert.equal(h.listeners.size, 0);
});
test("local text selection and unrelated shortcuts retain native behavior", () => {
  const h = fixture();
  for (const e of [event({ isContentEditable: true }), event({ closest: s => s === "input" ? { type: "number" } : null }),
    event({ closest: s => s.startsWith("textarea") ? {} : null }), event({}, { ctrlKey: false }), event({}, { shiftKey: true }),
    event({}, { altKey: true }), event({}, { code: "KeyC" }), event({}, { isComposing: true })]) {
    h.dispatch("keydown", e); assert.equal(e.defaultPrevented, false);
  }
});
test("list Ctrl+A executes before the page fallback and keeps its selection", () => {
  const h = fixture(), e = event(); let selected;
  assert.equal(selectAllListItems(e, { records: [{ id: 3 }, { id: 8 }], onSelect: value => { selected = value; } }), true);
  h.dispatch("keydown", e); assert.deepEqual(selected, [3, 8]); assert.equal(e.stops, 1);
});
