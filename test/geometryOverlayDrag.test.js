import test from "node:test";
import assert from "node:assert/strict";
import { geometryOverlayPosition, installGeometryOverlayDrag } from "../src/services/visualization/geometryOverlayDrag.js";

function fixture(saved = null, detached = false) {
  const owner = new EventTarget(), panel = new EventTarget(), handle = { closest: () => handle };
  const callbacks = [], writes = [], capture = [], classes = new Set();
  const win = new EventTarget();
  owner.defaultView = win;
  win.ResizeObserver = class {
    constructor(run) { this.run = run; this.connected = true; callbacks.push(this); }
    observe() {} disconnect() { this.connected = false; }
  };
  const parent = { clientWidth: 1000, clientHeight: 600, clientLeft: 2, clientTop: 2,
    getBoundingClientRect: () => ({ left: 30, top: 20 }) };
  Object.assign(panel, { ownerDocument: detached ? new EventTarget() : owner, parentElement: parent, offsetWidth: 200, offsetHeight: 100,
    style: { left: "", top: "", right: "", bottom: "10px" }, contains: child => child === handle,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    setPointerCapture: id => capture.push(["set", id]), releasePointerCapture: id => capture.push(["release", id]),
    getBoundingClientRect: () => ({ left: 32 + (parseFloat(panel.style.left) || 780),
      top: 22 + (parseFloat(panel.style.top) || 8) }) });
  const event = (type, surface = win, values = {}) => {
    const { target, ...properties } = values;
    const e = Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, button: 0, clientX: 822, clientY: 38, ...properties });
    if (surface === panel) Object.defineProperty(e, "target", { value: values.target ?? handle });
    surface.dispatchEvent(e); return e;
  };
  const drag = installGeometryOverlayDrag(panel, { getPosition: () => saved, setPosition: value => { saved = value; writes.push(value); } });
  return { panel, owner: win, parent, event, drag, callbacks, writes, capture, classes, position: () => saved,
    adopt: () => { panel.ownerDocument = owner; } };
}

test("relative positions clamp every edge and oversized panels keep an accessible origin", () => {
  const size = { width: 1000, height: 600, panelWidth: 200, panelHeight: 100 };
  assert.deepEqual(geometryOverlayPosition(size, { x: -5, y: -1 }), { left: 8, top: 8 });
  assert.deepEqual(geometryOverlayPosition(size, { x: 5, y: 9 }), { left: 792, top: 492 });
  assert.deepEqual(geometryOverlayPosition(size, { x: .5, y: .5 }), { left: 400, top: 250 });
  assert.deepEqual(geometryOverlayPosition({ ...size, width: 100, height: 50 }, { x: 1, y: 1 }), { left: 0, top: 0 });
});

test("only the primary pointer on a heading starts a drag, without changing untouched defaults", async () => {
  const f = fixture(); await Promise.resolve();
  assert.equal(f.panel.style.left, ""); assert.equal(f.panel.style.bottom, "10px"); assert.deepEqual(f.writes, []);
  f.event("pointerdown", f.panel, { button: 2 });
  f.event("pointerdown", f.panel, { target: { closest: () => null } });
  assert.deepEqual(f.capture, []);
  const e = f.event("pointerdown", f.panel); assert.equal(e.defaultPrevented, true);
  assert.ok(f.classes.has("is-dragging")); assert.deepEqual(f.capture, [["set", 1]]);
  f.drag.dispose();
});

test("drag retains the pointer offset, clamps to the viewport and commits coordinates on release", () => {
  const f = fixture(); f.event("pointerdown", f.panel);
  f.event("pointermove", f.owner, { pointerId: 2, clientX: 2000, clientY: 2000 });
  assert.equal(f.panel.style.left, "");
  f.event("pointermove", f.owner, { clientX: 1000, clientY: 700 });
  assert.equal(f.panel.style.left, "792px"); assert.equal(f.panel.style.top, "492px");
  assert.equal(f.panel.style.bottom, "auto");
  assert.deepEqual(f.writes, []);
  f.event("pointerup"); assert.deepEqual(f.position(), { x: 1, y: 1 }); assert.equal(f.writes.length, 1);
  assert.equal(f.classes.size, 0); assert.deepEqual(f.capture.at(-1), ["release", 1]);
  f.event("pointermove", f.owner, { clientX: 0, clientY: 0 }); assert.equal(f.panel.style.left, "792px");
  const rect=f.panel.getBoundingClientRect();
  f.event("pointerdown",f.panel,{clientX:rect.left+10,clientY:rect.top+8});
  f.event("pointermove",f.owner,{clientX:0,clientY:0});f.event("pointerup");
  assert.deepEqual(f.position(),{x:0,y:0});assert.equal(f.writes.length,2);
  f.drag.dispose();
});

test("saved positions follow viewport and content size changes and survive panel remount", async () => {
  const f = fixture({ x: 1, y: 1 }); await Promise.resolve();
  assert.equal(f.panel.style.left, "792px"); assert.equal(f.panel.style.top, "492px");
  f.parent.clientWidth = 500; f.panel.offsetHeight = 200; f.callbacks[0].run();
  assert.equal(f.panel.style.left, "292px"); assert.equal(f.panel.style.top, "392px");
  assert.equal(f.writes.length, 0); const saved = f.position(); f.drag.dispose();
  const next = fixture(saved); await Promise.resolve(); assert.equal(next.panel.style.left, "792px"); next.drag.dispose();
});

test("pointer cancellation retains the final position and disposal releases observers and capture", async () => {
  const f = fixture(); await Promise.resolve(); f.event("pointerdown", f.panel);
  f.event("pointermove", f.owner, { clientX: -500, clientY: -500 }); f.event("pointercancel");
  assert.deepEqual(f.position(), { x: 0, y: 0 });
  f.event("pointerdown", f.panel); f.drag.dispose();
  assert.equal(f.callbacks[0].connected, false); assert.equal(f.classes.size, 0);
  const writes = f.writes.length; f.event("pointerup"); f.event("pointerdown", f.panel);
  assert.equal(f.writes.length, writes); assert.deepEqual(f.capture.at(-1), ["release", 1]);
});

test("disposal before mounting does not create a late observer", async () => {
  const f = fixture(); f.drag.dispose(); await Promise.resolve(); assert.deepEqual(f.callbacks, []);
});

test("a ref cloned from an inert template connects to its live document after insertion", async () => {
  const f=fixture(null,true);f.adopt();await Promise.resolve();
  f.event("pointerdown",f.panel);f.event("pointermove",f.owner,{clientX:2000,clientY:2000});f.event("pointerup");
  assert.deepEqual(f.position(),{x:1,y:1});assert.equal(f.callbacks.length,1);f.drag.dispose();
});
