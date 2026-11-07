import { createEffect, createSignal, Show } from "solid-js";
import { resultScaleMidpoint } from "../../services/visualization/resultScalarColors.js";

const compact = value => Number(value.toPrecision(6)).toString();
const numberValue = text => {
  const value = text.trim().replace(",", ".");
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) ? Number(value) : NaN;
};

export function ColorScaleLimits(props) {
  const [draft, setDraft] = createSignal(null);
  const [error, setError] = createSignal("");
  const reset = () => { setDraft(null); setError(""); };
  createEffect(() => { props.task; props.automatic; reset(); });
  const value = which => draft()?.[which] ?? String(props.limits?.[which] ?? props.legend[which]);
  function change(which, text) {
    setDraft({ minimum: value("minimum"), maximum: value("maximum"), [which]: text });
    setError("");
  }
  function apply() {
    if (!draft()) return;
    const min = numberValue(value("minimum")), max = numberValue(value("maximum"));
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
      setError("Введите два конечных числа: минимум должен быть меньше максимума.");
      return;
    }
    props.onChange(min, max);
    reset();
  }
  function bound(which, label) {
    return <input type="text" inputmode="decimal" autocomplete="off" aria-label={label}
      title={label} value={value(which)} aria-invalid={Boolean(error())}
      onInput={event => change(which, event.currentTarget.value)} onChange={apply}
      onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); apply(); }
        if (event.key === "Escape") { event.preventDefault(); reset(); }
        event.stopPropagation();
      }} />;
  }
  return <>
    <div class="geometry-scalar-legend-limits">
      <Show when={!props.automatic} fallback={<span>{compact(props.legend.minimum)}</span>}>
        {bound("minimum", "Нижний предел")}
      </Show>
      <Show when={props.legend.logScale}>
        <span class="geometry-scale-middle" title="Значение в середине цветовой шкалы">{compact(resultScaleMidpoint(props.legend.minimum, props.legend.maximum, props.legend.logScale))}</span>
      </Show>
      <Show when={!props.automatic} fallback={<span>{compact(props.legend.maximum)}</span>}>
        {bound("maximum", "Верхний предел")}
      </Show>
    </div>
    <Show when={error()}><div class="geometry-scale-error" role="status">{error()}</div></Show>
  </>;
}
