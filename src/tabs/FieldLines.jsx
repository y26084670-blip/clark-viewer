import { createSignal } from "solid-js";
import { ObjectList } from "../components/ObjectList.jsx";
import { LineChart } from "../components/LineChart.jsx";
import { QuantitySelect } from "../components/QuantitySelect.jsx";
import { TimeSlider } from "../components/TimeSlider.jsx";
import { QUANTITIES } from "../services/results/resultMappings.js";
import { lineSeries } from "../services/results/resultPlots.js";
import { readObjectFrames, useAsyncResult } from "../services/results/resultRequests.js";

export function FieldLines(props) {
  const [quantityKey, setQuantity] = createSignal("Bs");
  const [component, setComponent] = createSignal("norm");
  const [direction, setDirection] = createSignal("i2");
  const records = () => props.task?.regions ?? [];
  const result = useAsyncResult(() => props.task && ({ task: props.task, quantityKey: quantityKey(), selected: props.regions, time: props.time, component: component(), direction: direction() }), async request => {
    const frames = await readObjectFrames(request);
    return frames.flatMap(({ frame, record }) => lineSeries(frame, record, QUANTITIES[request.quantityKey], request.component, request.direction));
  });
  return <div class="results-layout">
    <ObjectList title="Площадки" records={records()} selected={props.regions} onSelect={props.setRegions} />
    <section class="plot-panel">
      <div class="plot-toolbar"><QuantitySelect options={["Bs", "As"]} value={quantityKey()} onChange={setQuantity} component={component()} onComponentChange={setComponent} />
        <label>По оси X <select value={direction()} onChange={event => setDirection(event.currentTarget.value)}><option value="i1">i1</option><option value="i2">i2</option></select></label>
      </div>
      <div class="plot-status" role="status">{result.loading() ? "Чтение поля…" : result.error() || ""}</div>
      <LineChart series={result.value() ?? []} xLabel={`Номер узла ${direction()}`} integerX={true} yLabel={`${QUANTITIES[quantityKey()].label}, ${QUANTITIES[quantityKey()].unit}`} emptyText={result.error()} />
      <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep} onChange={props.setTime} />
    </section>
  </div>;
}
