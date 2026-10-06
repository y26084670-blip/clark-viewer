import { createEffect, createMemo, createSignal, on } from "solid-js";
import { ObjectList } from "../components/ObjectList.jsx";
import { LineChart } from "../components/LineChart.jsx";
import { QuantitySelect } from "../components/QuantitySelect.jsx";
import { FieldComponentsMenu } from "../components/FieldComponentsMenu.jsx";
import { TimeSlider } from "../components/TimeSlider.jsx";
import { QUANTITIES } from "../services/results/resultMappings.js";
import { fieldLineChartRange, fieldLineCycleRange, normalizeFieldLineComponents } from "../services/results/fieldLineComponents.js";
import { readLineFrame, useResultFrame } from "../services/results/resultRequests.js";
import { completedMovieFrame, createMovieTabAdapter } from "../services/movie/movieTabAdapter.js";

export function FieldLines(props) {
  const [quantityKey, setQuantity] = createSignal("Bs");
  const [components, setComponents] = createSignal(["norm"]);
  const [globalScale, setGlobalScale] = createSignal(true);
  const [direction, setDirection] = createSignal("i2");
  const [copy, setCopy] = createSignal(0);
  const [allCopies, setAllCopies] = createSignal(false);
  const records = () => props.task?.regions ?? [];
  const selectedRecords = createMemo(() => records().filter(row => props.regions.includes(row.id)));
  const copyCount = createMemo(() => selectedRecords().reduce((max, row) => Math.max(max, row.symLs ?? 1), 1));
  const localCopy = () => Math.min(copy(), copyCount() - 1);
  const cycleRange = createMemo(() => fieldLineCycleRange(props.task, quantityKey(), props.regions, components()));
  const globalYRange = createMemo(() => globalScale() ? fieldLineChartRange(cycleRange()) : null);
  createEffect(on(() => props.task, () => setCopy(0)));
  createEffect(on(copyCount, max => setCopy(previous => Math.min(previous, max - 1))));
  const result = useResultFrame(() => props.task && ({ task: props.task, quantityKey: quantityKey(), selected: props.regions,
    time: props.time, components: components(), direction: direction(), copy: localCopy(), allCopies: allCopies() }), readLineFrame);
  // Loading status changes must not update the chart while its frame is unchanged.
  const displayed = createMemo(() => result().frame);
  const emptySeries = [];
  const series = createMemo(() => displayed()?.value.series ?? emptySeries);
  const status = () => {
    if (!components().length) return "Выберите компоненты поля";
    const frame = displayed();
    const skipped = frame?.value.skipped ?? [];
    const message = result().loading ? "Чтение поля…" : result().error
      || (skipped.length ? `LS ${frame.request.copy + 1} отсутствует у площадок ${skipped.join(", ")}` : "Поле в сохранённых узлах");
    const rangeMessage = globalYRange() ? "Пределы Y для «Авто»: весь расчёт (HDF5)"
      : `Пределы Y для «Авто»: текущий кадр${globalScale() ? `; общий диапазон недоступен: ${cycleRange().reason || "некорректные пределы"}` : ""}`;
    return `${frame ? `${message} · показан шаг ${frame.request.time}` : message} · ${rangeMessage}`;
  };
  const movie = createMovieTabAdapter(props, { title: "Поле на линиях", filenamePrefix: "lines", readFrame: index => {
    if (!components().length) return { error: "Выберите компоненты поля" };
    if (!selectedRecords().length) return { error: "Выберите площадки" };
    const current = completedMovieFrame(result(), { task: props.task, index });
    if (!current.ready) return current;
    return current.value.value.series.some(series => series.points.length) ? current : { error: "Нет линий для записи" };
  } });
  return <div class="results-layout">
    <ObjectList title="Площадки" records={records()} selected={props.regions} onSelect={props.setRegions} />
    <section class="plot-panel">
      <LineChart series={series()} autoScaleToggle={true} autoYRange={globalYRange()}
        captureFrameKey={displayed()} onCaptureReady={movie.onCaptureReady} captureError={result().error}
        toolbar={<><QuantitySelect options={["Bs", "As"]} value={quantityKey()} onChange={setQuantity} />
        <FieldComponentsMenu value={components()} disabled={props.movieBusy}
          onChange={values => setComponents(normalizeFieldLineComponents(values))} />
        <label title={cycleRange().available
          ? "Общие пределы Y выбранных компонент по всем узлам и образам выбранных площадок. Применяются при включённом «Авто»; ручной масштаб сохраняется."
          : cycleRange().reason}>
          <input type="checkbox" checked={globalScale() && cycleRange().available}
            disabled={props.movieBusy || !cycleRange().available}
            onChange={event => setGlobalScale(event.currentTarget.checked)} />За весь расчёт
        </label>
        <label>По оси X <select value={direction()} onChange={event => setDirection(event.currentTarget.value)}><option value="i1">i1</option><option value="i2">i2</option></select></label>
        <label>Локальный образ <input type="number" min="1" max={copyCount()} step="1" value={localCopy() + 1}
          aria-label="Номер локального образа LS" disabled={allCopies() || !selectedRecords().length}
          onChange={event => {
            const value = event.currentTarget.valueAsNumber;
            const next = Number.isFinite(value) ? Math.max(1, Math.min(copyCount(), Math.trunc(value))) : localCopy() + 1;
            event.currentTarget.value = String(next); setCopy(next - 1);
          }} /><span>из {copyCount()}</span></label>
        <label><input type="checkbox" checked={allCopies()} onChange={event => setAllCopies(event.currentTarget.checked)} />Все локальные образы</label>
        </>}
        status={status()}
        xLabel={allCopies() ? `Сквозной номер узла ${direction()} по LS` : `Номер узла ${direction()}`} integerX={true}
        yLabel={`${QUANTITIES[quantityKey()].label}, ${QUANTITIES[quantityKey()].unit}`}
        emptyText={!components().length ? "Выберите компоненты поля" : result().error} />
      <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep} onChange={props.setTime} />
    </section>
  </div>;
