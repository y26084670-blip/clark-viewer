import { createGeometryViewSetting } from "../services/visualization/geometryViewSettings.js";
import { ProtocolCheck } from "../components/protocol/ProtocolCheck.jsx";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { installSourcesFieldsKeyboard } from "../services/sourcesFieldsKeyboard.js";
import { ObjectList } from "../components/ObjectList.jsx";
import { ELEMENT_SELECTION_PRESETS, selectElementPreset } from "../services/elementSelectionPresets.js";
import { ResultsGeometryViewport } from "../components/geometry/ResultsGeometryViewport.jsx";
import { GeometryMaterialLegend } from "../components/geometry/GeometryMaterialLegend.jsx";
import { TimeSlider } from "../components/TimeSlider.jsx";
import { QUANTITIES, assignedHtsElements } from "../services/results/resultMappings.js";
import { resultDisplaySelection, useResultFrame } from "../services/results/resultRequests.js";
import { RESULT_LAYER_GROUPS, RESULT_LAYER_QUANTITY_LABELS } from "../services/results/resultLayerDefinitions.js";
import { createResultLayerReader } from "../services/results/resultLayerRequests.js";
import { applyResultGlobalRange, resultGlobalScale } from "../services/results/resultGlobalScale.js";
import { completedMovieFrame, createMovieTabAdapter } from "../services/movie/movieTabAdapter.js";
import { movie3DFilenamePrefix } from "../services/movie/movieFilename.js";
import { STREAMLINE_METHODS, STREAMLINE_DEFAULT_TOLERANCE } from "../services/visualization/resultStreamlineField.js";
import { createGraphAxesController, graphAxisKey } from "../services/visualization/graphAxes.js";
import { createResultGraphReader, graphQuantityKey, graphResultSignature } from "../services/results/resultGraphRequests.js";
import "./SourcesFields3D.css";

// Switching tabs unmounts this component. Retain descriptors and sampled curves,
// not source HDF5 buffers or worker/GPU resources, for the loaded task's lifetime.
const streamlineSessions = new WeakMap();
const cameraSessions = new WeakMap();
const graphSessions = new WeakMap();

export function SourcesFields3D(props) {
  const cameraState = () => props.task && cameraSessions.get(props.task);
  const rememberCamera = (state, task) => { if (task) cameraSessions.set(task, state); };
  const [cameraRequest,setCameraRequest]=createSignal(null);
  const [flightState, setFlightState] = createSignal("idle");
  const flightBusy = () => flightState() !== "idle";
  const changeTime = index => { if (!flightBusy()) props.setTime(index); };
  onMount(()=>{
    const remove=installSourcesFieldsKeyboard(window,{blocked:()=>props.movieBusy || Boolean(graphState().mode),flightBusy,
      time:()=>props.time,maxTime:()=>props.task?.general.countTimeSteps??0,setTime:changeTime,
      view:command=>setCameraRequest(previous=>({command,sequence:(previous?.sequence??0)+1}))});
    const closeMenus = event => {
      if (openSourceMenu() === "graphs" && graphState().mode && event.target?.closest?.(".geometry-viewer-canvas-region")) return;
      if (!event.target?.closest?.(".source-toolbar-menu")) setOpenSourceMenu(null);
    };
    window.addEventListener("pointerdown", closeMenus, true);
    onCleanup(() => { remove(); window.removeEventListener("pointerdown", closeMenus, true); });
  });
  const savedStreamlines = props.task && streamlineSessions.get(props.task);
  const [streamlineSeeds, setStreamlineSeeds] = createSignal(savedStreamlines?.seeds ?? []);
  const [selectedStreamline, setSelectedStreamline] = createSignal(savedStreamlines?.selected ?? null);
  const [streamlineMethod, setStreamlineMethod] = createSignal(savedStreamlines?.method ?? "trilinear");
  const [streamlineNotice, setStreamlineNotice] = createSignal("");
  const [openSourceMenu, setOpenSourceMenu] = createSignal(null);
  const savedGraphs = props.task && graphSessions.get(props.task);
  const [graphsOnly, setGraphsOnly] = createSignal(savedGraphs?.only ?? true);
  const [showGraphs, setShowGraphs] = createSignal(savedGraphs?.show ?? true);
  const [graphComponents, setGraphComponents] = createSignal(savedGraphs?.components ?? { X: true, Y: true, Z: true });
  const [graphBackground, setGraphBackground] = createSignal(savedGraphs?.background ?? "#ffffff");
  const [graphState, setGraphState] = createSignal(null);
  const graphController = createGraphAxesController(setGraphState, savedGraphs?.axes ?? []);
  setGraphState(graphController.state);
  const [graphResults, setGraphResults] = createSignal(savedGraphs?.results ?? []);
  const [graphBusy, setGraphBusy] = createSignal(false), [graphError, setGraphError] = createSignal("");
  const [graphViewRequest, setGraphViewRequest] = createSignal(null);
  let graphReader = createResultGraphReader({ initialTask: props.task, initialResults: savedGraphs?.results }), graphTask = props.task;
  let graphRevision = 0, graphTime = props.time, deleteAxisDialog;
  let graphPending = null, graphBuildPromise = null, graphAlive = true, graphAutoTask, graphAutoTime;
  let graphRequestedIds = new Set(savedGraphs?.requestedIds ?? savedGraphs?.results?.map(g => g.id) ?? []);
  const graphBlocked = () => props.movieBusy || flightBusy() || graphBusy();
  const graphQuantities = () => ({ elements: elementsQuantity(), regions: regionsQuantity(), virtual: virtualQuantity() });
  const activeGraphAxis = () => graphState().axes.find(a => a.id === graphState().active);
  const scalarGraph = () => {
    const axis = activeGraphAxis();
    return axis ? QUANTITIES[graphQuantityKey(props.task, axis, graphQuantities())]?.components === 1 : !hasVectors() && hasScalars();
  };
  const currentGraphResults = () => graphResults().filter(result => {
    const axis = graphState().axes.find(a => a.id === result.id);
    // Keep the last complete curve, with its own time label, until its replacement
    // is ready. Geometry/quantity/method changes still invalidate incompatible data.
    return axis && result.signature === graphResultSignature(axis, result.timeIndex ?? props.time, graphQuantityKey(props.task, axis, graphQuantities()), streamlineMethod());
  });
  const builtGraphAxes = () => graphState().axes.filter(a => graphRequestedIds.has(a.id));
  const graphSession = () => ({ axes: graphState().axes, results: graphResults(), requestedIds: builtGraphAxes().map(a => a.id),
    only: graphsOnly(), show: showGraphs(), components: graphComponents(), background: graphBackground() });
  createEffect(() => {
    const task = props.task, time = props.time;
    untrack(() => {
      if (task !== graphTask) {
        if (graphTask) graphSessions.set(graphTask, graphSession());
        graphRevision++; graphPending = null; graphReader.close(); graphTask = task;
        const saved = graphTask && graphSessions.get(graphTask);
        graphRequestedIds = new Set(saved?.requestedIds ?? saved?.results?.map(g => g.id) ?? []);
        graphController.reset(saved?.axes ?? []); setGraphResults(saved?.results ?? []);
        setGraphsOnly(saved?.only ?? true); setShowGraphs(saved?.show ?? true);
        setGraphComponents(saved?.components ?? { X: true, Y: true, Z: true }); setGraphBackground(saved?.background ?? "#ffffff");
        graphReader = createResultGraphReader({ initialTask: graphTask, initialResults: saved?.results });
        setGraphBusy(false); setGraphError(""); setGraphViewRequest(null);
      }
      if (time !== graphTime) { graphTime = time; graphController.cancel(); }
    });
  });
  onCleanup(() => {
    graphAlive = false; graphRevision++; graphPending = null; graphReader.close();
    if (graphTask) graphSessions.set(graphTask, graphSession());
  });
  createEffect(() => {
    const deleting = graphState().deleting;
    if (!deleteAxisDialog) return;
    if (deleting != null && !deleteAxisDialog.open) deleteAxisDialog.showModal();
    else if (deleting == null && deleteAxisDialog.open) deleteAxisDialog.close();
  });
  async function buildGraphs() {
    if (graphBlocked() || !graphState().axes.length) return graphBuildPromise;
    graphController.cancel();
    graphState().axes.forEach(a => graphRequestedIds.add(a.id));
    return requestGraphBuild(graphState().axes);
  }
  function requestGraphBuild(axes) {
    if (!axes.length || !graphAlive) return;
    graphPending = { version: ++graphRevision, reader: graphReader, task: props.task, time: props.time,
      method: streamlineMethod(), quantities: graphQuantities(), axes };
    setGraphError(""); setGraphBusy(true);
    // One running read plus one replaceable request: fast time changes do not
    // queue every intermediate step or invoke the reader concurrently.
    graphBuildPromise ??= drainGraphBuilds().finally(() => { graphBuildPromise = null; });
    return graphBuildPromise;
  }
  async function drainGraphBuilds() {
    while (graphPending && graphAlive) {
      const request = graphPending; graphPending = null;
      const { version, reader, task, time, method, quantities, axes } = request;
      try {
        const results = await reader.read(request);
        if (!graphAlive || version !== graphRevision) continue;
        const axesChanged = axes.some(axis => {
          const current = graphState().axes.find(a => a.id === axis.id);
          return !current || graphAxisKey(axis) !== graphAxisKey(current);
        });
        if (task !== props.task || time !== props.time || method !== streamlineMethod()
          || JSON.stringify(quantities) !== JSON.stringify(graphQuantities())
          || axesChanged) {
          setGraphError("Параметры изменились. Нажмите «Построить» ещё раз."); continue;
        }
        const previous = currentGraphResults();
        setGraphResults(results.map(result => result.error ? previous.find(g => g.id === result.id && !g.error) ?? result : result));
        setGraphError(results.filter(g => g.error).map(g => `Ось №${g.id}: ${g.error}`).join(" · "));
      } catch (error) { if (graphAlive && version === graphRevision && error.name !== "AbortError") setGraphError(error.message); }
    }
    if (graphAlive) setGraphBusy(false);
  }
  function refreshTimedGraphs(task, time) {
    if (task !== graphTask || (task === graphAutoTask && time === graphAutoTime)) return;
    graphAutoTask = task; graphAutoTime = time;
    const axes = builtGraphAxes();
    if (graphBuildPromise || axes.some(axis => !graphResults().some(g => g.id === axis.id
      && g.signature === graphResultSignature(axis, time, graphQuantityKey(task, axis, graphQuantities()), streamlineMethod())))) {
      requestGraphBuild(axes);
    }
  }
  function graphCaptureStatus(index) {
    const axes = builtGraphAxes();
    if (showGraphs() && axes.length) {
      if (graphBusy() || graphAutoTime !== index) return { ready: false };
      if (graphError()) return { error: graphError() };
      if (axes.some(axis => !graphResults().some(g => !g.error && g.id === axis.id
        && g.signature === graphResultSignature(axis, index, graphQuantityKey(props.task, axis, graphQuantities()), streamlineMethod())))) {
        return { error: "Сначала постройте графики для выбранных параметров." };
      }
    }
    return { ready: true };
  }
  let nextStreamlineId = savedStreamlines?.nextId ?? 1, streamlineTask = props.task;
  createEffect(() => {
    if (props.task === streamlineTask) return;
    streamlineSessions.delete(streamlineTask);
    streamlineTask = props.task; setStreamlineSeeds([]); setSelectedStreamline(null); setStreamlineNotice("");
    setStreamlineMethod("trilinear"); nextStreamlineId = 1;
  });
  onCleanup(() => {
    if (streamlineTask && streamlineTask === props.task) streamlineSessions.set(streamlineTask, {
      seeds: streamlineSeeds(), selected: selectedStreamline(), method: streamlineMethod(), nextId: nextStreamlineId,
    });
  });
  function addStreamline(vector) {
    if (vector?.source?.schemaId !== "elements" || QUANTITIES[vector.quantityKey]?.components !== 3
      || !Number.isSafeInteger(vector.node) || displayed()?.request.task !== props.task) return;
    const seed = { id: nextStreamlineId++, source: vector.source, instance: vector.instance,
      node: vector.node, quantityKey: vector.quantityKey };
    setStreamlineSeeds(previous => [...previous, seed]); setSelectedStreamline(seed.id); setStreamlineNotice("");
  }
  function deleteStreamline(id = selectedStreamline()) {
    const current = selectedStreamline();
    const remaining = streamlineSeeds().filter(seed => seed.id !== id);
    setStreamlineSeeds(remaining);
    if (current === id) setSelectedStreamline(remaining.at(-1)?.id ?? null);
    setStreamlineNotice("");
  }
  function changeStreamlineMethod(event) {
    const method = event.currentTarget.value;
    if (!props.movieBusy && Object.hasOwn(STREAMLINE_METHODS, method)) setStreamlineMethod(method);
    else event.currentTarget.value = streamlineMethod();
  }
  const [elementsQuantity, setElementsQuantity] = createGeometryViewSetting("resultElementsQuantity", "M");
  const [regionsQuantity, setRegionsQuantity] = createGeometryViewSetting("resultRegionsQuantity", "none");
  const [virtualQuantity, setVirtualQuantity] = createGeometryViewSetting("resultVirtualQuantity", "none");
  createEffect(() => {
    const task = props.task, time = props.time;
    untrack(() => refreshTimedGraphs(task, time));
  });
  const [scale, setScale] = createGeometryViewSetting("resultVectorScale", 1);
  const [colorMap, setColorMap] = createGeometryViewSetting("resultVectorColorMap", false);
  const [normalizeVectors, setNormalizeVectors] = createGeometryViewSetting("resultNormalizeVectors", false);
  const conductivityAvailable = createMemo(() => assignedHtsElements(props.task).length > 0);
  const unavailableConductivity = (quantity = elementsQuantity()) => quantity === "sigmaRelative" && !conductivityAvailable();
  function changeColorMap(checked) {
    if (hasScalars() || props.movieBusy) return;
    setColorMap(checked);
    if (checked) setNormalizeVectors(false);
  }
  function changeNormalizeVectors(checked) {
    if (!hasVectors() || props.movieBusy) return;
    setNormalizeVectors(checked);
    if (checked) setColorMap(false);
  }
  const [globalMinMax, setGlobalMinMax] = createGeometryViewSetting("resultGlobalMinMax", true);
  const [streamlineWidth, setStreamlineWidth] = createGeometryViewSetting("resultStreamlineWidth", 2);
  const [performanceEnabled] = createGeometryViewSetting("resultPerformanceOverlay", false);
  const [performanceProfile, setPerformanceProfile] = createSignal(null);
  let lastProfiledTime = props.time;
  const onFramePerformance = profile => {
    if (!performanceEnabled()) return;
    const timeChanged = profile.time !== lastProfiledTime;
    lastProfiledTime = profile.time;
    if (!timeChanged && profile.detail?.line) {
      setPerformanceProfile({ ...profile.detail.line, mode: "line" });
    } else {
      setPerformanceProfile({ ...profile, detail: undefined, mode: "time" });
    }
  };
  const [elementsMode] = createGeometryViewSetting("elementsMode", "all");
  const [regionsMode] = createGeometryViewSetting("regionsMode", "all");
  const quantities = {
    elements: { read: elementsQuantity, write: setElementsQuantity },
    regions: { read: regionsQuantity, write: setRegionsQuantity },
    virtual: { read: virtualQuantity, write: setVirtualQuantity },
  };
  const hasVectors = createMemo(() => RESULT_LAYER_GROUPS.some(group =>
    QUANTITIES[quantities[group.key].read()]?.components === 3));
  const hasScalars = createMemo(() => RESULT_LAYER_GROUPS.some(group =>
    QUANTITIES[quantities[group.key].read()]?.components === 1
      && !(quantities[group.key].read() === "sigmaRelative" && !conductivityAvailable())));
  // Scalars require a color map, but must not replace the user's vector-mode
  // preference when a later quantity selection contains only vectors again.
  const effectiveColorMap = createMemo(() => hasScalars() || colorMap());
  const volumeMode = createMemo(() => effectiveColorMap() && scale() >= 10 - 1e-9);
  const requestedLayers = createMemo(() => RESULT_LAYER_GROUPS.map(group => {
    const records = group.key === "regions" ? props.task?.regions ?? []
      : (props.task?.elements ?? []).filter(record => group.key === "virtual" ? record.targ === 3 : record.targ !== 3);
    const recordIds = new Set(records.map(record => record.id));
    const selected = resultDisplaySelection(records, group.key === "regions" ? props.regions : props.elements,
      group.key === "regions" ? regionsMode() : elementsMode()).filter(id => recordIds.has(id));
    const chosen = quantities[group.key].read();
    const quantityKey = chosen === "sigmaRelative" && !conductivityAvailable() ? "none" : chosen;
    return { key: group.key, quantityKey, selected,
      volumeMode: quantityKey !== "none" && volumeMode()
        && (QUANTITIES[quantityKey]?.components === 1 || !normalizeVectors()) };
  }));
  const globalRanges = createMemo(() => resultGlobalScale(props.task, requestedLayers(), streamlineSeeds()));
  const effectiveGlobalMinMax = createMemo(() => globalMinMax() && globalRanges().available);
  const hasRequestedResults = createMemo(() => !graphsOnly() && requestedLayers().some(layer => layer.quantityKey !== "none" && layer.selected.length > 0));
  const layerReader = createResultLayerReader();
  onCleanup(() => layerReader.close());
  // Even a completely disabled frame reaches the reader so it can release its
  // workers; no HDF5 is read, and geometry follows the requested time immediately.
  const result = useResultFrame(() => props.task && ({ task: props.task, time: props.time,
    layers: graphsOnly() ? requestedLayers().map(layer => ({ ...layer, quantityKey: "none" })) : requestedLayers(),
    streamlineSeeds: graphsOnly() ? [] : streamlineSeeds(), streamlineTolerance: STREAMLINE_DEFAULT_TOLERANCE,
    streamlineMethod: streamlineMethod(), performanceEnabled }),
    request => layerReader.read(request), { onPerformance: onFramePerformance, performanceEnabled });
  const displayed = () => result().frame;
  const value = () => displayed()?.value;
  const streamlines = createMemo(() => (value()?.streamlines ?? [])
    .filter(line => streamlineSeeds().some(seed => seed.id === line.id))
    .map(line => ({ ...line, displayRange: effectiveGlobalMinMax() ? globalRanges().lineRanges[line.quantityKey] : undefined, quantity: QUANTITIES[line.quantityKey]?.label ?? line.quantityKey,
      unit: QUANTITIES[line.quantityKey]?.unit ?? "" })));
  const layerMetadata = layer => ({ ...applyResultGlobalRange(layer, effectiveGlobalMinMax() ? globalRanges().layerRanges[layer.key] : null),
    groupLabel: RESULT_LAYER_GROUPS.find(group => group.key === layer.key)?.label ?? layer.key,
    color: layer.quantityKey === "J" ? 0xff5454 : layer.quantityKey === "M" ? 0x44dd66 : 0x44bbff,
  });
  const resultLayers = createMemo(() => hasRequestedResults() ? (value()?.layers ?? []).map(layerMetadata) : []);
  const timeIndex = () => !graphsOnly() && (hasRequestedResults() || streamlineSeeds().length) ? displayed()?.request.time ?? props.time : props.time;
  const flightDisabledReason = () => props.movieBusy ? "Дождитесь завершения создания GIF."
    : result().loading || result().error || timeIndex() !== props.time
      ? "Дождитесь готовности выбранного кадра." : "";
  const selections = createMemo(() => ({
    elements: props.elements.map(id => id - 1), regions: props.regions.map(id => id - 1),
  }));
  const captureFrameKey = createMemo(() => {
    const frame = displayed(), graphs = showGraphs() ? currentGraphResults().filter(g => !g.error) : [];
    return graphs.length ? { frame, graphs } : frame;
  });
  const movie = createMovieTabAdapter(props, { title: "Источники / Поле 3D",
    filenamePrefix: () => movie3DFilenamePrefix(requestedLayers(), streamlines()), readFrame: index => {
    const status = completedMovieFrame(result(), { task: props.task, index });
    if (!status.ready) return status;
    const graphs = graphCaptureStatus(index);
    if (!graphs.ready) return graphs;
    const errors = status.value.value.errors ?? [];
    return errors.length ? { error: errors.map(item => item.message).join(" · ") } : { ready: true, value: captureFrameKey() };
  } });
  const quantityText = key => key === "none"
    ? RESULT_LAYER_QUANTITY_LABELS.none
    : `${RESULT_LAYER_QUANTITY_LABELS[key]}, ${QUANTITIES[key]?.unit ?? ""}`;
  const toggleSourceMenu = name => setOpenSourceMenu(current => current === name ? null : name);

  return <div class="results-layout">
    <aside class="split-list-column">
      <ObjectList title="Элементы" records={props.task?.elements} selected={props.elements} onSelect={props.setElements}
        selectionPresets={ELEMENT_SELECTION_PRESETS}
        presetSelection={key => selectElementPreset(props.task?.elements, props.task?.general, key)} />
      <ObjectList title="Области" records={props.task?.regions} selected={props.regions} onSelect={props.setRegions} />
    </aside>
    <section class="plot-panel">
      <div class="plot-toolbar sources-fields-toolbar">
        <div class="sources-fields-toolbar-controls">
        <For each={[
          ["elements", "Объемные элементы"],
          ["regions", "Области интересов"],
          ["virtual", "Виртуальные элементы"],
        ]}>{([key, label]) => {
          const group = RESULT_LAYER_GROUPS.find(item => item.key === key);
          return <div class="source-toolbar-menu">
            <button type="button" class="source-toolbar-menu-button"
              aria-expanded={openSourceMenu() === key} aria-label={label}
              title={{
                elements: "Выбрать величину для объемных элементов",
                regions: "Выбрать величину для областей интересов",
                virtual: "Выбрать величину для виртуальных элементов",
              }[key]}
              onClick={() => toggleSourceMenu(key)}>{label}</button>
            <Show when={openSourceMenu() === key}>
              <div class="source-toolbar-menu-panel">
                <For each={group.quantities}>{quantityKey =>
                  <label class="source-toolbar-option">
                    <input type="radio" name={`source-quantity-${key}`}
                      checked={quantities[key].read() === quantityKey}
                      disabled={unavailableConductivity(quantityKey)}
                      title={unavailableConductivity(quantityKey) ? "В задании нет материалов ВТСП" : undefined}
                      onChange={() => quantities[key].write(quantityKey)} />
                    <span>{quantityText(quantityKey)}</span>
                  </label>}
                </For>
              </div>
            </Show>
          </div>;
        }}</For>

        <div class="source-toolbar-menu">
          <button type="button" class="source-toolbar-menu-button"
            aria-expanded={openSourceMenu() === "presentation"} aria-label="Представление"
            title="Настроить размер, карту, нормализацию и минимакс"
            onClick={() => toggleSourceMenu("presentation")}>Представление</button>
          <Show when={openSourceMenu() === "presentation"}>
            <div class="source-toolbar-menu-panel source-presentation-panel">
              <label class="source-presentation-slider">Размер
                <input type="range" min="-1" max="1" step="0.05"
                  value={Math.log10(scale())} aria-label="Размер представления"
                  onInput={event => setScale(10 ** event.currentTarget.valueAsNumber)} />
              </label>
              <label><input type="checkbox" aria-label="Карта" checked={effectiveColorMap()} disabled={hasScalars()}
                onChange={event => changeColorMap(event.currentTarget.checked)} /> Карта</label>
              <label title="Одинаковая длина векторов; цвет соответствует исходному модулю">
                <input type="checkbox" aria-label="Нормализовать вектора" checked={normalizeVectors()}
                  disabled={!hasVectors() || props.movieBusy}
                  onChange={event => changeNormalizeVectors(event.currentTarget.checked)} /> Нормализовать вектора
              </label>
              <label title={globalRanges().available ? "Общие пределы за весь расчёт из HDF5." : globalRanges().reason}>
                <input type="checkbox" aria-label="Общий минимакс" checked={effectiveGlobalMinMax()}
                  disabled={props.movieBusy || !globalRanges().available}
                  onChange={event => !props.movieBusy && globalRanges().available
                    && setGlobalMinMax(event.currentTarget.checked)} /> Общий минимакс
              </label>
            </div>
          </Show>
        </div>

        <div class="source-toolbar-menu">
          <button type="button" class="source-toolbar-menu-button"
            aria-expanded={openSourceMenu() === "lines"} aria-label="Векторные линии"
            title="Настроить метод и толщину, выбрать или удалить векторные линии"
            onClick={() => toggleSourceMenu("lines")}>Векторные линии</button>
          <Show when={openSourceMenu() === "lines"}>
            <div class="source-toolbar-menu-panel source-lines-panel">
              <label class="source-line-method">Метод построения
                <select aria-label="Метод построения" value={streamlineMethod()} disabled={props.movieBusy}
                  title="Выбрать метод построения векторных линий" onChange={changeStreamlineMethod}>
                  <For each={Object.entries(STREAMLINE_METHODS)}>{([key, label]) =>
                    <option value={key}>{label}</option>}
                  </For>
                </select>
              </label>
              <label class="source-presentation-slider">Толщина
                <input type="range" min="1" max="10" step="1"
                  value={streamlineWidth()} aria-label="Толщина линий"
                  onInput={event => setStreamlineWidth(event.currentTarget.valueAsNumber)} />
                <span>{streamlineWidth()} px</span>
              </label>
              <Show when={streamlineSeeds().length} fallback={<div class="source-toolbar-empty">Нет линий</div>}>
                <For each={streamlineSeeds()}>{seed =>
                  <div class="source-line-row" classList={{ selected: selectedStreamline() === seed.id }}>
                    <button type="button" class="source-line-select"
                      title={streamlines().find(line => line.id === seed.id)?.notice || "Выбрать линию и её симметричные образы"}
                      onClick={() => setSelectedStreamline(seed.id)}>
                      №{seed.id} · {QUANTITIES[seed.quantityKey]?.label} · Элемент №{seed.source.recordIndex + 1}
                    </button>
                    <button type="button" class="source-line-delete"
                      aria-label={`Удалить линию №${seed.id}`}
                      title="Удалить линию"
                      onClick={() => deleteStreamline(seed.id)}>×</button>
                  </div>}
                </For>
              </Show>
              <Show when={streamlineNotice()}><div class="source-toolbar-empty">{streamlineNotice()}</div></Show>
            </div>
          </Show>
        </div>

        <div class="source-toolbar-menu">
          <button type="button" class="source-toolbar-menu-button"
            aria-expanded={openSourceMenu() === "graphs"} aria-label="Графики"
            title="Открыть панель графиков"
            onClick={() => toggleSourceMenu("graphs")}>Графики</button>
          <Show when={openSourceMenu() === "graphs"}>
            <div class="source-toolbar-menu-panel source-graphs-panel">
              <label class="source-toolbar-option"><input type="checkbox" checked={graphsOnly()}
                onChange={event => setGraphsOnly(event.currentTarget.checked)} /> только графики</label>
              <label class="source-toolbar-option"><input type="checkbox" checked={showGraphs()}
                onChange={event => setShowGraphs(event.currentTarget.checked)} /> Показывать графики</label>
              <div class="source-graph-axis-actions"><span>ось:</span>
                <For each={[["add", "Добавить"], ["edit", "Изменить"], ["delete", "Удалить"]]}>{([mode, label]) =>
                  <button type="button" aria-pressed={graphState().mode === mode} disabled={graphBlocked() || (mode !== "add" && !graphState().axes.length)}
                    onClick={() => graphController.toggle(mode)}>{label}</button>}
                </For>
              </div>
              <Show when={activeGraphAxis()}><span>Выбрана ось №{graphState().active}</span></Show>
              <For each={["X", "Y", "Z"]}>{axis =>
                <label class="source-toolbar-option"><input type="checkbox" checked={graphComponents()[axis]}
                  disabled={scalarGraph()}
                  onChange={event => setGraphComponents(previous => ({ ...previous, [axis]: event.currentTarget.checked }))} />
                  {axis}-компонента
                </label>}
              </For>
              <label class="source-graph-background"><input type="color" aria-label="фон" value={graphBackground()}
                onInput={event => setGraphBackground(event.currentTarget.value)} /> фон</label>
              <div class="source-graph-build-actions">
                <button type="button" disabled={graphBlocked() || !graphState().axes.length} onClick={buildGraphs}>Построить</button>
                <button type="button" disabled={graphBlocked() || !showGraphs() || !currentGraphResults().some(g => g.id === graphState().active && !g.error)}
                  onClick={() => setGraphViewRequest(previous => ({ id: graphState().active, sequence: (previous?.sequence ?? 0) + 1 }))}>Повернуть</button>
              </div>
              <Show when={graphBusy()}><span role="status">Построение графиков…</span></Show>
              <Show when={graphError()}><span class="source-graph-error" role="alert">{graphError()}</span></Show>
              <For each={currentGraphResults().filter(g => g.error || g.notice)}>{graph => <span class="source-graph-error" role={graph.error ? "alert" : "status"}>Ось №{graph.id}: {graph.error || graph.notice}</span>}</For>
            </div>
          </Show>
        </div>
        </div>
        <ProtocolCheck context={props} entryKey="sources" title="Источники / Поле 3D" adapter={movie.adapter}
          disabled={flightBusy() || result().loading}
          comment={requestedLayers().filter(layer => layer.quantityKey !== "none").map(layer =>
            `${QUANTITIES[layer.quantityKey]?.label}: объекты ${layer.selected.join(", ")}`).join("; ")} />
        <GeometryMaterialLegend buttonClass="source-toolbar-menu-button"
          onOpen={() => setOpenSourceMenu(null)} />
      </div>
      <div class="embedded-geometry">
        <Show when={graphState().mode}><div class="source-graph-hint" role="status">
          {graphState().notice || (graphState().mode === "add" ? graphState().pending ? "Укажите вторую точку того же объекта и образа. Esc — отмена." : "Укажите первый узел области или центр ЭО. Esc — отмена."
            : graphState().mode === "edit" ? "Перетаскивайте концы осей между узлами. Отожмите «Изменить» для завершения."
            : "Щёлкните по концу оси для удаления. Отожмите «Удалить» для завершения.")}
        </div></Show>
        <ResultsGeometryViewport cameraState={cameraState()} onCameraStateChange={rememberCamera} open={true} model={props.task} moves={props.task?.moves} amplitudes={props.task?.amps}
          allowFlight={true} flightBlocked={props.movieBusy || graphBusy() || Boolean(graphState().mode)} flightDisabledReason={flightDisabledReason()}
          onFlightStateChange={setFlightState}
          cameraRequest={cameraRequest()}
          prescribedSources={props.task?.mhj} taskKey={props.task} timeIndex={timeIndex()}
          selections={selections()} resultLayers={graphsOnly() ? [] : resultLayers()}
          resultError={[result().error, ...(value()?.errors ?? []).map(error => error.message)].filter(Boolean).join(" · ")}
          resultStreamlines={graphsOnly() ? [] : streamlines()} selectedStreamline={selectedStreamline()}
          graphController={graphController} graphState={graphState()} graphResults={currentGraphResults().filter(g => !g.error)}
          graphComponents={graphComponents()} graphBackground={graphBackground()} showGraphs={showGraphs()}
          graphViewRequest={graphViewRequest()} graphBlocked={graphBlocked()}
          streamlineWidth={streamlineWidth()} streamlineColorMap={true}
          onSelectStreamline={setSelectedStreamline} onResultNodeDoubleClick={addStreamline}
          captureFrameKey={captureFrameKey()} onCaptureReady={movie.onCaptureReady}
          resultVectorScale={scale()} resultPickingOnly={!graphsOnly()}
          resultVectorColorMap={effectiveColorMap()}
          resultNormalizeVectors={normalizeVectors()}
          performanceProfile={performanceProfile()} />
      </div>
      <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep}
        disabled={flightBusy()} onChange={changeTime} />
      <dialog ref={deleteAxisDialog} class="source-graph-delete-dialog" aria-label="Удаление оси графика"
        onCancel={event => { event.preventDefault(); graphController.confirmDelete(false); }}>
        <p>Удалить ось №{graphState().deleting} и её график?</p>
        <div><button type="button" onClick={() => graphController.confirmDelete(true)}>Удалить ось</button>
          <button type="button" autofocus onClick={() => graphController.confirmDelete(false)}>Отмена</button></div>
      </dialog>
    </section>
  </div>;
}
