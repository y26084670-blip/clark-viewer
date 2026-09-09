import { createEffect, createMemo, createSignal } from "solid-js";
import { ObjectList } from "../components/ObjectList.jsx";
import { SurfaceChart } from "../components/SurfaceChart.jsx";
import { QuantitySelect } from "../components/QuantitySelect.jsx";
import { TimeSlider } from "../components/TimeSlider.jsx";
import { QUANTITIES, virtualLayout } from "../services/results/resultMappings.js";
import { surfaceGrid } from "../services/results/resultPlots.js";
import { readObjectFrames, useAsyncResult } from "../services/results/resultRequests.js";

export function FieldAreas(props) {
  const [quantityKey, setQuantity] = createSignal("Bv");
  const [component, setComponent] = createSignal("norm");
  const [axis, setAxis] = createSignal(2), [layer, setLayer] = createSignal(0), [copy, setCopy] = createSignal(0);
  const records = createMemo(() => (props.task?.elements ?? []).filter(row => row.targ === 3));
  const record = createMemo(() => records().find(row => props.elements.includes(row.id)));
  const layout = createMemo(() => record() ? virtualLayout(record()) : null);
  createEffect(() => { record(); axis(); setLayer(0); setCopy(0); });
  const result = useAsyncResult(() => props.task && record() && ({ task: props.task, quantityKey: quantityKey(), selected: [record().id], time: props.time,
    component: component(), axis: axis(), layer: layer(), copy: copy() }), async request => {
    const [{ frame, record }] = await readObjectFrames(request);
    return surfaceGrid(frame, record, QUANTITIES[request.quantityKey], request.component, request.axis, request.layer, request.copy);
  });
  return <div class="results-layout">
    <ObjectList title="Виртуальные элементы" records={records()} selected={record() ? [record().id] : []} onSelect={props.setElements} multiple={false} />
    <section class="plot-panel">
      <div class="plot-toolbar"><QuantitySelect options={["Bv", "Av"]} value={quantityKey()} onChange={setQuantity} component={component()} onComponentChange={setComponent} />
        <label>Срез <select value={axis()} onChange={event => setAxis(Number(event.currentTarget.value))}>
          <option value="0">i1 = const</option><option value="1">i2 = const</option><option value="2">i3 = const</option>
        </select></label>
        <label>Слой <input type="number" min="1" max={layout()?.dimensions[axis()] ?? 1} step="1" value={layer() + 1} onChange={event => setLayer(event.currentTarget.valueAsNumber - 1)} /></label>
        <label>Образ <input type="number" min="1" max={layout()?.copyCount ?? 1} step="1" value={copy() + 1} onChange={event => setCopy(event.currentTarget.valueAsNumber - 1)} /></label>
      </div>
      <div class="plot-status" role="status">{result.loading() ? "Чтение среза…" : result.error() || "Оси поверхности — номера узлов сетки; координаты и значение доступны при наведении"}</div>
      <SurfaceChart grid={result.value()} label={QUANTITIES[quantityKey()].label} unit={QUANTITIES[quantityKey()].unit} emptyText={result.error()} />
      <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep} onChange={props.setTime} />
    </section>
  </div>;
}
