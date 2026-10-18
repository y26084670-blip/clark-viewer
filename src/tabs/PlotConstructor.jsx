import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { LineChart } from "../components/LineChart.jsx";
import { TimeSlider } from "../components/TimeSlider.jsx";
import { plotChannels, plotChannelLabel, readPlotCurves, validatePlotCurve } from "../services/results/plotConstructor.js";
import { loadLatestOMChannels, readChannelSource } from "../services/results/omResultChannels.js";
import { useAsyncResult } from "../services/results/resultRequests.js";
import { completedMovieFrame, createMovieTabAdapter } from "../services/movie/movieTabAdapter.js";
import "./PlotConstructor.css";

export function PlotConstructor(props) {
  const [error, setError] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [sourceError, setSourceError] = createSignal("");
  const [localActive, setLocalActive] = createSignal(null);
  const [x, setX] = createSignal({ key: "time", point: 1, component: "norm" });
  const [y, setY] = createSignal({ key: "", point: 1, component: "norm" });
  let sourceDialog, sourceButton, disposed = false;
  const sources = () => props.plotSources ?? [];
  const recipes = () => props.plotRecipes ?? [];
  const activeId = () => props.activePlotId ?? localActive();
  const setActiveId = id => (props.setActivePlotId ?? setLocalActive)(id);
  const latest = useAsyncResult(() => props.task, loadLatestOMChannels);
  const allSources = createMemo(() => [...(latest.value() ? [latest.value()] : []), ...sources()]);
  const channels = createMemo(() => plotChannels(props.task, allSources()));
  const byKey = key => channels().find(c => c.key === key);
  const label = c => c ? `${c.label}${c.unit ? `, ${c.unit}` : ""}` : "";
  const activeRecipe = () => recipes().find(r => r.id === activeId());
  createEffect(() => { if (!y().key && channels().length > 1) setY({ ...y(), key: channels()[1].key }); });
  createEffect(() => {
    if (!recipes().some(r => r.id === activeId())) setActiveId(recipes().at(-1)?.id ?? null);
  });
  onCleanup(() => { disposed = true; });

  function chooseSource() {
    setError(""); setSourceError("");
    if (!window.showDirectoryPicker) { setError("Выбор каталога дополнительных результатов недоступен в этом браузере."); return; }
    sourceDialog.showModal();
  }
  async function addSource() {
    setSourceError(""); setAdding(true);
    const task = props.task;
    try {
      const directory = await window.showDirectoryPicker({ mode: "read", id: "clark-om-results",
        startIn: latest.value()?.directory ?? task.handle });
      const source = await readChannelSource(directory, task);
      if (disposed || props.task !== task) return;
      props.setPlotSources([...sources(), source]);
      sourceDialog.close();
    } catch (e) { if (!disposed && e.name !== "AbortError") setSourceError(`Каталог не подключён: ${e.message}`); }
    finally { if (!disposed) setAdding(false); }
  }
  async function saveReport() {
    setError("");
    try {
      const file = await (await latest.value().directory.getFileHandle("report.html")).getFile();
      const url = URL.createObjectURL(file), link = document.createElement("a");
      link.href = url; link.download = "report.html"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) { if (!disposed) setError(`HTML-протокол недоступен: ${e.message}`); }
  }
  function addPlotOrCurve(append) {
    setError("");
    if (props.movieBusy) return;
    try {
      const target = append ? activeRecipe() : null;
      if (append && !target) throw new Error("Сначала добавьте график или выберите существующий щелчком по его полю.");
      if (!append && recipes().length >= 12) throw new Error("На вкладке допускается до 12 графиков.");
      // Keep the exact source objects; later imports must not replace a curve's data.
      const curve = validatePlotCurve({ id: crypto.randomUUID(), x: { ...x() }, y: { ...y() },
        xChannel: byKey(x().key), yChannel: byKey(y().key) }, target?.curves[0]);
      if (target) props.setPlotRecipes(recipes().map(r => r.id === target.id ? { ...r, curves: [...r.curves, curve] } : r));
      else {
        const id = crypto.randomUUID();
        props.setPlotRecipes([...recipes(), { id, curves: [curve] }]);
        setActiveId(id);
      }
    } catch (e) { setError(e.message); }
  }
  function removeCurve(plot, id) {
    if (props.movieBusy) return;
    const curves = plot.curves.filter(curve => curve.id !== id);
    props.setPlotRecipes(curves.length ? recipes().map(r => r.id === plot.id ? { ...r, curves } : r)
      : recipes().filter(r => r.id !== plot.id));
  }
  function AxisPicker(p) {
    const spec = () => p.get(), c = () => byKey(spec().key);
    return <fieldset><legend>{p.title}</legend>
      <label>Величина<select value={spec().key} title="Выберите стандартную величину результата или подключённый параметр ОМ"
        onChange={e => p.set({ ...spec(), key: e.currentTarget.value, point: 1 })}>
        <option value="" selected={!spec().key}>Выберите величину</option><For each={channels()}>{item => <option value={item.key} selected={spec().key === item.key}>{label(item)}</option>}</For>
      </select></label>
      <Show when={c()?.kind === "field"}><label>Точка в файле результата
        <input type="number" min="1" max={c()?.points} value={spec().point}
          title="Порядковый номер сохранённой точки в файле результата, начиная с 1; это не номер элемента или области"
          onInput={e => p.set({ ...spec(), point: e.currentTarget.value })} /> из {c()?.points}
      </label></Show>
      <Show when={c()?.components === 3 && !c()?.productOffsets}><label>Компонента
        <select value={spec().component} title="Модуль вектора или одна из знаковых компонент X, Y, Z"
          onChange={e => p.set({ ...spec(), component: e.currentTarget.value })}>
          <option value="norm">Модуль</option><option value="0">X</option><option value="1">Y</option><option value="2">Z</option>
        </select></label></Show>
    </fieldset>;
  }
  function Plot(p) {
    const emptyRecipe = { id: p.id, curves: [] };
    const recipe = createMemo(() => recipes().find(r => r.id === p.id) ?? emptyRecipe);
    const number = () => recipes().findIndex(r => r.id === p.id) + 1;
    const [renderer, setRenderer] = createSignal(null);
    const data = useAsyncResult(() => ({ task: props.task, curves: recipe().curves }),
      ({ task, curves }) => readPlotCurves(task, curves));
    // Keep existing dataset objects (and their visibility) while an added
    // curve is loading. A new task must never inherit the preceding data.
    const displayed = createMemo(previous => {
      const state = data.state();
      if (state.frame) return { task: state.frame.request.task, series: state.frame.value.series };
      return state.loading && previous?.task === props.task ? previous : null;
    });
    const series = createMemo(() => {
      const ids = new Set(recipe().curves.map(curve => curve.id));
      return (displayed()?.series ?? []).filter(item => ids.has(item.key));
    });
    const failure = () => data.error() || data.value()?.error || "";
    const frameKey = createMemo(() => ({ frame: data.state().frame, time: props.time }));
    const axisLabel = axis => {
      const labels = [...new Set(recipe().curves.map(curve => plotChannelLabel(curve[`${axis}Channel`], curve[axis])))];
      if (labels.length === 1) return labels[0];
      const unit = recipe().curves[0]?.[`${axis}Channel`].unit;
      return `${axis.toUpperCase()}${unit ? `, ${unit}` : ""} (величины указаны в легенде)`;
    };
    function ActiveMovie() {
      const movie = createMovieTabAdapter(props, { title: "Графики", filenamePrefix: "graphs", readFrame: index => {
        const current = completedMovieFrame(data.state(), { task: props.task, index, timed: false });
        if (!current.ready) return current;
        if (failure()) return { error: failure() };
        if (!series().length) return { error: "Нет кривых для записи" };
        if (series().some(item => !item.points.some(point => point.step === index))) return { error: `У кривых нет общего сохранённого шага ${index}` };
        return frameKey().time === index ? { ready: true, value: frameKey() } : { ready: false };
      } });
      createEffect(() => movie.onCaptureReady(renderer()));
      return null;
    }
    return <section class="plot-panel constructor-plot" classList={{ "constructor-plot-active": activeId() === p.id }}
      tabIndex="0" aria-label={`График ${number()}${activeId() === p.id ? ", активный" : ""}`}
      onPointerDown={() => !props.movieBusy && setActiveId(p.id)} onFocusIn={() => !props.movieBusy && setActiveId(p.id)}>
      <Show when={activeId() === p.id}><ActiveMovie /></Show>
      <LineChart series={series()} autoScaleToggle={true} legendMode="overlay"
        marker={{ points: series().flatMap(item => item.points.filter(point => point.step === props.time)) }}
        captureFrameKey={frameKey()} onCaptureReady={target => setRenderer(() => target)} captureError={failure()}
        tableUnavailableReason={data.loading() ? "Дождитесь загрузки всех кривых графика" : failure()}
        xLabel={axisLabel("x")} yLabel={axisLabel("y")}
        emptyText={data.loading() ? "Чтение результатов…" : failure() || "Нет общих шагов"} status={data.loading() ? "Чтение результатов…" : failure()}
        toolbar={<strong title="Щёлкните по графику, чтобы добавлять кривые в него и записывать его в GIF">График {number()}{activeId() === p.id ? " · активный" : ""}</strong>}
        toolbarEnd={<button type="button" title="Удалить этот график со всеми его кривыми; файлы результатов сохраняются"
          onClick={() => !props.movieBusy && props.setPlotRecipes(recipes().filter(r => r.id !== p.id))}>Удалить график</button>} />
      <details class="constructor-curves"><summary title="Посмотреть состав графика или удалить отдельную кривую">Кривые: {recipe().curves.length}</summary>
        <For each={recipe().curves}>{(curve, index) => <div><span>{index() + 1}. {plotChannelLabel(curve.yChannel, curve.y)} / {plotChannelLabel(curve.xChannel, curve.x)}</span>
          <button type="button" title="Удалить эту кривую; удаление последней кривой закрывает график"
            aria-label={`Удалить кривую ${index() + 1}`} onClick={() => removeCurve(recipe(), curve.id)}>×</button></div>}</For>
      </details>
    </section>;
  }
  return <div class="plot-constructor">
    <div class="constructor-controls"><AxisPicker title="Ось X" get={x} set={setX} /><AxisPicker title="Ось Y" get={y} set={setY} />
      <div class="constructor-actions"><button type="button" title="Создать отдельный график выбранной зависимости Y(X) и сделать его активным"
        onClick={() => addPlotOrCurve(false)}>Добавить график</button>
        <button type="button" disabled={!activeRecipe()} title="Добавить выбранную зависимость Y(X) в график с выделенной рамкой. Выберите график щелчком; единицы обеих осей должны совпадать"
          onClick={() => addPlotOrCurve(true)}>Добавить кривую</button>
        <button ref={sourceButton} type="button" disabled={adding()}
          title="Подключить дополнительные величины из каталога выполненного ОМ-расчёта: results.json и таблица TSV. Сначала откроется пояснение, затем выбор каталога"
          onClick={chooseSource}>Добавить параметры ОМ…</button>
        <Show when={latest.value()}><button type="button" title="Скачать report.html последнего успешного ОМ-расчёта: результаты модели и сходимость решателя"
          onClick={saveReport}>Сохранить HTML-протокол</button></Show></div>
    </div>
    <Show when={error() || latest.error()}><p class="constructor-error" role="alert">{error() || latest.error()}</p></Show>
    <For each={allSources().filter(s => s.warning)}>{s => <p role="status">{s.warning}</p>}</For>
    <p class="constructor-hint">Щелчок по графику выбирает его для добавления кривых и записи GIF. Величины сопоставляются по общим сохранённым шагам времени, без интерполяции.</p>
    <div class="constructor-plots"><For each={recipes().map(recipe => recipe.id)} fallback={<p>Выберите величины для осей и добавьте график.</p>}>{id => <Plot id={id} />}</For></div>
    <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep} onChange={props.setTime} />
    <dialog ref={sourceDialog} class="constructor-source-dialog" aria-label="Добавление параметров ОМ"
      onCancel={event => { if (adding()) event.preventDefault(); }} onClose={() => sourceButton?.focus()}>
      <h3>Добавление параметров ОМ</h3>
      <p>Выберите каталог <strong>одного выполненного расчёта</strong>, например <code>outputOM/run-…</code> внутри задания.</p>
      <p>В каталоге должны находиться <code>results.json</code> с описанием величин и указанная в нём таблица TSV. Для старых результатов поддерживаются <code>run.json</code> и <code>currents.tsv</code>.</p>
      <p>После подключения величины появятся в списках осей X и Y. Последний успешный ОМ-расчёт этого задания подключается автоматически.</p>
      <Show when={sourceError()}><p role="alert">{sourceError()}</p></Show>
      <div><button type="button" disabled={adding()} title="Открыть системный выбор каталога с описанием и таблицей результатов ОМ" onClick={addSource}>Выбрать каталог…</button>
        <button type="button" disabled={adding()} title="Закрыть пояснение без подключения результатов" onClick={() => sourceDialog.close()}>Отмена</button></div>
    </dialog>
  </div>;
}
