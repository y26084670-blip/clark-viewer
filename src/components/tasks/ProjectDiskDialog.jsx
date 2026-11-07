import { createEffect, Show } from "solid-js";

export function ProjectDiskDialog(props) {
  let dialog, picker, proceed, closeButton;
  createEffect(() => {
    if (!props.open) {
      if (dialog.open) dialog.close();
      return;
    }
    if (!dialog.open) dialog.showModal();
    // Restoring a saved disk temporarily disables the focused picker after F5.
    if (!props.busy && (document.activeElement === dialog || !dialog.contains(document.activeElement))) {
      picker.focus();
    }
  });
  async function confirmAccess(action, retryButton) {
    const confirmed = await action();
    if (!dialog.open || props.busy) return;
    if (!confirmed) retryButton.focus();
    else if (props.count) proceed.focus();
    else closeButton.focus();
  }
  return <dialog ref={dialog} class="task-selection-error-dialog task-disk-dialog" aria-labelledby="project-disk-title"
    onCancel={event => { event.preventDefault(); if (!props.busy) props.onClose(); }}>
    <h2 id="project-disk-title">Доступ к проектам</h2>
    <p>Выберите диск с проектами и разрешите чтение и запись.</p>
    <p>Каталоги clark.* с проектами появятся в верхнем списке.</p>
    <div class="task-disk-dialog-row">
      <button ref={picker} type="button" autofocus onClick={() => confirmAccess(props.onPick, picker)} disabled={props.busy || props.picked}>Выбрать диск с проектами</button>
      <p>Выбрано каталогов: {props.count}</p>
    </div>
    <Show when={props.pending}><button type="button" disabled={props.busy} onClick={event => confirmAccess(props.onAllow, event.currentTarget)}>
      Разрешить доступ к диску «{props.pending.name}»</button></Show>
    <Show when={props.notice}><p role="status" aria-live="polite">{props.notice}</p></Show>
    <div class="task-disk-dialog-actions">
      <button ref={proceed} type="button" disabled={props.busy || !props.count} onClick={props.onClose}>Продолжить</button>
      <button ref={closeButton} type="button" disabled={props.busy} onClick={props.onClose}>Закрыть</button>
    </div>
  </dialog>;
}
