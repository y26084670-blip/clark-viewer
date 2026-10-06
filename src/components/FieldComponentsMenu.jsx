import { createEffect, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { FIELD_LINE_COMPONENTS, normalizeFieldLineComponents } from "../services/results/fieldLineComponents.js";
import "./FieldComponentsMenu.css";

/** Only FieldLines uses this multi-select; QuantitySelect/FieldAreas stay unchanged. */
export function FieldComponentsMenu(props) {
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal({ left: 8, top: 8 });
  const id = createUniqueId();
  let trigger, panel;
  const selected = () => normalizeFieldLineComponents(props.value);
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus && !props.disabled) trigger?.focus();
  };
  function place() {
    const bounds = trigger?.getBoundingClientRect();
    if (!bounds) return;
    const width = 184, height = panel?.offsetHeight || 172;
    const top = bounds.bottom + 4 + height <= window.innerHeight - 8
      ? bounds.bottom + 4 : Math.max(8, bounds.top - height - 4);
    setPosition({ left: Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8)), top });
  }
  function show(focusLast = false) {
    if (props.disabled) return;
    place(); setOpen(true);
    queueMicrotask(() => {
      if (!open()) return;
      place();
      const inputs = panel?.querySelectorAll("input");
      inputs?.[focusLast ? inputs.length - 1 : 0]?.focus();
    });
  }
  function toggleComponent(value, checked) {
    if (props.disabled) return;
    const next = selected().filter(item => item !== value);
    if (checked) next.push(value);
    props.onChange(normalizeFieldLineComponents(next));
  }
  function triggerKey(event) {
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault(); show(event.key === "ArrowUp");
    }
  }
  function panelKey(event) {
    const inputs = [...(panel?.querySelectorAll("input") ?? [])];
    let index = inputs.indexOf(event.target);
    if (event.key === "ArrowDown") index = (index + 1) % inputs.length;
    else if (event.key === "ArrowUp") index = (index + inputs.length - 1) % inputs.length;
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = inputs.length - 1;
    else return;
    event.preventDefault(); inputs[index]?.focus();
  }
  createEffect(() => { if (props.disabled) close(); });
  createEffect(() => {
    if (!open()) return;
    const outside = event => {
      const path = event.composedPath?.() ?? [];
      if (!path.includes(trigger) && !path.includes(panel)
        && !trigger?.contains(event.target) && !panel?.contains(event.target)) close();
    };
    const escape = event => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault(); event.stopPropagation(); close(true);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    });
  });
  return <>
    <button type="button" ref={trigger} class="field-components-trigger"
      aria-expanded={open()} aria-controls={id} disabled={props.disabled}
      title={`Компоненты: ${FIELD_LINE_COMPONENTS.filter(item => selected().includes(item.value)).map(item => item.label).join(", ") || "не выбраны"}`}
      onClick={() => open() ? close() : show()} onKeyDown={triggerKey}>
      Компоненты <span aria-hidden="true">▾</span>
    </button>
    <Show when={open()}><Portal>
      <div ref={panel} id={id} class="field-components-panel" role="group" aria-label="Компоненты поля"
        style={{ left: `${position().left}px`, top: `${position().top}px` }} onKeyDown={panelKey}>
        <For each={FIELD_LINE_COMPONENTS}>{item => <label>
          <input type="checkbox" value={item.value} checked={selected().includes(item.value)} disabled={props.disabled}
            onChange={event => toggleComponent(item.value, event.currentTarget.checked)} />
          <span>{item.label}</span>
        </label>}</For>
      </div>
    </Portal></Show>
  </>;
}
