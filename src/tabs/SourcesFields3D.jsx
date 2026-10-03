import { createGeometryViewSetting } from "../services/visualization/geometryViewSettings.js";
import { createMemo, For, onCleanup, Show } from "solid-js";
import { ObjectList } from "../components/ObjectList.jsx";
import { ResultsGeometryViewport } from "../components/geometry/ResultsGeometryViewport.jsx";
import { TimeSlider } from "../components/TimeSlider.jsx";
import { QUANTITIES } from "../services/results/resultMappings.js";
import { resultDisplaySelection, useResultFrame } from "../services/results/resultRequests.js";
import { RESULT_LAYER_GROUPS, RESULT_LAYER_QUANTITY_LABELS } from "../services/results/resultLayerDefinitions.js";
import { createResultLayerReader } from "../services/results/resultLayerRequests.js";
import { RESULT_SCALAR_PALETTES } from "../services/visualization/resultScalarColors.js";
import { completedMovieFrame, createMovieTabAdapter } from "../services/movie/movieTabAdapter.js";
import "./SourcesFields3D.css";

export function SourcesFields3D(props) {
  const [elementsQuantity, setElementsQuantity] = createGeometryViewSetting("resultElementsQuantity", "M");
  const [regionsQuantity, setRegionsQuantity] = createGeometryViewSetting("resultRegionsQuantity", "none");
  const [virtualQuantity, setVirtualQuantity] = createGeometryViewSetting("resultVirtualQuantity", "none");
  const [scale, setScale] = createGeometryViewSetting("resultVectorScale", 1);
  const [colorMap, setColorMap] = createGeometryViewSetting("resultVectorColorMap", false);
  const [palette, setPalette] = createGeometryViewSetting("resultPalette", "Viridis");
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
  const volumeMode = createMemo(() => colorMap() && scale() >= 10 - 1e-9);
  const requestedLayers = createMemo(() => RESULT_LAYER_GROUPS.map(group => {
    const records = group.key === "regions" ? props.task?.regions ?? []
      : (props.task?.elements ?? []).filter(record => group.key === "virtual" ? record.targ === 3 : record.targ !== 3);
    const recordIds = new Set(records.map(record => record.id));
    const selected = resultDisplaySelection(records, group.key === "regions" ? props.regions : props.elements,
      group.key === "regions" ? regionsMode() : elementsMode()).filter(id => recordIds.has(id));
    const quantityKey = quantities[group.key].read();
    return { key: group.key, quantityKey, selected,
      volumeMode: QUANTITIES[quantityKey]?.components === 3 && volumeMode() };
  }));
  const hasRequestedResults = createMemo(() => requestedLayers().some(layer => layer.quantityKey !== "none" && layer.selected.length > 0));
  const layerReader = createResultLayerReader();
  onCleanup(() => layerReader.close());
  // Even a completely disabled frame reaches the reader so it can release its
  // workers; no HDF5 is read, and geometry follows the requested time immediately.
  const result = useResultFrame(() => props.task && ({ task: props.task, time: props.time, layers: requestedLayers() }),
    request => layerReader.read(request));
  const displayed = () => result().frame;
  const value = () => displayed()?.value;
  const layerMetadata = layer => ({ ...layer,
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
    const range = scalar ? `${number(scalar.minimum)} … ${number(scalar.maximum)}` : `max ${number(maximum)}`;
    const volume = layer.volumeFields ? layer.volumeFields.domains.length
      ? ` · Объёмная карта: ${layer.volumeFields.domains.length} сеток`
      : " · Объёмная карта недоступна; показаны цветные узлы" : "";
    return `${quantity.formula ? quantity.formula + " · " : ""}${range} ${quantity.unit}`
      + volume + (layer.volumeNotice ? ` · ${layer.volumeNotice}` : "")
      + (layer.sampled ? " · показана выборка узлов" : "");
  };
  const timeIndex = () => hasRequestedResults() ? displayed()?.request.time ?? props.time : props.time;
  const selections = createMemo(() => ({
    elements: props.elements.map(id => id - 1), regions: props.regions.map(id => id - 1),
  }));
  const movie = createMovieTabAdapter(props, { title: "Источники/Поля 3D", filenamePrefix: "3d", readFrame: index => {
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
        <Show when={hasVectors()}>
          <label>{colorMap() ? "Размер точки" : "Векторы"} <input type="range" min="-1" max="1" step="0.05" value={Math.log10(scale())} onInput={event => setScale(10 ** event.currentTarget.valueAsNumber)} /></label>
          <label><input type="checkbox" checked={colorMap()} onChange={event => setColorMap(event.currentTarget.checked)} /> Цветовая карта</label>
        </Show>
        <label>Палитра <select aria-label="Палитра" value={palette()} disabled={!hasScalars() && !(hasVectors() && colorMap())} onChange={event => setPalette(event.currentTarget.value)}>
          <For each={RESULT_SCALAR_PALETTES}>{name => <option value={name}>{name}</option>}</For>
        </select></label>
      </div>
      <div class="plot-status sources-fields-status" role="status">
        <For each={statusLayers()}>{layer => <span classList={{ "source-layer-error": layer.state === "error" }}><b>{layer.groupLabel}:</b> {layerStatus(layer)}</span>}</For>
        <Show when={hasRequestedResults() && result().loading && displayed()}><span>Чтение результатов…</span></Show>
        <Show when={hasRequestedResults() && displayed()}><span>Показан шаг {displayed().request.time}</span></Show>
      </div>
      <div class="embedded-geometry">
        <ResultsGeometryViewport open={true} model={props.task} moves={props.task?.moves} amplitudes={props.task?.amps}
          prescribedSources={props.task?.mhj} taskKey={props.task} timeIndex={timeIndex()}
          selections={selections()} resultLayers={resultLayers()}
          captureFrameKey={displayed()} onCaptureReady={movie.onCaptureReady}
          resultVectorScale={scale()} resultPickingOnly={true}
          resultVectorColorMap={colorMap()} resultPalette={palette()} />
      </div>
      <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep} onChange={props.setTime} />
    </section>
  </div>;
}
