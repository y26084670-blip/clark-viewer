import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { LineChart } from "../components/LineChart.jsx";
import { plotChannels, readPlotChannel, pairPlotChannels } from "../services/results/plotConstructor.js";
import { loadLatestOMChannels, readChannelSource } from "../services/results/omResultChannels.js";
import { useAsyncResult } from "../services/results/resultRequests.js";
import "./PlotConstructor.css";

export function PlotConstructor(props) {
  const [error, setError] = createSignal("");
  const sources = () => props.plotSources ?? [];
  const [adding, setAdding] = createSignal(false);
  const [x, setX] = createSignal({ key: "time", point: 1, component: "norm" });
  const [y, setY] = createSignal({ key: "", point: 1, component: "norm" });
  const latest = useAsyncResult(() => props.task, loadLatestOMChannels);
  const allSources = createMemo(() => [...(latest.value() ? [latest.value()] : []), ...sources()]);
  const channels = createMemo(() => plotChannels(props.task, allSources()));
  const byKey = key => channels().find(c => c.key === key);
  createEffect(() => { if (!y().key && channels().length > 1) setY({ ...y(), key: channels()[1].key }); });
  const label = c => c ? `${c.label}${c.unit ? `, ${c.unit}` : ""}` : "";
  const recipes = () => props.plotRecipes ?? [];
  async function addSource() {
    setError("");
    if (!window.showDirectoryPicker) { setError("Выбор каталога дополнительных результатов недоступен в этом браузере."); return; }
    setAdding(true);
    try {
      const directory = await window.showDirectoryPicker({ mode: "read" });
      const source = await readChannelSource(directory, props.task);
      props.setPlotSources([...sources(), source]);
    } catch (e) { if (e.name !== "AbortError") setError(e.message); }
    finally { setAdding(false); }
  }
  async function saveReport() {
    setError("");
    try {
      const file = await (await latest.value().directory.getFileHandle("report.html")).getFile();
      const url = URL.createObjectURL(file), link = document.createElement("a");
      link.href = url; link.download = "report.html"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) { setError(`HTML-протокол недоступен: ${e.message}`); }
  }
  function addPlot() {
    setError("");
    const a = byKey(x().key), b = byKey(y().key);
    if (!a || !b) { setError("Выберите X и Y."); return; }
    if (recipes().length >= 12) { setError("На вкладке допускается до 12 графиков."); return; }
    // Source objects are kept with the recipe, so selecting another extra file
    // never silently changes an existing plot.
    props.setPlotRecipes([...recipes(), { id: crypto.randomUUID(), x: { ...x() }, y: { ...y() },
      xChannel: a, yChannel: b, title: `${label(b)} / ${label(a)}` }]);
  }
  function AxisPicker(p) {
    const spec = () => p.get(), c = () => byKey(spec().key);
    return <fieldset><legend>{p.title}</legend>
      <label>Величина<select value={spec().key} onChange={e => p.set({ ...spec(), key: e.currentTarget.value, point: 1 })}>
        <option value="">Выберите величину</option><For each={channels()}>{item => <option value={item.key}>{label(item)}</option>}</For>
      </select></label>
      <Show when={c()?.kind === "field"}><label>Точка в файле результата
        <input type="number" min="1" max={c()?.points} value={spec().point} onInput={e => p.set({ ...spec(), point: e.currentTarget.value })} /> из {c()?.points}
      </label></Show>
      <Show when={c()?.components === 3 && !c()?.productOffsets}><label>Компонента
        <select value={spec().component} onChange={e => p.set({ ...spec(), component: e.currentTarget.value })}>
          <option value="norm">Модуль</option><option value="0">X</option><option value="1">Y</option><option value="2">Z</option>
        </select></label></Show>
    </fieldset>;
  }
  function Plot(p) {
    const data = useAsyncResult(() => ({ task: props.task, recipe: p.recipe }), async ({ task, recipe }) => {
      const [a, b] = await Promise.all([readPlotChannel(task, recipe.xChannel, recipe.x), readPlotChannel(task, recipe.yChannel, recipe.y)]);
      return [{ label: recipe.title, points: pairPlotChannels(a, b), tooltip: point => [
        `t = ${point.time} с; шаг ${point.step}`, `X = ${point.x}`, `Y = ${point.y}`] }];
    });
    return <section class="plot-panel constructor-plot"><LineChart series={data.value() ?? []}
      marker={{ points: (data.value()?.[0]?.points ?? []).filter(p => p.step === props.time) }}
      xLabel={label(p.recipe.xChannel)} yLabel={label(p.recipe.yChannel)}
      emptyText={data.loading() ? "Чтение результатов…" : data.error() || "Нет общих шагов"} status={data.error()}
      toolbar={<strong>{p.recipe.title}</strong>}
      toolbarEnd={<button type="button" onClick={() => props.setPlotRecipes(recipes().filter(r => r.id !== p.recipe.id))}>Удалить график</button>} />
    </section>;
  }
  return <div class="plot-constructor">
    <div class="constructor-controls"><AxisPicker title="Ось X" get={x} set={setX} /><AxisPicker title="Ось Y" get={y} set={setY} />
      <div class="constructor-actions"><button type="button" onClick={addPlot}>Добавить график</button>
        <button type="button" disabled={adding()} onClick={addSource}>Добавить параметры ОМ…</button>
        <Show when={latest.value()}><button type="button" onClick={saveReport}>Сохранить HTML-протокол</button></Show></div>
    </div>
    <Show when={error() || latest.error()}><p class="constructor-error" role="alert">{error() || latest.error()}</p></Show>
    <For each={allSources().filter(s => s.warning)}>{s => <p role="status">{s.warning}</p>}</For>
    <p class="constructor-hint">Величины сопоставляются по общим сохранённым шагам времени. Порядок точек сохраняет ход процесса; интерполяция не выполняется.</p>
    <div class="constructor-plots"><For each={recipes()} fallback={<p>Выберите величины для осей и добавьте график.</p>}>{recipe => <Plot recipe={recipe} />}</For></div>
  </div>;
}
