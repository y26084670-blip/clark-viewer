import { createMemo } from "solid-js";
import { ObjectList } from "../components/ObjectList.jsx";
import { LineChart } from "../components/LineChart.jsx";
import { useAsyncResult } from "../services/results/resultRequests.js";
import { HISTORY_QUANTITIES, measurementCoils, readFluxHistories, fluxHistorySeries } from "../services/results/resultHistories.js";
import { completedMovieFrame, createMovieTabAdapter } from "../services/movie/movieTabAdapter.js";

export function Fluxes(props) {
  const catalog = createMemo(() => {
    try { return { records: measurementCoils(props.task), error: "" }; }
    catch (error) { return { records: [], error: error.message }; }
  });
  // A null selection chooses the first coil in a newly loaded task; [] means
  // the user explicitly cleared the list. App preserves selection across tabs.
  const selected = () => props.coils ?? catalog().records.slice(0, 1).map(record => record.id);
  const result = useAsyncResult(() => props.task && ({ task: props.task, selected: selected(), error: catalog().error }), async request => {
    if (request.error) throw new Error(request.error);
    const histories = await readFluxHistories(request);
    return histories.map(item => fluxHistorySeries(item, request.task.general.timeStep));
  });
  const emptyText = () => result.loading() ? "Чтение потокосцеплений…" : result.error()
    || (catalog().records.length ? "Выберите измерительные катушки" : "В задании нет измерительных катушек");
  const movieFrame = createMemo(() => ({ frame: result.state().frame, time: props.time }));
  const movie = createMovieTabAdapter(props, { title: "Потоки", readFrame: index => {
    const current = completedMovieFrame(result.state(), { task: props.task, index, timed: false });
    if (!current.ready) return current;
    const series = current.value.value;
    if (!series.length) return { error: "Выберите измерительные катушки" };
    if (series.some(item => !item.points.some(point => point.step === index))) return { error: `PSI.h5: нет сохранённого шага ${index}` };
    return movieFrame().time === index ? { ready: true, value: movieFrame() } : { ready: false };
  } });
  return <div class="results-layout">
    <ObjectList title="Измерительные катушки" records={catalog().records} selected={selected()} onSelect={props.setCoils} />
    <section class="plot-panel">
      <LineChart series={result.value() ?? []} xLabel="Время, с"
        captureFrameKey={movieFrame()} onCaptureReady={movie.onCaptureReady} captureError={result.error()}
        movieCursor={{ time: props.time * props.task.general.timeStep, step: props.time }}
        yLabel={`${HISTORY_QUANTITIES.flux.label}, ${HISTORY_QUANTITIES.flux.unit}`}
        toolbar={<strong>Потокосцепление</strong>}
        toolbarEnd={result.loading() ? <span role="status">Чтение потокосцеплений…</span> : null}
        status={result.error()} emptyText={emptyText()} />
    </section>
  </div>;
}
