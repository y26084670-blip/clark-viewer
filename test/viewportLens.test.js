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
  target.send = (type, properties = {}) => target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), properties));
  return target;
}
test("lens works with retained input focus and no sources, and clears on leave, blur, hidden document and disposal", () => {
  const element = events(), owner = events(), win = events();
  element.ownerDocument = owner; owner.defaultView = win;
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 300 });
  let enabled = true, frames = 0;
  const lens = createViewportLens({ THREE: {}, renderer: { domElement: element }, enabled: () => enabled, requestRender: () => frames++ });
  const enter = () => element.send("pointerenter", { clientX: 200, clientY: 150, ctrlKey: true });
  owner.send("keydown", { code: "Space", ctrlKey: true });
  enter(); assert.equal(lens.active, true);
  owner.send("keyup", { code: "Space", ctrlKey: false }); assert.equal(lens.active, false);
  owner.send("keydown", { code: "Space", ctrlKey: true }); assert.equal(lens.active, true);
  enabled = false; assert.equal(lens.active, false); enabled = true;
  owner.activeElement = { tagName: "INPUT", type: "range" }; assert.equal(lens.active, true); owner.activeElement = null;
  element.send("pointerleave"); assert.equal(lens.active, false);
  enter(); win.send("blur"); assert.equal(lens.active, false);
  owner.send("keydown", { code: "Space", ctrlKey: true }); enter(); owner.hidden = true; owner.send("visibilitychange"); owner.hidden = false; assert.equal(lens.active, false);
  owner.send("keydown", { code: "Space", ctrlKey: true }); enter(); lens.dispose(); const count = frames; enter(); owner.send("keydown", { code: "Space", ctrlKey: true });
  assert.equal(lens.active, false); assert.equal(frames, count);
});

test("Space+wheel changes only the lens, and the next activation starts again at x5", () => {
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
  owner.send("keydown", { code: "Space", ctrlKey: true });
  assert.equal(lens.magnification, 5);
  assert.equal(wheel(-100).defaultPrevented, true); assert.ok(lens.magnification > 5);
  assert.equal(orbitWheelEvents, 1);
  wheel(100); assert.ok(Math.abs(lens.magnification - 5) < 1e-10);
  wheel(-400); owner.send("keyup", { code: "Space", ctrlKey: false });
  wheel(-100); assert.equal(orbitWheelEvents, 2);
  owner.send("keydown", { code: "Space", ctrlKey: true }); assert.equal(lens.magnification, 5);
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


test("only Space activates the lens and releases on keyup outside the canvas", () => {
  const element = events(), owner = events(), win = events();
  element.ownerDocument = owner; owner.defaultView = win;
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 300 });
  const lens = createViewportLens({ THREE: {}, renderer: { domElement: element } });
  const enter = () => element.send("pointerenter", { clientX: 200, clientY: 150 });
  enter();
  for (const code of ["ControlLeft", "ControlRight"]) {
    assert.equal(owner.send("keydown", { code, ctrlKey: true }), true);
    assert.equal(lens.active, false);
    owner.send("keyup", { code, ctrlKey: false });
  }
  assert.equal(owner.send("keydown", { code: "Space" }), false, "prevent scrolling/control activation over the canvas");
  assert.equal(lens.active, true);
  element.send("pointermove", { clientX: 201, clientY: 150, ctrlKey: false });
  assert.equal(lens.active, true, "Space is independent of pointer modifier flags");
  assert.equal(owner.send("keydown", { code: "Space", repeat: true }), false);
  element.send("pointerleave"); assert.equal(lens.active, false);
  enter(); assert.equal(lens.active, true, "holding Space survives re-entry");
  element.send("pointerleave");
  assert.equal(owner.send("keyup", { code: "Space" }), false, "suppress a focused button's release action even after leaving");
  enter(); assert.equal(lens.active, false);
  element.send("pointerleave");
  assert.equal(owner.send("keydown", { code: "Space" }), true, "Space outside 3D keeps its default action");
  assert.equal(owner.send("keyup", { code: "Space" }), true);
  enter(); owner.send("keydown", { code: "Space" }); win.send("blur");
  enter(); assert.equal(lens.active, false, "blur clears the held key");
  lens.dispose();
});

test("Space leaves typing and other dialogs alone but works with retained button and slider focus", () => {
  const element = events(), owner = events(); element.ownerDocument = owner;
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 300 });
  let enabled = true;
  const lens = createViewportLens({ THREE: {}, renderer: { domElement: element }, enabled: () => enabled });
  element.send("pointerenter", { clientX: 200, clientY: 150 });
  for (const focus of [{ tagName: "INPUT", type: "text" }, { tagName: "TEXTAREA" },
    { isContentEditable: true }, { closest: () => ({ contains: () => false }) }]) {
    owner.activeElement = focus;
    assert.equal(owner.send("keydown", { code: "Space" }), true);
    assert.equal(lens.active, false);
    owner.send("keyup", { code: "Space" });
  }
  for (const focus of [{ tagName: "BUTTON" }, { tagName: "INPUT", type: "checkbox" },
    { tagName: "INPUT", type: "range" }, { closest: () => ({ contains: () => true }) }]) {
    owner.activeElement = focus;
    assert.equal(owner.send("keydown", { code: "Space" }), false);
    assert.equal(lens.active, true);
    assert.equal(owner.send("keyup", { code: "Space" }), false);
  }
  owner.activeElement = null; enabled = false;
  assert.equal(owner.send("keydown", { code: "Space" }), true); assert.equal(lens.active, false);
  owner.send("keyup", { code: "Space" }); enabled = true;
  assert.equal(owner.send("keydown", { code: "Space", isComposing: true }), true); assert.equal(lens.active, false);
  lens.dispose();
});


test("detail rendering runs only inside the lens and restores renderer state after failure", () => {
  const element = events(), owner = events(); element.ownerDocument = owner;
  element.getBoundingClientRect = () => ({left:0,top:0,width:800,height:600});
  const scissor = new THREE.Vector4(3,4,100,200), calls = [];
  const renderer = {domElement:element,autoClear:false,scissorTest:false,
    render(scene,camera){calls.push([scene,camera]);}, copyFramebufferToTexture(){},
    getDrawingBufferSize:out=>out.set(800,600),getScissor:out=>out.copy(scissor),
    getScissorTest(){return this.scissorTest;},setScissorTest(value){this.scissorTest=value;},
    setScissor(...values){values.length===1?scissor.copy(values[0]):scissor.set(...values);}};
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40,4/3,.1,100);
  let details = 0, fail = false;
  const lens = createViewportLens({THREE,renderer,renderDetails(s,c){
    details++; assert.equal(s,scene); assert.notEqual(c,camera);
    assert.notDeepEqual(c.projectionMatrix.elements,camera.projectionMatrix.elements);
    if(fail)throw Error("detail error");
  }});
  lens.render(scene,camera); assert.equal(details,0);
  element.send("pointerenter",{clientX:400,clientY:300,ctrlKey:false});
  owner.send("keydown",{code:"Space",ctrlKey:true});
  lens.render(scene,camera); assert.equal(details,1);
  assert.deepEqual(scissor.toArray(),[3,4,100,200]); assert.equal(renderer.autoClear,false); assert.equal(renderer.scissorTest,false);
  fail=true; assert.throws(()=>lens.render(scene,camera),/detail error/);
  assert.deepEqual(scissor.toArray(),[3,4,100,200]); assert.equal(renderer.autoClear,false); assert.equal(renderer.scissorTest,false);
  owner.send("keyup",{code:"Space",ctrlKey:false}); lens.render(scene,camera); assert.equal(details,2); lens.dispose();
});


test("lens activation callback ignores typing, previews and repeated Space events", () => {
  const element = events(), owner = events(); element.ownerDocument = owner;
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 300 });
  let enabled = false, activated = 0;
  const lens = createViewportLens({ THREE: {}, renderer: { domElement: element },
    enabled: () => enabled, onActivate: () => activated++ });
  element.send("pointerenter", { clientX: 200, clientY: 150 });
  owner.send("keydown", { code: "Space" }); owner.send("keyup", { code: "Space" });
  assert.equal(activated, 0, "task-selection previews do not activate the lens");
  enabled = true; owner.activeElement = { tagName: "TEXTAREA" };
  owner.send("keydown", { code: "Space" }); owner.send("keyup", { code: "Space" });
  assert.equal(activated, 0, "typing a space does not acknowledge the hint");
  owner.activeElement = null;
  owner.send("keydown", { code: "Space" }); owner.send("keydown", { code: "Space", repeat: true });
  assert.equal(activated, 1);
  owner.send("keyup", { code: "Space" }); element.send("pointerleave");
  owner.send("keydown", { code: "Space" }); assert.equal(activated, 1);
  element.send("pointerenter", { clientX: 200, clientY: 150 });
  assert.equal(activated, 2, "holding Space before entering the viewport also activates the lens");
  lens.dispose(); owner.send("keydown", { code: "Space" }); assert.equal(activated, 2);
});
