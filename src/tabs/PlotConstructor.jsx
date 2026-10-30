import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { LineChart } from "../components/LineChart.jsx";
import { ProtocolCheck } from "../components/protocol/ProtocolCheck.jsx";
import { captureProtocolRenderer } from "../services/protocol/protocolCapture.js";
import { TimeSlider } from "../components/TimeSlider.jsx";
import { plotChannels, plotAxisLabel, plotCurveLabel, plotPointAtStep, readPlotCurves, validatePlotCurve, expandPlotComponents, isSingleTimePlot, singleTimePlotTable } from "../services/results/plotConstructor.js";
import { listPlotTasks } from "../services/results/plotTaskSources.js";
import { loadLatestOMChannels, readChannelSource } from "../services/results/omResultChannels.js";
import { useAsyncResult } from "../services/results/resultRequests.js";
import { completedMovieFrame, createMovieTabAdapter } from "../services/movie/movieTabAdapter.js";
import "./PlotConstructor.css";

export function PlotConstructor(props) {
  const [error, setError] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [sourceError, setSourceError] = createSignal("");
  const [localActive, setLocalActive] = createSignal(null);
  const [x, setX] = createSignal({ key: "time", point: 1 });
  const [y, setY] = createSignal({ key: "", point: 1 });
  const [taskMode, setTaskMode] = createSignal("current");
  let sourceDialog, sourceButton, panel, disposed = false;
  const sources = () => props.plotSources ?? [];
  const recipes = () => props.plotRecipes ?? [];
  const activeId = () => props.activePlotId ?? localActive();
  const setActiveId = id => (props.setActivePlotId ?? setLocalActive)(id);
  const latest = useAsyncResult(() => props.task, loadLatestOMChannels);
  const allSources = createMemo(() => [...(latest.value() ? [latest.value()] : []), ...sources()]);
  const channels = createMemo(() => plotChannels(props.task, allSources()));
  const taskList = useAsyncResult(() => taskMode() === "other" ? props.plotRoot : null, listPlotTasks);
  const selectedTask = () => taskMode() === "other" ? props.plotTaskSource?.task : props.task;
  const sourceReady = () => Boolean(selectedTask()) && !(taskMode() === "other" && props.plotTaskSource?.loading);
  const yChannels = createMemo(() => taskMode() === "other"
    ? selectedTask() ? plotChannels(selectedTask(), selectedTask().plotSources) : [] : channels());
  const byKey = (key, axis = "x") => (axis === "y" ? yChannels() : channels()).find(c => c.key === key);
  const label = c => c ? `${c.label}${c.unit ? `, ${c.unit}` : ""}` : "";
  const activeRecipe = () => recipes().find(r => r.id === activeId());
  createEffect(() => {
    const available = yChannels();
    if (available.length && !available.some(c => c.key === y().key)) {
      setY({ key: (available[1] ?? available[0]).key, point: 1 });
    }
  });
  createEffect(() => {
    if (!recipes().some(r => r.id === activeId())) setActiveId(recipes().at(-1)?.id ?? null);
  });
  let previousRoot = props.plotRoot;
  createEffect(() => {
    if (previousRoot !== props.plotRoot) {
      previousRoot = props.plotRoot; setTaskMode("current"); props.selectPlotTask?.(null);
    }
  });
  onCleanup(() => { disposed = true; props.selectPlotTask?.(null); });
  const taskSourceError = () => taskMode() === "other"
    ? taskList.error() || props.plotTaskSource?.error || selectedTask()?.plotSourceError || "" : "";

  function changeTaskMode(value) {
    setTaskMode(value); setError("");
    props.selectPlotTask?.(null);
  }

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
      if (!sourceReady()) throw new Error("Выберите задание для оси Y и дождитесь загрузки его результатов.");
      const target = append ? activeRecipe() : null;
      if (append && !target) throw new Error("Сначала добавьте график или выберите существующий щелчком по его полю.");
      if (!append && recipes().length >= 12) throw new Error("На вкладке допускается до 12 графиков.");
      // Keep the exact source objects; later imports must not replace a curve's data.
      const curve = validatePlotCurve({ id: crypto.randomUUID(),
        x: { ...x() },
        y: { ...y() },
        xChannel: byKey(x().key), yChannel: byKey(y().key, "y"),
        yTask: taskMode() === "other" ? selectedTask() : undefined,
        taskLabel: taskMode() === "other" ? props.plotTaskSource.entry.label : props.task.plotLabel || props.task.name }, target?.curves[0]);
      const curves = expandPlotComponents(curve);
      if (target) props.setPlotRecipes(recipes().map(r => r.id === target.id ? { ...r, curves: [...r.curves, ...curves] } : r));
      else {
        const id = crypto.randomUUID();
        props.setPlotRecipes([...recipes(), { id, curves }]);
        setActiveId(id);
      }
    } catch (e) { setError(e.message); }
  }
  function removeCurve(plot, id) {
    if (props.movieBusy) return;
    const curves = plot.curves.filter(curve => curve.id !== id);
    if (!curves.length) props.setProtocolEntry?.(`plot:${plot.id}`, null);
    props.setPlotRecipes(curves.length ? recipes().map(r => r.id === plot.id ? { ...r, curves } : r)
      : recipes().filter(r => r.id !== plot.id));
  }
  function removePlot(id) {
    if (props.movieBusy) return;
    props.setProtocolEntry?.(`plot:${id}`, null);
    props.setPlotRecipes(recipes().filter(recipe => recipe.id !== id));
  }
  function AxisPicker(p) {
    const spec = () => p.get(), c = () => byKey(spec().key, p.axis);
    return <fieldset><legend>{p.title}</legend>
      <Show when={p.axis === "y"}>
        <label>Источник данных<select value={taskMode()} title="Выбрать текущее задание или другое задание из базового каталога"
          onChange={e => changeTaskMode(e.currentTarget.value)}>
          <option value="current">Текущее задание</option><option value="other" disabled={!props.plotRoot}>Другое задание</option>
        </select></label>
        <Show when={taskMode() === "other"}>
          <label>Задание<select aria-label="Задание" value={props.plotTaskSource?.entry?.key ?? ""} disabled={taskList.loading()}
            title="Все задания базового каталога в одном списке: проект / задание"
            onChange={e => { setError(""); props.selectPlotTask?.(taskList.value()?.find(item => item.key === e.currentTarget.value) ?? null); }}>
            <option value="">Выберите задание</option><For each={taskList.value() ?? []}>{item => <option value={item.key}>{item.label}</option>}</For>
          </select></label>
          <Show when={taskList.loading() || props.plotTaskSource?.loading}><span role="status">{taskList.loading() ? "Чтение списка заданий…" : "Чтение результатов задания…"}</span></Show>
          <Show when={!taskList.loading() && !taskList.error() && !taskList.value()?.length}><span role="status">В базовом каталоге нет заданий.</span></Show>
        </Show>
      </Show>
      <label>Величина<select value={spec().key} title="Выберите стандартную величину результата или подключённый параметр ОМ"
        disabled={p.axis === "y" && !sourceReady()}
        onChange={e => p.set({ ...spec(), key: e.currentTarget.value, point: 1 })}>
        <option value="" selected={!c()}>Выберите величину</option><For each={p.axis === "y" ? yChannels() : channels()}>{item => <option value={item.key} selected={spec().key === item.key}
          classList={{ "constructor-integral-option": ["flux", "force", "moment", "loss"].includes(item.kind) }}>{label(item)}</option>}</For>
      </select></label>
      <Show when={c()?.kind === "field"}><label>Точка в файле результата
        <input type="number" min="1" max={c()?.points} value={spec().point}
          title="Порядковый номер сохранённой точки в файле результата, начиная с 1; это не номер элемента или области"
          onInput={e => p.set({ ...spec(), point: e.currentTarget.value })} /> из {c()?.points}
      </label></Show>

    </fieldset>;
  }
  function Plot(p) {
    const emptyRecipe = { id: p.id, curves: [] };
    const recipe = createMemo(() => recipes().find(r => r.id === p.id) ?? emptyRecipe);
    let plotDialog, expandButton;
    const [expanded, setExpanded] = createSignal(false);
    const [expandedBounds, setExpandedBounds] = createSignal({});
    function fitExpanded() {
      if (!expanded()) return;
      const bounds = panel.getBoundingClientRect();
      const left = Math.max(0, bounds.left), top = Math.max(0, bounds.top);
      setExpandedBounds({ left: `${left}px`, top: `${top}px`,
        width: `${Math.max(0, Math.min(innerWidth, bounds.right) - left)}px`,
        height: `${Math.max(0, Math.min(innerHeight, bounds.bottom) - top)}px` });
    }
    function toggleExpanded() {
      if (props.movieBusy) return;
      const next = !expanded();
      plotDialog.close(); setExpanded(next);
      if (next) { setActiveId(p.id); fitExpanded(); plotDialog.showModal(); }
      else { plotDialog.show(); expandButton?.focus(); }
    }
    onMount(() => {
      const observer = new ResizeObserver(fitExpanded); observer.observe(panel);
      window.addEventListener("resize", fitExpanded);
      onCleanup(() => { observer.disconnect(); window.removeEventListener("resize", fitExpanded); });
    });
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
    const singleTime = createMemo(() => isSingleTimePlot(props.task, recipe().curves));
    const valueTable = createMemo(() => !data.loading() && !failure() ? singleTimePlotTable(recipe().curves, series()) : null);
    const frameKey = createMemo(() => ({ frame: data.state().frame, time: props.time }));
    const axisLabel = axis => plotAxisLabel(recipe().curves, axis);
    const protocol = () => <ProtocolCheck context={props} entryKey={`plot:${p.id}`} title={`График ${number()}`}
      compact={!expanded()} disabled={data.loading() || !!failure()}
      comment={recipe().curves.map(curve => `${plotCurveLabel(curve, "y")} / ${plotCurveLabel(curve, "x")}`).join("; ")}
      capture={options => {
        if (!singleTime()) return captureProtocolRenderer(renderer(), frameKey(), options);
        const table = valueTable();
        if (!table) throw new Error("Таблица ещё не готова.");
        return { kind: "table", table: { headers: [...table.headers, ...(table.hasPoint ? ["Точка"] : []), "Комментарий"],
          rows: table.rows.map(row => [...row.values, ...(table.hasPoint ? [row.point ?? ""] : []), row.comment].map(String)) } };
      }} />;
    function ActiveMovie() {
      const movie = createMovieTabAdapter(props, { title: "Графики", filenamePrefix: "graphs", readFrame: index => {
        const current = completedMovieFrame(data.state(), { task: props.task, index, timed: false });
        if (!current.ready) return current;
        if (failure()) return { error: failure() };
        if (!series().length) return { error: "Нет кривых для записи" };
        if (series().some(item => !item.points.some(point => plotPointAtStep(point, props.task, index)))) return { error: `У кривых нет общего сохранённого момента t = ${index * props.task.general.timeStep} с` };
        return frameKey().time === index ? { ready: true, value: frameKey() } : { ready: false };
      } });
      createEffect(() => movie.onCaptureReady(renderer()));
      return null;
    }
    return <div class="constructor-plot-slot"><dialog open ref={plotDialog} class="plot-panel constructor-plot" classList={{ "constructor-plot-active": activeId() === p.id, "constructor-value-panel": singleTime(), "constructor-expanded": expanded() }}
      style={expanded() ? expandedBounds() : {}}
      onCancel={event => { event.preventDefault(); if (expanded()) toggleExpanded(); }}
      tabIndex="0" aria-label={`График ${number()}${activeId() === p.id ? ", активный" : ""}`}
      onPointerDown={() => !props.movieBusy && setActiveId(p.id)} onFocusIn={() => !props.movieBusy && setActiveId(p.id)}>
      <Show when={activeId() === p.id && !singleTime()}><ActiveMovie /></Show>
      <Show when={singleTime()} fallback={
      <LineChart series={series()} autoScaleToggle={true} legendMode="overlay"
        marker={{ points: series().flatMap(item => item.points.filter(point => plotPointAtStep(point, props.task, props.time))) }}
        captureFrameKey={frameKey()} onCaptureReady={target => setRenderer(() => target)} captureError={failure()}
        tableUnavailableReason={data.loading() ? "Дождитесь загрузки всех кривых графика" : failure()}
        xLabel={axisLabel("x")} yLabel={axisLabel("y")}
        emptyText={data.loading() ? "Чтение результатов…" : failure() || "Нет общих шагов"} status={data.loading() ? "Чтение результатов…" : failure()}
        toolbar={<strong title="Щёлкните по графику, чтобы добавлять кривые в него и записывать его в GIF">График {number()}{activeId() === p.id ? " · активный" : ""}</strong>}
        afterAuto={<button ref={expandButton} type="button" disabled={props.movieBusy} aria-pressed={expanded()}
          title={expanded() ? "Вернуть обычный размер окна" : "Развернуть активный график на доступную область панели"}
          onClick={toggleExpanded}>{expanded() ? "Свернуть" : "Развернуть"}</button>}
        toolbarEnd={<button type="button" title="Удалить этот график со всеми его кривыми; файлы результатов сохраняются"
          onClick={() => removePlot(p.id)}>Удалить график</button>}
        toolbarLast={protocol()} />
      }>
        <div class="constructor-value-toolbar"><strong>Значения {number()}{activeId() === p.id ? " · активные" : ""}</strong>
          <button type="button" onClick={() => removePlot(p.id)}>Удалить таблицу</button>
          {protocol()}
        </div>
        <Show when={valueTable()} fallback={<p role="status">{data.loading() ? "Чтение результатов…" : failure() || "Нет значений для единственного момента времени"}</p>}>
          {table => <div class="constructor-value-scroll"><table class="constructor-values" aria-label="Значения в единственный момент времени">
            <thead><tr><For each={table().headers}>{header => <th scope="col">{header}</th>}</For><Show when={table().hasPoint}><th scope="col">Точка</th></Show><th scope="col">Комментарий</th></tr></thead>
            <tbody><For each={table().rows}>{row => <tr><For each={row.values}>{value => <td>{value}</td>}</For><Show when={table().hasPoint}><td>{row.point ?? ""}</td></Show><td class="constructor-value-comment">{row.comment}</td></tr>}</For></tbody>
          </table></div>}
        </Show>
      </Show>
      <details class="constructor-curves"><summary title="Посмотреть состав графика или удалить отдельную кривую">Кривые: {recipe().curves.length}</summary>
        <For each={recipe().curves}>{(curve, index) => <div><span>{index() + 1}. {plotCurveLabel(curve, "y")} / {plotCurveLabel(curve, "x")}</span>
          <button type="button" title="Удалить эту кривую; удаление последней кривой закрывает график"
            aria-label={`Удалить кривую ${index() + 1}`} onClick={() => removeCurve(recipe(), curve.id)}>×</button></div>}</For>
      </details>
    </dialog></div>;
  }
  return <div ref={panel} class="plot-constructor">
    <div class="constructor-controls"><AxisPicker title="Ось X" axis="x" get={x} set={setX} /><AxisPicker title="Ось Y" axis="y" get={y} set={setY} />
      <div class="constructor-actions"><button type="button" disabled={!sourceReady()} title="Создать отдельный график выбранной зависимости Y(X) и сделать его активным"
        onClick={() => addPlotOrCurve(false)}>Добавить график</button>
        <button type="button" disabled={!activeRecipe() || !sourceReady()} title="Добавить выбранную зависимость Y(X) в график с выделенной рамкой. Выберите график щелчком; выбранные величины обеих осей должны совпадать"
          onClick={() => addPlotOrCurve(true)}>Добавить кривую</button>
        <button ref={sourceButton} type="button" disabled={adding()}
          title="Подключить дополнительные величины из каталога выполненного ОМ-расчёта: results.json и таблица TSV. Сначала откроется пояснение, затем выбор каталога"
          onClick={chooseSource}>Добавить параметры ОМ…</button>
        <Show when={latest.value()}><button type="button" title="Скачать report.html последнего успешного ОМ-расчёта: результаты модели и сходимость решателя"
          onClick={saveReport}>Сохранить HTML-протокол</button></Show></div>
    </div>
    <Show when={error() || latest.error()}><p class="constructor-error" role="alert">{error() || latest.error()}</p></Show>
    <Show when={taskSourceError()}><p class="constructor-error" role="alert">{taskSourceError()}</p></Show>
    <For each={taskMode() === "other" ? (selectedTask()?.plotSources ?? []).filter(s => s.warning) : []}>{s => <p role="status">{s.warning}</p>}</For>
    <For each={allSources().filter(s => s.warning)}>{s => <p role="status">{s.warning}</p>}</For>
    <p class="constructor-hint">Векторные величины выводятся компонентами X, Y, Z; их видимость переключается в легенде. При нуле интервалов времени каждое добавление создаёт строку таблицы значений с путём задания в комментарии. Щелчок по графику выбирает его для добавления кривых и записи GIF. X берётся из текущего задания; при X = «Время» используется временная сетка задания Y. Остальные величины разных заданий сопоставляются по совпадающим моментам времени, без интерполяции.</p>
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
