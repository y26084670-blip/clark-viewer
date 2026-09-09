import { createMemo, Show } from "solid-js";
import { ObjectList } from "../components/ObjectList.jsx";
import { LineChart } from "../components/LineChart.jsx";
import { TimeSlider } from "../components/TimeSlider.jsx";
import { workingPointSeries } from "../services/results/resultPlots.js";
import { resultObjects, useAsyncResult } from "../services/results/resultRequests.js";
import { characteristicCurve, isAnisotropic, isFmm, loadFmmCharacteristic } from "../services/results/fmmCharacteristics.js";
import { buildGeometryTimeModel } from "../services/visualization/geometryTimeModel.js";

export function WorkingPoints(props) {
  const records = createMemo(() => (props.task?.elements ?? []).filter(isFmm));
  const selected = createMemo(() => records().filter(row => props.elements.includes(row.id)));
  const curves = useAsyncResult(() => props.task && ({ task: props.task, records: selected() }), async request => {
    const materials = await Promise.all(request.records.map(async record => {
      try {
        const source = await loadFmmCharacteristic(request.task, record.xapName);
        return { record, ...characteristicCurve(source, isAnisotropic(record)) };
      } catch (error) {
        return { record, error: `№${record.id}, ${record.xapName}: ${error.message}` };
      }
    }));
    const unique = new Map(), warnings = [];
    for (const item of materials) {
      if (item.error) { warnings.push(item.error); continue; }
      const key = JSON.stringify([item.record.xapName, item.reflected]);
      if (!unique.has(key)) unique.set(key, { name: item.record.xapName, points: item.points, ids: [] });
      unique.get(key).ids.push(item.record.id);
    }
    return { series: [...unique.values()].map(item => ({ label: `${item.name} · элементы ${item.ids.join(", ")}`,
      points: item.points, showLine: true, pointRadius: 0, borderWidth: 2 })), warnings };
  });
  const points = useAsyncResult(() => props.task && ({ task: props.task, records: selected(), time: props.time }), async request => {
    if (!request.records.length) return { series: [], warnings: [], count: 0 };
    const objects = resultObjects(request.task, "M").filter(item => request.records.some(r => r.id === item.record.id));
    const projection = buildGeometryTimeModel(request.task, request.task.moves, request.time);
    const results = await Promise.all(objects.map(async object => {
      try {
        if (isAnisotropic(object.record)) {
          const warning = projection.diagnostics.find(d => d.schemaId === "general"
            || (d.schemaId === "elements" && d.recordIndex === object.record.recordIndex));
          if (warning) throw new Error(warning.message);
        }
        const frame = await request.task.reader.read({ name: "MH", step: request.time, start: object.start, count: object.count });
        return { series: workingPointSeries(frame, object.record, projection.model.elements[object.record.recordIndex]) };
      } catch (error) { return { error: `№${object.record.id}: ${error.message}` }; }
    }));
    const series = results.filter(r => r.series).map(r => r.series);
    return { series, warnings: results.filter(r => r.error).map(r => r.error), count: series.reduce((n, s) => n + s.points.length, 0) };
  });
  const warnings = () => [curves.error(), points.error(), ...(curves.value()?.warnings ?? []), ...(points.value()?.warnings ?? [])].filter(Boolean).join(" · ");
  return <div class="results-layout">
    <ObjectList title="Элементы ФММ" records={records()} selected={props.elements} onSelect={props.setElements} />
    <section class="plot-panel">
      <div class="plot-toolbar"><strong>M(H)</strong><span>Изотропные ФММ: модули · Анизотропные: проекции на ось намагничивания</span></div>
      <div class="plot-status" role="status">{points.loading() || curves.loading() ? "Чтение рабочих точек и характеристик…" : `Рабочих точек: ${points.value()?.count ?? 0}`}
        <Show when={warnings()}><span> · {warnings()}</span></Show>
      </div>
      <LineChart series={[...(curves.value()?.series ?? []), ...(points.value()?.series ?? [])]}
        xLabel="H, кА/м" yLabel="M, кА/м" emptyText={warnings() || "Выберите элементы ФММ"} />
      <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep} onChange={props.setTime} />
    </section>
  </div>;
}
