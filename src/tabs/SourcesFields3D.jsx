import { createGeometryViewSetting } from "../services/visualization/geometryViewSettings.js";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { installSourcesFieldsKeyboard } from "../services/sourcesFieldsKeyboard.js";
import { ObjectList } from "../components/ObjectList.jsx";
import { ResultsGeometryViewport } from "../components/geometry/ResultsGeometryViewport.jsx";
import { TimeSlider } from "../components/TimeSlider.jsx";
import { QUANTITIES } from "../services/results/resultMappings.js";
import { resultDisplaySelection, useResultFrame } from "../services/results/resultRequests.js";
import { RESULT_LAYER_GROUPS, RESULT_LAYER_QUANTITY_LABELS } from "../services/results/resultLayerDefinitions.js";
import { createResultLayerReader } from "../services/results/resultLayerRequests.js";
import { applyResultGlobalRange, resultGlobalScale } from "../services/results/resultGlobalScale.js";
import { RESULT_SCALAR_PALETTES } from "../services/visualization/resultScalarColors.js";
import { completedMovieFrame, createMovieTabAdapter } from "../services/movie/movieTabAdapter.js";
import { movie3DFilenamePrefix } from "../services/movie/movieFilename.js";
import { STREAMLINE_LIMITS, STREAMLINE_METHODS, STREAMLINE_TOLERANCE_MM } from "../services/visualization/resultStreamlineField.js";
import "./SourcesFields3D.css";

// Switching tabs unmounts this component. Retain only small seed descriptors,
// not HDF5 buffers or worker/GPU resources, for the lifetime of the loaded task.
const streamlineSessions = new WeakMap();

export function SourcesFields3D(props) {
  const [cameraRequest,setCameraRequest]=createSignal(null);
  onMount(()=>{
    const remove=installSourcesFieldsKeyboard(window,{blocked:()=>props.movieBusy,
      time:()=>props.time,maxTime:()=>props.task?.general.countTimeSteps??0,setTime:props.setTime,
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
    if (streamlineSeeds().length >= STREAMLINE_LIMITS.lines) { setStreamlineNotice("Доступно 64 линии; удалите ненужную линию."); return; }
    const seed = { id: nextStreamlineId++, source: vector.source, instance: vector.instance,
      node: vector.node, quantityKey: vector.quantityKey };
    setStreamlineSeeds(previous => [...previous, seed]); setSelectedStreamline(seed.id); setStreamlineNotice("");
  }
  function deleteStreamline(id) {
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
  const [globalMinMax, setGlobalMinMax] = createGeometryViewSetting("resultGlobalMinMax", true);
  const [streamlineWidth, setStreamlineWidth] = createGeometryViewSetting("resultStreamlineWidth", 2);
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
    QUANTITIES[quantities[group.key].read()]?.components === 1));
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
    const quantityKey = quantities[group.key].read();
    return { key: group.key, quantityKey, selected,
      volumeMode: quantityKey !== "none" && volumeMode() };
  }));
  const globalRanges = createMemo(() => resultGlobalScale(props.task, requestedLayers(), streamlineSeeds()));
  const effectiveGlobalMinMax = createMemo(() => globalMinMax() && globalRanges().available);
  const hasRequestedResults = createMemo(() => requestedLayers().some(layer => layer.quantityKey !== "none" && layer.selected.length > 0));
  const layerReader = createResultLayerReader();
  onCleanup(() => layerReader.close());
  // Even a completely disabled frame reaches the reader so it can release its
  // workers; no HDF5 is read, and geometry follows the requested time immediately.
  const result = useResultFrame(() => props.task && ({ task: props.task, time: props.time, layers: requestedLayers(),
    streamlineSeeds: streamlineSeeds(), streamlineTolerance: STREAMLINE_TOLERANCE_MM, streamlineMethod: streamlineMethod() }),
    request => layerReader.read(request));
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
  const timeIndex = () => hasRequestedResults() || streamlineSeeds().length ? displayed()?.request.time ?? props.time : props.time;
  const selections = createMemo(() => ({
    elements: props.elements.map(id => id - 1), regions: props.regions.map(id => id - 1),
  }));
  const movie = createMovieTabAdapter(props, { title: "Источники / Поле 3D",
    filenamePrefix: () => movie3DFilenamePrefix(requestedLayers(), streamlines()), readFrame: index => {
    const status = completedMovieFrame(result(), { task: props.task, index });
    if (!status.ready) return status;
    const errors = status.value.value.errors ?? [];
    return errors.length ? { error: errors.map(item => item.message).join(" · ") } : status;
  } });
  const quantityText = key => key === "none"
    ? RESULT_LAYER_QUANTITY_LABELS.none
    : `${RESULT_LAYER_QUANTITY_LABELS[key]}, ${QUANTITIES[key]?.unit ?? ""}`;
  const toggleSourceMenu = name => setOpenSourceMenu(current => current === name ? null : name);

  return <div class="results-layout">
    <aside class="split-list-column">
      <ObjectList title="Элементы" records={props.task?.elements} selected={props.elements} onSelect={props.setElements} />
      <ObjectList title="Области" records={props.task?.regions} selected={props.regions} onSelect={props.setRegions} />
    </aside>
    <section class="plot-panel">
      <div class="plot-toolbar sources-fields-toolbar">
        <For each={[
          ["elements", "Объемные элементы"],
          ["regions", "Области просмотра"],
          ["virtual", "Виртуальные элементы"],
        ]}>{([key, label]) => {
          const group = RESULT_LAYER_GROUPS.find(item => item.key === key);
          return <div class="source-toolbar-menu">
            <button type="button" class="source-toolbar-menu-button"
              aria-expanded={openSourceMenu() === key}
              onClick={() => toggleSourceMenu(key)}>{label}</button>
            <Show when={openSourceMenu() === key}>
              <div class="source-toolbar-menu-panel">
                <For each={group.quantities}>{quantityKey =>
                  <label class="source-toolbar-option">
                    <input type="radio" name={`source-quantity-${key}`}
                      checked={quantities[key].read() === quantityKey}
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
            aria-expanded={openSourceMenu() === "presentation"}
            onClick={() => toggleSourceMenu("presentation")}>Представление</button>
          <Show when={openSourceMenu() === "presentation"}>
            <div class="source-toolbar-menu-panel source-presentation-panel">
              <label class="source-presentation-slider">Размер
                <input type="range" min="-1" max="1" step="0.05"
                  value={Math.log10(scale())}
                  onInput={event => setScale(10 ** event.currentTarget.valueAsNumber)} />
              </label>
              <label><input type="checkbox" checked={effectiveColorMap()} disabled={hasScalars()}
                onChange={event => !hasScalars() && setColorMap(event.currentTarget.checked)} /> Карта</label>
              <label title={globalRanges().available ? "Общие пределы за весь расчёт из HDF5." : globalRanges().reason}>
                <input type="checkbox" checked={effectiveGlobalMinMax()}
                  disabled={props.movieBusy || !globalRanges().available}
                  onChange={event => !props.movieBusy && globalRanges().available
                    && setGlobalMinMax(event.currentTarget.checked)} /> Общий минимакс
              </label>
              <label class="source-presentation-slider">Толщина
                <input type="range" min="1" max="10" step="1"
                  value={streamlineWidth()}
                  onInput={event => setStreamlineWidth(event.currentTarget.valueAsNumber)} />
                <span>{streamlineWidth()} px</span>
              </label>
            </div>
          </Show>
        </div>

        <div class="source-toolbar-menu">
          <button type="button" class="source-toolbar-menu-button"
            aria-expanded={openSourceMenu() === "lines"}
            onClick={() => toggleSourceMenu("lines")}>Линия</button>
          <Show when={openSourceMenu() === "lines"}>
            <div class="source-toolbar-menu-panel source-lines-panel">
              <Show when={streamlineSeeds().length} fallback={<div class="source-toolbar-empty">Нет линий</div>}>
                <For each={streamlineSeeds()}>{seed =>
                  <div class="source-line-row" classList={{ selected: selectedStreamline() === seed.id }}>
                    <button type="button" class="source-line-select"
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
            </div>
          </Show>
        </div>

        <div class="source-toolbar-menu">
          <button type="button" class="source-toolbar-menu-button"
            aria-expanded={openSourceMenu() === "method"}
            onClick={() => toggleSourceMenu("method")}>Метод</button>
          <Show when={openSourceMenu() === "method"}>
            <div class="source-toolbar-menu-panel">
              <For each={Object.entries(STREAMLINE_METHODS)}>{([key, label]) =>
                <label class="source-toolbar-option">
                  <input type="radio" name="source-streamline-method"
                    checked={streamlineMethod() === key} disabled={props.movieBusy}
                    onChange={() => !props.movieBusy && setStreamlineMethod(key)} />
                  <span>{label}</span>
                </label>}
              </For>
            </div>
          </Show>
        </div>
      </div>
      <div class="embedded-geometry">
        <ResultsGeometryViewport open={true} model={props.task} moves={props.task?.moves} amplitudes={props.task?.amps}
          cameraRequest={cameraRequest()}
          prescribedSources={props.task?.mhj} taskKey={props.task} timeIndex={timeIndex()}
          selections={selections()} resultLayers={resultLayers()}
          resultStreamlines={streamlines()} selectedStreamline={selectedStreamline()}
          streamlineWidth={streamlineWidth()} streamlineColorMap={true}
          onSelectStreamline={setSelectedStreamline} onResultNodeDoubleClick={addStreamline}
          captureFrameKey={displayed()} onCaptureReady={movie.onCaptureReady}
          resultVectorScale={scale()} resultPickingOnly={true}
          resultVectorColorMap={effectiveColorMap()} />
      </div>
      <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep} onChange={props.setTime} />
    </section>
  </div>;
}
