import test from "node:test";
import assert from "node:assert/strict";
import { installViewportGate, isViewportUsable } from "../src/viewportGate.js";

// DOM fixture for lifecycle tests; native dialog layout is not emulated here.
class Element extends EventTarget {
  constructor(document, tagName) {
    super();
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.inert = false;
    this.open = false;
    this.modalOpenCount = 0;
  }
  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  showModal() { this.open = true; this.modalOpenCount++; this.focus(); }
  close() { this.open = false; }
  focus() { this.ownerDocument.activeElement = this; }
}

function fixture(width = 1200, height = 800) {
  const window = new EventTarget();
  Object.assign(window, { innerWidth: width, innerHeight: height, devicePixelRatio: 1 });
  let observer;
  window.MutationObserver = class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  const document = { defaultView: window };
  document.createElement = tag => new Element(document, tag);
  document.body = document.createElement("body");
  document.activeElement = document.body;
  const root = document.createElement("main");
  document.body.append(root);
  return {
    window, document, root,
    get gate() { return document.body.children.find(child => child.tagName === "DIALOG"); },
    get observer() { return observer; },
    resize(w, h) {
      window.innerWidth = w;
      window.innerHeight = h;
      window.dispatchEvent(new Event("resize"));
    },
  };
}

const flush = () => new Promise(resolve => queueMicrotask(resolve));

test("both viewport dimensions must meet the inclusive minimum", () => {
  assert.equal(isViewportUsable(1100, 600), true);
  assert.equal(isViewportUsable(1099, 1000), false);
  assert.equal(isViewportUsable(1600, 599), false);
  assert.equal(isViewportUsable(390, 844), false);
});

test("small high-density viewport blocks startup and cannot dismiss with Escape", t => {
  const f = fixture(390, 844);
  f.window.devicePixelRatio = 3;
  let loads = 0;
  t.after(installViewportGate({ root: f.root, applicationName: "Editor", load: () => { loads++; } }));
  assert.equal(loads, 0);
  assert.equal(f.gate.open, true);
  assert.equal(f.root.inert, true);
  assert.equal(f.root.getAttribute("aria-hidden"), "true");
  const cancel = new Event("cancel", { cancelable: true });
  f.gate.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(f.gate.open, true);
});

test("repeated shrink/enlarge preserves mounted data and restores focus and keyboard input", async t => {
  const f = fixture(800, 600);
  let loads = 0, mounts = 0, disposals = 0, keyEvents = 0;
  const input = f.document.createElement("input");
  const dispose = installViewportGate({
    root: f.root, applicationName: "Editor",
    load: () => {
      loads++;
      return () => {
        mounts++;
        f.root.append(input);
        input.value = "несохранённая модель";
        input.focus();
        f.window.addEventListener("keydown", () => keyEvents++);
        return () => disposals++;
      };
    },
  });
  t.after(dispose);
  f.resize(1100, 600);
  await flush();
  for (let cycle = 0; cycle < 3; cycle++) {
    f.resize(1100, 599);
    assert.equal(f.gate.open, true);
    assert.equal(f.root.inert, true);
    f.window.dispatchEvent(new Event("keydown"));
    assert.equal(keyEvents, cycle);
    f.resize(1200, 600);
    assert.equal(f.gate.open, false);
    assert.equal(f.root.inert, false);
    assert.equal(f.root.getAttribute("aria-hidden"), null);
    assert.equal(f.document.activeElement, input);
    assert.equal(input.value, "несохранённая модель");
    f.window.dispatchEvent(new Event("keydown"));
    assert.equal(keyEvents, cycle + 1);
  }
  assert.deepEqual({ loads, mounts, disposals }, { loads: 1, mounts: 1, disposals: 0 });
});

test("shrinking during import defers mounting until the window becomes large enough", async t => {
  const f = fixture();
  let finishLoading, mounts = 0;
  t.after(installViewportGate({
    root: f.root, applicationName: "Viewer",
    load: () => new Promise(resolve => { finishLoading = resolve; }),
  }));
  f.resize(800, 700);
  finishLoading(() => { mounts++; });
  await flush();
  assert.equal(mounts, 0);
  assert.equal(f.gate.open, true);
  f.resize(1100, 600);
  assert.equal(mounts, 1);
  assert.equal(f.gate.open, false);
});

test("an app dialog opening asynchronously cannot cover the blocking screen", t => {
  const f = fixture(800, 600);
  t.after(installViewportGate({ root: f.root, applicationName: "Viewer", load: () => {} }));
  const appDialog = f.document.createElement("dialog");
  f.root.append(appDialog);
  appDialog.showModal();
  f.observer.callback([{ target: appDialog }]);
  assert.equal(f.gate.open, true);
  assert.equal(f.gate.modalOpenCount, 2);
});

test("disposal while loading prevents later mounting and removes the gate", async () => {
  const f = fixture();
  let finishLoading, mounts = 0;
  const dispose = installViewportGate({
    root: f.root, applicationName: "Viewer",
    load: () => new Promise(resolve => { finishLoading = resolve; }),
  });
  f.resize(800, 600);
  dispose();
  finishLoading(() => { mounts++; });
  await flush();
  f.resize(1200, 800);
  assert.equal(mounts, 0);
  assert.equal(f.gate, undefined);
  assert.equal(f.root.inert, false);
  assert.equal(f.observer.disconnected, true);
});

test("startup failure leaves an explicit blocking error instead of a blank app", async t => {
  t.mock.method(console, "error", () => {});
  const f = fixture();
  let loads = 0;
  t.after(installViewportGate({
    root: f.root, applicationName: "Editor",
    load: () => { loads++; return Promise.reject(new Error("offline")); },
  }));
  await flush();
  f.resize(1400, 900);
  assert.equal(loads, 1);
  assert.equal(f.gate.open, true);
  assert.equal(f.gate.children[0].children[0].textContent, "Не удалось загрузить приложение");
});
