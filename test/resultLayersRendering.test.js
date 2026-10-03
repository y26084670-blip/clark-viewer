import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import * as THREE from "three";
import { resultHitScalar, resultHitVector } from "../src/services/visualization/geometryPicking.js";
import { fitCameraToVisibleObjects } from "../src/services/visualization/geometryCameraFit.js";

const server = await createServer({ configFile: false, plugins: [solid({ ssr: true })],
  root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: false } });
after(() => server.close());
const { updateResultLayers, resultLayerRoots, intersectResultLayers } =
  await server.ssrLoadModule("/src/components/geometry/ThreeGeometryViewport.jsx");

const instance = { ls: 0, as: 0, ps: 0, mirrorX: false, mirrorY: false };
const item = (magnitude, { schemaId = "elements", recordIndex = 0, origin = [1, 2, 3],
  quantity = "M", unit = "кА/м", ls = 0 } = {}) => ({ source: { schemaId, recordIndex },
  instance: { ...instance, ls }, origin, vector: [magnitude, 0, 0], magnitude,
  kind: "magnetization", characteristicSize: 1, quantity, unit });
const scene = vectors => ({ vectors, sceneDiagonal: 100,
  maximumMagnitude: { magnetization: Math.max(...vectors.map(p => p.magnitude), 0), current: 0 } });
const layer = (key, points, extra = {}) => ({ key, groupLabel: key, state: "ready", scene: scene(points), ...extra });
const domain = (point, maximum = point.magnitude) => ({ ...point, key: "same-domain-key", points: [point],
  dimensions: [2, 2, 2], bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  values: new Float32Array([0, maximum, 0, maximum, 0, maximum, 0, maximum]), mask: new Uint8Array(8).fill(255) });
const filters = {};
const run = (states, definitions, options = {}) => updateResultLayers(THREE, states, definitions, { filters, ...options });
const clean = states => run(states, []);
const withCanvas = callback => {
  const old = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({ beginPath() {}, arc() {}, fill() {} }) }) };
  try { return callback(); } finally { globalThis.document = old; }
};

// These invoke the production reconciliation/picking paths with real Three objects;
// no browser or WebGL context is required for buffer, texture and raycast checks.
test("three simultaneous vector categories keep independent normalization and saved world coordinates", () => {
  const definitions = [layer("elements", [item(1)], { color: 0x44dd66 }),
    layer("regions", [item(1e6, { schemaId: "regions", quantity: "Bs", unit: "Тл", origin: [20, 0, 0] })]),
    layer("virtual", [item(.001, { recordIndex: 4, quantity: "Av", unit: "Тл·мм", origin: [-20, 0, 0] })])];
  const states = run(new Map(), definitions);
  assert.equal(states.size, 3);
  assert.equal(resultLayerRoots(states).length, 3);
  for (const definition of definitions) {
    const root = states.get(definition.key).vectorRoot;
    const line = root.getObjectByName("prescribed-source-magnetization");
    const coordinates = line.geometry.getAttribute("position").array;
    const point = definition.scene.vectors[0];
    assert.deepEqual(Array.from(coordinates.slice(0, 3)), point.origin);
    assert.ok(Math.abs(coordinates[3] - coordinates[0] - .7) < 1e-6);
    assert.equal(resultHitVector({ object: line, index: 0 }), point);
    assert.equal(states.get(definition.key).legends.length, 0);
  }
  assert.equal(states.get("elements").vectorRoot.children[0].material.color.getHex(), 0x44dd66);
  clean(states);
});

test("color legends and resource changes remain local to the updated category", () => {
  const definitions = [layer("elements", [item(0), item(2)]),
    layer("regions", [item(10, { schemaId: "regions", unit: "Тл" }), item(30, { schemaId: "regions", unit: "Тл" })]),
    layer("virtual", [item(100, { unit: "Тл·мм" }), item(200, { unit: "Тл·мм" })])];
  let states = run(new Map(), definitions, { colorMap: true });
  assert.deepEqual([...states.values()].map(s => [s.legends[0].minimum, s.legends[0].maximum, s.legends[0].unit]),
    [[0, 2, "кА/м"], [10, 30, "Тл"], [100, 200, "Тл·мм"]]);
  const unchanged = states.get("regions"), nodes = unchanged.vectorRoot.children[0];
  const position = nodes.geometry.getAttribute("position"), color = nodes.geometry.getAttribute("color");
  const versions = [position.version, color.version];
  let disposals = 0;
  for (const resource of [nodes.geometry, nodes.material, nodes.material.map]) {
    resource.addEventListener("dispose", () => disposals++);
  }
  states = run(states, [layer("elements", [item(7), item(8)]), ...definitions.slice(1)], { colorMap: true });
  assert.equal(states.get("regions"), unchanged);
  assert.deepEqual([position.version, color.version], versions);
  assert.equal(disposals, 0);
  assert.deepEqual(states.get("elements").legends.map(l => [l.minimum, l.maximum]), [[7, 8]]);
  assert.equal(states.get("regions").legends[0].groupLabel, "regions");
  clean(states);
});

test("scalar, nodal vector and interpolated volume layers coexist with separate legends", () => withCanvas(() => {
  const scalar = { ...item(0), value: 12 };
  const virtual = item(50, { quantity: "Av", unit: "Тл·мм" });
  const states = run(new Map(), [
    { key: "elements", groupLabel: "Элементы", state: "ready", scalarScene: { points: [scalar], minimum: 12,
      maximum: 12, quantity: "Плотность энергии ФММ", unit: "Дж/м³" } },
    layer("regions", [item(.5, { schemaId: "regions", quantity: "Bs", unit: "Тл" })]),
    layer("virtual", [virtual], { volumeFields: { domains: [domain(virtual)], fallbackPoints: [] } }),
  ], { colorMap: true, scale: 10, opacity: .42 });
  assert.equal(states.get("elements").scalarRoot.isPoints, true);
  assert.equal(states.get("regions").vectorStyle, "points");
  const volume = states.get("virtual").vectorRoot.getObjectByName("result-volume-domain");
  assert.ok(volume);
  assert.equal(volume.material.uniforms.uOpacity.value, .42);
  assert.deepEqual([...states.values()].flatMap(s => s.legends.map(l => l.unit)), ["Дж/м³", "Тл", "Тл·мм"]);
  assert.equal(resultHitScalar({ object: states.get("elements").scalarRoot, index: 0 }), scalar);
  const pick = states.get("virtual").vectorRoot.getObjectByName("result-volume-pick-nodes");
  assert.equal(resultHitVector({ object: pick, index: 0 }), virtual);
  assert.equal(pick.material.colorWrite, false);
  clean(states);
}));

test("turning off one category disposes its volume resources and leaves other results and geometry intact", () => {
  const a = item(3), b = item(5, { schemaId: "regions", unit: "Тл" });
  const definitions = [layer("elements", [a], { volumeFields: { domains: [domain(a)], fallbackPoints: [] } }),
    layer("regions", [b], { volumeFields: { domains: [domain(b)], fallbackPoints: [] } })];
  let states = run(new Map(), definitions, { colorMap: true });
  const parent = new THREE.Group();
  const geometry = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  parent.add(geometry, ...resultLayerRoots(states));
  const removed = states.get("elements").vectorRoot;
  const mesh = removed.getObjectByName("result-volume-domain");
  let freed = 0, unaffected = 0;
  for (const resource of [mesh.geometry, mesh.material, ...mesh.material.userData.resultOwnedTextures]) {
    resource.addEventListener("dispose", () => freed++);
  }
  geometry.geometry.addEventListener("dispose", () => unaffected++);
  const kept = states.get("regions");
  states = run(states, [{ key: "elements", state: "disabled", scene: definitions[0].scene }, definitions[1]], { colorMap: true });
  assert.equal(freed, 4);
  assert.equal(removed.parent, null);
  assert.equal(states.get("regions"), kept);
  assert.equal(geometry.parent, parent);
  assert.equal(unaffected, 0);
  states = run(states, [{ key: "regions", state: "error", scene: definitions[1].scene }], { colorMap: true });
  assert.equal(states.size, 0);
  assert.deepEqual(parent.children, [geometry]);
  geometry.geometry.dispose(); geometry.material.dispose();
});

test("independent object and symmetry filters apply to vectors, scalar nodes, volume domains and fallback nodes", () => withCanvas(() => {
  const points = [item(1, { recordIndex: 0 }), item(2, { recordIndex: 1 }), item(3, { recordIndex: 1, ls: 1 })];
  const regions = points.map(p => ({ ...p, source: { ...p.source, schemaId: "regions" } }));
  const options = { colorMap: true, filters: { objectModes: { elements: "exceptSelected", regions: "selected" },
    selections: { elements: new Set([0]), regions: new Set([0]) }, symmetry: { local: false } } };
  const states = run(new Map(), [
    layer("virtual", points, { volumeFields: { domains: points.map((p, index) => ({ ...domain(p), key: `${index}` })), fallbackPoints: points } }),
    layer("regions", regions),
    { key: "elements", scalarScene: { points: points.map(p => ({ ...p, value: p.magnitude })),
      minimum: 1, maximum: 3, quantity: "M·H", unit: "Дж/м³" } },
  ], options);
  const virtualRoot = states.get("virtual").vectorRoot;
  assert.equal(virtualRoot.children.filter(c => c.name === "result-volume-domain").length, 1);
  assert.deepEqual(virtualRoot.getObjectByName("result-volume-pick-nodes").userData.resultVectors, [points[1]]);
  assert.deepEqual(virtualRoot.getObjectByName("result-volume-fallback-nodes").userData.resultVectors, [points[1]]);
  assert.deepEqual(states.get("regions").vectorRoot.children[0].userData.resultVectors, [regions[0]]);
  assert.equal(states.get("elements").scalarRoot.geometry.drawRange.count, 1);
  assert.equal(states.get("elements").scalarRoot.userData.resultScalars[0].source.recordIndex, 1);
  clean(states);
}));

test("actual raycasts choose nearest saved nodes across layers without widening scalar hit radius", () => withCanvas(() => {
  const vector = item(5, { origin: [.3, 0, -10] });
  const farScalar = { ...item(0, { origin: [.3, 0, -5] }), value: 3 };
  const nearScalar = { ...item(0, { origin: [0, 0, -2] }), value: 4 };
  let definitions = [layer("regions", [vector]), { key: "elements", scalarScene: {
    points: [farScalar], minimum: 3, maximum: 4, quantity: "J·E", unit: "Вт/мм³" } }];
  let states = run(new Map(), definitions, { colorMap: true, scale: 10 });
  resultLayerRoots(states).forEach(root => root.updateMatrixWorld(true));
  const raycaster = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
  let hits = intersectResultLayers(raycaster, states, .01);
  assert.equal(hits.length, 1);
  assert.equal(resultHitVector(hits[0]), vector);
  definitions = [definitions[0], { ...definitions[1], scalarScene: { ...definitions[1].scalarScene, points: [farScalar, nearScalar] } }];
  states = run(states, definitions, { colorMap: true, scale: 10 });
  resultLayerRoots(states).forEach(root => root.updateMatrixWorld(true));
  hits = intersectResultLayers(raycaster, states, .01);
  assert.equal(hits.length, 2);
  assert.equal(resultHitScalar(hits[0]), nearScalar);
  assert.equal(resultHitVector(hits[1]), vector);
  clean(states);
}));

test("visible-fit includes all result categories and contracts after disabling a distant category", () => {
  const definitions = [layer("elements", [item(1, { origin: [-20, 0, 0] })]),
    layer("regions", [item(3, { origin: [40, 0, 0], schemaId: "regions" })])];
  let states = run(new Map(), definitions);
  const helper = new THREE.Group(); helper.add(...resultLayerRoots(states));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 1000); camera.position.set(0, 0, 100);
  const controls = { target: new THREE.Vector3(), update() {} };
  assert.equal(fitCameraToVisibleObjects(THREE, camera, controls, [helper]), true);
  assert.ok(camera.right - camera.left > 60);
  states = run(states, [definitions[0]]);
  assert.equal(fitCameraToVisibleObjects(THREE, camera, controls, [helper]), true);
  assert.ok(camera.right - camera.left < 2);
  clean(states);
});

test("bounded volume fallback picks only displayed nodes and successful volume nodes", () => {
  const visible = item(1, { origin: [0, 0, -5] });
  const omitted = item(2, { origin: [1, 0, -5] });
  const volumeNode = item(3, { recordIndex: 1, origin: [2, 0, -5] });
  const states = run(new Map(), [layer("elements", [visible, omitted, volumeNode], {
    volumeFields: { domains: [domain(volumeNode)], fallbackPoints: [visible] },
  })], { colorMap: true });
  const root = states.get("elements").vectorRoot;
  const pick = root.getObjectByName("result-volume-pick-nodes");
  assert.deepEqual(pick.userData.resultVectors, [volumeNode, visible]);
  assert.deepEqual(root.getObjectByName("result-volume-fallback-nodes").userData.resultVectors, [visible]);
  root.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1));
  assert.equal(intersectResultLayers(ray, states, .01).length, 0);
  clean(states);
});
