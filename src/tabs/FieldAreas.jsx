import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { createGeometryViewSetting } from "../services/visualization/geometryViewSettings.js";
import { ObjectList } from "../components/ObjectList.jsx";
import { ProtocolCheck } from "../components/protocol/ProtocolCheck.jsx";
import { SurfaceChart } from "../components/SurfaceChart.jsx";
import { QuantitySelect } from "../components/QuantitySelect.jsx";
import { TimeSlider } from "../components/TimeSlider.jsx";
import { QUANTITIES, regionLayout } from "../services/results/resultMappings.js";
import { surfaceComponentRange } from "../services/results/resultPlots.js";
import { readSurfaceFrame, useResultFrame } from "../services/results/resultRequests.js";
import { completedMovieFrame, createMovieTabAdapter } from "../services/movie/movieTabAdapter.js";
import { combineMovieFrames } from "../services/movie/movieCanvas.js";

export function FieldAreas(props) {
  const [quantityKey, setQuantity] = createSignal("Bs");
  const [copy, setCopy] = createSignal(0);
  const [projections, setProjections] = createGeometryViewSetting("areaProjections", true);
  const [isolines, setIsolines] = createGeometryViewSetting("areaIsolines", 0);
  const [viewState, setViewState] = createSignal(null);
  const [viewControls, setViewControls] = createSignal(null);
  // This tab compares three components at one time, independently of the
  // full-cycle preference shared by 3D, working points and field lines.
  const [globalMinMax, setGlobalMinMax] = createGeometryViewSetting("areaComponentMinMax", true);
  const records = () => props.task?.regions ?? [];
  const record = createMemo(() => records().find(row => props.regions.includes(row.id)));
  const selectedIds = createMemo(() => record() ? [record().id] : []);
  const layout = createMemo(() => record() ? regionLayout(record()) : null);
  createEffect(() => { record(); setCopy(0); });
  const result = useResultFrame(() => props.task && record() && ({ task: props.task, quantityKey: quantityKey(), selected: [record().id],
    time: props.time, components: ["0", "1", "2"], copy: copy() }), readSurfaceFrame);
  const displayed = createMemo(() => result().frame);
  const commonRange = createMemo(() => surfaceComponentRange(displayed()?.value));
  const grids = createMemo(() => {
    const values = displayed()?.value ?? [];
    return globalMinMax() && commonRange() ? values.map(value => ({ ...value, displayRange: commonRange() })) : values;
  });
  const movie = createMovieTabAdapter(props, { title: "Поле в областях", filenamePrefix: "areas", readFrame: index =>
    record() ? completedMovieFrame(result(), { task: props.task, index }) : { error: "Выберите площадку" } });
  const renderers = [null, null, null];
  const targets = () => {
    if (renderers.some(renderer => !renderer)) throw new Error("Не все компоненты поля готовы к записи");
    return renderers;
  };
  movie.onCaptureReady({
    async prepare(options) {
      try { for (const renderer of targets()) await renderer.prepare(options); }
      catch (error) { for (const renderer of renderers) renderer?.restore(); throw error; }
    },
    async renderReady(key, options) { await Promise.all(targets().map(renderer => renderer.renderReady(key, options))); },
    capture(key, options) {
      const quantity = QUANTITIES[quantityKey()];
      return combineMovieFrames(targets().map((renderer, index) => renderer.capture(key,
        { caption: `${quantity.label} · ${"XYZ"[index]}, ${quantity.unit}` })), options);
    },
    restore() { for (const renderer of renderers) renderer?.restore(); },
  });
  return <div class="results-layout">
    <ObjectList title="Площадки" records={records()} selected={selectedIds()} onSelect={props.setRegions} multiple={false} />
    <section class="plot-panel field-area-panel">
      <div class="plot-toolbar"><QuantitySelect options={["Bs", "As"]} value={quantityKey()} onChange={setQuantity} />
        <label title="Единые пределы высоты и цвета трёх компонент в текущем кадре: от наименьшего минимума до наибольшего максимума X/Y/Z. Без отметки каждая компонента масштабируется отдельно">
          <input type="checkbox" aria-label="Общий минимакс" checked={globalMinMax()} disabled={props.movieBusy}
            onChange={event => !props.movieBusy && setGlobalMinMax(event.currentTarget.checked)} /> Общий минимакс
        </label>
        <div class="surface-view-buttons" role="group" aria-label="Ракурс всех компонент"
          title="Управление как в 3D: ЛКМ — поворот, ПКМ — перенос, колесо — масштаб. Ракурс синхронен у трёх компонент">
          <button disabled={props.movieBusy || !viewControls()} title="Вернуть начальный наклонный ракурс всех трёх компонент"
            onClick={() => viewControls()?.view("iso")}>Вписать</button>
          <For each={["x", "y", "z"]}>{direction => <button disabled={props.movieBusy || !viewControls()}
            title={`Смотреть вдоль оси ${direction.toUpperCase()}; ракурс меняется у всех трёх компонент`}
            onClick={() => viewControls()?.view(direction)}>Вид {direction.toUpperCase()}</button>}</For>
        </div>
        <label title="Номер локального образа выбранной площадки">Локальный образ <input aria-label="Локальный образ" disabled={props.movieBusy || !record()} type="number" min="1" max={layout()?.copies ?? 1} step="1" value={copy() + 1}
          onChange={event => {
            const value = event.currentTarget.valueAsNumber;
            const next = Number.isFinite(value) ? Math.max(1, Math.min(layout()?.copies ?? 1, Math.trunc(value))) : copy() + 1;
            event.currentTarget.value = String(next); setCopy(next - 1);
          }} /></label>
        <label><input type="checkbox" aria-label="Проекции" checked={projections()} disabled={props.movieBusy}
          onChange={event => !props.movieBusy && setProjections(event.currentTarget.checked)} /> Проекции</label>
        <label title="Число равномерных уровней по минимаксу каждой компоненты: 0 — нет, 1 — минимум, 2 — минимум и максимум; вырожденные изолинии показаны точками">Изолинии <input
          type="number" aria-label="Изолинии" min="0" step="1" value={isolines()} disabled={props.movieBusy}
          onChange={event => {
            const value = event.currentTarget.valueAsNumber;
            const next = Number.isSafeInteger(value) && value >= 0 ? value : isolines();
            event.currentTarget.value = String(next); if (!props.movieBusy) setIsolines(next);
          }} /></label>
        <ProtocolCheck context={props} entryKey="field-areas" title="Поле в областях" adapter={movie.adapter}
          disabled={result().loading || !record()} comment={`${QUANTITIES[quantityKey()].label}; площадка ${record()?.id}; LS ${copy() + 1}; компоненты X, Y, Z`} />
      </div>
      <Show when={result().error}><div class="plot-error" role="alert">{result().error}</div></Show>
      <div class="field-area-plots"><For each={[0, 1, 2]}>{index => <section class="field-area-component" aria-label={`Компонента ${"XYZ"[index]}`}>
        <SurfaceChart grid={grids()[index]} label={`${quantityKey()[0]}${"xyz"[index]}`} projections={projections()} isolines={isolines()} unit={QUANTITIES[quantityKey()].unit}
          viewState={viewState()} onViewChange={setViewState} emptyText={result().error}
          onViewReady={index === 0 ? setViewControls : undefined}
          captureFrameKey={displayed()} onCaptureReady={renderer => { renderers[index] = renderer; }} />
      </section>}</For></div>
      <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep} onChange={props.setTime} />
    </section>
  </div>;
}
