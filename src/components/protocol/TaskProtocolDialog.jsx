import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { appendProtocolBlocks, serializeProtocol } from "../../services/protocol/protocolDocument.js";
import { createTaskProtocol, readProtocolConditions, readTaskProtocol, saveTaskProtocol } from "../../services/protocol/taskProtocolService.js";
import "./Protocol.css";
import { ProtocolScenePreview } from "./ProtocolScenePreview.jsx";

export function TaskProtocolDialog(props) {
  let dialog, revision = 0, saved = null, readAbort, saveAbort, previewUrl;
  const [doc, setDoc] = createSignal(null);
  const [filename, setFilename] = createSignal("protocol.html"), [selected, setSelected] = createSignal("");
  const [replacement, setReplacement] = createSignal("");
  const [loading, setLoading] = createSignal(false), [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal(""), [notice, setNotice] = createSignal("");
  const pending = () => Object.values(props.entries ?? {});
  const additions = () => pending().filter(block => !doc()?.blocks.some(existing => existing.id === block.id));
  const title = () => props.initialFilename ? "Редактировать протокол" : "Создать протокол";
  function discardPreview() { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; }
  async function read(name = "") {
    readAbort?.abort();
    const controller = new AbortController(); readAbort = controller;
    const current = ++revision, task = props.task;
    setLoading(true); setError(""); setNotice(""); setDoc(null); saved = null; setSelected(name); setReplacement("");
    try {
      // Capture the previous HTML for the existing conflict check. Creating a
      // protocol rebuilds current snapshots/videos instead of editing old blocks.
      const existing = await readTaskProtocol(task, name || "protocol.html");
      controller.signal.throwIfAborted();
      if (name && !existing) throw new Error("Протокол удалён или перемещён. Обновите список файлов.");
      const draft = name ? existing.document : await createTaskProtocol(task, pending(), { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (current !== revision || !props.open || task !== props.task) return;
      saved = existing; setDoc(draft);
      setFilename(name || "protocol.html");
      setReplacement(!name && existing ? existing.name : "");
      dialog.scrollTop = 0;
    } catch (failure) { if (current === revision) setError(failure.message); }
    finally { if (current === revision) setLoading(false); }
  }
  createEffect(on(() => [props.open, props.task, props.initialFilename], ([open]) => {
    if (open && props.task) { if (!dialog.open) dialog.showModal(); void read(props.initialFilename || ""); }
    else { revision++; readAbort?.abort(); if (dialog.open) dialog.close(); discardPreview(); }
  }));
  onCleanup(() => { revision++; readAbort?.abort(); saveAbort?.abort(); discardPreview(); if (dialog?.open) dialog.close(); });
  function close() { if (!saving()) { revision++; readAbort?.abort(); props.onClose(); } }
  function changeComment(id, comment) {
    setNotice(""); setDoc(previous => ({ ...previous, blocks: previous.blocks.map(block => block.id === id ? { ...block, comment } : block) }));
  }
  function remove(id) {
    setNotice(""); setDoc(previous => ({ ...previous, blocks: previous.blocks.filter(block => block.id !== id) }));
    props.onRemoveBlock?.(id);
  }
  function addMarked() {
    try { setDoc(previous => appendProtocolBlocks(previous, pending())); setNotice(""); setError(""); }
    catch (failure) { setError(failure.message); }
  }
  async function addConditions() {
    const current = ++revision, task = props.task; setLoading(true); setError("");
    try {
      const block = await readProtocolConditions(task);
      if (current !== revision || task !== props.task) return;
      if (!block) { setNotice("Файл output3XX/conditions.json отсутствует."); return; }
      setDoc(previous => appendProtocolBlocks(previous, [block])); setNotice("");
    } catch (failure) { if (current === revision) setError(failure.message); }
    finally { if (current === revision) setLoading(false); }
  }
  function preview() {
    setError("");
    try {
      const html = serializeProtocol(doc()); discardPreview();
      previewUrl = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
      const tab = window.open(previewUrl, "_blank");
      if (tab) tab.opener = null; else setError("Разрешите открытие новой вкладки для просмотра протокола.");
    } catch (failure) { setError(failure.message); }
  }
  async function save() {
    if (saving() || loading() || !doc()) return;
    const task = props.task;
    saveAbort = new AbortController();
    const operation = saveTaskProtocol(task, filename(), doc(), saved?.name === filename().trim() ? saved.html : null,
      { signal: saveAbort.signal });
    setSaving(true); props.onBusyChange?.(true); setError(""); setNotice("");
    try {
      saved = await operation; setDoc(saved.document); setSelected(saved.name); setFilename(saved.name); setReplacement("");
      setNotice(`Сохранено: DOCS/${saved.name}. Для повторного редактирования разверните протокол во вкладке DOCS.`);
      props.onSaved?.({ task, name: saved.name });
    } catch (failure) { setError(failure.message); }
    finally { saveAbort = null; setSaving(false); props.onBusyChange?.(false); }
  }
  return <dialog ref={dialog} class="viewer-movie-dialog protocol-dialog" aria-label={title()}
    aria-busy={loading() || saving()} onCancel={event => { event.preventDefault(); close(); }}>
    <h2>{title()}</h2>
    <p class="viewer-movie-note">Один HTML-файл в DOCS: автономный просмотр и повторное редактирование блоков в Viewer.</p>
    <p class="viewer-movie-note">Все WebM из output3XX/demo автоматически добавляются в конец нового протокола и включаются внутрь HTML.</p>
    <p class="viewer-movie-note">В начале — интерактивная геометрия системы и сводки исходных данных и расчёта.</p>
    <fieldset disabled={loading() || saving()} style={{ border: "0", padding: "0", margin: "0" }}>
      <Show when={selected()}><p class="viewer-movie-note">Файл: DOCS/{selected()} <button type="button" onClick={() => void read(selected())}>Перечитать</button></p>
        <p class="viewer-movie-note">«Перечитать» отменяет несохранённые правки в этом окне.</p></Show>
      <label>Имя файла <input type="text" aria-label="Имя файла протокола" value={filename()} onInput={event => setFilename(event.currentTarget.value)} /></label>
      <Show when={replacement() && replacement() === filename().trim()}>
        <p class="viewer-movie-note">При сохранении DOCS/{replacement()} будет перезаписан текущим содержимым протокола.</p>
      </Show>
      <Show when={doc()}>
        <p class="viewer-movie-note">Задание в протоколе: {doc()?.taskPath}</p>
        <div class="protocol-dialog-toolbar">
          <button type="button" disabled={!additions().length} onClick={addMarked}>Добавить отмеченные ({additions().length})</button>
          <button type="button" onClick={() => void addConditions()}>Добавить условия расчёта</button>
          <button type="button" onClick={preview}>Просмотр HTML</button>
        </div>
        <Show when={!doc()?.blocks.length}><p>Отметьте нужные виды флажком «В протокол» или добавьте условия расчёта.</p></Show>
        <For each={doc()?.blocks.map(block => block.id) ?? []}>{id => {
          const block = () => doc()?.blocks.find(item => item.id === id);
          return <section class="protocol-block" data-block-id={id}>
            <div class="protocol-block-header"><strong>{block()?.title}</strong><button type="button" onClick={() => remove(id)}>Удалить блок</button></div>
            <Show when={block()?.kind === "scene"}><ProtocolScenePreview block={block()} /></Show>
            <Show when={block()?.kind === "image"}><img src={block()?.dataUrl} alt={block()?.title} /></Show>
            <Show when={block()?.kind === "video"}><video src={block()?.dataUrl} controls preload="metadata" playsinline aria-label={block()?.filename} /></Show>
            <Show when={block()?.kind === "text"}><pre>{block()?.text}</pre></Show>
            <Show when={block()?.kind === "table"}><div class="protocol-table"><table>
              <thead><tr><For each={block()?.table.headers}>{header => <th>{header}</th>}</For></tr></thead>
              <tbody><For each={block()?.table.rows}>{row => <tr><For each={row}>{cell => <td>{cell}</td>}</For></tr>}</For></tbody>
            </table></div></Show>
            <label>Комментарий<textarea aria-label={`Комментарий: ${block()?.title}`} maxLength="10000" value={block()?.comment}
              onInput={event => changeComment(id, event.currentTarget.value)} /></label>
          </section>;
        }}</For>
      </Show>
    </fieldset>
    <Show when={loading()}><p role="status">Чтение протокола…</p></Show>
    <Show when={error()}><p role="alert" class="viewer-movie-error">{error()}</p></Show>
    <Show when={notice()}><p role="status" class="viewer-movie-saved">{notice()}</p></Show>
    <div class="viewer-movie-actions"><button type="button" disabled={loading() || saving() || !doc()} onClick={() => void save()}>
      {saving() ? "Сохранение…" : "Сохранить в DOCS"}</button><button type="button" disabled={saving()} onClick={close}>Закрыть</button></div>
  </dialog>;
}
