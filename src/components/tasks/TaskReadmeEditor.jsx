import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { loadTaskReadme, saveTaskReadme, deleteTaskReadme } from "../../services/taskReadmeService.js";
import { TaskMediaDialog } from "./TaskMediaDialog.jsx";

export function TaskReadmeEditor(props) {
  const request = props.request;
  const [snapshot, setSnapshot] = createSignal(null), [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(true), [error, setError] = createSignal("");
  const [discard, setDiscard] = createSignal(false);
  let disposed = false, input;
  const deleting = request.mode === "delete";
  const dirty = () => !deleting && snapshot() && text() !== snapshot().text;
  const close = () => {
    if (busy()) return;
    if (dirty()) setDiscard(true);
    else props.onClose();
  };
  onMount(() => {
    props.onBusyChange?.(true);
    const beforeUnload = event => {
      if (dirty() || busy()) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    onCleanup(() => window.removeEventListener("beforeunload", beforeUnload));
    void loadTaskReadme(request.task).then(value => {
      if (disposed) return;
      if (request.mode === "create" && value.exists) throw new Error("README.txt уже существует. Откройте его командой «Править».");
      if (request.mode !== "create" && !value.exists) throw new Error("README.txt отсутствует. Используйте команду «Создать».");
      setSnapshot(value); setText(value.text);
    }).catch(failure => { if (!disposed) setError(failure.message); })
      .finally(() => { if (!disposed) { setBusy(false); input?.focus(); } });
  });
  onCleanup(() => { disposed = true; props.onBusyChange?.(false); });
  async function commit() {
    if (busy() || !snapshot()) return;
    setBusy(true); setError("");
    try {
      if (deleting) await deleteTaskReadme(request.task, snapshot());
      else await saveTaskReadme(request.task, snapshot(), text());
      if (!disposed) { props.onChanged(); props.onClose(); }
    } catch (failure) { if (!disposed) setError(failure.message); }
    finally { if (!disposed) setBusy(false); }
  }
  const title = `${deleting ? "Удалить" : request.mode === "create" ? "Создать" : "Править"} README.txt — ${request.task.name}`;
  return <TaskMediaDialog open title={title} opener={() => request.opener} onClose={close}
    closeLabel="Закрыть редактор README.txt" renderBody={() => <section class="task-readme-editor" aria-busy={busy()}>
      <Show when={deleting} fallback={<textarea ref={input} class="task-media-text" aria-label="Текст README.txt"
        spellcheck={false} wrap="off" value={text()} disabled={busy() || !snapshot()}
        onInput={event => setText(event.currentTarget.value)} />}>
        <p>Удалить файл DOCS/{snapshot()?.name ?? "README.txt"} задания «{request.task.name}»?</p>
      </Show>
      <Show when={error()}><p class="task-readme-error" role="alert">{error()}</p></Show>
      <Show when={discard()} fallback={<div class="task-readme-actions">
        <button type="button" disabled={busy() || !snapshot()} onClick={commit}>{deleting ? "Удалить README.txt" : "Сохранить"}</button>
        <button type="button" disabled={busy()} onClick={close}>Отмена</button>
      </div>}>
        <div class="task-readme-actions" role="alert">
          <span>Закрыть без сохранения изменений?</span>
          <button type="button" onClick={() => props.onClose()}>Не сохранять</button>
          <button type="button" onClick={() => { setDiscard(false); input?.focus(); }}>Продолжить редактирование</button>
        </div>
      </Show>
    </section>} />;
}
