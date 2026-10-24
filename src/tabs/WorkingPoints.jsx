import { createMemo, createSignal, For, Show } from "solid-js";
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
import "./WorkingPoints.css";

export function WorkingPoints(props) {
  const [mode, setMode] = createSignal("M");
  const [logE, setLogE] = createSignal(false);
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
        logE={logE()} setLogE={setLogE} />}</Show>
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
  const curves = useAsyncResult(() => props.task && ({ task: props.task, records: selected() }), async request => {
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
  const points = useAsyncResult(() => props.task && ({ task: props.task, records: selected(), time: props.time }), async request => {
    if (!request.records.length) return { series: [], warnings: [], count: 0 };
    const objects = resultObjects(request.task, magnetic ? "M" : "J").filter(item => request.records.some(r => r.id === item.record.id));
    const projection = magnetic ? buildGeometryTimeModel(request.task, request.task.moves, request.time) : null;
    const results = await Promise.all(objects.map(async object => {
      try {
        if (!magnetic) {
          const frame = await request.task.reader.read({ name: "JE", step: request.time, start: object.start, count: object.count, every: 1 });
          return { series: currentWorkingPointSeries(frame, object.record) };
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
    return { series, warnings: results.filter(r => r.error).map(r => r.error), count: series.reduce((n, s) => n + s.points.length, 0) };
  });
  const warnings = () => [curves.error(), points.error(), ...(curves.value()?.warnings ?? []), ...(points.value()?.warnings ?? [])].filter(Boolean).join(" · ");
  const displayed = createMemo(() => magnetic ? (points.value() ?? { series: [], count: 0 })
    : currentWorkingPointView(points.value()?.series ?? [], props.logE));
  const zeroNotice = () => displayed().omittedZeros
    ? `В режиме log(E) не показаны точки с |E| = 0: ${displayed().omittedZeros}` : "";
  const movieFrame = createMemo(() => ({ points: points.state().frame, curves: curves.state().frame, logE: !magnetic && props.logE }));
  const movie = createMovieTabAdapter(props, { title: `Рабочие точки ${title}`,
    filenamePrefix: () => magnetic ? "mh" : props.logE ? "j-loge" : "je", readFrame: index => {
    if (!selected().length) return { error: emptyText };
    const a = completedMovieFrame(points.state(), { task: props.task, index });
    const b = completedMovieFrame(curves.state(), { task: props.task, index, timed: false });
    if (a.error || b.error) return { error: a.error || b.error };
    if (!a.ready || !b.ready) return { ready: false };
    return warnings() ? { error: warnings() } : !displayed().count
      ? { error: zeroNotice() || "Нет рабочих точек" } : { ready: true, value: movieFrame() };
  } });
  // Linear and log(E) use different coordinates: give each fresh zoom bounds.
  return <Show when={!magnetic && props.logE ? "log" : "linear"} keyed>{_scale =>
      <LineChart series={[...(curves.value()?.series ?? []), ...displayed().series]} autoScaleToggle={true} autoYRange={magnetic ? globalYRange() : null}
        captureFrameKey={movieFrame()} onCaptureReady={movie.onCaptureReady} captureError={warnings()}
        toolbar={<><strong>{title}</strong><Show when={magnetic} fallback={<>
          <span class="chart-toolbar-note">Модули J и E</span>
          <label title="Десятичный логарифм |E| в В/м; точки с E = 0 не отображаются">
            <input type="checkbox" aria-label="log(E)" checked={props.logE} disabled={props.movieBusy}
              onChange={event => !props.movieBusy && props.setLogE(event.currentTarget.checked)} />log(E)
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
          title={`Рабочие точки ${!magnetic && props.logE ? "J(log E)" : title}`} adapter={movie.adapter}
          disabled={points.loading() || curves.loading()} comment={`Элементы: ${selected().map(row => row.id).join(", ")}`} />}
        status={[warnings(), zeroNotice()].filter(Boolean).join(" · ")}
        xLabel={magnetic ? "H, кА/м" : props.logE ? "log₁₀(|E| / (1 В/м))" : "|E|, В/м"}
        yLabel={magnetic ? "M, кА/м" : "|J|, А/мм²"} emptyText={warnings() || zeroNotice() || emptyText} />
    }</Show>;
}
