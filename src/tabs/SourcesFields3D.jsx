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
import { STREAMLINE_DEFAULT_TOLERANCE, STREAMLINE_LIMITS, STREAMLINE_REASONS } from "../services/visualization/resultStreamlineField.js";
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
    onCleanup(remove);
  });
  const savedStreamlines = props.task && streamlineSessions.get(props.task);
  const [streamlineSeeds, setStreamlineSeeds] = createSignal(savedStreamlines?.seeds ?? []);
  const [selectedStreamline, setSelectedStreamline] = createSignal(savedStreamlines?.selected ?? null);
  const [streamlineTolerance, setStreamlineTolerance] = createSignal(savedStreamlines?.tolerance ?? STREAMLINE_DEFAULT_TOLERANCE);
  const [streamlineNotice, setStreamlineNotice] = createSignal("");
  let nextStreamlineId = savedStreamlines?.nextId ?? 1, streamlineTask = props.task;
  createEffect(() => {
    if (props.task === streamlineTask) return;
    streamlineSessions.delete(streamlineTask);
    streamlineTask = props.task; setStreamlineSeeds([]); setSelectedStreamline(null); setStreamlineNotice("");
    setStreamlineTolerance(STREAMLINE_DEFAULT_TOLERANCE); nextStreamlineId = 1;
  });
  onCleanup(() => {
    if (streamlineTask && streamlineTask === props.task) streamlineSessions.set(streamlineTask, {
      seeds: streamlineSeeds(), selected: selectedStreamline(), tolerance: streamlineTolerance(), nextId: nextStreamlineId,
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
  function deleteStreamline() {
    const remaining = streamlineSeeds().filter(seed => seed.id !== selectedStreamline());
    setStreamlineSeeds(remaining); setSelectedStreamline(remaining.at(-1)?.id ?? null); setStreamlineNotice("");
  }
  function changeStreamlineTolerance(event) {
    const value = event.currentTarget.valueAsNumber / 100;
    if (Number.isFinite(value) && value >= 1e-7 && value <= 1e-2) setStreamlineTolerance(value);
    else event.currentTarget.value = streamlineTolerance() * 100;
  }
  const [elementsQuantity, setElementsQuantity] = createGeometryViewSetting("resultElementsQuantity", "M");
  const [regionsQuantity, setRegionsQuantity] = createGeometryViewSetting("resultRegionsQuantity", "none");
  const [virtualQuantity, setVirtualQuantity] = createGeometryViewSetting("resultVirtualQuantity", "none");
  const [scale, setScale] = createGeometryViewSetting("resultVectorScale", 1);
  const [colorMap, setColorMap] = createGeometryViewSetting("resultVectorColorMap", false);
  const [palette, setPalette] = createGeometryViewSetting("resultPalette", "Rainbow");
  const [globalMinMax, setGlobalMinMax] = createGeometryViewSetting("resultGlobalMinMax", false);
  const [streamlineWidth, setStreamlineWidth] = createGeometryViewSetting("resultStreamlineWidth", 2);
  const [streamlineColorMap, setStreamlineColorMap] = createGeometryViewSetting("resultStreamlineColorMap", true);
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
  const paletteDisabled = createMemo(() => !hasScalars() && !(hasVectors() && colorMap())
    && !(streamlineSeeds().length && streamlineColorMap()));
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
    streamlineSeeds: streamlineSeeds(), streamlineTolerance: streamlineTolerance() }),
    request => layerReader.read(request));
  const displayed = () => result().frame;
  const value = () => displayed()?.value;
  const streamlines = createMemo(() => (value()?.streamlines ?? [])
    .filter(line => streamlineSeeds().some(seed => seed.id === line.id))
    .map(line => ({ ...line, displayRange: effectiveGlobalMinMax() ? globalRanges().lineRanges[line.quantityKey] : undefined, quantity: QUANTITIES[line.quantityKey]?.label ?? line.quantityKey,
      unit: QUANTITIES[line.quantityKey]?.unit ?? "" })));
  const selectedLineStatus = () => {
    const line = streamlines().find(item => item.id === selectedStreamline());
    return line?.error || line?.reasons?.map(reason => STREAMLINE_REASONS[reason] ?? reason).join(" · ") || "";
  };
  const layerMetadata = layer => ({ ...applyResultGlobalRange(layer, effectiveGlobalMinMax() ? globalRanges().layerRanges[layer.key] : null),
    groupLabel: RESULT_LAYER_GROUPS.find(group => group.key === layer.key)?.label ?? layer.key,
    color: layer.quantityKey === "J" ? 0xff5454 : layer.quantityKey === "M" ? 0x44dd66 : 0x44bbff,
  });
  const resultLayers = createMemo(() => hasRequestedResults() ? (value()?.layers ?? []).map(layerMetadata) : []);
  const statusLayers = createMemo(() => {
    const published = hasRequestedResults() && value()?.layers;
    return (published || requestedLayers().map(layer => ({ ...layer,
      state: layer.quantityKey === "none" ? "disabled" : layer.selected.length === 0 ? "empty"
        : result().error ? "error" : "loading", error: result().error,
    }))).map(layerMetadata);
  });
  const layerStatus = layer => {
    if (layer.state === "disabled") return "Не показывать";
    if (layer.state === "empty") return "Нет объектов для показа";
    if (layer.state === "error") return layer.error || "Не удалось прочитать результаты";
    if (layer.state !== "ready") return "Чтение результатов…";
    const quantity = QUANTITIES[layer.quantityKey];
    const scalar = layer.scalarScene;
    const maximum = layer.scene?.maximumMagnitude?.magnetization;
    const number = value => Number.isFinite(value) ? value.toPrecision(6) : "—";
    const bounds = layer.displayRange;
    const range = bounds ? `${number(bounds.minimum)} … ${number(bounds.maximum)}`
      : scalar ? `${number(scalar.minimum)} … ${number(scalar.maximum)}` : `max ${number(maximum)}`;
    const representations = [];
    if (layer.volumeFields?.domains?.length) representations.push(`Объёмная карта: ${layer.volumeFields.domains.length} сеток`);
    if (layer.volumeFields?.surfaces?.length) representations.push(`Поверхность: ${layer.volumeFields.surfaces.length} площадок`);
    const volume = layer.volumeFields ? ` · ${representations.join(" · ") || "Объёмная карта недоступна; показаны цветные узлы"}` : "";
    return `${quantity.formula ? quantity.formula + " · " : ""}${range} ${quantity.unit}`
      + (bounds ? ` · общий минмакс${bounds.approximate ? " (произведение модулей)" : ""}` : "")
      + volume + (layer.volumeNotice ? ` · ${layer.volumeNotice}` : "")
      + (layer.sampled ? " · показана выборка узлов" : "");
  };
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
  return <div class="results-layout">
    <aside class="split-list-column">
      <ObjectList title="Элементы" records={props.task?.elements} selected={props.elements} onSelect={props.setElements} />
      <ObjectList title="Области" records={props.task?.regions} selected={props.regions} onSelect={props.setRegions} />
    </aside>
    <section class="plot-panel">
      <div class="plot-toolbar sources-fields-toolbar">
        <For each={RESULT_LAYER_GROUPS}>{group => <label class="source-quantity-selector">{group.label}
          <select aria-label={group.label} value={quantities[group.key].read()}
            onChange={event => quantities[group.key].write(event.currentTarget.value)}>
            <For each={group.quantities}>{key => <option value={key}>{RESULT_LAYER_QUANTITY_LABELS[key]}</option>}</For>
          </select>
          <span class="unit-label">{QUANTITIES[quantities[group.key].read()]?.unit ?? ""}</span>
        </label>}</For>
        <Show when={hasVectors() || hasScalars()}>
          <label>{effectiveColorMap() ? "Размер точки" : "Векторы"}
            <span class="source-result-size-slider" classList={{ "is-color-map": effectiveColorMap() }}>
              <input type="range" min="-1" max="1" step="0.05" value={Math.log10(scale())} onInput={event => setScale(10 ** event.currentTarget.valueAsNumber)} />
            </span>
          </label>
          <label><input type="checkbox" checked={effectiveColorMap()} disabled={hasScalars()} onChange={event => !hasScalars() && setColorMap(event.currentTarget.checked)} /> Карта</label>
        </Show>
        <label class="source-global-minmax" title={globalRanges().available
          ? "Общие пределы модулей за весь расчёт из HDF5. Для энергии/потерь — произведения границ модулей."
          : globalRanges().reason}>
          <input type="checkbox" aria-label="Общий минмакс" checked={effectiveGlobalMinMax()}
            disabled={props.movieBusy || !globalRanges().available}
            onChange={event => !props.movieBusy && globalRanges().available && setGlobalMinMax(event.currentTarget.checked)} />Общий минмакс
        </label>
        <label>Палитра <select aria-label="Палитра" value={palette()} disabled={paletteDisabled()} onChange={event => setPalette(event.currentTarget.value)}>
          <For each={RESULT_SCALAR_PALETTES}>{name => <option value={name}>{name}</option>}</For>
        </select></label>
      </div>
      <Show when={streamlineSeeds().length}>
        <div class="plot-toolbar source-streamline-toolbar">
          <label>Линия <select aria-label="Выбранная линия поля" value={selectedStreamline() ?? ""}
            onChange={event => setSelectedStreamline(Number(event.currentTarget.value) || null)}>
            <option value="">не выбрана</option>
            <For each={streamlineSeeds()}>{seed => <option value={seed.id}>
              №{seed.id} · {QUANTITIES[seed.quantityKey]?.label} · Элемент №{seed.source.recordIndex + 1}
            </option>}</For>
          </select></label>
          <button type="button" disabled={selectedStreamline() === null} onClick={deleteStreamline}>Стереть линию</button>
          <label>Допуск, % шага сетки <input type="number" min="0.00001" max="1" step="0.01"
            aria-label="Допуск линии, процент шага сетки" value={streamlineTolerance() * 100} onChange={changeStreamlineTolerance} /></label>
          <label class="source-streamline-width">Толщина
            <input type="range" min="1" max="10" step="1" aria-label="Толщина линий, пиксели" value={streamlineWidth()} onInput={event => setStreamlineWidth(event.currentTarget.valueAsNumber)} />
            <span>{streamlineWidth()} px</span>
          </label>
          <label><input type="checkbox" aria-label="Цвет линий по модулю" checked={streamlineColorMap()} onChange={event => setStreamlineColorMap(event.currentTarget.checked)} /> Цвет по модулю</label>
          <span class="source-streamline-status">{selectedLineStatus()}</span>
        </div>
      </Show>
      <div class="plot-status sources-fields-status" role="status">
        <For each={statusLayers()}>{layer => <span classList={{ "source-layer-error": layer.state === "error" }}><b>{layer.groupLabel}:</b> {layerStatus(layer)}</span>}</For>
        <Show when={hasRequestedResults() && result().loading && displayed()}><span>Чтение результатов…</span></Show>
        <Show when={hasRequestedResults() && displayed()}><span>Показан шаг {displayed().request.time}</span></Show>
        <Show when={globalMinMax() && !globalRanges().available}><span>Общий минмакс недоступен: {globalRanges().reason}</span></Show>
        <Show when={streamlineNotice()}><span class="source-layer-error">{streamlineNotice()}</span></Show>
        <Show when={streamlineSeeds().length && result().loading}><span>Расчёт линий…</span></Show>
      </div>
      <div class="embedded-geometry">
        <ResultsGeometryViewport open={true} model={props.task} moves={props.task?.moves} amplitudes={props.task?.amps}
          cameraRequest={cameraRequest()}
          prescribedSources={props.task?.mhj} taskKey={props.task} timeIndex={timeIndex()}
          selections={selections()} resultLayers={resultLayers()}
          resultStreamlines={streamlines()} selectedStreamline={selectedStreamline()}
          streamlineWidth={streamlineWidth()} streamlineColorMap={streamlineColorMap()}
          onSelectStreamline={setSelectedStreamline} onResultNodeDoubleClick={addStreamline}
          captureFrameKey={displayed()} onCaptureReady={movie.onCaptureReady}
          resultVectorScale={scale()} resultPickingOnly={true}
          resultVectorColorMap={effectiveColorMap()} resultPalette={palette()} />
      </div>
      <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep} onChange={props.setTime} />
    </section>
  </div>;
}
