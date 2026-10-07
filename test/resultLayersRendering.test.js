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
const scalarLayer = (points, extra = {}) => ({ key: "elements", groupLabel: "Элементы", state: "ready",
  scalarScene: { points, minimum: Math.min(...points.map(point => point.value)),
    maximum: Math.max(...points.map(point => point.value)), quantity: "Потери на токи проводимости", unit: "Вт/мм³" }, ...extra });
const scalarDomain = (points, extra = {}) => ({ ...domain(points[0]), points,
  values: new Float32Array(Array.from({ length: 8 }, (_, i) => points[i % points.length].value)), ...extra });
const surface = (points, extra = {}) => ({ ...points[0], key: "surface", points, dimensions: [2, 2, 1],
  positions: new Float64Array(points.flatMap(point => point.origin)),
  values: new Float64Array(points.map(point => point.value ?? point.magnitude)),
  indices: new Uint32Array([0, 2, 3, 0, 3, 1]), ...extra });
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

test("actual raycasts choose nearest saved nodes across layers using each marker radius", () => withCanvas(() => {
  const vector = item(5, { origin: [.03, 0, -10] });
  const farScalar = { ...item(0, { origin: [.06, 0, -5] }), value: 3 };
  const nearScalar = { ...item(0, { origin: [0, 0, -2] }), value: 4 };
  let definitions = [layer("regions", [vector]), { key: "elements", scalarScene: {
    points: [farScalar], minimum: 3, maximum: 4, quantity: "J·E", unit: "Вт/мм³" } }];
  let states = run(new Map(), definitions, { colorMap: true, scale: 1 });
  resultLayerRoots(states).forEach(root => root.updateMatrixWorld(true));
  const raycaster = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
  let hits = intersectResultLayers(raycaster, states, .01);
  assert.equal(hits.length, 1);
  assert.equal(resultHitVector(hits[0]), vector);
  definitions = [definitions[0], { ...definitions[1], scalarScene: { ...definitions[1].scalarScene, points: [farScalar, nearScalar] } }];
  states = run(states, definitions, { colorMap: true, scale: 1 });
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

test("scalar point size and picking follow the shared scale without changing values or GPU allocations", () => withCanvas(() => {
  const negative = { ...item(999, { origin: [.03, 0, -5] }), value: -4 };
  const positive = { ...item(999, { origin: [1, 0, -5] }), value: 4 };
  const definitions = [scalarLayer([negative, positive])];
  let states = run(new Map(), definitions, { scale: 1, palette: "Rainbow" });
  const nodes = states.get("elements").scalarRoot;
  const geometry = nodes.geometry, material = nodes.material, texture = material.map;
  const color = geometry.getAttribute("color");
  assert.deepEqual(Array.from(color.array.slice(0, 6)), [0, 0, 1, 1, 0, 0]);
  let disposals = 0;
  for (const resource of [geometry, material, texture]) resource.addEventListener("dispose", () => disposals++);
  const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
  for (const [scale, size, picked] of [[.01, .8, false], [1, 8, true], [20, 80, true]]) {
    states = run(states, definitions, { scale, palette: "Rainbow" });
    assert.equal(states.get("elements").scalarRoot, nodes);
    assert.equal(nodes.geometry, geometry); assert.equal(nodes.material, material); assert.equal(material.map, texture);
    assert.equal(material.size, size); nodes.updateMatrixWorld(true);
    const hits = intersectResultLayers(ray, states, .01);
    assert.equal(hits.length, picked ? 1 : 0);
    if (picked) assert.equal(resultHitScalar(hits[0]), negative);
    assert.equal(nodes.userData.resultScalars[0].value, -4);
  }
  assert.equal(disposals, 0); clean(states); assert.equal(disposals, 3);
}));

test("scalar volumes preserve signed and constant ranges, units and geometry opacity", () => withCanvas(() => {
  for (const [minimum, maximum] of [[-4, 6], [-8, -2], [0, 0]]) {
    const points = [{ ...item(100), value: minimum }, { ...item(100), value: maximum }];
    const field = scalarDomain(points);
    const states = run(new Map(), [scalarLayer(points, { volumeFields: { domains: [field], fallbackPoints: [] } })],
      { colorMap: true, scale: 10, palette: "Rainbow", opacity: .37 });
    const state = states.get("elements"), root = state.scalarRoot;
    assert.equal(root.isGroup, true); assert.equal(state.vectorRoot, null);
    const mesh = root.getObjectByName("result-volume-domain");
    assert.equal(mesh.material.uniforms.uOpacity.value, .37);
    assert.equal(mesh.userData.minimum, minimum); assert.equal(mesh.userData.maximum, maximum);
    const bytes = mesh.material.uniforms.uField.value.image.data;
    assert.deepEqual([bytes[0], bytes[4]], minimum === maximum ? [128, 128] : [0, 255]);
    assert.deepEqual(state.legends.map(({ quantity, unit, minimum, maximum }) => ({ quantity, unit, minimum, maximum })),
      [{ quantity: "Потери на токи проводимости", unit: "Вт/мм³", minimum, maximum }]);
    const pick = root.getObjectByName("result-scalar-volume-pick-nodes");
    assert.equal(resultHitScalar({ object: pick, index: 0 }), points[0]);
    assert.equal(resultHitVector({ object: pick, index: 0 }), null);
    assert.equal(pick.material.colorWrite, false); assert.equal(pick.material.depthWrite, false);
    clean(states);
  }
}));

test("scalar volume picking excludes support vertices, proxy surfaces and omitted fallback samples", () => withCanvas(() => {
  const saved = { ...item(30, { origin: [0, 0, -5] }), value: -3 };
  const fallback = { ...item(30, { origin: [1, 0, -5] }), value: 8 };
  const omitted = { ...item(30, { origin: [2, 0, -5] }), value: 2 };
  const support = { ...item(30, { origin: [3, 0, -5] }), value: -3 };
  const field = scalarDomain([saved], { supportPoints: [support],
    bounds: { min: [-1, -1, -6], max: [4, 1, -4] } });
  const definitions = [scalarLayer([saved, fallback, omitted], { volumeFields: { domains: [field], fallbackPoints: [fallback] } })];
  const states = run(new Map(), definitions, { colorMap: true, scale: 10 });
  const root = states.get("elements").scalarRoot;
  const pick = root.getObjectByName("result-scalar-volume-pick-nodes");
  const markers = root.getObjectByName("result-scalar-volume-fallback-nodes");
  assert.deepEqual(pick.userData.resultScalars, [saved, fallback]);
  assert.deepEqual(markers.userData.resultScalars, [fallback]); assert.equal(markers.material.size, 8);
  root.updateMatrixWorld(true);
  for (const [x, expected] of [[0, saved], [1, fallback], [2, null], [3, null], [.5, null]]) {
    const ray = new THREE.Raycaster(new THREE.Vector3(x, 0, 0), new THREE.Vector3(0, 0, -1));
    const hits = intersectResultLayers(ray, states, .01);
    assert.equal(hits.length, expected ? 1 : 0);
    if (expected) assert.equal(resultHitScalar(hits[0]), expected);
  }
  clean(states);
}));

test("scalar volume resources persist across frames and are released on point/fallback/layer transitions", () => withCanvas(() => {
  const first = { ...item(0), value: -2 }, next = { ...item(0), value: 5 };
  const vectorDefinition = layer("regions", [item(7, { schemaId: "regions" })]);
  const options = { colorMap: true, scale: 10, palette: "Rainbow", opacity: .6 };
  let states = run(new Map(), [scalarLayer([first]), vectorDefinition], options);
  const pointRoot = states.get("elements").scalarRoot;
  let pointDisposed = 0;
  for (const resource of [pointRoot.geometry, pointRoot.material, pointRoot.material.map]) resource.addEventListener("dispose", () => pointDisposed++);
  const vectorState = states.get("regions");
  let definition = scalarLayer([first], { volumeFields: { domains: [scalarDomain([first])], fallbackPoints: [] } });
  states = run(states, [definition, vectorDefinition], options);
  assert.equal(pointDisposed, 3); assert.equal(states.get("regions"), vectorState);
  const root = states.get("elements").scalarRoot, mesh = root.getObjectByName("result-volume-domain");
  const fieldTexture = mesh.material.uniforms.uField.value, paletteTexture = mesh.material.uniforms.uPalette.value;
  const pick = root.getObjectByName("result-scalar-volume-pick-nodes"), pickGeometry = pick.geometry;
  let volumeDisposed = 0;
  for (const resource of [mesh.geometry, mesh.material, fieldTexture, paletteTexture]) resource.addEventListener("dispose", () => volumeDisposed++);
  definition = scalarLayer([next], { volumeFields: { domains: [scalarDomain([next])], fallbackPoints: [] } });
  states = run(states, [definition, vectorDefinition], options);
  assert.equal(states.get("elements").scalarRoot, root); assert.equal(root.getObjectByName("result-volume-domain"), mesh);
  assert.equal(mesh.material.uniforms.uField.value, fieldTexture); assert.equal(pick.geometry, pickGeometry);
  assert.equal(resultHitScalar({ object: pick, index: 0 }), next);
  const version = fieldTexture.version;
  states = run(states, [definition, vectorDefinition], { ...options, palette: "Inferno", opacity: .2 });
  assert.equal(fieldTexture.version, version); assert.equal(mesh.material.uniforms.uOpacity.value, .2);
  assert.equal(paletteTexture.userData.palette, "Inferno"); assert.equal(volumeDisposed, 0);
  definition = scalarLayer([next], { volumeFields: { domains: [], fallbackPoints: [next] } });
  states = run(states, [definition, vectorDefinition], options);
  assert.equal(states.get("elements").scalarRoot, root); assert.equal(volumeDisposed, 4);
  assert.equal(root.getObjectByName("result-volume-domain"), undefined);
  assert.equal(root.getObjectByName("result-scalar-volume-fallback-nodes").material.size, 8);
  let fallbackDisposed = 0;
  root.traverse(object => { for (const resource of [object.geometry, object.material, object.material?.map].filter(Boolean)) resource.addEventListener("dispose", () => fallbackDisposed++); });
  states = run(states, [scalarLayer([next]), vectorDefinition], { ...options, scale: 2 });
  assert.equal(fallbackDisposed, 6); assert.equal(states.get("elements").scalarRoot.material.size, 16);
  const remaining = states.get("regions");
  states = run(states, [vectorDefinition], { ...options, scale: 2 });
  assert.equal(states.get("regions"), remaining); assert.equal(states.has("elements"), false);
  clean(states);
}));

test("planar vector fields coexist with scalar volumes, keep saved-node picking and release only their own resources", () => withCanvas(() => {
  const points = [[0, 0, -5], [0, 1, -5], [1, 0, -5], [1, 1, -5]].map((origin, i) =>
    item(i + 1, { schemaId: "regions", origin, quantity: "Bs", unit: "Тл" }));
  const planar = surface(points);
  const scalar = { ...item(0, { origin: [3, 0, -5] }), value: -2 };
  const scalarDefinition = scalarLayer([scalar], { volumeFields: { domains: [scalarDomain([scalar])], fallbackPoints: [] } });
  const definition = layer("regions", points, { volumeFields: { domains: [], surfaces: [planar], fallbackPoints: [] } });
  const options = { colorMap: true, scale: 10, palette: "Rainbow", opacity: .4 };
  let states = run(new Map(), [scalarDefinition, definition], options);
  const root = states.get("regions").vectorRoot;
  const mesh = root.getObjectByName("result-surface-domain");
  assert.ok(mesh); assert.equal(root.getObjectByName("result-volume-domain"), undefined);
  const pick = root.getObjectByName("result-volume-pick-nodes");
  assert.deepEqual(pick.userData.resultVectors, points);
  resultLayerRoots(states).forEach(layerRoot => layerRoot.updateMatrixWorld(true));
  const nodeRay = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
  const hits = intersectResultLayers(nodeRay, states, .01);
  assert.equal(hits.length, 1); assert.equal(resultHitVector(hits[0]), points[0]);
  const faceRay = new THREE.Raycaster(new THREE.Vector3(.5, .5, 0), new THREE.Vector3(0, 0, -1));
  assert.equal(intersectResultLayers(faceRay, states, .01).length, 0);
  const scalarState = states.get("elements");
  let released = 0;
  for (const resource of [mesh.geometry, mesh.material, ...mesh.material.userData.resultOwnedTextures]) resource.addEventListener("dispose", () => released++);
  states = run(states, [scalarDefinition, layer("regions", points, { volumeFields: { domains: [], surfaces: [], fallbackPoints: points } })], options);
  assert.equal(states.get("regions").vectorRoot, root); assert.equal(released, 3);
  assert.equal(states.get("elements"), scalarState);
  assert.deepEqual(root.getObjectByName("result-volume-fallback-nodes").userData.resultVectors, points);
  clean(states);
}));

test("surface filters and scalar surface picking share the saved-node contract across representation changes", () => withCanvas(() => {
  const points = [[0, 0, -5], [0, 1, -5], [1, 0, -5], [1, 1, -5]].map((origin, i) =>
    ({ ...item(99, { origin }), value: i - 2 }));
  const excluded = points.map(point => ({ ...point, source: { ...point.source, recordIndex: 1 } }));
  const mirrored = points.map(point => ({ ...point, instance: { ...point.instance, ls: 1 } }));
  const surfaces = [surface(points), surface(excluded, { key: "excluded" }), surface(mirrored, { key: "local-image" })];
  const definition = scalarLayer([...points, ...excluded, ...mirrored], { volumeFields: { domains: [], surfaces, fallbackPoints: [] } });
  const options = { colorMap: true, scale: 10, palette: "Rainbow", filters: {
    objectModes: { elements: "selected" }, selections: { elements: new Set([0]) }, symmetry: { local: false },
  } };
  let states = run(new Map(), [definition], options);
  const root = states.get("elements").scalarRoot;
  const meshes = root.children.filter(child => child.name === "result-surface-domain");
  assert.equal(meshes.length, 1);
  const pick = root.getObjectByName("result-scalar-volume-pick-nodes");
  assert.deepEqual(pick.userData.resultScalars, points);
  root.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, 0, -1));
  const hits = intersectResultLayers(ray, states, .01);
  assert.equal(hits.length, 1); assert.equal(resultHitScalar(hits[0]), points[0]);
  let released = 0;
  for (const resource of [meshes[0].geometry, meshes[0].material, ...meshes[0].material.userData.resultOwnedTextures]) resource.addEventListener("dispose", () => released++);
  states = run(states, [layer("elements", points)], { ...options, scale: 1 });
  assert.equal(released, 3); assert.equal(states.get("elements").scalarRoot, null);
  assert.equal(states.get("elements").vectorRoot.userData.style, "points");
  clean(states);
}));

test('global point colours and legends change without re-reading or replacing point buffers', () => {
  const base=layer('elements',[item(5),item(10)]), bounds={available:true,minimum:0,maximum:100};
  let states=run(new Map(),[base],{colorMap:true});const nodes=states.get('elements').vectorRoot.children[0];
  const geometry=nodes.geometry,oldColors=[...geometry.getAttribute('color').array];
  states=run(states,[{...base,displayRange:bounds}],{colorMap:true});
  assert.equal(states.get('elements').vectorRoot.children[0],nodes);assert.equal(nodes.geometry,geometry);
  assert.deepEqual(states.get('elements').legends.map(l=>[l.minimum,l.maximum]),[[0,100]]);
  assert.notDeepEqual([...geometry.getAttribute('color').array],oldColors);
  states=run(states,[base],{colorMap:true});
  assert.deepEqual(states.get('elements').legends.map(l=>[l.minimum,l.maximum]),[[5,10]]);
  assert.deepEqual(base.scene.vectors.map(v=>v.magnitude),[5,10]);clean(states);
});

test('global extrema drive vector volume textures, surfaces and scalar maps; actual signed values remain untouched',()=>withCanvas(()=>{
  const vector=item(5),domainData=domain(vector,10),bounds={available:true,minimum:0,maximum:100};
  let states=run(new Map(),[layer('elements',[vector],{displayRange:bounds,volumeFields:{domains:[domainData],fallbackPoints:[]}})],{colorMap:true});
  const mesh=states.get('elements').vectorRoot.getObjectByName('result-volume-domain');
  assert.equal(mesh.userData.minimum,0);assert.equal(mesh.userData.maximum,100);
  assert.equal(mesh.material.uniforms.uField.value.image.data[4],26);
  clean(states);
  const points=[{...item(1),value:-2},{...item(1,{origin:[1,0,0]}),value:3},{...item(1,{origin:[0,1,0]}),value:4},{...item(1,{origin:[1,1,0]}),value:6}];
  for(const volume of [false,true]){
    const base=scalarLayer(points,{displayRange:bounds,...(volume?{volumeFields:{domains:[scalarDomain(points)],surfaces:[surface(points)],fallbackPoints:[]}}:{})});
    states=run(new Map(),[base],{colorMap:true});
    assert.deepEqual(states.get('elements').legends.map(l=>[l.minimum,l.maximum]),[[0,100]]);
    assert.deepEqual(points.map(p=>p.value),[-2,3,4,6]);
    if(volume)assert.equal(states.get('elements').scalarRoot.getObjectByName('result-volume-domain').userData.maximum,100);
    clean(states);
  }
}));

test('global vector length reference survives tiny/large/zero frames without mutating actual extrema',async()=>{
  const {applyResultGlobalRange}=await import('../src/services/results/resultGlobalScale.js');
  let states=new Map();
  for(const magnitude of [1e-6,10,0,5]){
    const base=layer('elements',[item(magnitude)],{vectorLengthReference:{characteristicSize:1,sceneDiagonal:100,maximumMagnitude:{magnetization:1e-6}}});
    const displayed=applyResultGlobalRange(base,{available:true,minimum:0,maximum:10});
    states=run(states,[displayed]);
    const line=states.get('elements').vectorRoot.getObjectByName('prescribed-source-magnetization');
    if(magnitude){const p=line.geometry.getAttribute('position').array;assert.ok(Math.abs(p[3]-p[0]-.7*magnitude/10)<1e-6);}
    assert.equal(base.scene.maximumMagnitude.magnetization,magnitude);
  }
  clean(states);
});
