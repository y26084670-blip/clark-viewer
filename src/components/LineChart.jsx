import { createEffect, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js";
import Chart from "chart.js/auto";
import { chartPanLimits, chartZoomLimits, clampChartPoint } from "../services/visualization/chartZoom.js";

const colors = ["#1776bd", "#d94943", "#289447", "#994bbc", "#db8b19", "#15a2a2"];
export function LineChart(props) {
  let canvas, chart, drag, skipContextMenu = false;
  const [ready, setReady] = createSignal(false);
  const [menu, setMenu] = createSignal(null);
  const [message, setMessage] = createSignal("");
  const [limits, setLimits] = createSignal({});
  const [showLegend, setShowLegend] = createSignal(false);
  const [selection, setSelection] = createSignal(null);
  const [panning, setPanning] = createSignal(false);
  function applyChartLimits(range) {
    if (!chart) return;
    Object.assign(chart.options.scales.x, { min: range.xMin, max: range.xMax });
    Object.assign(chart.options.scales.y, { min: range.yMin, max: range.yMax });
    chart.update("none");
  }
  function releaseSelection() {
    const finished = drag, pointerId = finished?.pointerId;
    drag = null; setSelection(null); setPanning(false);
    // Some browsers emit contextmenu on press, others after pointerup.
    if (finished?.mode === "pan") {
      skipContextMenu = !finished.contextMenuSeen;
    }
    if (pointerId !== undefined && canvas?.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    return finished;
  }
  function cancelSelection() {
    const finished = releaseSelection();
    if (finished?.mode === "pan" && finished.currentLimits) applyChartLimits(finished.previousLimits);
  }
  function resetLimits() {
    cancelSelection(); setLimits({});
  }
  // Keep the chosen range when time or data changes, but reset it for different axes.
  createEffect(on(() => [props.xLabel, props.yLabel, props.integerX], resetLimits));
  const cancelOnEscape = event => {
    if (!event.defaultPrevented && !event.isComposing && event.code === "Escape") cancelSelection();
  };
  onMount(() => { window.addEventListener("keydown", cancelOnEscape); setReady(true); });
  createEffect(() => {
    const series = props.series ?? [];
    const marker = props.marker;
    const xLabel = props.xLabel, yLabel = props.yLabel, integerX = props.integerX;
    if (!ready()) return;
    const datasets = series.map((item, index) => ({ label: item.label,
      data: item.points, borderColor: colors[index % colors.length], backgroundColor: colors[index % colors.length],
      showLine: item.showLine ?? true, pointRadius: item.pointRadius ?? (item.points.length === 1 ? 4 : 0),
      pointHitRadius: 5, borderWidth: item.borderWidth ?? 1.6, spanGaps: false,
      order: item.showLine === false ? 1 : 2 }));
    if (marker?.points?.length) datasets.push({ label: "Текущий момент", data: marker.points,
      borderColor: "#161616", backgroundColor: "#f0ac24", pointRadius: 6, showLine: false });
    const range = untrack(limits);
    cancelSelection();
    chart?.destroy();
    chart = new Chart(canvas, { type: "scatter", data: { datasets },
      plugins: [{ id: "selectionFrame", beforeEvent: () => drag ? false : undefined }], options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      onResize: cancelSelection,
      scales: { x: { type: "linear", min: range.xMin, max: range.xMax,
        ticks: integerX ? { precision: 0 } : {}, title: { display: true, text: xLabel } },
        y: { min: range.yMin, max: range.yMax, title: { display: true, text: yLabel } } },
      plugins: { legend: { display: untrack(showLegend), position: "top" }, tooltip: { callbacks: {
        title: items => items[0]?.dataset.label ?? "",
        label: context => series[context.datasetIndex]?.tooltip?.(context.raw)
          ?? `${context.parsed.x}, ${context.parsed.y}`,
      } } },
    } });
  });
  createEffect(() => {
    const range = limits(), legend = showLegend();
    if (!ready() || !chart) return;
    cancelSelection();
    chart.options.plugins.legend.display = legend;
    applyChartLimits(range);
  });
  onCleanup(() => {
    cancelSelection(); window.removeEventListener("keydown", cancelOnEscape); chart?.destroy();
  });
  function chartPoint(event) {
    const bounds = canvas.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * chart.width / bounds.width,
      y: (event.clientY - bounds.top) * chart.height / bounds.height };
  }
  function startSelection(event) {
    skipContextMenu = false;
    if (![0, 2].includes(event.button) || event.isPrimary === false || !chart?.chartArea || !props.series?.some(series => series.points.length)) return;
    const point = chartPoint(event), area = chart.chartArea;
    if (point.x < area.left || point.x > area.right || point.y < area.top || point.y > area.bottom) return;
    cancelSelection(); setMenu(null); event.preventDefault();
    const mode = event.button === 2 ? "pan" : "zoom";
    drag = { pointerId: event.pointerId, mode, start: point, area: { ...area },
      previousLimits: { ...untrack(limits) },
      startLimits: { xMin: chart.scales.x.min, xMax: chart.scales.x.max,
        yMin: chart.scales.y.min, yMax: chart.scales.y.max } };
    setPanning(mode === "pan");
    canvas.setPointerCapture(event.pointerId);
    chart.setActiveElements([]); chart.tooltip?.setActiveElements([], point); chart.draw();
    updateDrag(point);
  }
  function updateDrag(current) {
    if (drag.mode === "pan") {
      if (!drag.moved && Math.hypot(current.x - drag.start.x, current.y - drag.start.y) < 3) return;
      const range = chartPanLimits(drag.start, current, drag.area, drag.startLimits);
      if (range) {
        drag.moved = true; drag.currentLimits = range;
        // Preview directly: committing the signal here would cancel pointer capture
        // through the effect that handles Auto, legend and external range changes.
        applyChartLimits(range);
      }
      return;
    }
    const point = clampChartPoint(current, drag.area);
    // Percentages keep the overlay aligned with the canvas's logical pixel size,
    // including high-DPI displays and CSS scaling.
    setSelection({ left: `${100 * Math.min(drag.start.x, point.x) / chart.width}%`,
      top: `${100 * Math.min(drag.start.y, point.y) / chart.height}%`,
      width: `${100 * Math.abs(point.x - drag.start.x) / chart.width}%`,
      height: `${100 * Math.abs(point.y - drag.start.y) / chart.height}%` });
  }
  function updateSelection(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (!(event.buttons & (drag.mode === "pan" ? 2 : 1))) { cancelSelection(); return; }
    updateDrag(chartPoint(event));
  }
  function finishSelection(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.mode === "pan") {
      event.preventDefault(); updateDrag(chartPoint(event));
      const finished = releaseSelection();
      if (finished?.moved) setLimits(finished.currentLimits);
      else if (finished) openChartMenu(event);
      return;
    }
    const range = chartZoomLimits(drag.start, chartPoint(event), drag.area, chart.scales);
    releaseSelection();
    if (range) setLimits(range);
  }
  function cancelPointerSelection(event) {
    if (drag?.pointerId === event.pointerId) cancelSelection();
  }
  function openChartMenu(event) {
    const bounds = canvas.parentElement.getBoundingClientRect();
    setMenu({ x: Math.max(0, Math.min(event.clientX - bounds.left, bounds.width - 200)),
      y: Math.max(0, Math.min(event.clientY - bounds.top, bounds.height - 100)) });
  }
  function handleContextMenu(event) {
    event.preventDefault();
    if (drag?.mode === "pan") { drag.contextMenuSeen = true; return; }
    if (skipContextMenu) { skipContextMenu = false; return; }
    cancelSelection(); openChartMenu(event);
  }
  async function copyTable() {
    try {
      const rows = [["Кривая", props.xLabel, props.yLabel].join("\t")];
      for (const series of props.series ?? []) for (const p of series.points) rows.push([series.label, p.x, p.y].join("\t"));
      await navigator.clipboard.writeText(rows.join("\n")); setMessage("Таблица скопирована");
    } catch (error) { setMessage(`Не удалось скопировать: ${error.message}`); }
    setMenu(null);
  }
  async function copyImage() {
    try {
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); setMessage("Картинка скопирована");
    } catch (error) { setMessage(`Не удалось скопировать: ${error.message}`); }
    setMenu(null);
  }
  return <div class="line-chart" onClick={() => setMenu(null)}>
    <div class="plot-toolbar chart-toolbar">
      {props.toolbar}
      <div class="chart-scale-controls">
        {props.toolbarEnd}
        <button type="button" onClick={resetLimits} title="Автоматические пределы по обеим осям">Авто</button>
        <label><input type="checkbox" checked={showLegend()} onChange={event => setShowLegend(event.currentTarget.checked)} />Показать легенду</label>
      </div>
    </div>
    <Show when={props.status}><div class="plot-status" role="status">{props.status}</div></Show>
    <div class="line-chart-canvas" onPointerDown={() => { skipContextMenu = false; }} onContextMenu={handleContextMenu}>
      <canvas ref={canvas} aria-label={`${props.yLabel ?? "График"} от ${props.xLabel ?? "координаты"}`}
        classList={{ "chart-panning": panning() }}
        title="Левая кнопка — рамка увеличения; удерживайте правую кнопку для перемещения. Правый щелчок — копирование. Esc — отмена, Авто — весь график."
        onPointerDown={startSelection} onPointerMove={updateSelection} onPointerUp={finishSelection}
        onPointerCancel={cancelPointerSelection} onLostPointerCapture={cancelPointerSelection} />
      <Show when={selection()}><div class="chart-selection-frame" style={selection()} /></Show>
      <Show when={!(props.series?.length)}><div class="plot-empty">{props.emptyText || "Выберите объект и величину"}</div></Show>
      <Show when={menu()}><div class="chart-menu" style={{ left: `${menu().x}px`, top: `${menu().y}px` }}>
        <button onClick={copyTable}>Копировать таблицу</button><button onClick={copyImage}>Копировать картинку</button>
      </div></Show>
      <Show when={message()}><button class="copy-message" onClick={() => setMessage("")}>{message()}</button></Show>
    </div>
  </div>;
}
