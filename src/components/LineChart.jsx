import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import Chart from "chart.js/auto";

const colors = ["#1776bd", "#d94943", "#289447", "#994bbc", "#db8b19", "#15a2a2"];
export function LineChart(props) {
  let canvas, chart;
  const [ready, setReady] = createSignal(false);
  const [menu, setMenu] = createSignal(null);
  const [message, setMessage] = createSignal("");
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
    chart?.destroy();
    chart = new Chart(canvas, { type: "scatter", data: { datasets }, options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      scales: { x: { type: "linear", ticks: integerX ? { precision: 0 } : {}, title: { display: true, text: xLabel } },
        y: { title: { display: true, text: yLabel } } },
      plugins: { legend: { display: true, position: "top" }, tooltip: { callbacks: {
        title: items => items[0]?.dataset.label ?? "",
        label: context => series[context.datasetIndex]?.tooltip?.(context.raw)
          ?? `${context.parsed.x}, ${context.parsed.y}`,
      } } },
    } });
  });
  onCleanup(() => chart?.destroy());
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
  return <div class="line-chart" onClick={() => setMenu(null)} onContextMenu={event => {
    event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect();
    setMenu({ x: Math.min(event.clientX - bounds.left, Math.max(0, bounds.width - 200)), y: Math.min(event.clientY - bounds.top, Math.max(0, bounds.height - 100)) });
  }}>
    <canvas ref={canvas} aria-label={`${props.yLabel ?? "График"} от ${props.xLabel ?? "координаты"}`} />
    <Show when={!(props.series?.length)}><div class="plot-empty">{props.emptyText || "Выберите объект и величину"}</div></Show>
    <Show when={menu()}><div class="chart-menu" style={{ left: `${menu().x}px`, top: `${menu().y}px` }}>
      <button onClick={copyTable}>Копировать таблицу</button><button onClick={copyImage}>Копировать картинку</button>
    </div></Show>
    <Show when={message()}><button class="copy-message" onClick={() => setMessage("")}>{message()}</button></Show>
  </div>;
}
