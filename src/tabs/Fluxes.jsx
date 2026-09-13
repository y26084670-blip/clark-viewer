import { createMemo } from "solid-js";
import { ObjectList } from "../components/ObjectList.jsx";
import { LineChart } from "../components/LineChart.jsx";
import { useAsyncResult } from "../services/results/resultRequests.js";
import { HISTORY_QUANTITIES, measurementCoils, readFluxHistories, fluxHistorySeries } from "../services/results/resultHistories.js";

export function Fluxes(props) {
  const catalog = createMemo(() => {
    try { return { records: measurementCoils(props.task), error: "" }; }
    catch (error) { return { records: [], error: error.message }; }
  });
  // A null selection chooses the first coil in a newly loaded task; [] means
  // the user explicitly cleared the list. App preserves selection across tabs.
  const selected = () => props.coils ?? catalog().records.slice(0, 1).map(record => record.id);
  const result = useAsyncResult(() => props.task && ({ task: props.task, selected: selected(), error: catalog().error }), async request => {
    if (request.error) throw new Error(request.error);
    const histories = await readFluxHistories(request);
    return histories.map(item => fluxHistorySeries(item, request.task.general.timeStep));
  });
  const emptyText = () => result.loading() ? "Чтение потокосцеплений…" : result.error()
    || (catalog().records.length ? "Выберите измерительные катушки" : "В задании нет измерительных катушек");
  return <div class="results-layout">
    <ObjectList title="Измерительные катушки" records={catalog().records} selected={selected()} onSelect={props.setCoils} />
    <section class="plot-panel">
      <LineChart series={result.value() ?? []} xLabel="Время, с"
        yLabel={`${HISTORY_QUANTITIES.flux.label}, ${HISTORY_QUANTITIES.flux.unit}`}
        toolbar={<strong>Потокосцепление</strong>}
        toolbarEnd={result.loading() ? <span role="status">Чтение потокосцеплений…</span> : null}
        status={result.error()} emptyText={emptyText()} />
    </section>
  </div>;
}
