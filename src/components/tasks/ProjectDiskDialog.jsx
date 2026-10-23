import { createEffect, Show } from "solid-js";

export function ProjectDiskDialog(props) {
  let dialog, picker;
  createEffect(() => {
    if (props.open) {
      if (!dialog.open) { dialog.showModal(); picker.focus(); }
    } else if (dialog.open) dialog.close();
  });
  return <dialog ref={dialog} class="task-selection-error-dialog task-disk-dialog" aria-labelledby="project-disk-title"
    onCancel={event => { event.preventDefault(); if (!props.busy) props.onClose(); }}>
    <h2 id="project-disk-title">Доступ к проектам</h2>
    <p>Выберите диск с проектами и разрешите чтение и запись. Каталоги clark.* появятся в верхнем списке; clark.app исключён.</p>
    <div class="task-disk-dialog-row">
      <button ref={picker} type="button" onClick={props.onPick} disabled={props.busy}>Выбрать диск с проектами</button>
      <p>{props.disk ? `Выбрано: ${props.disk.name || "корень диска"}. Каталогов: ${props.count}.` : "Диск ещё не выбран."}</p>
    </div>
    <Show when={props.pending}><button type="button" disabled={props.busy} onClick={props.onAllow}>
      Разрешить доступ к диску «{props.pending.name}»</button></Show>
    <Show when={props.notice}><p role="status" aria-live="polite">{props.notice}</p></Show>
    <div class="task-disk-dialog-actions">
      <button type="button" disabled={props.busy || !props.count} onClick={props.onClose}>Продолжить</button>
      <button type="button" disabled={props.busy} onClick={props.onClose}>Закрыть</button>
    </div>
  </dialog>;
}
