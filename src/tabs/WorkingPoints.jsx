import { createMemo, createSignal, Show } from "solid-js";
import { ObjectList } from "../components/ObjectList.jsx";
import { LineChart } from "../components/LineChart.jsx";
import { TimeSlider } from "../components/TimeSlider.jsx";
import { QUANTITIES, sourceRecords } from "../services/results/resultMappings.js";
import { scalarAt } from "../services/results/resultPlots.js";
import { resultObjects, useAsyncResult } from "../services/results/resultRequests.js";

export function WorkingPoints(props) {
  const [mode, setMode] = createSignal("MH");
  const [component, setComponent] = createSignal("norm");
  const [point, setPoint] = createSignal(1);
  const pair = () => mode() === "MH" ? ["H", "M"] : mode() === "JE" ? ["E", "J"] : [null, mode()];
  const quantityKey = () => pair()[1];
  const records = createMemo(() => props.task ? sourceRecords(props.task, QUANTITIES[quantityKey()].file)
    .filter(row => !(mode() === "MH" || mode() === "JE") || row.targ === 0) : []);
  const result = useAsyncResult(() => props.task && ({ task: props.task, selected: props.elements,
    mode: mode(), component: component(), point: point() }), async request => {
    const pair = request.mode === "MH" ? ["H", "M"] : request.mode === "JE" ? ["E", "J"] : [null, request.mode];
    const y = QUANTITIES[pair[1]], x = pair[0] ? QUANTITIES[pair[0]] : null;
    const objects = resultObjects(request.task, pair[1]).filter(item => request.selected.includes(item.record.id)
      && (!x || item.record.targ === 0));
    if (!objects.length) throw new Error("Выберите элемент с рассчитанными рабочими точками");
    const histories = await Promise.all(objects.map(async object => {
      if (!Number.isSafeInteger(request.point) || request.point < 1 || request.point > object.count) throw new Error(`Элемент №${object.record.id}: номер ЭО должен быть от 1 до ${object.count}`);
      const history = await request.task.reader.history({ name: y.file, point: object.start + request.point - 1 });
      return { label: `№${object.record.id} ${object.record.name} · ЭО ${request.point}`, steps: history.steps,
        points: history.steps.map((step, i) => ({ x: x ? scalarAt(history, i, x, request.component) : step * request.task.general.timeStep,
          y: scalarAt(history, i, y, request.component) })) };
    }));
    return histories;
  });
  const marker = createMemo(() => ({ points: (result.value() ?? []).flatMap(series => {
    const i = series.steps.indexOf(props.time); return i >= 0 ? [series.points[i]] : [];
  }) }));
  const label = key => key ? `${QUANTITIES[key].label}, ${QUANTITIES[key].unit}` : "Время, с";
  return <div class="results-layout">
    <ObjectList title="Элементы" records={records()} selected={props.elements} onSelect={props.setElements} />
    <section class="plot-panel">
      <div class="plot-toolbar">
        <label>График <select value={mode()} onChange={event => { setMode(event.currentTarget.value); setPoint(1); }}>
          <option value="MH">M(H)</option><option value="JE">J(E)</option><option value="M">M(t)</option><option value="H">H(t)</option>
          <option value="J">J(t)</option><option value="E">E(t)</option>
        </select></label>
        <label>Компонента <select value={component()} onChange={event => setComponent(event.currentTarget.value)}>
          <option value="norm">Модуль</option><option value="0">X</option><option value="1">Y</option><option value="2">Z</option>
        </select></label>
        <label>ЭО <input type="number" min="1" step="1" value={point()} onChange={event => setPoint(event.currentTarget.valueAsNumber)} /></label>
      </div>
      <div class="plot-status" role="status">{result.loading() ? "Чтение истории…" : result.error() || "Текущий момент отмечен на кривых"}
        <Show when={result.value() && !marker().points.length}><span> · для выбранного момента данных нет</span></Show>
      </div>
      <LineChart series={result.value() ?? []} marker={marker()} xLabel={label(pair()[0])} yLabel={label(pair()[1])} emptyText={result.error()} />
      <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep} onChange={props.setTime} />
    </section>
  </div>;
}
