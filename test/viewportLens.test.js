import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createViewportLens, lensSourcePoint, setLensProjection, VIEWPORT_LENS_DIAMETER } from "../src/services/visualization/viewportLens.js";

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
  owner.send("keydown", { code: "ControlLeft", ctrlKey: true });
  enter(); assert.equal(lens.active, true);
  owner.send("keyup", { code: "ControlLeft", ctrlKey: false }); assert.equal(lens.active, false);
  owner.send("keydown", { code: "ControlLeft", ctrlKey: true }); assert.equal(lens.active, true);
  enabled = false; assert.equal(lens.active, false); enabled = true;
  owner.activeElement = { closest: () => ({}) }; assert.equal(lens.active, true); owner.activeElement = null;
  element.send("pointerleave"); assert.equal(lens.active, false);
  enter(); win.send("blur"); assert.equal(lens.active, false);
  owner.send("keydown", { code: "ControlLeft", ctrlKey: true }); enter(); owner.hidden = true; owner.send("visibilitychange"); owner.hidden = false; assert.equal(lens.active, false);
  owner.send("keydown", { code: "ControlLeft", ctrlKey: true }); enter(); lens.dispose(); const count = frames; enter(); owner.send("keydown", { code: "ControlLeft", ctrlKey: true });
  assert.equal(lens.active, false); assert.equal(frames, count);
});

test("left Ctrl+wheel changes only the lens, and the next activation starts again at x5", () => {
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
  owner.send("keydown", { code: "ControlLeft", ctrlKey: true });
  assert.equal(lens.magnification, 5);
  assert.equal(wheel(-100).defaultPrevented, true); assert.ok(lens.magnification > 5);
  assert.equal(orbitWheelEvents, 1);
  wheel(100); assert.ok(Math.abs(lens.magnification - 5) < 1e-10);
  wheel(-400); owner.send("keyup", { code: "ControlLeft", ctrlKey: false });
  wheel(-100); assert.equal(orbitWheelEvents, 2);
  owner.send("keydown", { code: "ControlLeft", ctrlKey: true }); assert.equal(lens.magnification, 5);
  assert.ok(Math.abs(lensSourcePoint(.001, 0, 0, 0, 75, 4).x / .001 - .25) < 1e-8);
  lens.dispose();
});


test("lens projection rerenders the same rays at full resolution for orthographic and perspective cameras", () => {
  for (const source of [new THREE.PerspectiveCamera(40, 1.6, .01, 100), new THREE.OrthographicCamera(-4, 4, 2.5, -2.5, .01, 100)]) {
    source.position.set(2, 3, 8); source.lookAt(0, 0, 0); source.updateMatrixWorld();
    const saved = source.projectionMatrix.clone(), detail = source.clone();
    setLensProjection(THREE, detail, source, 800, 500, 150, 280, 5);
    for (const [dx, dy] of [[0, 0], [120, -150], [-230, 50]]) {
      const sourcePixel = lensSourcePoint(150 + dx, 280 + dy, 150, 280);
      const ndc = new THREE.Vector3(sourcePixel.x / 800 * 2 - 1, 1 - sourcePixel.y / 500 * 2, .5);
      const point = ndc.clone().unproject(source).project(detail);
      assert.ok(Math.abs(point.x - ((150 + dx) / 800 * 2 - 1)) < 1e-10);
      assert.ok(Math.abs(point.y - (1 - (280 + dy) / 500 * 2)) < 1e-10);
    }
    assert.deepEqual(source.projectionMatrix.elements, saved.elements);
    assert.notDeepEqual(detail.projectionMatrix.elements, source.projectionMatrix.elements);
  }
});


test("only left Ctrl activates the lens, including both keys and re-entry", () => {
  const element = events(), owner = events(), win = events();
  element.ownerDocument = owner; owner.defaultView = win;
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 300 });
  const lens = createViewportLens({ THREE: {}, renderer: { domElement: element } });
  const enter = () => element.send("pointerenter", { clientX: 200, clientY: 150, ctrlKey: true });
  enter(); assert.equal(lens.active, false, "aggregate ctrlKey is not enough");
  owner.send("keydown", { code: "ControlRight", ctrlKey: true });
  element.send("pointermove", { clientX: 201, clientY: 150, ctrlKey: true });
  assert.equal(lens.active, false, "right Ctrl and pointer motion do not activate");
  const wheel = Object.assign(new Event("wheel", { cancelable: true }), { deltaY: -100, deltaMode: 0 });
  element.dispatchEvent(wheel); assert.equal(wheel.defaultPrevented, false);
  owner.send("keydown", { code: "ControlLeft", ctrlKey: true });
  assert.equal(lens.active, true, "left Ctrl activates while right Ctrl is held");
  owner.send("keyup", { code: "ControlRight", ctrlKey: true });
  assert.equal(lens.active, true, "releasing right Ctrl leaves left Ctrl active");
  element.send("pointerleave"); assert.equal(lens.active, false);
  enter(); assert.equal(lens.active, true, "left Ctrl remains held outside the canvas");
  owner.send("keydown", { code: "ControlRight", ctrlKey: true });
  owner.send("keyup", { code: "ControlLeft", ctrlKey: true });
  assert.equal(lens.active, false, "releasing left Ctrl stops the lens despite right Ctrl");
  element.send("pointermove", { clientX: 201, clientY: 150, ctrlKey: true });
  assert.equal(lens.active, false);
  owner.send("keydown", { code: "ControlLeft", ctrlKey: true }); win.send("blur");
  enter(); assert.equal(lens.active, false, "blur clears keyboard state");
  owner.send("keydown", { code: "ControlLeft", ctrlKey: true });
  element.send("pointermove", { clientX: 201, clientY: 150, ctrlKey: false });
  assert.equal(lens.active, false, "a missed key release cannot leave a stuck lens");
  lens.dispose();
});
