import { createEffect, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js";
import Chart from "chart.js/auto";
import { chartZoomLimits, clampChartPoint } from "../services/visualization/chartZoom.js";

const colors = ["#1776bd", "#d94943", "#289447", "#994bbc", "#db8b19", "#15a2a2"];
export function LineChart(props) {
  let canvas, chart, drag;
  const [ready, setReady] = createSignal(false);
  const [menu, setMenu] = createSignal(null);
  const [message, setMessage] = createSignal("");
  const [limits, setLimits] = createSignal({});
  const [showLegend, setShowLegend] = createSignal(false);
  const [selection, setSelection] = createSignal(null);
  function cancelSelection() {
    const pointerId = drag?.pointerId;
    drag = null; setSelection(null);
    if (pointerId !== undefined && canvas?.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
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
    Object.assign(chart.options.scales.x, { min: range.xMin, max: range.xMax });
    Object.assign(chart.options.scales.y, { min: range.yMin, max: range.yMax });
    chart.options.plugins.legend.display = legend;
    chart.update("none");
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
    if (event.button !== 0 || event.isPrimary === false || !chart?.chartArea || !props.series?.some(series => series.points.length)) return;
    const point = chartPoint(event), area = chart.chartArea;
    if (point.x < area.left || point.x > area.right || point.y < area.top || point.y > area.bottom) return;
    cancelSelection(); setMenu(null); event.preventDefault();
    drag = { pointerId: event.pointerId, start: point, area: { ...area } };
    canvas.setPointerCapture(event.pointerId);
    chart.setActiveElements([]); chart.tooltip?.setActiveElements([], point); chart.draw();
    updateSelection(event);
  }
  function updateSelection(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const point = clampChartPoint(chartPoint(event), drag.area);
    // Percentages keep the overlay aligned with the canvas's logical pixel size,
    // including high-DPI displays and CSS scaling.
    setSelection({ left: `${100 * Math.min(drag.start.x, point.x) / chart.width}%`,
      top: `${100 * Math.min(drag.start.y, point.y) / chart.height}%`,
      width: `${100 * Math.abs(point.x - drag.start.x) / chart.width}%`,
      height: `${100 * Math.abs(point.y - drag.start.y) / chart.height}%` });
  }
  function finishSelection(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const range = chartZoomLimits(drag.start, chartPoint(event), drag.area, chart.scales);
    cancelSelection();
    if (range) setLimits(range);
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
    <div class="chart-scale-controls">
      <button type="button" onClick={resetLimits} title="Автоматические пределы по обеим осям">Авто</button>
      <label><input type="checkbox" checked={showLegend()} onChange={event => setShowLegend(event.currentTarget.checked)} />Показать легенду</label>
    </div>
    <div class="line-chart-canvas" onContextMenu={event => {
      event.preventDefault(); cancelSelection(); const bounds = event.currentTarget.getBoundingClientRect();
      setMenu({ x: Math.min(event.clientX - bounds.left, Math.max(0, bounds.width - 200)), y: Math.min(event.clientY - bounds.top, Math.max(0, bounds.height - 100)) });
    }}>
      <canvas ref={canvas} aria-label={`${props.yLabel ?? "График"} от ${props.xLabel ?? "координаты"}`}
        title="Выделите рамкой область графика для увеличения. Esc — отмена, Авто — весь график."
        onPointerDown={startSelection} onPointerMove={updateSelection} onPointerUp={finishSelection}
        onPointerCancel={cancelSelection} onLostPointerCapture={cancelSelection} />
      <Show when={selection()}><div class="chart-selection-frame" style={selection()} /></Show>
      <Show when={!(props.series?.length)}><div class="plot-empty">{props.emptyText || "Выберите объект и величину"}</div></Show>
      <Show when={menu()}><div class="chart-menu" style={{ left: `${menu().x}px`, top: `${menu().y}px` }}>
        <button onClick={copyTable}>Копировать таблицу</button><button onClick={copyImage}>Копировать картинку</button>
      </div></Show>
      <Show when={message()}><button class="copy-message" onClick={() => setMessage("")}>{message()}</button></Show>
    </div>
  </div>;
}
