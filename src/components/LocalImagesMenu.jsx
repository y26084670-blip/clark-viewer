import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import "./LocalImagesMenu.css";

export function LocalImagesMenu(props) {
  const [open, setOpen] = createSignal(false);
  let root, trigger;
  createEffect(() => {
    if (props.disabled) setOpen(false);
    if (!open()) return;
    const outside = event => { if (!root?.contains(event.target)) setOpen(false); };
    const escape = event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger?.focus(); }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    root.addEventListener("keydown", escape);
    onCleanup(() => { document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside); root.removeEventListener("keydown", escape); });
  });
  return <div ref={root} class="local-images-menu">
    <button ref={trigger} type="button" aria-expanded={open()} disabled={props.disabled} onClick={() => setOpen(value => !value)}
      onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); queueMicrotask(() => root.querySelector("input")?.focus()); } }}>
      Локальные образы ▾</button>
    <Show when={open()}><div class="local-images-panel" role="group" aria-label="Локальные образы">
      <label><input type="checkbox" checked={props.all} onChange={event => props.onAll(event.currentTarget.checked)} />Все локальные образы</label>
      <label>Локальный образ <input type="number" min="1" max={props.count} step="1" value={props.value + 1}
        aria-label="Номер локального образа LS" disabled={props.all || props.empty}
        onChange={event => {
          const value = event.currentTarget.valueAsNumber;
          const next = Number.isFinite(value) ? Math.max(1, Math.min(props.count, Math.trunc(value))) : props.value + 1;
          event.currentTarget.value = String(next); props.onValue(next - 1);
        }} /><span>из {props.count}</span></label>
    </div></Show>
  </div>;
}
