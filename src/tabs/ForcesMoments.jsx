import { createMemo, createSignal } from "solid-js";
import { LineChart } from "../components/LineChart.jsx";
import { useAsyncResult } from "../services/results/resultRequests.js";
import { HISTORY_QUANTITIES, readForceMomentHistory, forceMomentHistorySeries,
  readLossHistory, lossHistorySeries } from "../services/results/resultHistories.js";

export function ForcesMoments(props) {
  const [quantity, setQuantity] = createSignal("force");
  const family = createMemo(() => HISTORY_QUANTITIES[quantity()].file);
  // Силы/моменты делят одну историю FM; Q читается только для режима потерь.
  // Готовые истории текущего задания сохраняются при смене переключателя.
  let historyTask;
  const histories = new Map();
  const result = useAsyncResult(() => props.task ? { task: props.task, family: family() } : null,
    async ({ task, family }) => {
      if (task !== historyTask) { histories.clear(); historyTask = task; }
      let pending = histories.get(family);
      if (!pending) {
        pending = family === "Q" ? readLossHistory(task) : readForceMomentHistory(task);
        histories.set(family, pending);
      }
      try { return { family, history: await pending }; }
      catch (error) {
        if (task === historyTask && histories.get(family) === pending) histories.delete(family);
        throw error;
      }
    });
  const plot = createMemo(() => {
    const value = result.value();
    if (!value || value.family !== family()) return { series: [], error: "" };
    try {
      if (quantity() === "loss") return {
        series: [lossHistorySeries(value.history, props.task.general.timeStep)], error: "",
      };
      const series = ["norm", "0", "1", "2"].map(component => ({
        ...forceMomentHistorySeries(value.history, props.task.general.timeStep, quantity(), component),
        legendLabel: component === "norm" ? "Модуль" : `Компонента ${"XYZ"[Number(component)]}`,
      }));
      return { series, error: "" };
    } catch (error) { return { series: [], error: error.message }; }
  });
  const error = () => result.error() || plot().error;
  const reading = () => quantity() === "loss" ? "Чтение потерь…" : "Чтение сил и моментов…";
  return <div class="results-layout">
    <section class="plot-panel">
      <LineChart series={plot().series} xLabel="Время, с" legendMode="overlay"
        yLabel={`${HISTORY_QUANTITIES[quantity()].label}, ${HISTORY_QUANTITIES[quantity()].unit}`}
        toolbar={<>
          <label><input type="radio" name="force-moment" checked={quantity() === "force"} onChange={() => setQuantity("force")} />Силы</label>
          <label><input type="radio" name="force-moment" checked={quantity() === "moment"} onChange={() => setQuantity("moment")} />Моменты</label>
          <label><input type="radio" name="force-moment" checked={quantity() === "loss"} onChange={() => setQuantity("loss")} />Потери</label>
        </>}
        toolbarEnd={result.loading() ? <span role="status">{reading()}</span> : null}
        status={error()} emptyText={result.loading() ? reading() : error()
          || (quantity() === "loss" ? "Нет сохранённых потерь" : "Нет сохранённых сил и моментов")} />
    </section>
  </div>;
}
