import { createEffect, createSignal, createUniqueId, For, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import {
  GEOMETRY_MATERIAL_KINDS,
  geometryMaterialColor,
} from "../../services/visualization/geometryMaterialStyle.js";
import "./GeometryMaterialLegend.css";

const MATERIAL_LABELS = [
  [GEOMETRY_MATERIAL_KINDS.FMM_INSULATING, "ФММ без проводимости"],
  [GEOMETRY_MATERIAL_KINDS.FMM_CONDUCTIVE, "ФММ с проводимостью"],
  [GEOMETRY_MATERIAL_KINDS.NONMAGNETIC_CONDUCTIVE, "Немагнитный проводник"],
  [GEOMETRY_MATERIAL_KINDS.HTSC_MAGNETIC, "ВТСП: магнитная подсистема"],
  [GEOMETRY_MATERIAL_KINDS.HTSC_CURRENT, "ВТСП: токовая подсистема"],
  [GEOMETRY_MATERIAL_KINDS.HTSC_BOTH, "ВТСП: обе подсистемы"],
  [GEOMETRY_MATERIAL_KINDS.PRESCRIBED_MAGNETIZATION, "Заданная намагниченность"],
  [GEOMETRY_MATERIAL_KINDS.PRESCRIBED_CURRENT, "Заданный ток"],
  [GEOMETRY_MATERIAL_KINDS.VIRTUAL, "Виртуальный объём"],
  [GEOMETRY_MATERIAL_KINDS.NEUTRAL, "Нейтральный элемент"],
];

export function GeometryMaterialLegend(props) {
  const [open, setOpen] = createSignal(false);
  const titleId = createUniqueId();
  const dialogId = `${titleId}-dialog`;
  let dialog, button, closeButton;

  createEffect(() => {
    const isOpen = open();
    if (!dialog) return;
    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
        closeButton?.focus();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  });

  onCleanup(() => {
    if (dialog?.open) dialog.close();
  });

  return <>
    <button type="button" ref={element => (button = element)}
      class={`${props.buttonClass ?? ""} geometry-material-help-button`}
      title="Цвета объёмных элементов" aria-label="Цвета объёмных элементов"
      aria-haspopup="dialog" aria-controls={dialogId} aria-expanded={open()}
      onClick={() => { props.onOpen?.(); setOpen(true); }}>?</button>
    <Portal>
      <dialog ref={element => (dialog = element)} id={dialogId}
        class="geometry-material-legend" aria-labelledby={titleId}
        onKeyDown={event => event.stopPropagation()}
        onClose={() => { setOpen(false); button?.focus(); }}
        onClick={event => {
          if (event.target !== dialog) return;
          const bounds = dialog.getBoundingClientRect();
          if (event.clientX < bounds.left || event.clientX > bounds.right
            || event.clientY < bounds.top || event.clientY > bounds.bottom) setOpen(false);
        }}>
        <h2 id={titleId}>Цвета объёмных элементов</h2>
        <ul class="geometry-material-legend-list">
          <For each={MATERIAL_LABELS}>{([kind, label]) =>
            <li class="geometry-material-legend-row">
              <span class="geometry-material-legend-swatch" aria-hidden="true"
                style={{ "background-color": `#${geometryMaterialColor(kind).toString(16).padStart(6, "0")}` }} />
              <span>{label}</span>
            </li>}
          </For>
        </ul>
        <p class="geometry-material-legend-note">
          Исходные элементы показаны более тёмным оттенком; образы симметрии — цветами легенды.
        </p>
        <button type="button" ref={element => (closeButton = element)}
          class="geometry-material-legend-close" onClick={() => setOpen(false)}>Закрыть</button>
      </dialog>
    </Portal>
  </>;
}
