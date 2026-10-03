import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { sourcesFields3DSetup } from "../scripts/test-support/sourcesFields3DSetup.js";
import { RESULT_LAYER_GROUPS, RESULT_LAYER_QUANTITY_LABELS } from "../src/services/results/resultLayerDefinitions.js";

function fixture() {
  const task = { elements: [{ id: 1, targ: 0 }, { id: 2, targ: 3 }, { id: 3, targ: 2 }],
    regions: [{ id: 1 }, { id: 2 }] };
  return { task, elements: [1, 2, 3], regions: [1, 2], time: 9 };
}
const selections = layers => Object.fromEntries(layers.map(layer => [layer.key, layer.selected]));

// These tests execute the production setup and its real request/display functions.
// The UI labels/options are owned by the same descriptor rendered by its <For>.
test("3D quantity groups expose exact independent choices and M/none/none defaults", () => {
  assert.deepEqual(RESULT_LAYER_GROUPS.map(group => [group.key, group.defaultQuantity, [...group.quantities]]), [
    ["elements", "M", ["none", "M", "H", "MHdot", "J", "E", "JEdot"]],
    ["regions", "none", ["none", "Bs", "As"]],
    ["virtual", "none", ["none", "Bv", "Av"]],
  ]);
  assert.equal(RESULT_LAYER_QUANTITY_LABELS.H, "Напряженность МП");
  assert.equal(RESULT_LAYER_QUANTITY_LABELS.E, "Напряженность ЭП");
  const props = fixture(), ui = sourcesFields3DSetup(props);
  assert.deepEqual(ui.request().layers.map(layer => layer.quantityKey), ["M", "none", "none"]);
  ui.quantities.regions.write("As"); ui.quantities.virtual.write("Bv");
  assert.deepEqual(ui.request().layers.map(layer => layer.quantityKey), ["M", "As", "Bv"]);
  assert.deepEqual(selections(ui.request().layers), { elements: [1, 3], regions: [1, 2], virtual: [2] });
  ui.quantities.elements.write("none");
  assert.deepEqual(ui.request().layers.map(layer => layer.quantityKey), ["none", "As", "Bv"]);
  assert.deepEqual(props.elements, [1, 2, 3]);
  assert.deepEqual(ui.selections(), { elements: [0, 1, 2], regions: [0, 1] });
  ui.close();
});

test("inverse visibility uses the independent physical and virtual complements", () => {
  const props = fixture(); props.elements = [1]; props.regions = [2];
  const ui = sourcesFields3DSetup(props, { elementsMode: "exceptSelected", regionsMode: "exceptSelected",
    resultRegionsQuantity: "Bs", resultVirtualQuantity: "Av" });
  assert.deepEqual(selections(ui.request().layers), { elements: [3], regions: [1], virtual: [2] });
  assert.deepEqual(props.elements, [1]); assert.deepEqual(props.regions, [2]);
  ui.close();
});

test("shared color controls affect vector layers while scalar layers keep node representation", () => {
  const settings = { resultElementsQuantity: "MHdot", resultRegionsQuantity: "Bs", resultVirtualQuantity: "Av",
    resultVectorScale: 10, resultVectorColorMap: true };
  const ui = sourcesFields3DSetup(fixture(), settings);
  assert.equal(ui.hasVectors(), true); assert.equal(ui.hasScalars(), true);
  assert.deepEqual(ui.request().layers.map(layer => layer.volumeMode), [false, true, true]);
  settings.resultVectorColorMap = false;
  assert.deepEqual(ui.request().layers.map(layer => layer.volumeMode), [false, false, false]);
  ui.quantities.regions.write("none"); ui.quantities.virtual.write("none");
  assert.equal(ui.hasVectors(), false); assert.equal(ui.hasScalars(), true);
  ui.close();
});

test("published layers retain their units and shared time while a newer frame is loading", () => {
  const props = fixture(), ui = sourcesFields3DSetup(props, { resultRegionsQuantity: "Bs", resultVirtualQuantity: "Av" });
  const frame = { request: { time: 4 }, value: { layers: [
    { key: "elements", quantityKey: "JEdot", state: "ready", scalarScene: { minimum: 1, maximum: 2 },
      sampled: true, volumeNotice: "" },
    { key: "regions", quantityKey: "Bs", state: "error", error: "HS.h5 отсутствует" },
    { key: "virtual", quantityKey: "Av", state: "ready", scene: { maximumMagnitude: { magnetization: 3 } },
      volumeFields: { domains: [{}] }, volumeNotice: "Часть сеток показана узлами" },
  ] } };
  ui.setResultState({ frame, loading: true, error: "" });
  assert.equal(ui.timeIndex(), 4);
  const layers = ui.statusLayers();
  assert.match(ui.layerStatus(layers[0]), /J·E/);
  assert.match(ui.layerStatus(layers[0]), /Вт\/мм³/);
  assert.match(ui.layerStatus(layers[0]), /выборка/);
  assert.equal(ui.layerStatus(layers[1]), "HS.h5 отсутствует");
  assert.match(ui.layerStatus(layers[2]), /Тл·м/);
  assert.match(ui.layerStatus(layers[2]), /Объёмная карта: 1 сеток/);
  assert.match(ui.layerStatus(layers[2]), /Часть сеток/);
  assert.deepEqual(ui.resultLayers().map(layer => layer.groupLabel), ["Элементы", "Области", "Виртуальные элементы"]);
  assert.equal(ui.resultLayers()[0].scalarScene, frame.value.layers[0].scalarScene);
  assert.equal(ui.resultLayers()[2].scene, frame.value.layers[2].scene);
  ui.close();
});

test("all disabled quantities immediately hide results and follow time without changing geometry selection", async () => {
  const props = fixture(); let metadataReads = 0;
  Object.defineProperty(props.task, "metadata", { get() { metadataReads++; throw new Error("No HDF5 required"); } });
  const ui = sourcesFields3DSetup(props, { resultElementsQuantity: "none" });
  ui.setResultState({ frame: { request: { time: 2 }, value: { layers: [{ key: "elements", quantityKey: "M", state: "ready" }] } },
    loading: true, error: "" });
  assert.deepEqual(ui.resultLayers(), []);
  assert.equal(ui.timeIndex(), 9);
  assert.ok(ui.statusLayers().every(layer => layer.state === "disabled"));
  assert.deepEqual(ui.selections(), { elements: [0, 1, 2], regions: [0, 1] });
  const disabled = await ui.load(ui.request());
  assert.ok(disabled.layers.every(layer => layer.state === "disabled"));
  assert.equal(metadataReads, 0);
  ui.close();
});

test("Solid subscriptions reread data only when point/volume mode changes, not for palette or vector size", () => {
  execFileSync(process.execPath, ["--conditions=browser", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createRoot, createSignal, createMemo, createEffect } from "solid-js";
    import { sourcesFields3DSetup } from "./scripts/test-support/sourcesFields3DSetup.js";
    const signals = new Map(), requests = [];
    let dispose, ui;
    createRoot(cleanup => {
      dispose = cleanup;
      ui = sourcesFields3DSetup({ task: { elements: [{ id: 1, targ: 0 }], regions: [] }, elements: [1], regions: [], time: 0 }, {}, {
        createMemo,
        createGeometryViewSetting(name, initial) {
          if (!signals.has(name)) signals.set(name, createSignal(initial));
          return signals.get(name);
        },
        observeRequest(source) { createEffect(() => requests.push(source())); },
      });
    });
    const set = (name, value) => signals.get(name)[1](value);
    assert.equal(requests.length, 1);
    set("resultPalette", "Turbo"); set("resultVectorScale", 2);
    set("resultVectorColorMap", true); set("resultVectorScale", 8);
    set("resultVectorColorMap", false); set("resultVectorColorMap", true);
    assert.equal(requests.length, 1);
    set("resultVectorScale", 10);
    assert.equal(requests.length, 2);
    assert.equal(requests.at(-1).layers[0].volumeMode, true);
    set("resultPalette", "Inferno"); set("resultVectorScale", 10);
    assert.equal(requests.length, 2);
    set("resultVectorScale", 9);
    assert.equal(requests.length, 3);
    assert.equal(requests.at(-1).layers[0].volumeMode, false);
    set("resultVectorColorMap", false);
    assert.equal(requests.length, 3);
    ui.close(); dispose();
  `], { cwd: new URL("../", import.meta.url), stdio: "pipe" });
});
