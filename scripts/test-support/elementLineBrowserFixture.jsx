import { render } from "solid-js/web";
import { createSignal, Show } from "solid-js";
import { Chart } from "chart.js";
import { PlotConstructor } from "../../src/tabs/PlotConstructor.jsx";
import { ResultService } from "../../src/services/resultService.js";
import "../../src/App.css";

const service = new ResultService();
const metadata = await service.open({ JE: await (await fetch("./JE.h5")).blob() });
const reads = [];
const task = { name: "Профиль", plotLabel: "Проверка/Профиль", elements: window.__lineElements,
  regions: [], general: { countTimeSteps: 5, timeStep: .25 }, metadata,
  handle: { getDirectoryHandle: async () => { throw new DOMException("No OM", "NotFoundError"); } },
  reader: { read: request => { reads.push(request); return service.read(request); }, history: request => service.history(request) } };

function Fixture() {
  const [recipes, setPlotRecipes] = createSignal([]), [sources, setPlotSources] = createSignal([]);
  const [active, setActivePlotId] = createSignal(null), [time, setTime] = createSignal(0), [shown, setShown] = createSignal(true);
  const [entries, setEntries] = createSignal({});
  let movieAdapter = null;
  const charts = () => [...document.querySelectorAll(".constructor-plot canvas")].map(canvas => Chart.getChart(canvas));
  window.__line = { setShown, setTime, reads, entries,
    legendPoint: () => {
      const chart = charts()[0], area = chart.chartArea, bounds = chart.canvas.getBoundingClientRect();
      chart.ctx.save(); chart.ctx.font = "12px Arial, sans-serif";
      const width = Math.min(area.width - 12, 33 + Math.max(...chart.data.datasets.map(d => chart.ctx.measureText(d.label).width)));
      chart.ctx.restore();
      return { x: bounds.left + (area.right - 6 - width + 40) * bounds.width / chart.width,
        y: bounds.top + (area.top + 22) * bounds.height / chart.height };
    },
    snapshot: () => ({ time: time(), movie: !!movieAdapter, active: active(),
      recipes: recipes().map(r => ({ id: r.id, count: r.curves.length })),
      plots: charts().map(chart => ({ id: chart.id, area: { ...chart.chartArea },
        visible: chart.data.datasets.map((_, i) => chart.isDatasetVisible(i)),
        series: chart.data.datasets.filter(d => d._seriesKey !== "marker").map(d => d.data),
        labels: chart.data.datasets.map(d => d.label), xLabel: chart.options.scales.x.title.text,
        xmin: chart.scales.x.min, xmax: chart.scales.x.max, canvas: chart.canvas.getBoundingClientRect().toJSON() })) }),
    close: () => service.close() };
  return <div class="app-container"><h1>Графики · профиль по центрам ЭО</h1><main class="tabs-body">
    <Show when={shown()}><PlotConstructor task={task} time={time()} setTime={setTime}
      plotRecipes={recipes()} setPlotRecipes={setPlotRecipes} plotSources={sources()} setPlotSources={setPlotSources}
      activePlotId={active()} setActivePlotId={setActivePlotId} protocolEntries={entries()}
      setProtocolEntry={(key, entry) => setEntries(previous => ({ ...previous, [key]: entry }))}
      registerMovieAdapter={adapter => { movieAdapter = adapter; return () => { if (movieAdapter === adapter) movieAdapter = null; }; }}
    /></Show>
  </main></div>;
}
render(() => <Fixture />, document.getElementById("root"));
