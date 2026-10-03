import { batch, createEffect, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js";
import Chart from "chart.js/auto";
import { captureMovieCanvas } from "../services/movie/movieCanvas.js";
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
  let movieState = null, renderedFrameKey = null, currentMovieCursor = null, disposed = false;
  let pendingVisibility = null, drawingFailure = null;
  const renderWaiters = new Set();
  const [capturing, setCapturing] = createSignal(false);
  const [renderError, setRenderError] = createSignal("");
  const [ready, setReady] = createSignal(false);
  const [menu, setMenu] = createSignal(null);
  const [message, setMessage] = createSignal("");
  const [limits, setLimits] = createSignal({});
  const [autoScale, setAutoScale] = createSignal(true);
  const [showLegend, setShowLegend] = createSignal(false);
  const [selection, setSelection] = createSignal(null);
  const [panning, setPanning] = createSignal(false);
  const [legendHover, setLegendHover] = createSignal(false);
  function applyChartLimits(range) {
    if (!chart) return;
    range = movieState?.range ?? range;
    Object.assign(chart.options.scales.x, { min: range.xMin, max: range.xMax });
    Object.assign(chart.options.scales.y, { min: range.yMin, max: range.yMax });
    try {
      chart.update("none");
      drawingFailure = null; setRenderError("");
      return true;
    } catch (error) { recordRenderFailure(error); return false; }
  }
  function recordRenderFailure(error) {
    drawingFailure = error instanceof Error ? error : new Error(String(error));
    renderedFrameKey = null; setRenderError(`График недоступен: ${drawingFailure.message}`);
    rejectRenderWaiters(drawingFailure);
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
    if (movieState || !props.autoScaleToggle || untrack(autoScale) || !autoPending || !chart
      || !currentSeries.some(series => series.points.some(point => Number.isFinite(point.x) && Number.isFinite(point.y)))) return;
    autoPending = false;
    setLimits({ xMin: chart.scales.x.min, xMax: chart.scales.x.max,
      yMin: chart.scales.y.min, yMax: chart.scales.y.max });
  }
  function resetLimits() {
    if (movieState) return;
    cancelSelection(); autoPending = true; setLimits({});
  }
  function toggleAutoScale() {
    if (movieState) return;
    if (!props.autoScaleToggle) { resetLimits(); return; }
    cancelSelection();
    const enabled = !untrack(autoScale);
    batch(() => {
      setAutoScale(enabled); autoPending = true;
      setLimits({});
      // Turning Auto off freezes the actual displayed axes, including tick padding.
      // Before the first valid frame, defer the snapshot until it arrives.
      if (!enabled) captureAutoLimits();
    });
  }
  function commitManualLimits(range) {
    if (movieState) return;
    autoPending = false;
    batch(() => { if (props.autoScaleToggle) setAutoScale(false); setLimits(range); });
  }
  // Toggle charts keep frozen limits across quantity/axis changes too. Other
  // charts retain their previous reset-on-axis-change behavior.
  createEffect(on(() => [props.xLabel, props.yLabel, props.integerX], () => {
    if (!props.autoScaleToggle) resetLimits();
  }));
  const cancelOnEscape = event => {
    if (!movieState && !event.defaultPrevented && !event.isComposing && event.code === "Escape") cancelSelection();
  };
  onMount(() => {
    props.onCaptureReady?.(captureAdapter);
    window.addEventListener("keydown", cancelOnEscape); setReady(true);
  });
  createEffect(() => {
    const series = props.series ?? [];
    const marker = props.marker;
    const frameKey = props.captureFrameKey;
    const captureError = props.captureError;
    currentMovieCursor = props.movieCursor ?? null;
    renderedFrameKey = null;
    overlayLegend = props.legendMode === "overlay";
    currentSeries = series;
    const xLabel = props.xLabel, yLabel = props.yLabel, integerX = props.integerX;
    if (!ready()) return;
    try {
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
        plugins: [{ id: "selectionFrame", beforeEvent: () => movieState || drag ? false : undefined },
          { id: "movieTimeCursor", afterDatasetsDraw: drawMovieCursor },
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
      }
      applyFrozenVisibility();
      // Chart.js animation is disabled. The identity is published only after the
      // corresponding datasets, cursor and exact axes have been drawn.
      if (!applyChartLimits(range)) return;
      captureAutoLimits();
      renderedFrameKey = frameKey;
      settleRenderWaiters(captureError);
    } catch (error) {
      if (!chart) Chart.getChart?.(canvas)?.destroy();
      recordRenderFailure(error);
    }
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
    disposed = true;
    rejectRenderWaiters(new Error("График закрыт во время записи фильма"));
    props.onCaptureReady?.(null);
    cancelSelection(); window.removeEventListener("keydown", cancelOnEscape); chart?.destroy();
  });

  function abortError() {
    return Object.assign(new Error("Запись фильма отменена"), { name: "AbortError" });
  }
  function assertCaptureSource() {
    if (disposed || !chart || !canvas || !ready()) throw new Error("График ещё не готов к записи фильма");
    if (drawingFailure) throw drawingFailure;
    if (props.captureError) throw new Error(String(props.captureError));
    if (!currentSeries.some((series, index) => chart.isDatasetVisible(index)
      && series.points.some(point => Number.isFinite(point.x) && Number.isFinite(point.y)))) {
      throw new Error("Нет видимых данных для записи фильма");
    }
    if (movieState && (canvas.width !== movieState.width || canvas.height !== movieState.height
      || chart.width !== movieState.logicalWidth || chart.height !== movieState.logicalHeight)) {
      throw new Error("Размер графика изменился во время записи фильма. Повторите запись при неизменном размере окна.");
    }
  }
  function removeWaiter(waiter) {
    renderWaiters.delete(waiter);
    waiter.signal?.removeEventListener("abort", waiter.abort);
  }
  function rejectRenderWaiters(error) {
    for (const waiter of [...renderWaiters]) { removeWaiter(waiter); waiter.reject(error); }
  }
  function settleRenderWaiters(error = props.captureError) {
    if (error) { rejectRenderWaiters(new Error(String(error))); return; }
    for (const waiter of [...renderWaiters]) {
      if (!Object.is(renderedFrameKey, waiter.key)) continue;
      removeWaiter(waiter);
      try { assertCaptureSource(); waiter.resolve(); } catch (error) { waiter.reject(error); }
    }
  }
  function applyFrozenVisibility() {
    const visibility = movieState?.visibility ?? pendingVisibility;
    if (!visibility || !chart) return;
    for (let index = 0; index < chart.data.datasets.length; index++) {
      const key = chart.data.datasets[index]._seriesKey;
      if (visibility.has(key)) chart.setDatasetVisibility(index, visibility.get(key));
      if (!movieState) visibility.delete(key);
    }
    if (!movieState && visibility.size === 0) pendingVisibility = null;
  }
  function clearChartHover() {
    cancelSelection(); setMenu(null); setMessage("");
    chart.setActiveElements([]);
    chart.tooltip?.setActiveElements([], { x: 0, y: 0 });
  }
  function drawMovieCursor(current) {
    const cursor = currentMovieCursor, area = current.chartArea;
    if (!movieState || !cursor || !Number.isFinite(cursor.time) || !area) return;
    const x = current.scales.x.getPixelForValue(cursor.time), ctx = current.ctx;
    if (!Number.isFinite(x)) return;
    ctx.save();
    try {
      ctx.beginPath(); ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top); ctx.clip();
      ctx.strokeStyle = "#303840"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
      ctx.beginPath(); ctx.moveTo(x, area.top); ctx.lineTo(x, area.bottom); ctx.stroke(); ctx.setLineDash([]);
      currentSeries.forEach((series, index) => {
        if (!current.isDatasetVisible(index)) return;
        // Histories carry the solver step explicitly. Never invent an
        // interpolated value for a missing saved instant.
        const point = series.points.find(point => point.step === cursor.step
          && Number.isFinite(point.x) && Number.isFinite(point.y));
        if (!point) return;
        const px = current.scales.x.getPixelForValue(point.x), py = current.scales.y.getPixelForValue(point.y);
        ctx.fillStyle = colors[index % colors.length]; ctx.strokeStyle = "#161616"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      });
    } finally { ctx.restore(); }
  }
  const captureAdapter = {
    prepare({ signal } = {}) {
      if (signal?.aborted) throw abortError();
      if (movieState) throw new Error("Запись этого графика уже выполняется");
      assertCaptureSource(); clearChartHover();
      const range = { xMin: chart.scales.x.min, xMax: chart.scales.x.max,
        yMin: chart.scales.y.min, yMax: chart.scales.y.max };
      if (!Object.values(range).every(Number.isFinite) || range.xMin >= range.xMax || range.yMin >= range.yMax) {
        throw new Error("Пределы графика недоступны для записи фильма");
      }
      movieState = { range, width: canvas.width, height: canvas.height,
        logicalWidth: chart.width, logicalHeight: chart.height,
        responsive: chart.options.responsive,
        devicePixelRatio: (chart.config?.options ?? chart.options).devicePixelRatio,
        hadDevicePixelRatio: Object.hasOwn(chart.config?.options ?? chart.options, "devicePixelRatio"),
        styleWidth: canvas.style.width, styleHeight: canvas.style.height,
        autoPending, limits: { ...untrack(limits) }, autoScale: untrack(autoScale), showLegend: untrack(showLegend),
        visibility: new Map(chart.data.datasets.map((dataset, index) => [dataset._seriesKey, chart.isDatasetVisible(index)])),
      };
      pendingVisibility = null;
      setCapturing(true);
      chart.options.responsive = false;
      chart.options.devicePixelRatio = chart.currentDevicePixelRatio;
      canvas.style.width = `${chart.width}px`; canvas.style.height = `${chart.height}px`;
      applyChartLimits(range);
      assertCaptureSource();
    },
    renderReady(expectedKey, { signal } = {}) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (disposed) return Promise.reject(new Error("График закрыт во время записи фильма"));
      if (drawingFailure) return Promise.reject(drawingFailure);
      if (expectedKey === null || expectedKey === undefined) return Promise.reject(new Error("Нет идентификатора готового кадра графика"));
      if (props.captureError) return Promise.reject(new Error(String(props.captureError)));
      if (Object.is(renderedFrameKey, expectedKey)) {
        try { assertCaptureSource(); return Promise.resolve(); } catch (error) { return Promise.reject(error); }
      }
      return new Promise((resolve, reject) => {
        const waiter = { key: expectedKey, resolve, reject, signal };
        waiter.abort = () => { removeWaiter(waiter); reject(abortError()); };
        renderWaiters.add(waiter); signal?.addEventListener("abort", waiter.abort, { once: true });
      });
    },
    capture(expectedKey, { caption } = {}) {
      if (!movieState || expectedKey === null || expectedKey === undefined || !Object.is(renderedFrameKey, expectedKey)) throw new Error("Запрошенный кадр графика ещё не отрисован");
      assertCaptureSource(); clearChartHover(); applyFrozenVisibility(); applyChartLimits(movieState.range);
      assertCaptureSource();
      return captureMovieCanvas(canvas, { caption, background: "#ffffff" });
    },
    restore() {
      if (!movieState) return;
      const snapshot = movieState; movieState = null;
      setCapturing(false);
      rejectRenderWaiters(new Error("Запись графика завершена"));
      pendingVisibility = new Map(snapshot.visibility);
      if (chart && !disposed) {
        chart.options.responsive = snapshot.responsive;
        if (snapshot.hadDevicePixelRatio) chart.options.devicePixelRatio = snapshot.devicePixelRatio;
        else delete chart.options.devicePixelRatio;
        canvas.style.width = snapshot.styleWidth; canvas.style.height = snapshot.styleHeight;
        applyFrozenVisibility();
        autoPending = snapshot.autoPending;
        batch(() => { setLimits(snapshot.limits); setAutoScale(snapshot.autoScale); setShowLegend(snapshot.showLegend); });
        applyChartLimits(snapshot.limits);
        if (snapshot.responsive) chart.resize();
      }
    },
  };

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
    if (movieState || ![0, 2].includes(event.button) || event.isPrimary === false || !chart?.chartArea || !props.series?.some(series => series.points.length)) return;
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
    if (movieState) return;
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
    if (movieState || !drag || drag.pointerId !== event.pointerId) return;
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
      if (finished?.moved) commitManualLimits(finished.currentLimits);
      else if (finished) openChartMenu(event);
      return;
    }
    const range = chartZoomLimits(drag.start, chartPoint(event), drag.area, chart.scales);
    releaseSelection();
    if (range) commitManualLimits(range);
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
    if (movieState) return;
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
        <button type="button" disabled={capturing()} onClick={toggleAutoScale} aria-pressed={props.autoScaleToggle ? autoScale() : undefined}
          title={props.autoScaleToggle ? (autoScale() ? "Автомасштаб включён: нажмите, чтобы сохранить текущие пределы" : "Автомасштаб выключен: нажмите для автоматического подбора пределов") : "Автоматические пределы по обеим осям"}>Авто</button>
        <Show when={props.legendMode !== "overlay"}>
          <label><input type="checkbox" disabled={capturing()} checked={showLegend()} onChange={event => { if (!movieState) setShowLegend(event.currentTarget.checked); }} />Показать легенду</label>
        </Show>
      </div>
    </div>
    <Show when={props.status}><div class="plot-status" role="status">{props.status}</div></Show>
    <div class="line-chart-canvas" onPointerDown={() => { skipContextMenu = false; }} onContextMenu={handleContextMenu}>
      <canvas ref={canvas} aria-label={`${props.yLabel ?? "График"} от ${props.xLabel ?? "координаты"}`}
        classList={{ "chart-panning": panning(), "chart-legend-hover": legendHover() }}
        onPointerDown={startSelection} onPointerMove={updateSelection} onPointerUp={finishSelection}
        onPointerLeave={() => setLegendHover(false)}
        onPointerCancel={cancelPointerSelection} onLostPointerCapture={cancelPointerSelection} />
      <Show when={selection()}><div class="chart-selection-frame" style={selection()} /></Show>
      <Show when={renderError()}><div class="plot-empty" role="alert">{renderError()}</div></Show>
      <Show when={!renderError() && !(props.series?.length)}><div class="plot-empty">{props.emptyText || "Выберите объект и величину"}</div></Show>
      <Show when={menu()}><div class="chart-menu" style={{ left: `${menu().x}px`, top: `${menu().y}px` }}>
        <button onClick={copyTable}>Копировать таблицу</button><button onClick={copyImage}>Копировать картинку</button>
      </div></Show>
      <Show when={message()}><button class="copy-message" onClick={() => setMessage("")}>{message()}</button></Show>
    </div>
  </div>;
}
