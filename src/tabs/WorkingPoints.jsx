import { createMemo, For, Show } from "solid-js";
import { createGeometryViewSetting } from "../services/visualization/geometryViewSettings.js";
import { ProtocolCheck } from "../components/protocol/ProtocolCheck.jsx";
import { ObjectList } from "../components/ObjectList.jsx";
import { LineChart } from "../components/LineChart.jsx";
import { TimeSlider } from "../components/TimeSlider.jsx";
import { workingPointSeries } from "../services/results/resultPlots.js";
import { resultObjects, useAsyncResult } from "../services/results/resultRequests.js";
import { characteristicCurve, isAnisotropic, isFmm, loadFmmCharacteristic } from "../services/results/fmmCharacteristics.js";
import { buildGeometryTimeModel } from "../services/visualization/geometryTimeModel.js";
import { completedMovieFrame, createMovieTabAdapter } from "../services/movie/movieTabAdapter.js";
import { workingPointGlobalMRange } from "../services/results/resultGlobalScale.js";
import { currentWorkingPointSeries, currentWorkingPointView, updateWorkingPointSelection,
  workingPointEligibleIds, workingPointRecords } from "../services/results/workingPointsModel.js";
import { readCurrentCharacteristics } from "../services/results/currentCharacteristics.js";
import "./WorkingPoints.css";

export function WorkingPoints(props) {
  const [mode, setMode] = createGeometryViewSetting("workingPointMode", "M");
  const [logE, setLogE] = createGeometryViewSetting("workingPointLogE", false);
  const [logJ, setLogJ] = createGeometryViewSetting("workingPointLogJ", false);
  const records = createMemo(() => workingPointRecords(props.task));
  const eligible = createMemo(() => workingPointEligibleIds(records(), mode()));
  const selected = createMemo(() => {
    const ids = new Set(eligible()), marked = new Set(props.elements);
    return records().filter(record => ids.has(record.id) && marked.has(record.id));
  });
  function select(ids) {
    if (!props.movieBusy) props.setElements(updateWorkingPointSelection(props.elements, ids, eligible()));
  }
  function changeMode(value) { if (!props.movieBusy) setMode(value); }
  function tabKey(event) {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || props.movieBusy) return;
    event.preventDefault();
    const next = event.key === "Home" ? "M" : event.key === "End" ? "J" : mode() === "M" ? "J" : "M";
    changeMode(next);
    event.currentTarget.parentElement.querySelector(`#working-points-tab-${next}`)?.focus();
  }
  return <div class="results-layout">
    <ObjectList title="Элементы" records={records()} selectableIds={eligible()}
      selected={selected().map(record => record.id)} onSelect={select} disabled={props.movieBusy} />
    <div class="working-point-tabs" role="tablist" aria-label="Зависимость рабочих точек" aria-orientation="vertical">
      <For each={["M", "J"]}>{value => <button type="button" role="tab" id={`working-points-tab-${value}`}
        aria-selected={mode() === value} aria-controls="working-points-plot" tabIndex={mode() === value ? 0 : -1}
        disabled={props.movieBusy} onClick={() => changeMode(value)} onKeyDown={tabKey}>{value === "M" ? "M(H)" : "J(E)"}</button>}</For>
    </div>
    <section class="plot-panel" role="tabpanel" id="working-points-plot" aria-labelledby={`working-points-tab-${mode()}`}>
      <Show when={mode()} keyed>{value => <WorkingPointPlot {...props} mode={value} selected={selected()}
        logE={logE()} setLogE={setLogE} logJ={logJ()} setLogJ={setLogJ} />}</Show>
      <TimeSlider index={props.time} max={props.task?.general.countTimeSteps} step={props.task?.general.timeStep} onChange={props.setTime} />
    </section>
  </div>;
}

function WorkingPointPlot(props) {
  const magnetic = props.mode === "M";
  const selected = () => props.selected;
  const title = magnetic ? "M(H)" : "J(E)";
  const emptyText = magnetic ? "Выберите элементы с магнитными свойствами" : "Выберите элементы с проводящими свойствами";
  const [globalMinMax, setGlobalMinMax] = createGeometryViewSetting("resultGlobalMinMax", true);
  const globalMRange = createMemo(() => workingPointGlobalMRange(
    props.task,
    selected().map(record => record.id),
  ));
  const globalYRange = createMemo(() => globalMinMax() && globalMRange().available
    ? { minimum: globalMRange().minimum, maximum: globalMRange().maximum }
    : null);
  const points = useAsyncResult(() => props.task && ({ task: props.task, records: selected(), time: props.time }), async request => {
    if (!request.records.length) return { series: [], entries: [], warnings: [], count: 0 };
    const objects = resultObjects(request.task, magnetic ? "M" : "J").filter(item => request.records.some(r => r.id === item.record.id));
    const projection = magnetic ? buildGeometryTimeModel(request.task, request.task.moves, request.time) : null;
    const results = await Promise.all(objects.map(async object => {
      try {
        if (!magnetic) {
          const frame = await request.task.reader.read({ name: "JE", step: request.time, start: object.start, count: object.count, every: 1 });
          return { record: object.record, series: currentWorkingPointSeries(frame, object.record) };
        }
        const characteristic = isFmm(object.record) ? await loadFmmCharacteristic(request.task, object.record.xapName) : [];
        const doubleFloat = request.task.general.doubleFloat ?? false;
        if (isAnisotropic(object.record, characteristic, doubleFloat)) {
          const warning = projection.diagnostics.find(d => d.schemaId === "general"
            || (d.schemaId === "elements" && d.recordIndex === object.record.recordIndex));
          if (warning) throw new Error(warning.message);
        }
        const frame = await request.task.reader.read({ name: "MH", step: request.time, start: object.start, count: object.count });
        return { series: workingPointSeries(frame, object.record, projection.model.elements[object.record.recordIndex],
          { characteristic, doubleFloat }) };
      } catch (error) { return { error: `№${object.record.id}: ${error.message}` }; }
    }));
    const series = results.filter(r => r.series).map(r => r.series);
    return { series, entries: results.filter(r => r.series), warnings: results.filter(r => r.error).map(r => r.error), count: series.reduce((n, s) => n + s.points.length, 0) };
  });
  const curves = useAsyncResult(() => {
    if (!props.task) return null;
    if (magnetic) return { task: props.task, records: selected() };
    const frame = points.state().frame;
    return frame?.request.task === props.task && frame.request.time === props.time && frame.request.records === selected()
      ? { task: props.task, records: selected(), time: props.time, pointFrame: frame } : null;
  }, async request => {
    if (!magnetic) return readCurrentCharacteristics(request.task, request.pointFrame.value.entries, request.time);
    const materials = await Promise.all((magnetic ? request.records.filter(isFmm) : []).map(async record => {
      try {
        const source = await loadFmmCharacteristic(request.task, record.xapName);
        const doubleFloat = request.task.general.doubleFloat ?? false;
        return { record, ...characteristicCurve(source, isAnisotropic(record, source, doubleFloat), doubleFloat) };
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
  const warnings = () => [curves.error(), points.error(), ...(curves.value()?.warnings ?? []), ...(points.value()?.warnings ?? [])].filter(Boolean).join(" · ");
  const displayed = createMemo(() => magnetic ? (points.value() ?? { series: [], count: 0 })
    : currentWorkingPointView(points.value()?.series ?? [], props.logE, props.logJ));
  const displayedCurves = createMemo(() => magnetic ? curves.value()?.series ?? []
    : currentWorkingPointView(curves.value()?.series ?? [], props.logE, props.logJ).series);
  const zeroAxes = () => [props.logE && "|E| = 0", props.logJ && "|J| = 0"].filter(Boolean).join(" или ");
  const zeroNotice = () => displayed().omittedZeros
    ? `Не показаны точки с ${zeroAxes()}: ${displayed().omittedZeros}` : "";
  const currentTitle = () => `${props.logJ ? "log J" : "J"}(${props.logE ? "log E" : "E"})`;
  const movieFrame = createMemo(() => ({ points: points.state().frame, curves: curves.state().frame,
    logE: !magnetic && props.logE, logJ: !magnetic && props.logJ }));
  const movie = createMovieTabAdapter(props, { title: `Рабочие точки ${title}`,
    filenamePrefix: () => magnetic ? "mh" : `${props.logJ ? "logj" : "j"}-${props.logE ? "loge" : "e"}`, readFrame: index => {
    if (!selected().length) return { error: emptyText };
    const a = completedMovieFrame(points.state(), { task: props.task, index });
    const b = completedMovieFrame(curves.state(), { task: props.task, index, timed: !magnetic });
    if (a.error || b.error) return { error: a.error || b.error };
    if (!a.ready || !b.ready) return { ready: false };
    return warnings() ? { error: warnings() } : !displayed().count
      ? { error: zeroNotice() || "Нет рабочих точек" } : { ready: true, value: movieFrame() };
  } });
  // Axis transforms use different coordinates: give each fresh zoom bounds.
  return <Show when={magnetic ? "mh" : `${props.logE}-${props.logJ}`} keyed>{_scale =>
      <LineChart series={[...displayedCurves(), ...displayed().series]} autoScaleToggle={true} autoYRange={magnetic ? globalYRange() : null}
        legendMode={magnetic ? undefined : "overlay"}
        captureFrameKey={movieFrame()} onCaptureReady={movie.onCaptureReady} captureError={warnings()}
        toolbar={<><strong>{title}</strong><Show when={magnetic} fallback={<>
          <span class="chart-toolbar-note" title="Заданная зависимость — линия; расчётные рабочие точки — маркеры. При постоянном Jc степенной закон прямолинеен в log(J)–log(E).">Линия — задано; точки — расчёт</span>
          <label title="Десятичный логарифм |E| в В/м; точки с E = 0 не отображаются">
            <input type="checkbox" aria-label="log(E)" checked={props.logE} disabled={props.movieBusy}
              onChange={event => !props.movieBusy && props.setLogE(event.currentTarget.checked)} />log(E)
          </label>
          <label title="Десятичный логарифм |J| в А/мм²; точки с J = 0 не отображаются">
            <input type="checkbox" aria-label="log(J)" checked={props.logJ} disabled={props.movieBusy}
              onChange={event => !props.movieBusy && props.setLogJ(event.currentTarget.checked)} />log(J)
          </label></>}><span class="chart-toolbar-note"
          title="Изотропные ФММ: модули · Анизотропные: проекции на ось намагничивания">
          Изотропные ФММ: модули · Анизотропные: проекции на ось намагничивания
        </span>
        <label title={globalMRange().available
          ? "Общие пределы M по выбранным ФММ за весь расчёт. Нижняя граница: min(0, Mmin)."
          : globalMRange().reason}>
          <input type="checkbox" aria-label="Общий минмакс рабочих точек"
            checked={globalMinMax() && globalMRange().available}
            disabled={props.movieBusy || !globalMRange().available}
            onChange={event => !props.movieBusy && globalMRange().available
              && setGlobalMinMax(event.currentTarget.checked)} />Общий минмакс
        </label></Show></>}
        toolbarEnd={<span class="chart-toolbar-status" role="status">{points.loading() || curves.loading()
          ? "Чтение…" : `Рабочих точек: ${displayed().count}`}</span>}
        toolbarLast={<ProtocolCheck context={props} entryKey={magnetic ? "working-points" : "working-points-je"}
          title={`Рабочие точки ${magnetic ? title : currentTitle()}`} adapter={movie.adapter}
          disabled={points.loading() || curves.loading()} comment={`Элементы: ${selected().map(row => row.id).join(", ")}`} />}
        status={[warnings(), zeroNotice(), ...(curves.value()?.notes ?? [])].filter(Boolean).join(" · ")}
        xLabel={magnetic ? "H, кА/м" : props.logE ? "log₁₀(|E| / (1 В/м))" : "|E|, В/м"}
        yLabel={magnetic ? "M, кА/м" : props.logJ ? "log₁₀(|J| / (1 А/мм²))" : "|J|, А/мм²"}
        emptyText={warnings() || zeroNotice() || emptyText} />
    }</Show>;
}
