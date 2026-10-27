import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { sourcesFields3DSetup } from "../scripts/test-support/sourcesFields3DSetup.js";
import { RESULT_LAYER_GROUPS, RESULT_LAYER_QUANTITY_LABELS } from "../src/services/results/resultLayerDefinitions.js";

function fixture() {
  const task = { elements: [{ id: 1, targ: 0 }, { id: 2, targ: 3 }, { id: 3, targ: 2 }],
    regions: [{ id: 1 }, { id: 2 }] };
  return { task, elements: [1, 2, 3], regions: [1, 2], time: 9 };
}

test("3D camera state survives tab disposal and remains scoped to the loaded task", () => {
  const props = fixture(), task = props.task;
  const camera = { projection: "orthographic", position: [9, 8, 7], target: [3, 2, 1], zoom: 4 };
  let ui = sourcesFields3DSetup(props);
  const request = ui.request();
  ui.rememberCamera(camera, task); assert.deepEqual(ui.request(), request);
  ui.close(); ui = sourcesFields3DSetup(props);
  assert.equal(ui.cameraState(), camera);
  props.task = fixture().task; ui.flushEffects(); assert.equal(ui.cameraState(), undefined);
  ui.rememberCamera({ ...camera, zoom: 5 }, task);
  assert.equal(ui.cameraState(), undefined, "late old-task callback cannot overwrite the new task view");
  ui.close();
});
const selections = layers => Object.fromEntries(layers.map(layer => [layer.key, layer.selected]));

// These tests execute the production setup and its real request/display functions.
// The UI labels/options are owned by the same descriptor rendered by its <For>.
test("3D quantity groups expose exact independent choices and M/none/none defaults", () => {
  assert.deepEqual(RESULT_LAYER_GROUPS.map(group => [group.key, group.defaultQuantity, [...group.quantities]]), [
    ["elements", "M", ["none", "M", "H", "MHdot", "J", "E", "JEdot", "sigmaRelative"]],
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
test("line width persists while streamline colour map is permanently enabled", () => {
  const props=fixture(),settings={resultElementsQuantity:"none"};
  let ui=sourcesFields3DSetup(props,settings);
  ui.setResultState({frame:{request:{task:props.task,time:props.time},value:{layers:[]}}});
  assert.equal(ui.streamlineControls().width,2);
  assert.equal(ui.streamlineControls().colorMap,true);
  const request=ui.request();
  ui.streamlineControls().onWidthInput({currentTarget:{valueAsNumber:7}});
  assert.equal(ui.streamlineControls().viewportWidth,7);
  assert.equal(ui.streamlineControls().viewportColorMap,true);
  assert.deepEqual(ui.request(),request);
  ui.close();ui=sourcesFields3DSetup(props,settings);
  assert.equal(ui.streamlineControls().width,7);
  assert.equal(ui.streamlineControls().colorMap,true);
  ui.close();
});

test("scalar maps expose size controls, force every active layer to color mode and preserve the vector preference", () => {
  const settings = { resultElementsQuantity: "MHdot", resultRegionsQuantity: "Bs", resultVirtualQuantity: "Av",
    resultVectorScale: 1, resultVectorColorMap: false };
  const ui = sourcesFields3DSetup(fixture(), settings);
  assert.equal(ui.hasVectors(), true); assert.equal(ui.hasScalars(), true);
  assert.equal(ui.effectiveColorMap(), true);
  assert.equal(ui.colorMap(), false);
  assert.equal(ui.controls().visible, true);
  assert.equal(ui.controls().label, "Размер");
  assert.equal(ui.controls().checked, true);
  assert.equal(ui.controls().disabled, true);
  assert.equal(ui.controls().viewportColorMap, true);
  assert.deepEqual(ui.request().layers.map(layer => layer.volumeMode), [false, false, false]);
  ui.controls().onChange({ currentTarget: { checked: true } });
  assert.equal(settings.resultVectorColorMap, false, "forced scalar mode must not overwrite the vector preference");
  ui.controls().onInput({ currentTarget: { valueAsNumber: 3 } });
  assert.equal(ui.scale(), 1000);
  assert.deepEqual(ui.request().layers.map(layer => layer.volumeMode), [true, true, true]);
  ui.quantities.regions.write("none"); ui.quantities.virtual.write("none");
  assert.equal(ui.hasVectors(), false); assert.equal(ui.hasScalars(), true);
  assert.equal(ui.controls().visible, true);
  assert.deepEqual(ui.request().layers.map(layer => layer.volumeMode), [true, false, false]);
  ui.quantities.elements.write("JEdot");
  assert.deepEqual(ui.request().layers.map(layer => layer.volumeMode), [true, false, false]);
  ui.quantities.elements.write("M");
  assert.equal(ui.controls().checked, false);
  assert.equal(ui.controls().disabled, false);
  assert.equal(ui.controls().label, "Размер");
  assert.equal(ui.controls().viewportColorMap, false);
  assert.deepEqual(ui.request().layers.map(layer => layer.volumeMode), [false, false, false]);
  ui.controls().onChange({ currentTarget: { checked: true } });
  ui.quantities.elements.write("MHdot"); ui.quantities.elements.write("M");
  assert.equal(ui.colorMap(), true, "an enabled user preference also survives scalar selection");
  assert.equal(ui.controls().checked, true);
  assert.equal(ui.controls().disabled, false);
  assert.equal(ui.controls().viewportColorMap, true);
  ui.quantities.elements.write("none");
  assert.equal(ui.controls().visible, false);
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
  assert.deepEqual(ui.resultLayers().map(layer => layer.groupLabel), ["Элементы", "Области", "Виртуальные"]);
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
  assert.deepEqual(ui.selections(), { elements: [0, 1, 2], regions: [0, 1] });
  const disabled = await ui.load(ui.request());
  assert.ok(disabled.layers.every(layer => layer.state === "disabled"));
  assert.equal(metadataReads, 0);
  ui.close();
});

test("3D summary status row is absent so result updates do not change viewport height", () => {
  const source=readFileSync(new URL("../src/tabs/SourcesFields3D.jsx",import.meta.url),"utf8");
  assert.doesNotMatch(source,/sources-fields-status|Показан шаг|Общий минмакс недоступен/);
});

test("Solid subscriptions reread data only when point/volume mode changes, not for palette or vector size", () => {
  execFileSync(process.execPath, ["--conditions=browser", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createRoot, createSignal, createMemo, createEffect } from "solid-js";
    import { sourcesFields3DSetup } from "./scripts/test-support/sourcesFields3DSetup.js";
    const signals = new Map(), requests = [];
    let dispose, ui, setFlightState;
    createRoot(cleanup => {
      dispose = cleanup;
      ui = sourcesFields3DSetup({ task: { elements: [{ id: 1, targ: 0 }], regions: [] }, elements: [1], regions: [], time: 0 }, {}, {
        createMemo,
        createSignal(initial) {
          const pair = createSignal(initial);
          if (initial === "idle") setFlightState = pair[1];
          return pair;
        },
        createGeometryViewSetting(name, initial) {
          if (!signals.has(name)) signals.set(name, createSignal(initial));
          return signals.get(name);
        },
        observeRequest(source) { createEffect(() => requests.push(source())); },
      });
    });
    const set = (name, value) => signals.get(name)[1](value);
    assert.equal(requests.length, 1);
    for (const state of ["starting", "active", "idle"]) setFlightState(state);
    assert.equal(requests.length, 1, "flight lifecycle must not issue new HDF5 requests");
    set("resultVectorScale", 2);
    set("resultGlobalMinMax", true); set("resultGlobalMinMax", false);
    set("resultStreamlineWidth", 8);
    set("resultVectorColorMap", true); set("resultVectorScale", 8);
    set("resultVectorColorMap", false); set("resultVectorColorMap", true);
    assert.equal(requests.length, 1);
    set("resultVectorScale", 1000);
    assert.equal(requests.length, 2);
    assert.equal(requests.at(-1).layers[0].volumeMode, true);
    set("resultVectorScale", 1000);
    assert.equal(requests.length, 2);
    set("resultVectorScale", 9);
    assert.equal(requests.length, 3);
    assert.equal(requests.at(-1).layers[0].volumeMode, false);
    set("resultVectorColorMap", false);
    assert.equal(requests.length, 3);
    set("resultElementsQuantity", "MHdot");
    assert.equal(requests.length, 4);
    assert.equal(requests.at(-1).layers[0].volumeMode, false);
    assert.equal(ui.controls().checked, true);
    set("resultVectorScale", 8);
    assert.equal(requests.length, 4);
    set("resultVectorScale", 1000);
    assert.equal(requests.length, 5);
    assert.equal(requests.at(-1).layers[0].volumeMode, true);
    set("resultElementsQuantity", "JEdot");
    assert.equal(requests.length, 6);
    assert.equal(requests.at(-1).layers[0].volumeMode, true);
    set("resultElementsQuantity", "M");
    assert.equal(requests.length, 7);
    assert.equal(requests.at(-1).layers[0].volumeMode, false);
    assert.equal(ui.controls().checked, false);
    ui.close(); dispose();
  `], { cwd: new URL("../", import.meta.url), stdio: "pipe" });
});

test("line menu delete control removes its own line and preserves another selection",()=>{
  const props=fixture(),ui=sourcesFields3DSetup(props);
  try {
    ui.setResultState({frame:{request:{task:props.task,time:props.time},value:{layers:[]}}});
    const base={quantityKey:"H",source:{schemaId:"elements",recordIndex:0},instance:{ls:0,as:0,ps:0}};
    ui.addStreamline({...base,node:1});
    const first=ui.selectedStreamline();
    ui.addStreamline({...base,node:2});
    const second=ui.selectedStreamline();
    assert.notEqual(first,second);
    ui.deleteStreamline(first);
    assert.deepEqual(ui.request().streamlineSeeds.map(seed=>seed.id),[second]);
    assert.equal(ui.selectedStreamline(),second);
    ui.deleteStreamline(second);
    assert.deepEqual(ui.request().streamlineSeeds,[]);
    assert.equal(ui.selectedStreamline(),null);
  } finally {ui.close();}
});

test("field method selector keeps the same seeds and tolerance, validates choices and freezes during capture",()=>{
  const props=fixture(),ui=sourcesFields3DSetup(props);
  try {
    assert.deepEqual(ui.streamlineControls().methodOptions.map(([key])=>key),["trilinear","trilinear-boundary","quadratic","tricubic"]);
    assert.equal(ui.streamlineControls().method,"trilinear");
    ui.setResultState({frame:{request:{task:props.task,time:props.time},value:{layers:[]}}});
    const vector={quantityKey:"H",source:{schemaId:"elements",recordIndex:0},instance:{ls:0,as:0,ps:0},node:4};
    ui.addStreamline(vector);
    const seeds=ui.request().streamlineSeeds,tolerance=ui.request().streamlineTolerance;
    assert.equal(tolerance,1e-3);
    for(const method of ["trilinear-boundary","quadratic","tricubic","trilinear"]) {
      ui.streamlineControls().onMethodChange({currentTarget:{value:method}});
      assert.equal(ui.request().streamlineMethod,method);
      assert.equal(ui.request().streamlineSeeds,seeds);assert.equal(ui.request().streamlineTolerance,tolerance);
      assert.equal(ui.selectedStreamline(),seeds[0].id);
    }
    const invalid={currentTarget:{value:"unknown"}};
    ui.streamlineControls().onMethodChange(invalid);assert.equal(invalid.currentTarget.value,"trilinear");
    props.movieBusy=true;assert.equal(ui.streamlineControls().methodDisabled,true);
    const blocked={currentTarget:{value:"trilinear-boundary"}};
    ui.streamlineControls().onMethodChange(blocked);assert.equal(blocked.currentTarget.value,"trilinear");
    assert.equal(ui.request().streamlineMethod,"trilinear");
  } finally {ui.close();}
});

test("compact 3D toolbar exposes requested menus and fixed streamline settings",()=>{
  const source=readFileSync(new URL("../src/tabs/SourcesFields3D.jsx",import.meta.url),"utf8");
  for(const label of ["Элементы","Области","Симметрии","Представление","Векторные линии","Графики"]) assert.ok(source.includes(label),label);
  assert.match(source,/RESULT_LAYER_QUANTITY_LABELS\[key\].*QUANTITIES\[key\]\?\.unit/s);
  assert.doesNotMatch(source,/Допуск, % шага сетки|Цвет по модулю|Стереть линию/);
  assert.ok(source.includes("Удалить линию №"));
  assert.match(source,/streamlineColorMap=\{true\}/);
});
test("compact 3D toolbar buttons expose concise explanatory tooltips",()=>{
  const source=readFileSync(new URL("../src/tabs/SourcesFields3D.jsx",import.meta.url),"utf8");
  for(const text of [
    "Выбрать величину для объемных элементов",
    "Выбрать величину для областей интересов",
    "Выбрать величину для виртуальных элементов",
    "Настроить карту, нормализацию и минимакс",
    "Настроить метод и толщину, выбрать или удалить векторные линии",
    "Выбрать метод построения векторных линий",
    "Открыть панель графиков",
  ]) assert.ok(source.includes(text),text);
});

test("selected streamline does not add a status row that changes 3D height",()=>{
  const source=readFileSync(new URL("../src/tabs/SourcesFields3D.jsx",import.meta.url),"utf8");
  assert.doesNotMatch(source,/source-streamline-status|selectedLineStatus/);
});

test("relative conductivity is unavailable without HTS without blocking other maps", () => {
  const props = fixture(), settings = { resultElementsQuantity: "sigmaRelative", resultRegionsQuantity: "Bs" };
  const ui = sourcesFields3DSetup(props, settings);
  assert.equal(ui.conductivityAvailable(), false); assert.equal(ui.unavailableConductivity(), true);
  assert.equal(ui.requestedLayers()[0].quantityKey, "none"); assert.equal(ui.requestedLayers()[1].quantityKey, "Bs");
  assert.equal(ui.hasScalars(), false);
  props.task.elements[0].model = 2; props.task.elements[0].xapName = "HTS";
  assert.equal(ui.conductivityAvailable(), true); assert.equal(ui.requestedLayers()[0].quantityKey, "sigmaRelative");
  ui.close();
});

test("normalized vectors retain scalar maps, select arrows over vector maps and freeze during capture", () => {
  const props = fixture(), settings = { resultElementsQuantity: "J", resultRegionsQuantity: "Bs", resultVectorScale: 1000, resultVectorColorMap: true };
  const ui = sourcesFields3DSetup(props, settings);
  ui.changeNormalizeVectors(true);
  assert.equal(ui.normalizeVectors(), true); assert.equal(ui.colorMap(), false);
  assert.ok(ui.requestedLayers().every(layer => !layer.volumeMode));
  ui.changeColorMap(true);
  assert.equal(ui.normalizeVectors(), false); assert.equal(ui.colorMap(), true);
  settings.resultElementsQuantity = "JEdot";
  ui.changeNormalizeVectors(true);
  assert.equal(ui.effectiveColorMap(), true); assert.equal(ui.normalizeVectors(), true);
  assert.equal(ui.requestedLayers()[0].volumeMode, true); assert.equal(ui.requestedLayers()[1].volumeMode, false);
  ui.changeColorMap(false); assert.equal(ui.effectiveColorMap(), true);
  props.movieBusy = true; ui.changeNormalizeVectors(false); assert.equal(ui.normalizeVectors(), true);
  ui.close();
});
