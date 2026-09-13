import { createMemo, createSignal } from "solid-js";
import { LineChart } from "../components/LineChart.jsx";
import { useAsyncResult } from "../services/results/resultRequests.js";
import { HISTORY_QUANTITIES, readForceMomentHistory, forceMomentHistorySeries } from "../services/results/resultHistories.js";

export function ForcesMoments(props) {
  const [quantity, setQuantity] = createSignal("force");
  const [component, setComponent] = createSignal("norm");
  const result = useAsyncResult(() => props.task, readForceMomentHistory);
  // Switching the displayed vector/component reuses the loaded history.
  const plot = createMemo(() => {
    if (!result.value()) return { series: [], error: "" };
    try {
      return { series: [forceMomentHistorySeries(result.value(), props.task.general.timeStep, quantity(), component())], error: "" };
    } catch (error) { return { series: [], error: error.message }; }
  });
  const error = () => result.error() || plot().error;
  return <div class="results-layout">
    <section class="plot-panel">
      <LineChart series={plot().series} xLabel="Время, с"
        yLabel={`${HISTORY_QUANTITIES[quantity()].label}, ${HISTORY_QUANTITIES[quantity()].unit}`}
        toolbar={<>
          <label><input type="radio" name="force-moment" checked={quantity() === "force"} onChange={() => setQuantity("force")} />Силы</label>
          <label><input type="radio" name="force-moment" checked={quantity() === "moment"} onChange={() => setQuantity("moment")} />Моменты</label>
          <label>Показать <select value={component()} onChange={event => setComponent(event.currentTarget.value)}>
            <option value="norm">Модуль</option>
            <option value="0">Компонента X</option>
            <option value="1">Компонента Y</option>
            <option value="2">Компонента Z</option>
          </select></label>
        </>}
        toolbarEnd={result.loading() ? <span role="status">Чтение сил и моментов…</span> : null}
        status={error()} emptyText={result.loading() ? "Чтение сил и моментов…" : error() || "Нет сохранённых сил и моментов"} />
    </section>
  </div>;
}
