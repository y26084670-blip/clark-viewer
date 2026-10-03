import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import { batch, createEffect, createSignal, createRoot, onCleanup, onMount } from "solid-js/dist/solid.js";
import { disposeSurfaceObject, updateSurfaceLabel, updateSurfaceMesh } from "../src/services/visualization/surfaceChartResources.js";
import { captureRenderedMovieFrame, createRenderedFrameGate, restoreMovieCamera, snapshotMovieCamera } from "../src/services/movie/renderedFrameGate.js";

const source = await readFile(new URL("../src/components/SurfaceChart.jsx", import.meta.url), "utf8");
const start = source.indexOf("export function SurfaceChart(props) {") + "export function SurfaceChart(props) {".length;
const end = source.indexOf('  return <div class="surface-chart"', start);
// Run the actual component's Solid effects and capture/view/resize handlers.
// Only the WebGL context, DOM canvas boundary and pixel readback are replaced;
// mesh buffers, palettes, labels, camera and frame gates are production code.
const component = new Function("props", "dependencies", `
  const {createEffect,createSignal,onCleanup,onMount,THREE,OrbitControls,ResizeObserver,
    disposeSurfaceObject,updateSurfaceLabel,updateSurfaceMesh,captureMovieCanvas,
    captureRenderedMovieFrame,createRenderedFrameGate,restoreMovieCamera,snapshotMovieCamera,testHost}=dependencies;
  const devicePixelRatio=2;
  ${source.slice(start, end)}
  host=testHost;
  return {captureAdapter,view,resize,limits,error,camera:()=>camera,controls:()=>controls,
    surface:()=>surface,renderer:()=>renderer,labels:()=>labelObjects};
`);
const grid = values => ({ width: 2, height: 2, values: Float64Array.from(values),
  coordinates: new Float64Array(12), axes: ["i1", "i2"], copy: 0 });

function runtime({ initial = [0, 0, 0, 0], failInit = false } = {}) {
  let dispose, api, registered;
  const events = new Map(), captures = [], drawCalls = [];
  const canvas = { width: 0, height: 0, addEventListener: (name, listener) => events.set(name, listener),
    removeEventListener: name => events.delete(name), remove() {} };
  const host = { clientWidth: 400, clientHeight: 240, append() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 240 }) };
  class Renderer {
    constructor() { if (failInit) throw new Error("WebGL initialization failed"); this.domElement = canvas; }
    setPixelRatio(value) { this.ratio = value; }
    setSize(width, height) { canvas.width = width * this.ratio; canvas.height = height * this.ratio; }
    render(scene, camera) {
      if (this.failDraw) throw new Error("WebGL drawing failed");
      drawCalls.push({ scene, camera });
    }
    dispose() {} forceContextLoss() {}
  }
  class Controls extends THREE.EventDispatcher {
    constructor(camera) { super(); this.object = camera; this.target = new THREE.Vector3(); this.enabled = true; }
    update() { this.object.lookAt(this.target); this.object.updateMatrixWorld(); }
    dispose() {}
  }
  const labelCanvas = () => ({ width: 0, height: 0, getContext: () => ({ clearRect() {}, fillText() {} }) });
  createRoot(cleanup => {
    dispose = cleanup;
    const [data, setGrid] = createSignal(grid(initial)), [key, setKey] = createSignal({ step: 0 });
    api = component({ get grid() { return data(); }, get captureFrameKey() { return key(); }, label: "Индукция", unit: "Тл",
      onCaptureReady: value => { registered = value; } }, {
      createEffect, createSignal, onCleanup, onMount, THREE: { ...THREE, WebGLRenderer: Renderer }, OrbitControls: Controls,
      ResizeObserver: class { observe() {} disconnect() {} }, disposeSurfaceObject, updateSurfaceMesh,
      updateSurfaceLabel: (sprite, text, position) => updateSurfaceLabel(sprite, text, position, labelCanvas),
      captureRenderedMovieFrame, createRenderedFrameGate, restoreMovieCamera, snapshotMovieCamera, testHost: host,
      captureMovieCanvas: (source, options) => {
        const texts = [], context = { fillRect() {}, fillText: text => texts.push(String(text)),
          createLinearGradient: () => ({ addColorStop() {} }) };
        options.overlay(context, { width: source.width, height: source.height });
        const image = { width: source.width, height: source.height, data: new Uint8ClampedArray(source.width * source.height * 4) };
        captures.push({ image, texts, caption: options.caption }); return image;
      },
    });
    Object.assign(api, { key, publish(values, frame) { batch(() => { setGrid(grid(values)); setKey(frame); }); } });
  });
  return { ...api, dispose, host, canvas, captures, drawCalls, events, get registered() { return registered; } };
}
const cameraState = h => ({ position: h.camera().position.toArray(), quaternion: h.camera().quaternion.toArray(),
  up: h.camera().up.toArray(), projection: [...h.camera().projectionMatrix.elements], zoom: h.camera().zoom,
  target: h.controls().target.toArray() });

function assertAutomaticSurface(h, values) {
  const expected = updateSurfaceMesh(null, grid(values)), actual = h.surface();
  assert.deepEqual(actual.userData.limits, expected.userData.limits);
  assert.deepEqual(Array.from(actual.geometry.getAttribute("position").array), Array.from(expected.geometry.getAttribute("position").array));
  assert.deepEqual(Array.from(actual.geometry.getAttribute("color").array), Array.from(expected.geometry.getAttribute("color").array));
  assert.equal(h.labels()[3].userData.text, expected.userData.limits.min.toPrecision(6));
  assert.equal(h.labels()[4].userData.text, expected.userData.limits.max.toPrecision(6));
  disposeSurfaceObject(expected);
}

test("Surface movie keeps per-frame automatic heights/colors and original camera through zero, large, tiny and signed fields", async () => {
  const h = runtime();
  try {
    const camera = h.camera(); camera.position.set(5, -6, 7); camera.zoom = 1.7; camera.updateProjectionMatrix();
    h.controls().target.set(.1, -.2, .3); h.controls().update();
    const original = cameraState(h), originalKey = h.key(), geometry = h.surface().geometry;
    await h.captureAdapter.renderReady(originalKey);
    h.captureAdapter.prepare(); assert.equal(h.controls().enabled, false);
    assertAutomaticSurface(h, [0, 0, 0, 0]);
    const frames = [[0, 1000, 250, 500], [0, 1e-9, 2.5e-10, 5e-10], [-1000, 1000, -500, 0], [0, 0, 0, 0]];
    for (const [index, values] of frames.entries()) {
      const key = { step: index + 1 };
      h.publish(values, key); await h.captureAdapter.renderReady(key);
      assertAutomaticSurface(h, values);
      assert.equal(h.surface().geometry, geometry, "new scales retain existing geometry allocations");
      assert.deepEqual(cameraState(h), original, "numeric auto scale never changes camera, projection or zoom");
      const count = h.drawCalls.length;
      const image = h.captureAdapter.capture(key, { caption: `step ${index + 1}` });
      assert.equal(h.drawCalls.length, count + 1, "capture forces a real component draw before copying");
      assert.equal(image, h.captures.at(-1).image);
      assert.ok(h.captures.at(-1).texts.includes(Math.min(...values).toPrecision(6)));
      assert.ok(h.captures.at(-1).texts.includes(Math.max(...values).toPrecision(6)));
    }
    h.publish([0, 0, 0, 0], originalKey); await h.captureAdapter.renderReady(originalKey);
    h.captureAdapter.restore(); assert.equal(h.controls().enabled, true);
    assert.deepEqual(cameraState(h), original);
    h.publish([0, 2000, 1000, 1500], { step: 5 }); assertAutomaticSurface(h, [0, 2000, 1000, 1500]);
  } finally { h.dispose(); }
  assert.equal(h.registered, null);
});

test("Surface movie blocks camera commands and defers renderer resizing without blocking automatic value scales", () => {
  const h = runtime({ initial: [-4, -2, 2, 4] });
  try {
    const original = cameraState(h), size = [h.canvas.width, h.canvas.height];
    h.captureAdapter.prepare(); h.view("z");
    h.host.clientWidth = 520; h.host.clientHeight = 310; h.resize();
    assert.deepEqual(cameraState(h), original); assert.deepEqual([h.canvas.width, h.canvas.height], size);
    h.publish([-10000, 5000, 7500, 10000], { step: 1 });
    assertAutomaticSurface(h, [-10000, 5000, 7500, 10000]);
    h.captureAdapter.restore();
    assert.deepEqual([h.canvas.width, h.canvas.height], [1040, 620]);
    assert.deepEqual(h.camera().position.toArray(), original.position);
    assert.deepEqual(h.controls().target.toArray(), original.target);
    assert.equal(h.camera().zoom, original.zoom); assert.equal(h.controls().enabled, true);
  } finally { h.dispose(); }
});

test("Surface movie preserves exact render identity and rejects init, context loss and unmount waits", async () => {
  const failed = runtime({ failInit: true });
  try { assert.ok(failed.registered); await assert.rejects(failed.captureAdapter.renderReady(failed.key()), /initialization/); }
  finally { failed.dispose(); }
  const h = runtime();
  try {
    h.captureAdapter.prepare(); const expected = { step: 1 }; let completed = false;
    const waiting = h.captureAdapter.renderReady(expected).then(() => { completed = true; });
    h.publish([0, 1000, 500, 250], { step: 1 }); await Promise.resolve(); assert.equal(completed, false);
    assert.throws(() => h.captureAdapter.capture(expected), /не отрисован/);
    h.publish([0, 1e-9, 5e-10, 2.5e-10], expected); await waiting;
    const lost = h.captureAdapter.renderReady({ step: 2 });
    h.events.get("webglcontextlost")({ preventDefault() {} }); await assert.rejects(lost, /WebGL потерян/);
    h.events.get("webglcontextrestored")();
    const closed = h.captureAdapter.renderReady({ step: 3 }); h.dispose();
    await assert.rejects(closed, /закрыто/); h.captureAdapter.restore();
  } finally { h.dispose(); }
});
