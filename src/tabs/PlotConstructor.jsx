import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { LineChart } from "../components/LineChart.jsx";
import { ProtocolCheck } from "../components/protocol/ProtocolCheck.jsx";
import { captureProtocolRenderer } from "../services/protocol/protocolCapture.js";
import { TimeSlider } from "../components/TimeSlider.jsx";
import { plotChannels, plotChannelLabel, plotCurveLabel, plotPointAtStep, readPlotCurves, validatePlotCurve, expandPlotComponents, isSingleTimePlot, singleTimePlotTable } from "../services/results/plotConstructor.js";
import { listPlotTasks } from "../services/results/plotTaskSources.js";
import { loadLatestOMChannels, readChannelSource } from "../services/results/omResultChannels.js";
import { useAsyncResult } from "../services/results/resultRequests.js";
import { completedMovieFrame, createMovieTabAdapter } from "../services/movie/movieTabAdapter.js";
import { ELEMENT_LINE_CHANNEL, supportsElementLine, elementLineObjects, elementLineLayout,
  defaultElementLine, elementLineRequest } from "../services/results/elementLinePlots.js";
import "./PlotConstructor.css";

export function PlotConstructor(props) {
  const [error, setError] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [sourceError, setSourceError] = createSignal("");
  const [localActive, setLocalActive] = createSignal(null);
  const [x, setX] = createSignal({ key: "time", point: 1 });
  const [y, setY] = createSignal({ key: "", point: 1 });
  const [line, setLine] = createSignal({ element: 0, indices: [1, 1, 1], copies: [1, 1, 1] });
  const [lineStep, setLineStep] = createSignal(null);
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
  const spatial = () => x().key === ELEMENT_LINE_CHANNEL.key;
  const offeredY = createMemo(() => spatial() ? yChannels().filter(supportsElementLine) : yChannels());
  const byKey = (key, axis = "x") => axis === "x" && key === ELEMENT_LINE_CHANNEL.key ? ELEMENT_LINE_CHANNEL
    : (axis === "y" ? yChannels() : channels()).find(c => c.key === key);
  const label = c => c ? `${c.label}${c.unit ? `, ${c.unit}` : ""}` : "";
  const activeRecipe = () => recipes().find(r => r.id === activeId());
  createEffect(() => {
    const available = offeredY();
    if (available.length && !available.some(c => c.key === y().key)) {
      setY({ key: (spatial() ? available[0] : available[1] ?? available[0]).key, point: 1 });
    }
  });
  const lineObjects = createMemo(() => {
    if (!spatial() || !sourceReady()) return { objects: [], error: "" };
    try { return { objects: elementLineObjects(selectedTask(), byKey(y().key, "y")), error: "" }; }
    catch (e) { return { objects: [], error: e.message }; }
  });
  const lineObject = createMemo(() => lineObjects().objects.find(item => item.record.id === Number(line().element)));
  const lineGrid = createMemo(() => lineObject() ? elementLineLayout(lineObject().record, byKey(y().key, "y")) : null);
  const lineSteps = createMemo(() => spatial() ? selectedTask()?.metadata?.[byKey(y().key, "y")?.file]?.steps ?? [] : []);
  createEffect(() => {
    const objects = lineObjects().objects, channel = byKey(y().key, "y");
    if (!objects.length) return;
    setLine(previous => {
      const object = objects.find(item => item.record.id === previous.element) ?? objects[0];
      const next = defaultElementLine(object.record, channel, object.record.id === previous.element ? previous : {});
      return JSON.stringify(next) === JSON.stringify(previous) ? previous : next;
    });
  });
  createEffect(() => {
    const steps = lineSteps();
    if (!steps.length) { setLineStep(null); return; }
    setLineStep(previous => steps.some(s => s.index === previous) ? previous
      : steps.find(s => s.index === untrack(() => props.time))?.index ?? steps[0].index);
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
      const selection = spatial() ? elementLineRequest(selectedTask(), byKey(y().key, "y"), line(), lineStep()) : null;
      const curve = validatePlotCurve({ id: crypto.randomUUID(),
        x: selection ? { ...x(), ...line(), indices: [...line().indices], copies: [...line().copies], lineLabel: selection.label } : { ...x() },
        y: selection ? { ...y(), profile: true, step: lineStep(), time: lineStep() * selectedTask().general.timeStep } : { ...y() },
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
  function LinePicker() {
    const changeIndex = (axis, value, key = "indices") => {
      setError(""); setLine(previous => ({ ...previous, [key]: previous[key].map((n, i) => i === axis ? value : n) }));
    };
    return <div class="constructor-line-picker">
      <label>Элемент<select aria-label="Элемент для отрезка" value={line().element} disabled={!lineObjects().objects.length}
        title="Номер и имя элемента из списка задания, выбранного для оси Y"
        onChange={e => {
          setError("");
          const record = lineObjects().objects.find(item => item.record.id === Number(e.currentTarget.value))?.record;
          if (record) setLine(defaultElementLine(record, byKey(y().key, "y"), { direction: line().direction }));
        }}><For each={lineObjects().objects}>{item => <option value={item.record.id}>№{item.record.id} · {item.record.name || "Элемент"}</option>}</For>
      </select></label>
      <Show when={lineGrid()}>{grid => <>
        <label>Направление<select aria-label="Направление отрезка" value={line().direction}
          title="Индекс вдоль ряда центров ЭО меняется от 1 до N; два поперечных индекса фиксированы"
          onChange={e => { setError(""); setLine(previous => ({ ...previous, direction: Number(e.currentTarget.value) })); }}>
          <For each={grid().dimensions}>{(n, axis) => <option value={axis()} disabled={n < 2}>i{axis() + 1} · {n} ЭО</option>}</For>
        </select></label>
        <div class="constructor-line-indices"><For each={[0, 1, 2].filter(axis => axis !== line().direction)}>{axis =>
          <label>i{axis + 1}<input type="number" aria-label={`Поперечный индекс i${axis + 1}`} step="1"
            min="1" max={grid().dimensions[axis]} disabled={grid().dimensions[axis] === 1} value={line().indices[axis]}
            title={`Поперечный индекс i${axis + 1}: от 1 до ${grid().dimensions[axis]}`}
            onInput={e => changeIndex(axis, e.currentTarget.value)} /><small>1…{grid().dimensions[axis]}</small></label>
        }</For><button type="button" title="Ближайший к середине ряд ЭО; при чётном числе выбирается меньший из двух центральных индексов"
          onClick={() => { setError(""); setLine(previous => ({ ...previous, indices: grid().dimensions.map(n => Math.ceil(n / 2)) })); }}>Середина</button></div>
        <span class="constructor-hint">i{line().direction + 1}: 1…{grid().dimensions[line().direction]} · от первого до последнего центра ЭО</span>
        <Show when={grid().copies.some(n => n > 1)}><details class="constructor-line-images"><summary>Сохранённый образ: {grid().copies.flatMap((n, axis) => n > 1 ? [`${["LS", "AS", "PS"][axis]}=${line().copies[axis]}`] : []).join(", ")}</summary>
          <For each={[0, 1, 2].filter(axis => grid().copies[axis] > 1)}>{axis => <label>{["LS", "AS", "PS"][axis]}
            <input type="number" min="1" max={grid().copies[axis]} step="1" value={line().copies[axis]}
              aria-label={`Образ ${["LS", "AS", "PS"][axis]}`} onInput={e => changeIndex(axis, e.currentTarget.value, "copies")} /> из {grid().copies[axis]}</label>}</For>
        </details></Show>
      </>}</Show>
      <Show when={lineObjects().error}><span class="constructor-error" role="alert">{lineObjects().error}</span></Show>
      <Show when={!lineObjects().error && sourceReady() && !lineObjects().objects.length}><span role="status">Нет элементов с сохранённой величиной Y.</span></Show>
    </div>;
  }
  function LineTimePicker() {
    const position = () => lineSteps().findIndex(s => s.index === lineStep());
    return <div class="constructor-line-time"><label>Момент времени<select aria-label="Момент времени профиля" value={lineStep() ?? ""}
      title="Номер сохранённого шага и его физическое время; выбор закрепляется при добавлении кривой"
      onChange={e => setLineStep(Number(e.currentTarget.value))}>
      <For each={lineSteps()}>{s => <option value={s.index}>№{s.index} · t = {Number((s.index * selectedTask().general.timeStep).toPrecision(10))} с</option>}</For>
    </select></label>
      <button type="button" aria-label="Предыдущий сохранённый момент" title="Предыдущий сохранённый момент" disabled={position() <= 0}
        onClick={() => setLineStep(lineSteps()[position() - 1].index)}>←</button>
      <button type="button" aria-label="Следующий сохранённый момент" title="Следующий сохранённый момент" disabled={position() < 0 || position() >= lineSteps().length - 1}
        onClick={() => setLineStep(lineSteps()[position() + 1].index)}>→</button>
    </div>;
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
        <option value="" selected={!c()}>Выберите величину</option><For each={p.axis === "y" ? offeredY() : [...channels(), ELEMENT_LINE_CHANNEL]}>{item => <option value={item.key} selected={spec().key === item.key}>{label(item)}</option>}</For>
      </select></label>
      <Show when={p.axis === "x" && spatial()}><LinePicker /></Show>
      <Show when={p.axis === "y" && spatial()}><LineTimePicker /></Show>
      <Show when={c()?.kind === "field" && !(p.axis === "y" && spatial())}><label>Точка в файле результата
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
    const spatialPlot = createMemo(() => recipe().curves[0]?.xChannel.kind === "distance");
    const annotations = createMemo(() => [...new Set(series().filter(s => s.annotations).map(s => s.annotations.join("\n")))].flatMap(s => s.split("\n")));
    const distanceRange = createMemo(() => spatialPlot() && series().length
      ? { minimum: 0, maximum: Math.max(...series().map(s => s.profile?.length ?? 0)) } : null);
    const valueTable = createMemo(() => !data.loading() && !failure() ? singleTimePlotTable(recipe().curves, series()) : null);
    const frameKey = createMemo(() => ({ frame: data.state().frame, time: spatialPlot() ? null : props.time }));
    const axisLabel = axis => {
      const labels = [...new Set(recipe().curves.map(curve => plotChannelLabel(curve[`${axis}Channel`], curve[axis])))];
      if (labels.length === 1) return labels[0];
      const unit = recipe().curves[0]?.[`${axis}Channel`].unit;
      return `${axis.toUpperCase()}${unit ? `, ${unit}` : ""} (величины указаны в легенде)`;
    };
    const protocol = () => <ProtocolCheck context={props} entryKey={`plot:${p.id}`} title={`График ${number()}`}
      compact={!expanded()} disabled={data.loading() || !!failure()}
      momentLabel={spatialPlot() ? [...new Set(recipe().curves.map(curve => `№${curve.y.step}: t=${curve.y.time} с`))].join("; ") : undefined}
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
      <Show when={activeId() === p.id && !singleTime() && !spatialPlot()}><ActiveMovie /></Show>
      <Show when={singleTime()} fallback={
      <LineChart series={series()} autoScaleToggle={true} legendMode="overlay"
        marker={spatialPlot() ? null : { points: series().flatMap(item => item.points.filter(point => plotPointAtStep(point, props.task, props.time))) }}
        annotations={annotations()} autoXRange={distanceRange()}
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
    <p class="constructor-hint"><Show when={spatial()} fallback={<>Векторные величины выводятся компонентами X, Y, Z; их видимость переключается в легенде. При нуле интервалов времени каждое добавление создаёт строку таблицы значений с путём задания в комментарии. Щелчок по графику выбирает его для добавления кривых и записи GIF. X берётся из текущего задания; при X = «Время» используется временная сетка задания Y. Остальные величины разных заданий сопоставляются по совпадающим моментам времени, без интерполяции.</>}>
      Отрезок и величина Y берутся из одного выбранного задания. Индексы i1/i2/i3 задают направления сетки элемента; компоненты вектора X/Y/Z — глобальные.
      Время закрепляется за добавленной кривой. Можно добавить другие ряды, моменты и задания в тот же график.
      По отрезку доступны локальные величины в ЭО; результаты областей и суммарные параметры имеют другую сетку или не зависят от положения.
    </Show></p>
    <div class="constructor-plots"><For each={recipes().map(recipe => recipe.id)} fallback={<p>Выберите величины для осей и добавьте график.</p>}>{id => <Plot id={id} />}</For></div>
    <Show when={activeRecipe()?.curves[0]?.xChannel.kind !== "distance"} fallback={<p class="constructor-hint">На активном графике показаны фиксированные моменты времени, указанные у кривых. Координаты концов входят в снимок протокола.</p>}>
      <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep} onChange={props.setTime} />
    </Show>
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
