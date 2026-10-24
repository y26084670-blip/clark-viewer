import test from "node:test";
import assert from "node:assert/strict";
import { createViewportLensHintPreference, VIEWPORT_LENS_HINT_KEY } from "../src/services/visualization/viewportLensHint.js";

function windowFixture(storage = new Map(), blocked = false) {
  const win = new EventTarget(), listeners = new Set();
  const add = win.addEventListener.bind(win), remove = win.removeEventListener.bind(win);
  win.Event = Event;
  win.addEventListener = (name, callback) => { listeners.add(callback); add(name, callback); };
  win.removeEventListener = (name, callback) => { listeners.delete(callback); remove(name, callback); };
  Object.defineProperty(win, "localStorage", { get() {
    if (blocked) throw new Error("Storage disabled");
    return { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  } });
  return { win, storage, listeners };
}
const observe = win => {
  const changes = [];
  const preference = createViewportLensHintPreference({ window: win, onChange: show => changes.push(show) });
  return { ...preference, changes };
};

test("first lens use hides all current viewports and stays dismissed after reopening and reload", () => {
  const { win, storage, listeners } = windowFixture();
  const first = observe(win), second = observe(win);
  assert.deepEqual(first.changes, [true]); assert.deepEqual(second.changes, [true]);
  first.dismiss();
  assert.equal(storage.get(VIEWPORT_LENS_HINT_KEY), "1");
  assert.deepEqual(first.changes, [true, false]); assert.deepEqual(second.changes, [true, false]);
  assert.equal(listeners.size, 0);
  first.dismiss(); second.dismiss(); assert.deepEqual(first.changes, [true, false]);
  assert.deepEqual(observe(win).changes, [false]);
  assert.deepEqual(observe(windowFixture(storage).win).changes, [false], "a new page reads the persisted acknowledgement");
  first.dispose(); second.dispose();
});

test("storage events synchronize other application tabs without reacting to unrelated preferences", () => {
  const { win, listeners } = windowFixture(), hint = observe(win);
  const send = (key, newValue) => win.dispatchEvent(Object.assign(new Event("storage"), { key, newValue }));
  send("other", "1"); send(VIEWPORT_LENS_HINT_KEY, null); send(VIEWPORT_LENS_HINT_KEY, "0");
  assert.deepEqual(hint.changes, [true]);
  send(VIEWPORT_LENS_HINT_KEY, "1");
  assert.deepEqual(hint.changes, [true, false]); assert.equal(listeners.size, 0);
  assert.deepEqual(observe(win).changes, [false]); hint.dispose();
});

test("unavailable browser storage does not break the lens and remembers dismissal within the page", () => {
  const { win, listeners } = windowFixture(new Map(), true), a = observe(win), b = observe(win);
  assert.doesNotThrow(() => a.dismiss());
  assert.deepEqual(a.changes, [true, false]); assert.deepEqual(b.changes, [true, false]);
  assert.deepEqual(observe(win).changes, [false]); assert.equal(listeners.size, 0);
  a.dispose(); b.dispose();
});

test("unmounted hints remove listeners and cannot acknowledge an unused lens", () => {
  const { win, storage, listeners } = windowFixture(), a = observe(win), b = observe(win);
  a.dispose(); assert.equal(listeners.size, 2);
  a.dismiss(); assert.equal(storage.size, 0);
  b.dismiss(); assert.deepEqual(a.changes, [true]); assert.equal(listeners.size, 0);
  b.dispose();
});
