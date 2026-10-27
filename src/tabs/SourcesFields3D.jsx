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
import { GRAPH_SLICE_DIRECTIONS, graphSliceCount, middleGraphDiscrete } from "../services/visualization/resultGraphField.js";
import { RESULT_SIZE_SCALE } from "../services/visualization/resultVectorScale.js";
import { createResultGraphReader, graphQuantityKey, graphRequestKey } from "../services/results/resultGraphRequests.js";
import { createGraphSettingsStore, GRAPH_VIEW_DEFAULTS } from "../services/results/graphSettingsStore.js";
import { graphContourIdentity } from "../services/visualization/resultGraphContours.js";
import { Graph1DCollection } from "../components/Graph1DCollection.jsx";
import "./SourcesFields3D.css";

// Switching tabs unmounts this component. Retain task-owned choices,
// not HDF5 buffers or worker/GPU resources.
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
    const remove=installSourcesFieldsKeyboard(window,{blocked:()=>props.movieBusy,flightBusy,
      time:()=>props.time,maxTime:()=>props.task?.general.countTimeSteps??0,setTime:changeTime,
      view:command=>setCameraRequest(previous=>({command,sequence:(previous?.sequence??0)+1}))});
    const closeMenus = event => {
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
  const [geometryToolbarHost, setGeometryToolbarHost] = createSignal(null);
  const savedGraphs = props.task && graphSessions.get(props.task);
  const [graphsOnly, setGraphsOnly] = createSignal(savedGraphs?.only ?? false);
  const [areaGraphs, setAreaGraphs] = createSignal(savedGraphs?.areas ?? false);
  const [sliceGraphs, setSliceGraphs] = createSignal(savedGraphs?.showSlices ?? false);
  const [graphSlices, setGraphSlices] = createSignal(savedGraphs?.slices ?? []);
  const [activeSlice, setActiveSlice] = createSignal(savedGraphs?.active ?? null);
  const [graphProfiles, setGraphProfiles] = createSignal(savedGraphs?.profiles ?? []);
  const [activeProfile, setActiveProfile] = createSignal(savedGraphs?.activeProfile ?? null);
  const [expandedProfile, setExpandedProfile] = createSignal(savedGraphs?.expandedProfile ?? null);
  const graphContour = () => graphProfiles().find(p => p.id === activeProfile()) ?? null;
  const [graphReady, setGraphReady] = createSignal(!props.task?.handle || !!savedGraphs);
  const [graphSaveNotice, setGraphSaveNotice] = createSignal("");
  const [addingSlice, setAddingSlice] = createSignal(false), [addElement, setAddElement] = createSignal(0);
  const [directionMenu, setDirectionMenu] = createSignal(null), [previewSlice, setPreviewSlice] = createSignal(null);
  let graphTask = props.task, graphStore, graphRevision = 0, nextSliceId = Math.max(0, ...graphSlices().map(s => s.id)) + 1;
  let nextProfileId = Math.max(0, ...graphProfiles().map(p => p.id)) + 1;
  const graphSession = () => ({ only: graphsOnly(), areas: areaGraphs(), showSlices: sliceGraphs(), slices: graphSlices(), active: activeSlice(),
    profiles: graphProfiles(), activeProfile: activeProfile(), expandedProfile: expandedProfile(),
    view: Object.fromEntries(Object.entries(graphView).map(([key, [read]]) => [key, read()])),
    selections: { elements: props.elements, regions: props.regions } });
  const graphBlocked = () => props.movieBusy || flightBusy() || !graphReady();
  const selectedSlice = () => graphSlices().find(s => s.id === activeSlice());
  const graphQuantities = () => ({ elements: elementsQuantity(), regions: regionsQuantity(), virtual: virtualQuantity() });
  const sliceScalar = slice => QUANTITIES[graphQuantityKey(props.task, slice, graphQuantities())]?.components !== 3;
  const sliceCount = (recordIndex, direction) => graphSliceCount(props.task?.elements?.[recordIndex], direction);
  const sliceLabel = (recordIndex, direction) => `${GRAPH_SLICE_DIRECTIONS[direction].label} (${sliceCount(recordIndex, direction) || "—"})`;
  const sliceChoice = (recordIndex, direction, previous) => ({ recordIndex, direction,
    discrete: previous?.direction === direction ? previous.discrete : middleGraphDiscrete(sliceCount(recordIndex, direction)) });
  const closeGraphChoice = () => { setAddingSlice(false); setDirectionMenu(null); setPreviewSlice(null); };
  createEffect(() => { if (openSourceMenu() !== "graphs" || props.movieBusy) closeGraphChoice(); });
  function addSlice(direction) {
    if (graphBlocked()) return;
    const record = props.task.elements[addElement()];
    if (!record || !sliceCount(addElement(), direction)) return;
    const discrete = middleGraphDiscrete(sliceCount(addElement(), direction));
    const group = record.targ === 3 ? "virtual" : "elements";
    if (quantities[group].read() === "none") quantities[group].write(group === "virtual" ? (props.task.metadata.HV ? "Bv" : "Av") : (props.task.metadata.MH ? "M" : "J"));
    const existing = graphSlices().find(s => s.recordIndex === addElement() && s.direction === direction && s.discrete === discrete && s.component === 0);
    if (existing) setActiveSlice(existing.id);
    else {
      const slice = { id: nextSliceId++, recordIndex: addElement(), direction, discrete, component: 0 };
      setGraphSlices(previous => [...previous, slice]); setActiveSlice(slice.id);
    }
    setSliceGraphs(true); closeGraphChoice();
  }
  function changeSlice(id, update) {
    if (graphBlocked()) return;
    setGraphSlices(previous => previous.map(s => {
      if (s.id !== id) return s;
      const direction = update.direction ?? s.direction, count = sliceCount(s.recordIndex, direction);
      const discrete = direction !== s.direction ? middleGraphDiscrete(count) : update.discrete ?? s.discrete;
      if (!Number.isSafeInteger(discrete) || discrete < 1 || discrete > count) return s;
      if (direction !== s.direction) removeProfiles(p => p.graphId === id);
      return { ...s, ...update, direction, discrete };
    }));
    setActiveSlice(id);
  }
  function deleteSlice() {
    if (graphBlocked()) return;
    removeProfiles(p => p.graphId === activeSlice());
    const remaining = graphSlices().filter(s => s.id !== activeSlice());
    setGraphSlices(remaining); setActiveSlice(remaining.at(-1)?.id ?? null); closeGraphChoice();
  }
  function selectGraphContour(contour, { add = true } = {}) {
    if (graphBlocked() || !contour) return;
    const existing = graphProfiles().find(p => graphContourIdentity(p) === graphContourIdentity(contour));
    if (existing) setActiveProfile(existing.id);
    else if (!add && graphContour()) {
      const id = activeProfile(); setGraphProfiles(previous => previous.map(p => p.id === id ? { ...p, ...contour } : p));
    } else {
      const profile = { ...contour, id: nextProfileId++ };
      setGraphProfiles(previous => [...previous, profile]); setActiveProfile(profile.id);
    }
    if (graphSlices().some(slice => slice.id === contour?.graphId)) setActiveSlice(contour.graphId);
  }
  function removeProfiles(predicate) {
    const remaining = graphProfiles().filter(p => !predicate(p)); setGraphProfiles(remaining);
    if (!remaining.some(p => p.id === activeProfile())) setActiveProfile(remaining.at(-1)?.id ?? null);
    if (!remaining.some(p => p.id === expandedProfile())) setExpandedProfile(null);
  }
  function selectProfile(id) {
    if (graphBlocked()) return;
    setActiveProfile(id);
    const profile = graphProfiles().find(p => p.id === id);
    if (graphSlices().some(s => s.id === profile?.graphId)) setActiveSlice(profile.graphId);
  }
  function changeProfileView(id, view) {
    if (graphBlocked()) return;
    setGraphProfiles(previous => previous.map(p => p.id === id ? { ...p, view: { ...p.view, ...view } } : p));
  }
  function DirectionChoices(p) {
    return <div class="source-slice-directions" role="menu" aria-label="Направление среза"
      onPointerLeave={() => setPreviewSlice(null)}>
      <For each={GRAPH_SLICE_DIRECTIONS}>{option => <button type="button" role="menuitem"
        disabled={!sliceCount(p.recordIndex, option.value)}
        title={`Срез поперёк DV${option.value + 1}; в скобках число дискретов. Наведите для предпросмотра, нажмите для выбора. Новое направление начинает с центрального дискрета.`}
        onPointerEnter={() => setPreviewSlice(sliceChoice(p.recordIndex, option.value, p.slice))}
        onFocus={() => setPreviewSlice(sliceChoice(p.recordIndex, option.value, p.slice))}
        onClick={() => { p.choose(option.value); setDirectionMenu(null); setPreviewSlice(null); }}>{sliceLabel(p.recordIndex, option.value)}</button>}</For>
    </div>;
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
  const graphView = Object.fromEntries(Object.entries(GRAPH_VIEW_DEFAULTS).map(([key, initial]) => [key, createGeometryViewSetting(key, initial)]));
  function restoreGraphs(saved, restoreVisibility = true) {
    setGraphsOnly(restoreVisibility && (saved?.only ?? false));
    setAreaGraphs(restoreVisibility && (saved?.areas ?? false));
    setSliceGraphs(restoreVisibility && (saved?.showSlices ?? false));
    setGraphSlices(saved?.slices ?? []); setActiveSlice(saved?.active ?? null);
    setGraphProfiles(saved?.profiles ?? []); setActiveProfile(saved?.activeProfile ?? null); setExpandedProfile(saved?.expandedProfile ?? null);
    for (const [key, value] of Object.entries(saved?.view ?? {})) graphView[key]?.[1](value);
    if (saved?.selections?.elements) props.setElements?.(saved.selections.elements);
    if (saved?.selections?.regions) props.setRegions?.(saved.selections.regions);
    nextSliceId = Math.max(0, ...graphSlices().map(s => s.id)) + 1;
    nextProfileId = Math.max(0, ...graphProfiles().map(p => p.id)) + 1; closeGraphChoice();
  }
  createEffect(() => {
    const task = props.task;
    untrack(() => {
      if (graphStore && task === graphTask) return;
      if (graphStore) { if (graphTask) graphSessions.set(graphTask, graphSession()); graphStore.dispose(); }
      graphTask = task; const revision = ++graphRevision, saved = task && graphSessions.get(task);
      restoreGraphs(saved); setGraphSaveNotice(""); setGraphReady(!task?.handle || !!saved);
      graphStore = createGraphSettingsStore(task, { onNotice: text => { if (revision === graphRevision) setGraphSaveNotice(text); } });
      graphStore.ready.then(value => {
        if (revision !== graphRevision) return;
        // A new project starts with graph overlays off; tab remounts use the
        // in-memory session above and retain the user's current checkboxes.
        if (!saved && value) restoreGraphs(value, false);
        setGraphReady(true);
      });
    });
  });
  createEffect(() => {
    if (!graphReady()) return;
    const saved = graphSession();
    if (graphTask) graphSessions.set(graphTask, saved);
    graphStore?.save(saved);
  });
  onMount(() => {
    const flush = () => graphStore?.flush();
    window.addEventListener("pagehide", flush); document.addEventListener("visibilitychange", flush);
    onCleanup(() => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", flush); });
  });
  onCleanup(() => {
    if (graphReady() && graphTask) { const saved = graphSession(); graphSessions.set(graphTask, saved); graphStore?.save(saved); }
    ++graphRevision; graphStore?.dispose();
  });
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
  const volumeMode = createMemo(() => effectiveColorMap() && scale() >= RESULT_SIZE_SCALE.maximum * (1 - 1e-9));
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
  const graphReader = createResultGraphReader();
  onCleanup(() => graphReader.close());
  const profileDefinitions = createMemo(() => graphReady() ? graphProfiles().map(({ id, graphId, instanceKey, surfaceKey, direction, index }) => ({ id, graphId, instanceKey, surfaceKey, direction, index })) : [],
    undefined, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  const graphRequest = createMemo(() => {
    const profiles = profileDefinitions();
    const wanted = new Set(profiles.map(p => p.graphId));
    const request = { task: props.task, time: props.time, quantities: graphQuantities(),
      slices: graphReady() ? graphSlices().filter(s => sliceGraphs() || wanted.has(s.id)) : [], profiles,
      regions: graphReady() && regionsQuantity() !== "none" ? (props.task?.regions ?? [])
        .filter(r => r.geoType !== 2 && (wanted.has(`region:${r.recordIndex}`) || areaGraphs() && requestedLayers().find(g => g.key === "regions").selected.includes(r.id))).map(r => r.recordIndex) : [] };
    return { ...request, quantityKey: graphRequestKey(request) };
  });
  const graphResult = useResultFrame(graphRequest, request => graphReader.read(request));
  const graphResults = () => (graphResult().frame?.value.graphs ?? []).filter(g => g.kind === "region" ? areaGraphs() : sliceGraphs() && graphSlices().some(s => s.id === g.id));
  const profileResults = () => graphResult().frame?.value.profiles ?? [];
  const graphBusy = () => graphResult().loading;
  const graphError = () => [graphResult().error, ...(graphResult().frame?.value.errors ?? []).map(e => e.message)].filter(Boolean).join(" · ");
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
  const captureFrameKey = createMemo(() => ({ frame: displayed(), graphs: graphResult().frame }));
  const movie = createMovieTabAdapter(props, { title: "Источники / Поле 3D",
    filenamePrefix: () => movie3DFilenamePrefix(requestedLayers(), streamlines()), readFrame: index => {
    const status = completedMovieFrame(result(), { task: props.task, index });
    if (!status.ready) return status;
    const graphs = completedMovieFrame(graphResult(), { task: props.task, index });
    if (!graphs.ready) return graphs;
    const errors = [...(status.value.value.errors ?? []), ...(graphs.value.value.errors ?? [])];
    return errors.length ? { error: errors.map(item => item.message).join(" · ") } : { ready: true, value: captureFrameKey() };
  } });
  const quantityText = key => key === "none"
    ? RESULT_LAYER_QUANTITY_LABELS.none
    : `${RESULT_LAYER_QUANTITY_LABELS[key]}, ${QUANTITIES[key]?.unit ?? ""}`;
  const toggleSourceMenu = name => setOpenSourceMenu(current => current === name ? null : name);
  function positionSourcePanel(element) {
    const place = () => {
      if (!element.isConnected) return;
      element.style.transform = "";
      const bounds = element.getBoundingClientRect(), width = element.ownerDocument.documentElement.clientWidth;
      const offset = bounds.left < 8 ? 8 - bounds.left : Math.min(0, width - 8 - bounds.right);
      element.style.transform = `translateX(${offset}px)`;
    };
    queueMicrotask(place); window.addEventListener("resize", place);
    onCleanup(() => window.removeEventListener("resize", place));
  }


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
          ["elements", "Элементы"],
          ["regions", "Области"],
          ["virtual", "Симметрии"],
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
              <div class="source-toolbar-menu-panel" ref={positionSourcePanel}>
                <For each={group.quantities}>{quantityKey => <>
                  <label class="source-toolbar-option">
                    <input type="radio" name={`source-quantity-${key}`}
                      checked={quantities[key].read() === quantityKey}
                      disabled={unavailableConductivity(quantityKey)}
                      title={unavailableConductivity(quantityKey) ? "В задании нет материалов ВТСП" : undefined}
                      onChange={() => quantities[key].write(quantityKey)} />
                    <span>{quantityText(quantityKey)}</span>
                  </label>
                  <Show when={(key === "elements" ? ["none", "MHdot", "sigmaRelative"] : key === "regions" ? ["none", "As"] : ["Av"]).includes(quantityKey)}>
                    <hr class="source-menu-separator" />
                  </Show>
                </>}</For>
                <Show when={key !== "virtual"} fallback={
                  <For each={[["showLocalSymmetry", "Локальная"], ["showAxialSymmetry", "Азимутальная"],
                    ["showPeriodicSymmetry", "Периодическая"], ["showMirrorSymmetry", "Зеркальная"]]}>{([setting, label]) =>
                    <label class="source-toolbar-option"><input type="checkbox" checked={graphView[setting][0]()} disabled={graphBlocked()}
                      onChange={event => graphView[setting][1](event.currentTarget.checked)} />{label}</label>
                  }</For>
                }>
                  <For each={[["all", "Показать все"], ["selected", "Выделенные в списке"], ["exceptSelected", "Кроме выделенных"]]}>{([mode, label]) =>
                    <label class="source-toolbar-option"><input type="radio" name={`source-visibility-${key}`}
                      checked={graphView[`${key}Mode`][0]() === mode} disabled={graphBlocked()}
                      onChange={() => graphView[`${key}Mode`][1](mode)} />{label}</label>
                  }</For>
                </Show>
              </div>
            </Show>
          </div>;
        }}</For>

        <div class="source-toolbar-menu">
          <button type="button" class="source-toolbar-menu-button"
            aria-expanded={["presentation", "graphs"].includes(openSourceMenu())} aria-label="Представление"
            title="Настроить карту, нормализацию и минимакс; построить линейные графики в 3D окне"
            onClick={() => toggleSourceMenu("presentation")}>Представление</button>
          <Show when={openSourceMenu() === "presentation"}>
            <div class="source-toolbar-menu-panel source-presentation-panel" ref={positionSourcePanel}>
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
              <button type="button" class="source-toolbar-menu-button" aria-haspopup="dialog"
                title="Открыть панель графиков" onClick={() => setOpenSourceMenu("graphs")}>Графики</button>
            </div>
          </Show>
          <Show when={openSourceMenu() === "graphs"}>
            <div class="source-toolbar-menu-panel source-graphs-panel" ref={positionSourcePanel} role="dialog" aria-label="Графики в 3D" onKeyDown={event => {
              if (event.key === "Escape") { event.stopPropagation(); closeGraphChoice(); }
            }}>
              <div class="source-graphs-header">
                <div class="source-graphs-controls">
                  <label class="source-toolbar-option" title="Оставить геометрию и включённые поверхности графиков; скрыть расчётные векторы, карты и векторные линии."><input type="checkbox" checked={graphsOnly()} disabled={graphBlocked()}
                    onChange={event => setGraphsOnly(event.currentTarget.checked)} /> Только графики</label>
                  <label class="source-toolbar-option" title="Показать над видимыми площадками поверхности выбранной величины областей: X — красная, Y — зелёная, Z — синяя. Снятие флажка скрывает поверхности."><input type="checkbox" checked={areaGraphs()} disabled={graphBlocked()}
                    onChange={event => {
                      if (event.currentTarget.checked && regionsQuantity() === "none") setRegionsQuantity(props.task.metadata.HS ? "Bs" : "As");
                      setAreaGraphs(event.currentTarget.checked);
                    }} /> Графики над площадками</label>
                  <div class="source-slice-actions">
                    <label class="source-toolbar-option" title="Показать или скрыть все добавленные срезы. Скрытие сохраняет строки таблицы и выбранные дискреты."><input type="checkbox" checked={sliceGraphs()} disabled={graphBlocked()}
                      onChange={event => setSliceGraphs(event.currentTarget.checked)} /> Срезы в элементах</label>
                    <button type="button" aria-expanded={addingSlice()} disabled={graphBlocked() || !props.task?.elements?.length}
                      title="Добавить график среза: выберите элемент, наведите на направление для предпросмотра и нажмите на плоскость. Создаётся центральный слой; номер дискрета меняется в таблице. Повторное нажатие закрывает выбор."
                      onClick={() => { setAddingSlice(!addingSlice()); setDirectionMenu(null); setPreviewSlice(null);
                        setAddElement(selectedSlice()?.recordIndex ?? Math.max(0, props.task.elements.findIndex(r => props.elements.includes(r.id)))); }}>Добавить</button>
                    <button type="button" disabled={graphBlocked() || !selectedSlice()} onClick={deleteSlice}
                      title="Удалить выбранную строку таблицы и её график во всех симметричных образах. Сначала выберите строку щелчком; элемент и файлы результатов сохраняются.">Удалить</button>
                  </div>
                </div>
                <aside class="source-graphs-reminder" aria-label="Напоминание о графиках" lang="ru">
                  <p>Текущие настройки и наборы графиков автосохраняются для следующих сессий.</p>
                  <p>Используйте выпадающее меню над поверхностью 2D графика для добавления 1D графиков.</p>
                </aside>
              </div>
              <Show when={addingSlice()}>
                <div class="source-slice-add">
                  <label>Элемент <select aria-label="Элемент для среза" value={addElement()}
                    title="Элемент для нового среза: порядковый номер и имя из списка элементов."
                    onChange={event => { setAddElement(Number(event.currentTarget.value)); setPreviewSlice(null); }}>
                    <For each={props.task.elements}>{record => <option value={record.recordIndex}>№{record.id} · {record.name}</option>}</For>
                  </select></label>
                  <DirectionChoices recordIndex={addElement()} choose={addSlice} />
                </div>
              </Show>
              <div class="source-slice-scroll">
                <table class="source-slice-table" aria-label="Графики срезов элементов">
                  <thead><tr><th title="Имя элемента из исходных данных; только для чтения.">Имя элемента</th>
                    <th title="Порядковый номер элемента в списке; только для чтения.">Номер</th>
                    <th title="Срез поперёк выбранного направления DV; в скобках число дискретов этого направления.">Направление среза</th>
                    <th title="Номер слоя ЭО в выбранном направлении, от 1 до числа дискретов.">Дискрет</th>
                    <th title="Глобальная компонента вектора X, Y или Z; для скалярной величины выбор не требуется.">Компонента</th></tr></thead>
                  <tbody><For each={graphSlices().map(s => s.id)}>{id => {
                    const slice = () => graphSlices().find(s => s.id === id);
                    return <tr classList={{ selected: activeSlice() === id }}
                    aria-selected={activeSlice() === id} tabIndex="0" title="Щёлкните для выделения среза и подсветки его элемента в 3D."
                    onClick={event => { if (!graphBlocked()) { setActiveSlice(id); if (!event.target.closest(".source-slice-direction")) { setDirectionMenu(null); setPreviewSlice(null); } } }}
                    onFocusIn={event => { if (!graphBlocked()) {
                      if (activeSlice() !== id || !event.target.closest(".source-slice-direction")) { setDirectionMenu(null); setPreviewSlice(null); }
                      setActiveSlice(id);
                    } }}>
                    <td title={`Имя элемента: ${props.task.elements[slice().recordIndex]?.name}`}>{props.task.elements[slice().recordIndex]?.name}</td>
                    <td title="Порядковый номер элемента в списке; только для чтения.">{props.task.elements[slice().recordIndex]?.id}</td>
                    <td><button type="button" class="source-slice-direction" aria-haspopup="menu" aria-expanded={directionMenu() === id}
                      title="Выбрать направление среза с предпросмотром. В скобках — число дискретов; при смене направления выбирается центральный слой."
                      disabled={graphBlocked()} onClick={() => { setDirectionMenu(directionMenu() === id ? null : id); setAddingSlice(false); setPreviewSlice(null); }}>
                      {sliceLabel(slice().recordIndex, slice().direction)}</button>
                    </td>
                    <td><input type="number" class="source-slice-discrete" aria-label={`Дискрет среза ${id}`}
                      min="1" max={sliceCount(slice().recordIndex, slice().direction)} step="1" value={slice().discrete} disabled={graphBlocked()}
                      title={`Слой от 1 до ${sliceCount(slice().recordIndex, slice().direction)}. Плоскость проходит через центры ЭО слоя; изменение номера сразу перемещает срез.`}
                      onInput={event => changeSlice(id, { discrete: event.currentTarget.valueAsNumber })}
                      onBlur={event => { event.currentTarget.value = String(slice().discrete); }}
                      onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.value = String(slice().discrete); } }} />
                    </td>
                    <td title={sliceScalar(slice()) ? "Выбрана скалярная величина: компоненты X, Y, Z неприменимы." : "Выбрать глобальную компоненту вектора для этой поверхности."}>
                      <select aria-label={`Компонента среза ${id}`} value={slice().component} disabled={graphBlocked() || sliceScalar(slice())}
                      onChange={event => changeSlice(id, { component: Number(event.currentTarget.value) })}>
                      <For each={["X", "Y", "Z"]}>{(name, index) => <option value={index()}>{name}</option>}</For>
                    </select></td>
                  </tr>; }}</For></tbody>
                </table>
              </div>
              <Show when={directionMenu() !== null && selectedSlice()}>
                <DirectionChoices recordIndex={selectedSlice().recordIndex} slice={selectedSlice()} choose={direction => changeSlice(directionMenu(), { direction })} />
              </Show>
              <Show when={graphBusy()}><span role="status">Построение поверхностей…</span></Show>
              <Show when={graphError()}><span class="source-graph-error" role="alert">{graphError()}</span></Show>
              <Show when={!graphReady()}><span role="status">Загрузка настроек графиков…</span></Show>
            </div>
          </Show>
        </div>
        <div class="source-toolbar-menu">
          <button type="button" class="source-toolbar-menu-button"
            aria-expanded={openSourceMenu() === "lines"} aria-label="Векторные линии"
            title="Настроить метод и толщину, выбрать или удалить векторные линии"
            onClick={() => toggleSourceMenu("lines")}>Векторные линии</button>
          <Show when={openSourceMenu() === "lines"}>
            <div class="source-toolbar-menu-panel source-lines-panel" ref={positionSourcePanel}>
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

        </div>
        <div class="source-geometry-controls" ref={setGeometryToolbarHost} />
        <ProtocolCheck context={props} entryKey="sources" title="Источники / Поле 3D" adapter={movie.adapter}
          disabled={flightBusy() || result().loading || graphBusy()}
          comment={requestedLayers().filter(layer => layer.quantityKey !== "none").map(layer =>
            `${QUANTITIES[layer.quantityKey]?.label}: объекты ${layer.selected.join(", ")}`).join("; ")} />
      </div>
      <Show when={graphSaveNotice()}><div class="plot-status" role="status">{graphSaveNotice()}</div></Show>
      <div class="source-graph-workspace"><div class="embedded-geometry source-geometry-viewport">
        <GeometryMaterialLegend buttonClass="source-toolbar-menu-button"
          onOpen={() => setOpenSourceMenu(null)} />
        <ResultsGeometryViewport toolbarMount={geometryToolbarHost()} cameraState={cameraState()} onCameraStateChange={rememberCamera} open={true} model={props.task} moves={props.task?.moves} amplitudes={props.task?.amps}
          allowFlight={true} flightBlocked={props.movieBusy || graphBusy()} flightDisabledReason={flightDisabledReason()}
          onFlightStateChange={setFlightState}
          cameraRequest={cameraRequest()}
          prescribedSources={props.task?.mhj} taskKey={props.task} timeIndex={timeIndex()}
          selections={selections()} resultLayers={graphsOnly() ? [] : resultLayers()}
          resultError={[result().error, ...(value()?.errors ?? []).map(error => error.message)].filter(Boolean).join(" · ")}
          resultStreamlines={graphsOnly() ? [] : streamlines()} selectedStreamline={selectedStreamline()}
          graphResults={graphResults()} activeGraph={activeSlice()} graphPreview={previewSlice()} graphSelection={selectedSlice()}
          graphContour={graphContour()} graphContours={graphProfiles()} onGraphContourChange={selectGraphContour} graphInteractionBlocked={graphBlocked() || graphBusy()}
          streamlineWidth={streamlineWidth()} streamlineColorMap={true}
          onSelectStreamline={setSelectedStreamline} onResultNodeDoubleClick={addStreamline}
          captureFrameKey={captureFrameKey()} onCaptureReady={movie.onCaptureReady}
          resultVectorScale={scale()} onResultVectorScaleChange={setScale} resultPickingOnly={!graphsOnly()}
          resultVectorColorMap={effectiveColorMap()}
          resultNormalizeVectors={normalizeVectors()}
          performanceProfile={performanceProfile()} />
      </div>
      <Show when={areaGraphs() || sliceGraphs()}>
        <Graph1DCollection entries={graphProfiles()} results={profileResults()} active={activeProfile()} expanded={expandedProfile()}
          blocked={graphBlocked()} loading={graphBusy()} error={graphError()}
          onSelect={selectProfile} onExpand={id => { if (!graphBlocked()) { selectProfile(id); setExpandedProfile(id); } }}
          onCollapse={() => setExpandedProfile(null)} onDelete={id => { if (!graphBlocked()) removeProfiles(p => p.id === id); }}
          onViewChange={changeProfileView} />
      </Show>
      </div>
      <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep}
        disabled={flightBusy()} onChange={changeTime} />
    </section>
  </div>;
}
