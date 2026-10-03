import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { ObjectList } from "../components/ObjectList.jsx";
import { SurfaceChart } from "../components/SurfaceChart.jsx";
import { QuantitySelect } from "../components/QuantitySelect.jsx";
import { TimeSlider } from "../components/TimeSlider.jsx";
import { QUANTITIES, regionLayout } from "../services/results/resultMappings.js";
import { readSurfaceFrame, useResultFrame } from "../services/results/resultRequests.js";
import { completedMovieFrame, createMovieTabAdapter } from "../services/movie/movieTabAdapter.js";

export function FieldAreas(props) {
  const [quantityKey, setQuantity] = createSignal("Bs");
  const [component, setComponent] = createSignal("norm"), [copy, setCopy] = createSignal(0);
  const records = () => props.task?.regions ?? [];
  const record = createMemo(() => records().find(row => props.regions.includes(row.id)));
  const layout = createMemo(() => record() ? regionLayout(record()) : null);
  createEffect(() => { record(); setCopy(0); });
  const result = useResultFrame(() => props.task && record() && ({ task: props.task, quantityKey: quantityKey(), selected: [record().id],
    time: props.time, component: component(), copy: copy() }), readSurfaceFrame);
  const displayed = createMemo(() => result().frame);
  const grid = createMemo(() => displayed()?.value ?? null);
  const status = () => {
    const frame = displayed();
    const message = result().loading ? "Чтение поля…" : result().error || frame?.value.title || "Выберите площадку";
    return frame ? `${message} · показан шаг ${frame.request.time}` : message;
  };
  const movie = createMovieTabAdapter(props, { title: "Поле в областях", readFrame: index =>
    record() ? completedMovieFrame(result(), { task: props.task, index }) : { error: "Выберите площадку" } });
  return <div class="results-layout">
    <ObjectList title="Площадки" records={records()} selected={record() ? [record().id] : []} onSelect={props.setRegions} multiple={false} />
    <section class="plot-panel">
      <div class="plot-toolbar"><QuantitySelect options={["Bs", "As"]} value={quantityKey()} onChange={setQuantity} component={component()} onComponentChange={setComponent} />
        <Show when={layout()?.copies > 1}><label>LS <input type="number" min="1" max={layout()?.copies ?? 1} step="1" value={copy() + 1}
          onChange={event => setCopy(event.currentTarget.valueAsNumber - 1)} /></label></Show>
      </div>
      <div class="plot-status" role="status">{status()}</div>
      <SurfaceChart grid={grid()} label={QUANTITIES[quantityKey()].label} unit={QUANTITIES[quantityKey()].unit} emptyText={result().error}
        captureFrameKey={displayed()} onCaptureReady={movie.onCaptureReady} />
      <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep} onChange={props.setTime} />
    </section>
  </div>;
}
