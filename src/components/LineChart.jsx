import { createEffect, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import Chart from "chart.js/auto";

const colors = ["#1776bd", "#d94943", "#289447", "#994bbc", "#db8b19", "#15a2a2"];
const limitFields = [
  { key: "xMin", label: "X min" }, { key: "xMax", label: "X max" },
  { key: "yMin", label: "Y min" }, { key: "yMax", label: "Y max" },
];
const emptyLimits = () => ({ xMin: "", xMax: "", yMin: "", yMax: "" });
export function LineChart(props) {
  let canvas, chart;
  const [ready, setReady] = createSignal(false);
  const [menu, setMenu] = createSignal(null);
  const [message, setMessage] = createSignal("");
  const [draftLimits, setDraftLimits] = createSignal(emptyLimits());
  const [limits, setLimits] = createSignal({});
  const [limitError, setLimitError] = createSignal("");
  function resetLimits() {
    setDraftLimits(emptyLimits()); setLimits({}); setLimitError("");
  }
  // Keep the chosen range when time or data changes, but reset it for different axes.
  createEffect(on(() => [props.xLabel, props.yLabel, props.integerX], resetLimits));
  onMount(() => setReady(true));
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
    chart?.destroy();
    chart = new Chart(canvas, { type: "scatter", data: { datasets }, options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      scales: { x: { type: "linear", min: range.xMin, max: range.xMax,
        ticks: integerX ? { precision: 0 } : {}, title: { display: true, text: xLabel } },
        y: { min: range.yMin, max: range.yMax, title: { display: true, text: yLabel } } },
      plugins: { legend: { display: true, position: "top" }, tooltip: { callbacks: {
        title: items => items[0]?.dataset.label ?? "",
        label: context => series[context.datasetIndex]?.tooltip?.(context.raw)
          ?? `${context.parsed.x}, ${context.parsed.y}`,
      } } },
    } });
  });
  createEffect(() => {
    const range = limits();
    if (!ready() || !chart) return;
    Object.assign(chart.options.scales.x, { min: range.xMin, max: range.xMax });
    Object.assign(chart.options.scales.y, { min: range.yMin, max: range.yMax });
    chart.update("none");
  });
  onCleanup(() => chart?.destroy());
  function applyLimits(event) {
    event.preventDefault();
    if ([...event.currentTarget.querySelectorAll("input")].some(input => input.validity.badInput)) {
      setLimitError("Введите числовые пределы или оставьте поля пустыми."); return;
    }
    const next = {};
    for (const { key } of limitFields) {
      const value = draftLimits()[key].trim();
      if (!value) continue;
      next[key] = Number(value);
      if (!Number.isFinite(next[key])) {
        setLimitError("Пределы должны быть конечными числами."); return;
      }
    }
    for (const axis of ["x", "y"]) {
      if (next[`${axis}Min`] !== undefined && next[`${axis}Max`] !== undefined
        && next[`${axis}Min`] >= next[`${axis}Max`]) {
        setLimitError(`Для оси ${axis.toUpperCase()} минимум должен быть меньше максимума.`); return;
      }
    }
    setLimits(next); setLimitError("");
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
    <form class="chart-scale-controls" onSubmit={applyLimits} noValidate>
      <span>Масштаб:</span>
      <For each={limitFields}>{field => <label>{field.label}
        <input type="number" step="any" placeholder="авто" aria-label={field.label}
          title="Пустое поле — автоматический предел" value={draftLimits()[field.key]}
          onInput={event => {
            const value = event.currentTarget.value;
            setDraftLimits(previous => ({ ...previous, [field.key]: value })); setLimitError("");
          }} />
      </label>}</For>
      <button type="submit">Применить</button>
      <button type="button" onClick={resetLimits} title="Автоматические пределы по обеим осям">Авто</button>
      <Show when={limitError()}><div class="chart-scale-error" role="alert">{limitError()}</div></Show>
    </form>
    <div class="line-chart-canvas" onContextMenu={event => {
      event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect();
      setMenu({ x: Math.min(event.clientX - bounds.left, Math.max(0, bounds.width - 200)), y: Math.min(event.clientY - bounds.top, Math.max(0, bounds.height - 100)) });
    }}>
      <canvas ref={canvas} aria-label={`${props.yLabel ?? "График"} от ${props.xLabel ?? "координаты"}`} />
      <Show when={!(props.series?.length)}><div class="plot-empty">{props.emptyText || "Выберите объект и величину"}</div></Show>
      <Show when={menu()}><div class="chart-menu" style={{ left: `${menu().x}px`, top: `${menu().y}px` }}>
        <button onClick={copyTable}>Копировать таблицу</button><button onClick={copyImage}>Копировать картинку</button>
      </div></Show>
      <Show when={message()}><button class="copy-message" onClick={() => setMessage("")}>{message()}</button></Show>
    </div>
  </div>;
}
