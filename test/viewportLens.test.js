import test from "node:test";
import assert from "node:assert/strict";
import { createViewportLens, lensSourcePoint, VIEWPORT_LENS_DIAMETER } from "../src/services/visualization/viewportLens.js";

test("lens uniformly magnifies a 300 CSS px radius by x5", () => {
  assert.equal(VIEWPORT_LENS_DIAMETER, 600);
  assert.deepEqual(lensSourcePoint(10, 20, 10, 20), { x: 10, y: 20 });
  for (const radius of [.001, 1, 75, 150, 299]) {
    assert.equal(lensSourcePoint(radius, 0, 0, 0).x, radius / 5);
  }
  assert.deepEqual(lensSourcePoint(150, 150, 0, 0), { x: 30, y: 30 });
  assert.deepEqual(lensSourcePoint(300, 0, 0, 0), { x: 300, y: 0 });
  assert.deepEqual(lensSourcePoint(301, 0, 0, 0), { x: 301, y: 0 });
});
function events() {
  const target = new EventTarget();
  target.send = (type, properties = {}) => target.dispatchEvent(Object.assign(new Event(type), properties));
  return target;
}
test("lens works with retained input focus and no sources, and clears on leave, blur, hidden document and disposal", () => {
  const element = events(), owner = events(), win = events();
  element.ownerDocument = owner; owner.defaultView = win;
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 300 });
  let enabled = true, frames = 0;
  const lens = createViewportLens({ THREE: {}, renderer: { domElement: element }, enabled: () => enabled, requestRender: () => frames++ });
  const enter = () => element.send("pointerenter", { clientX: 200, clientY: 150, ctrlKey: true });
  enter(); assert.equal(lens.active, true);
  owner.send("keyup", { ctrlKey: false }); assert.equal(lens.active, false);
  owner.send("keydown", { ctrlKey: true }); assert.equal(lens.active, true);
  enabled = false; assert.equal(lens.active, false); enabled = true;
  owner.activeElement = { closest: () => ({}) }; assert.equal(lens.active, true); owner.activeElement = null;
  element.send("pointerleave"); assert.equal(lens.active, false);
  enter(); win.send("blur"); assert.equal(lens.active, false);
  enter(); owner.hidden = true; owner.send("visibilitychange"); owner.hidden = false; assert.equal(lens.active, false);
  enter(); lens.dispose(); const count = frames; enter(); owner.send("keydown", { ctrlKey: true });
  assert.equal(lens.active, false); assert.equal(frames, count);
});

test("Ctrl+wheel changes only the lens, and the next activation starts again at x5", () => {
  const element = events(), owner = events(), win = events();
  element.ownerDocument = owner; owner.defaultView = win;
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 300 });
  const lens = createViewportLens({ THREE: {}, renderer: { domElement: element } });
  let orbitWheelEvents = 0;
  element.addEventListener("wheel", () => orbitWheelEvents++);
  const wheel = deltaY => {
    const event = Object.assign(new Event("wheel", { cancelable: true }), { deltaY, deltaMode: 0 });
    element.dispatchEvent(event); return event;
  };
  assert.equal(wheel(-100).defaultPrevented, false); assert.equal(orbitWheelEvents, 1);
  element.send("pointerenter", { clientX: 200, clientY: 150, ctrlKey: true });
  assert.equal(lens.magnification, 5);
  assert.equal(wheel(-100).defaultPrevented, true); assert.ok(lens.magnification > 5);
  assert.equal(orbitWheelEvents, 1);
  wheel(100); assert.ok(Math.abs(lens.magnification - 5) < 1e-10);
  wheel(-400); owner.send("keyup", { ctrlKey: false });
  wheel(-100); assert.equal(orbitWheelEvents, 2);
  owner.send("keydown", { ctrlKey: true }); assert.equal(lens.magnification, 5);
  assert.ok(Math.abs(lensSourcePoint(.001, 0, 0, 0, 75, 4).x / .001 - .25) < 1e-8);
  lens.dispose();
});
