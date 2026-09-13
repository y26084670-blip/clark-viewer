import { createEffect, createMemo, createSignal, on } from "solid-js";
import { ObjectList } from "../components/ObjectList.jsx";
import { LineChart } from "../components/LineChart.jsx";
import { QuantitySelect } from "../components/QuantitySelect.jsx";
import { TimeSlider } from "../components/TimeSlider.jsx";
import { QUANTITIES, regionLayout } from "../services/results/resultMappings.js";
import { lineSeries } from "../services/results/resultPlots.js";
import { readObjectFrames, resultObjects, useAsyncResult } from "../services/results/resultRequests.js";

export function FieldLines(props) {
  const [quantityKey, setQuantity] = createSignal("Bs");
  const [component, setComponent] = createSignal("norm");
  const [direction, setDirection] = createSignal("i2");
  const [copy, setCopy] = createSignal(0);
  const [allCopies, setAllCopies] = createSignal(false);
  const records = () => props.task?.regions ?? [];
  const selectedRecords = createMemo(() => records().filter(row => props.regions.includes(row.id)));
  const copyCount = createMemo(() => selectedRecords().reduce((max, row) => Math.max(max, row.symLs ?? 1), 1));
  const localCopy = () => Math.min(copy(), copyCount() - 1);
  createEffect(on(() => props.task, () => setCopy(0)));
  createEffect(on(copyCount, max => setCopy(previous => Math.min(previous, max - 1))));
  const result = useAsyncResult(() => props.task && ({ task: props.task, quantityKey: quantityKey(), selected: props.regions,
    time: props.time, component: component(), direction: direction(), copy: localCopy(), allCopies: allCopies() }), async request => {
    const quantity = QUANTITIES[request.quantityKey];
    if (request.allCopies) {
      const frames = await readObjectFrames(request);
      return { series: frames.flatMap(({ frame, record }) => lineSeries(frame, record, quantity, request.component, request.direction, { unfold: true })), skipped: [] };
    }
    const objects = resultObjects(request.task, request.quantityKey).filter(item => request.selected.includes(item.record.id));
    if (!objects.length) throw new Error("Для выбранных объектов нет этой величины");
    const available = objects.filter(item => request.copy < regionLayout(item.record).copies);
    const series = await Promise.all(available.map(async object => {
      const layout = regionLayout(object.record);
      const frame = await request.task.reader.read({ name: quantity.file, step: request.time,
        start: object.start + request.copy * layout.planeCount, count: layout.planeCount });
      return lineSeries(frame, object.record, quantity, request.component, request.direction, { copy: request.copy });
    }));
    return { series: series.flat(), skipped: objects.filter(item => !available.includes(item)).map(item => `№${item.record.id}`) };
  });
  const status = () => result.loading() ? "Чтение поля…" : result.error()
    || (result.value()?.skipped.length ? `LS ${localCopy() + 1} отсутствует у площадок ${result.value().skipped.join(", ")}` : "");
  return <div class="results-layout">
    <ObjectList title="Площадки" records={records()} selected={props.regions} onSelect={props.setRegions} />
    <section class="plot-panel">
      <LineChart series={result.value()?.series ?? []}
        toolbar={<><QuantitySelect options={["Bs", "As"]} value={quantityKey()} onChange={setQuantity} component={component()} onComponentChange={setComponent} />
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
        yLabel={`${QUANTITIES[quantityKey()].label}, ${QUANTITIES[quantityKey()].unit}`} emptyText={result.error()} />
      <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep} onChange={props.setTime} />
    </section>
  </div>;
}
