import { createEffect, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js";
import Chart from "chart.js/auto";
import { chartPanLimits, chartZoomLimits, clampChartPoint } from "../services/visualization/chartZoom.js";

const colors = ["#1776bd", "#d94943", "#289447", "#994bbc", "#db8b19", "#15a2a2"];

function drawOverlayLegend(chart, series) {
  const area = chart.chartArea;
  const entries = series.flatMap((item, index) => item.points.length
    ? [{ index, label: item.legendLabel ?? item.label, color: colors[index % colors.length], hidden: !chart.isDatasetVisible(index) }] : []);
  if (!area || !entries.length || area.width <= 12 || area.height <= 12) return [];
  const hitBoxes = [];
  const ctx = chart.ctx, padding = 7, squareSize = 12, gap = 7, rowHeight = 18;
  ctx.save();
  try {
    ctx.font = "12px Arial, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const width = Math.min(area.width - 12, 2 * padding + squareSize + gap
      + Math.max(...entries.map(item => ctx.measureText(item.label).width)));
    const height = Math.min(area.height - 12, 2 * padding + rowHeight * entries.length);
    const left = area.right - 6 - width, top = area.top + 6;
    // Clip the overlay itself: even a tiny chart keeps the legend inside its plot.
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.fillRect(left, top, width, height);
    const textWidth = width - 2 * padding - squareSize - gap;
    entries.forEach((item, index) => {
      const y = top + padding + rowHeight * (index + 0.5);
      const xBox = left + padding, yBox = y - squareSize / 2;
      ctx.fillStyle = item.color; ctx.strokeStyle = item.color; ctx.lineWidth = 1;
      ctx.fillRect(xBox, yBox, squareSize, squareSize);
      ctx.strokeRect(xBox + 0.5, yBox + 0.5, squareSize - 1, squareSize - 1);
      // Only the visible part of each square is interactive, including when
      // every dataset is hidden or the chart is too small for the full legend.
      const box = { index: item.index, left: xBox, top: Math.max(top, yBox),
        right: Math.min(left + width, xBox + squareSize), bottom: Math.min(top + height, yBox + squareSize) };
      if (box.right > box.left && box.bottom > box.top) hitBoxes.push(box);
      ctx.fillStyle = "#666";
      if (textWidth > 0) {
        const xText = xBox + squareSize + gap;
        ctx.fillText(item.label, xText, y, textWidth);
        if (item.hidden) {
          ctx.strokeStyle = "#666";
          ctx.beginPath(); ctx.moveTo(xText, y);
          ctx.lineTo(xText + Math.min(textWidth, ctx.measureText(item.label).width), y); ctx.stroke();
        }
      }
    });
  } finally { ctx.restore(); }
  return hitBoxes;
}

export function LineChart(props) {
  let canvas, chart, drag, skipContextMenu = false, legendHitBoxes = [];
  let currentSeries = [], overlayLegend = false, autoPending = true;
  const [ready, setReady] = createSignal(false);
  const [menu, setMenu] = createSignal(null);
  const [message, setMessage] = createSignal("");
  const [limits, setLimits] = createSignal({});
  const [showLegend, setShowLegend] = createSignal(false);
  const [selection, setSelection] = createSignal(null);
  const [panning, setPanning] = createSignal(false);
  const [legendHover, setLegendHover] = createSignal(false);
  function applyChartLimits(range) {
    if (!chart) return;
    Object.assign(chart.options.scales.x, { min: range.xMin, max: range.xMax });
    Object.assign(chart.options.scales.y, { min: range.yMin, max: range.yMax });
    chart.update("none");
  }
  function releaseSelection() {
    const finished = drag, pointerId = finished?.pointerId;
    drag = null; setSelection(null); setPanning(false); setLegendHover(false);
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
  function captureAutoLimits() {
    if (!props.freezeAutoScale || !autoPending || !chart
      || !currentSeries.some(series => series.points.some(point => Number.isFinite(point.x) && Number.isFinite(point.y)))) return;
    autoPending = false;
    setLimits({ xMin: chart.scales.x.min, xMax: chart.scales.x.max,
      yMin: chart.scales.y.min, yMax: chart.scales.y.max });
  }
  function resetLimits() {
    cancelSelection(); autoPending = true; setLimits({});
  }
  // Keep the chosen range when time or data changes, but reset it for different axes.
  createEffect(on(() => [props.xLabel, props.yLabel, props.integerX], () => {
    if (!props.freezeAutoScale) resetLimits();
  }));
  const cancelOnEscape = event => {
    if (!event.defaultPrevented && !event.isComposing && event.code === "Escape") cancelSelection();
  };
  onMount(() => { window.addEventListener("keydown", cancelOnEscape); setReady(true); });
  createEffect(() => {
    const series = props.series ?? [];
    const marker = props.marker;
    overlayLegend = props.legendMode === "overlay";
    currentSeries = series;
    const xLabel = props.xLabel, yLabel = props.yLabel, integerX = props.integerX;
    if (!ready()) return;
    const datasets = series.map((item, index) => ({ _seriesKey: `series:${item.label}:${index}`, label: item.label,
      data: item.points, borderColor: colors[index % colors.length], backgroundColor: colors[index % colors.length],
      showLine: item.showLine ?? true, pointRadius: item.pointRadius ?? (item.points.length === 1 ? 4 : 0),
      pointHitRadius: 5, borderWidth: item.borderWidth ?? 1.6, spanGaps: false,
      order: item.showLine === false ? 1 : 2 }));
    if (marker?.points?.length) datasets.push({ _seriesKey: "marker", label: "Текущий момент", data: marker.points,
      borderColor: "#161616", backgroundColor: "#f0ac24", pointRadius: 6, showLine: false });
    const range = untrack(limits);
    cancelSelection();
    legendHitBoxes = [];
    if (!chart) chart = new Chart(canvas, { type: "scatter", data: { datasets },
      plugins: [{ id: "selectionFrame", beforeEvent: () => drag ? false : undefined },
        { id: "overlayLegend", afterDatasetsDraw: current => {
          legendHitBoxes = overlayLegend ? drawOverlayLegend(current, currentSeries) : [];
        } }], options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      onResize: cancelSelection,
      scales: { x: { type: "linear", min: range.xMin, max: range.xMax,
        ticks: integerX ? { precision: 0 } : {}, title: { display: true, text: xLabel } },
        y: { min: range.yMin, max: range.yMax, title: { display: true, text: yLabel } } },
      plugins: { legend: { display: !overlayLegend && untrack(showLegend), position: "top" }, tooltip: { callbacks: {
        title: items => items[0]?.dataset.label ?? "",
        label: context => currentSeries[context.datasetIndex]?.tooltip?.(context.raw)
          ?? `${context.parsed.x}, ${context.parsed.y}`,
      } } },
    } });
    else {
      // Keep the canvas, Chart instance and dataset metadata (including visibility).
      const previous = new Map(chart.data.datasets.map(dataset => [dataset._seriesKey, dataset]));
      chart.data.datasets = datasets.map(dataset => Object.assign(previous.get(dataset._seriesKey) ?? {}, dataset));
      chart.options.scales.x.title.text = xLabel;
      chart.options.scales.y.title.text = yLabel;
      chart.options.scales.x.ticks = integerX ? { precision: 0 } : {};
      chart.options.plugins.legend.display = !overlayLegend && untrack(showLegend);
      applyChartLimits(range);
    }
    captureAutoLimits();
  });
  createEffect(() => {
    const range = limits(), legend = props.legendMode !== "overlay" && showLegend();
    if (!ready() || !chart) return;
    cancelSelection();
    chart.options.plugins.legend.display = legend;
    applyChartLimits(range);
    captureAutoLimits();
  });
  onCleanup(() => {
    cancelSelection(); window.removeEventListener("keydown", cancelOnEscape); chart?.destroy();
  });
  function chartPoint(event) {
    const bounds = canvas.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * chart.width / bounds.width,
      y: (event.clientY - bounds.top) * chart.height / bounds.height };
  }
  function legendItemAt(point) {
    return legendHitBoxes.find(box => point.x >= box.left && point.x <= box.right
      && point.y >= box.top && point.y <= box.bottom);
  }
  function startSelection(event) {
    skipContextMenu = false;
    if (![0, 2].includes(event.button) || event.isPrimary === false || !chart?.chartArea || !props.series?.some(series => series.points.length)) return;
    const point = chartPoint(event), area = chart.chartArea;
    if (point.x < area.left || point.x > area.right || point.y < area.top || point.y > area.bottom) return;
    const legendItem = event.button === 0 ? legendItemAt(point) : null;
    cancelSelection(); setMenu(null); event.preventDefault();
    const mode = legendItem ? "legend" : event.button === 2 ? "pan" : "zoom";
    drag = { pointerId: event.pointerId, mode, datasetIndex: legendItem?.index, start: point, area: { ...area },
      previousLimits: { ...untrack(limits) },
      startLimits: { xMin: chart.scales.x.min, xMax: chart.scales.x.max,
        yMin: chart.scales.y.min, yMax: chart.scales.y.max } };
    setPanning(mode === "pan");
    setLegendHover(mode === "legend");
    canvas.setPointerCapture(event.pointerId);
    chart.setActiveElements([]); chart.tooltip?.setActiveElements([], point); chart.draw();
    updateDrag(point);
  }
  function updateDrag(current) {
    if (drag.mode === "legend") {
      // A drag that returns to its starting square is still not a click.
      if (Math.hypot(current.x - drag.start.x, current.y - drag.start.y) >= 3) drag.moved = true;
      return;
    }
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
    if (!drag) {
      setLegendHover(Boolean(chart && legendItemAt(chartPoint(event))));
      return;
    }
    if (drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (!(event.buttons & (drag.mode === "pan" ? 2 : 1))) { cancelSelection(); return; }
    updateDrag(chartPoint(event));
  }
  function finishSelection(event) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.mode === "legend") {
      if (event.button !== 0) return;
      event.preventDefault();
      const point = chartPoint(event);
      updateDrag(point);
      const item = legendItemAt(point), finished = releaseSelection();
      if (!finished.moved && item?.index === finished.datasetIndex) {
        chart.setDatasetVisibility(item.index, !chart.isDatasetVisible(item.index));
        chart.update("none");
      }
      setLegendHover(Boolean(legendItemAt(point)));
      return;
    }
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
        <button type="button" onClick={resetLimits} title={props.freezeAutoScale ? "Подобрать пределы по показанным данным и сохранить их при смене времени" : "Автоматические пределы по обеим осям"}>Авто</button>
        <Show when={props.legendMode !== "overlay"}>
          <label><input type="checkbox" checked={showLegend()} onChange={event => setShowLegend(event.currentTarget.checked)} />Показать легенду</label>
        </Show>
      </div>
    </div>
    <Show when={props.status}><div class="plot-status" role="status">{props.status}</div></Show>
    <div class="line-chart-canvas" onPointerDown={() => { skipContextMenu = false; }} onContextMenu={handleContextMenu}>
      <canvas ref={canvas} aria-label={`${props.yLabel ?? "График"} от ${props.xLabel ?? "координаты"}`}
        classList={{ "chart-panning": panning(), "chart-legend-hover": legendHover() }}
        title={`${props.legendMode === "overlay" ? "Щелчок по цветному квадратику легенды — скрыть или показать кривую. " : ""}Левая кнопка — рамка увеличения; удерживайте правую кнопку для перемещения. Правый щелчок — копирование. Esc — отмена, Авто — весь график.`}
        onPointerDown={startSelection} onPointerMove={updateSelection} onPointerUp={finishSelection}
        onPointerLeave={() => setLegendHover(false)}
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
