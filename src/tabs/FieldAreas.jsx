import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { ObjectList } from "../components/ObjectList.jsx";
import { SurfaceChart } from "../components/SurfaceChart.jsx";
import { QuantitySelect } from "../components/QuantitySelect.jsx";
import { TimeSlider } from "../components/TimeSlider.jsx";
import { QUANTITIES, regionLayout } from "../services/results/resultMappings.js";
import { regionSurfaceGrid } from "../services/results/resultPlots.js";
import { resultObjects, useAsyncResult } from "../services/results/resultRequests.js";

export function FieldAreas(props) {
  const [quantityKey, setQuantity] = createSignal("Bs");
  const [component, setComponent] = createSignal("norm"), [copy, setCopy] = createSignal(0);
  const records = () => props.task?.regions ?? [];
  const record = createMemo(() => records().find(row => props.regions.includes(row.id)));
  const layout = createMemo(() => record() ? regionLayout(record()) : null);
  createEffect(() => { record(); setCopy(0); });
  const result = useAsyncResult(() => props.task && record() && ({ task: props.task, quantityKey: quantityKey(), id: record().id,
    time: props.time, component: component(), copy: copy() }), async request => {
    const object = resultObjects(request.task, request.quantityKey).find(item => item.record.id === request.id);
    if (!object) throw new Error("Для выбранной площадки нет этой величины");
    const layout = regionLayout(object.record);
    if (!Number.isSafeInteger(request.copy) || request.copy < 0 || request.copy >= layout.copies) throw new Error("Неверный номер LS");
    const frame = await request.task.reader.read({ name: QUANTITIES[request.quantityKey].file, step: request.time,
      start: object.start + request.copy * layout.planeCount, count: layout.planeCount });
    return regionSurfaceGrid(frame, object.record, QUANTITIES[request.quantityKey], request.component, request.copy);
  });
  return <div class="results-layout">
    <ObjectList title="Площадки" records={records()} selected={record() ? [record().id] : []} onSelect={props.setRegions} multiple={false} />
    <section class="plot-panel">
      <div class="plot-toolbar"><QuantitySelect options={["Bs", "As"]} value={quantityKey()} onChange={setQuantity} component={component()} onComponentChange={setComponent} />
        <Show when={layout()?.copies > 1}><label>LS <input type="number" min="1" max={layout()?.copies ?? 1} step="1" value={copy() + 1}
          onChange={event => setCopy(event.currentTarget.valueAsNumber - 1)} /></label></Show>
      </div>
      <div class="plot-status" role="status">{result.loading() ? "Чтение поля…" : result.error() || result.value()?.title || "Выберите площадку"}</div>
      <SurfaceChart grid={result.value()} label={QUANTITIES[quantityKey()].label} unit={QUANTITIES[quantityKey()].unit} emptyText={result.error()} />
      <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep} onChange={props.setTime} />
    </section>
  </div>;
}
