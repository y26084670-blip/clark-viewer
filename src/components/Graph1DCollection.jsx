import { createMemo, For, onCleanup, onMount, Show } from "solid-js";
import { LineChart } from "./LineChart.jsx";
import { graphProfileDescription, graphProfileSeries, graphProfileThumbnail } from "../services/visualization/graphProfileChart.js";
import "./Graph1DCollection.css";

function ExpandedProfile(props) {
  let dialog;
  const series = createMemo(() => graphProfileSeries(props.result));
  const description = () => graphProfileDescription(props.result);
  const yLabel = createMemo(() => props.result ? `${props.result.label}, ${props.result.unit}` : "Значение");
  const autoXRange = createMemo(() => props.result?.length > 0 ? { minimum: 0, maximum: props.result.length } : undefined);
  const status = createMemo(() => props.loading ? "Обновление…" : props.result ? `t = ${props.result.time} с · ${props.result.distances.length} узлов` : props.error || "Для сечения нет данных выбранной величины");
  const initialView = props.entry.view;
  onMount(() => { dialog.showModal(); });
  onCleanup(() => dialog.close());
  return <dialog ref={dialog} class="graph-1d-expanded" aria-label={`1D график №${props.entry.id}`}
    onCancel={event => { event.preventDefault(); props.onCollapse(); }}>
    <header><strong>1D №{props.entry.id}</strong><span title={description()}>{description()}</span>
      <button type="button" title="Свернуть график обратно в миниатюру; данные и настройки сохранятся" onClick={props.onCollapse}>Свернуть</button></header>
    <LineChart series={series()} xLabel="Расстояние, мм" yLabel={yLabel()}
      legendMode="overlay" autoScaleToggle={true} initialViewState={initialView}
      onViewStateChange={props.onViewChange} endpointCoordinates={props.result}
      autoXRange={autoXRange()} copyImageLabel="Копировать изображение" status={status()}
      emptyText="Для сечения нет данных выбранной величины" />
  </dialog>;
}

export function Graph1DCollection(props) {
  const byId = createMemo(() => new Map((props.results ?? []).map(p => [p.id, p])));
  const entry = id => props.entries.find(p => p.id === id);
  // Key only on the id: a time/component/view update must not recreate the chart.
  const expanded = createMemo(() => props.entries.some(p => p.id === props.expanded) ? props.expanded : null);
  return <Show when={props.entries.length}>
    <aside class="graph-1d-collection" aria-label="Коллекция 1D">
      <div class="graph-1d-heading">1D <span>{props.entries.length}</span></div>
      <div class="graph-1d-scroll"><For each={props.entries.map(p => p.id)}>{id => {
        const result = () => byId().get(id), series = createMemo(() => graphProfileSeries(result()));
        const paths = createMemo(() => graphProfileThumbnail(series(), entry(id)?.view?.hidden));
        return <article class="graph-1d-miniature" classList={{ active: props.active === id }} aria-label={`1D график №${id}`}>
          <div class="graph-1d-actions"><span>№{id}</span>
            <button type="button" disabled={props.blocked} aria-label={`Развернуть 1D график №${id}`} title="Развернуть: компоненты XYZ, легенда, масштабирование и копирование" onClick={() => props.onExpand(id)}>⤢</button>
            <button type="button" disabled={props.blocked} aria-label={`Удалить 1D график №${id}`} title="Удалить 1D график и его контур; поверхность 2D останется" onClick={() => props.onDelete(id)}>×</button></div>
          <button type="button" class="graph-1d-preview" disabled={props.blocked} aria-pressed={props.active === id} title={graphProfileDescription(result())} aria-label={`Выбрать 1D график №${id}`} onClick={() => props.onSelect(id)}>
            <svg viewBox="0 0 200 92" role="img" aria-label={result() ? `${result().label}: линейный график` : "Данные недоступны"}>
              <path d="M12,8V80H190" fill="none" stroke="#bec8d2" />
              <For each={paths()}>{line => <path d={line.path} fill="none" stroke={line.color} stroke-width="2" stroke-linecap="round" />}</For>
              <Show when={!result()}><text x="100" y="45" text-anchor="middle">{props.loading ? "Обновление…" : "Нет данных"}</text></Show>
            </svg>
            <span>{result()?.source.name ?? `График ${entry(id)?.graphId}`}</span>
            <small>{result() ? `${result().plane == null ? "Площадка" : `DV${result().plane + 1}: ${result().discrete}/${result().discreteCount}`} · ${result().index + 1}/${result().count}` : ""}</small>
          </button>
        </article>;
      }}</For></div>
    </aside>
    <Show when={expanded()} keyed>{id => <ExpandedProfile entry={entry(id)} result={byId().get(id)} loading={props.loading} error={props.error}
      onCollapse={props.onCollapse} onViewChange={view => props.onViewChange(id, view)} />}</Show>
  </Show>;
}
