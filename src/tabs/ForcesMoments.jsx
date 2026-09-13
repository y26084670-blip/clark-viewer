import { createMemo, createSignal } from "solid-js";
import { LineChart } from "../components/LineChart.jsx";
import { useAsyncResult } from "../services/results/resultRequests.js";
import { HISTORY_QUANTITIES, readForceMomentHistory, forceMomentHistorySeries } from "../services/results/resultHistories.js";

export function ForcesMoments(props) {
  const [quantity, setQuantity] = createSignal("force");
  const result = useAsyncResult(() => props.task, readForceMomentHistory);
  // All four curves reuse the same saved history, including on force/moment changes.
  const plot = createMemo(() => {
    if (!result.value()) return { series: [], error: "" };
    try {
      const series = ["norm", "0", "1", "2"].map(component => ({
        ...forceMomentHistorySeries(result.value(), props.task.general.timeStep, quantity(), component),
        legendLabel: component === "norm" ? "Модуль" : `Компонента ${"XYZ"[Number(component)]}`,
      }));
      return { series, error: "" };
    } catch (error) { return { series: [], error: error.message }; }
  });
  const error = () => result.error() || plot().error;
  return <div class="results-layout">
    <section class="plot-panel">
      <LineChart series={plot().series} xLabel="Время, с" legendMode="overlay"
        yLabel={`${HISTORY_QUANTITIES[quantity()].label}, ${HISTORY_QUANTITIES[quantity()].unit}`}
        toolbar={<>
          <label><input type="radio" name="force-moment" checked={quantity() === "force"} onChange={() => setQuantity("force")} />Силы</label>
          <label><input type="radio" name="force-moment" checked={quantity() === "moment"} onChange={() => setQuantity("moment")} />Моменты</label>
        </>}
        toolbarEnd={result.loading() ? <span role="status">Чтение сил и моментов…</span> : null}
        status={error()} emptyText={result.loading() ? "Чтение сил и моментов…" : error() || "Нет сохранённых сил и моментов"} />
    </section>
  </div>;
}
