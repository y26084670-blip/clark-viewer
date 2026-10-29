import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { appendProtocolBlocks, canCommentProtocolBlock, refreshProtocolDraft, serializeProtocol } from "../../services/protocol/protocolDocument.js";
import { deleteTaskProtocol, listTaskProtocols, openTaskProtocol, readTaskProtocol, saveTaskProtocol } from "../../services/protocol/taskProtocolService.js";
import { readProtocolClipboard } from "../../services/protocol/protocolClipboard.js";
import "./Protocol.css";
import { ProtocolScenePreview } from "./ProtocolScenePreview.jsx";

export function TaskProtocolDialog(props) {
  const fallbackSession = { handle: null, files: new Map(), lastFilename: "protocol.html" };
  let dialog, revision = 0, saved = null, readAbort, writeAbort, pasteAbort, previewUrl, activeSession;
  const [doc, setDoc] = createSignal(null);
  const [filename, setFilename] = createSignal("protocol.html"), [openedName, setOpenedName] = createSignal("");
  const [names, setNames] = createSignal([]), [exists, setExists] = createSignal(false);
  const [loading, setLoading] = createSignal(false), [saving, setSaving] = createSignal(false), [deleting, setDeleting] = createSignal(false);
  const [pasting, setPasting] = createSignal(false);
  const [error, setError] = createSignal(""), [notice, setNotice] = createSignal("");
  const pending = () => Object.values(props.entries ?? {});
  const additions = () => pending().filter(block => !doc()?.blocks.some(existing => existing.id === block.id));
  const busy = () => loading() || saving() || deleting() || pasting();
  const title = () => exists() ? "Редактировать протокол" : "Создать протокол";
  function discardPreview() { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; }
  function cancelPaste() { pasteAbort?.abort(); pasteAbort = null; setPasting(false); }
  function remember() {
    if (!activeSession || !doc() || !openedName()) return;
    activeSession.files.set(openedName(), { document: doc(), saved, filename: filename() });
    activeSession.lastFilename = openedName();
  }
  async function read(requested = "", refresh = false) {
    remember(); readAbort?.abort(); cancelPaste();
    const controller = new AbortController(); readAbort = controller;
    const current = ++revision, task = props.task, session = props.session ?? fallbackSession;
    const valid = () => current === revision && props.open && task === props.task;
    let recover;
    setLoading(true); setError(""); setNotice(""); setDoc(null); setOpenedName(""); setExists(false);
    activeSession = null; saved = null;
    try {
      let same = session.handle === task.handle;
      if (!same && session.handle?.isSameEntry) same = await session.handle.isSameEntry(task.handle);
      controller.signal.throwIfAborted();
      if (!valid()) return;
      if (!same) { session.handle = task.handle; session.files.clear(); session.lastFilename = "protocol.html"; }
      const name = requested || session.lastFilename || "protocol.html", cached = session.files.get(name);
      if (cached) recover = { name, cached };
      const files = await listTaskProtocols(task);
      controller.signal.throwIfAborted();
      if (!valid()) return;
      setNames(files);
      let state, currentFile;
      if (cached) {
        currentFile = await readTaskProtocol(task, name);
        const document = refresh ? refreshProtocolDraft(cached.document, cached.saved?.document, currentFile?.document) : cached.document;
        state = { ...cached, document: appendProtocolBlocks(document, pending().map(block => ({ ...block, comment: "" }))),
          saved: refresh || !currentFile ? currentFile : cached.saved };
      } else {
        state = await openTaskProtocol(task, name, pending(), { signal: controller.signal });
        currentFile = state.saved;
      }
      controller.signal.throwIfAborted();
      if (!valid()) return;
      activeSession = session; saved = state.saved;
      setDoc(state.document); setOpenedName(name); setFilename(refresh || requested ? name : state.filename || name);
      setNames(files); setExists(Boolean(currentFile)); remember();
      if (currentFile && cached && !refresh && currentFile.html !== cached.saved?.html) {
        setNotice("Файл изменён вне Viewer. Черновик сохранён. Перечитайте файл перед записью или сохраните под другим именем.");
      } else if (refresh) setNotice("Файл перечитан. Несохранённые комментарии и правки сохранены в черновике.");
      dialog.scrollTop = 0;
    } catch (failure) {
      if (valid()) {
        if (recover) {
          activeSession = session; saved = recover.cached.saved;
          setDoc(recover.cached.document); setOpenedName(recover.name); setFilename(recover.cached.filename || recover.name);
          setExists(names().includes(recover.name));
        }
        setError(failure.message);
      }
    }
    finally { if (current === revision) setLoading(false); }
  }
  createEffect(on(() => [props.open, props.task, props.initialFilename, props.session], ([open]) => {
    if (open && props.task) { if (!dialog.open) dialog.showModal(); void read(props.initialFilename || ""); }
    else { remember(); revision++; readAbort?.abort(); cancelPaste(); setLoading(false); if (dialog.open) dialog.close(); discardPreview(); }
  }));
  onCleanup(() => { revision++; readAbort?.abort(); writeAbort?.abort(); cancelPaste(); discardPreview(); if (dialog?.open) dialog.close(); });
  function close() { if (!saving() && !deleting()) { remember(); revision++; readAbort?.abort(); cancelPaste(); props.onClose(); } }
  function changeComment(id, comment) {
    setNotice(""); setDoc(previous => ({ ...previous, blocks: previous.blocks.map(block => block.id === id ? { ...block, comment } : block) })); remember();
  }
  function remove(id) {
    setNotice(""); setDoc(previous => ({ ...previous, blocks: previous.blocks.filter(block => block.id !== id) })); remember();
    props.onRemoveBlock?.(id);
  }
  function addMarked() {
    try { setDoc(previous => appendProtocolBlocks(previous, pending().map(block => ({ ...block, comment: "" })))); remember(); setNotice(""); setError(""); }
    catch (failure) { setError(failure.message); }
  }
  async function paste(kind) {
    if (busy() || !doc()) return;
    const controller = new AbortController(), current = revision, task = props.task, documentId = doc().id;
    pasteAbort = controller;
    const valid = () => !controller.signal.aborted && current === revision && props.open && task === props.task && doc()?.id === documentId;
    setPasting(true); setError(""); setNotice("");
    try {
      const block = await readProtocolClipboard(kind, { signal: controller.signal });
      if (!valid()) return;
      setDoc(previous => appendProtocolBlocks(previous, [block])); remember();
      setNotice(kind === "image" ? "Рисунок из буфера добавлен в протокол." : "Текст из буфера добавлен в протокол.");
    } catch (failure) { if (valid()) setError(failure.message); }
    finally { if (pasteAbort === controller) { pasteAbort = null; setPasting(false); } }
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
    if (busy() || !doc()) return;
    const task = props.task, sourceName = openedName();
    writeAbort = new AbortController();
    const operation = saveTaskProtocol(task, filename(), doc(), saved?.name === filename().trim() ? saved.html : null,
      { signal: writeAbort.signal });
    setSaving(true); props.onBusyChange?.(true); setError(""); setNotice("");
    try {
      saved = await operation;
      if (saved.name !== sourceName && activeSession?.files.has(sourceName)) {
        const source = activeSession.files.get(sourceName);
        activeSession.files.set(sourceName, { ...source, filename: sourceName });
      }
      setDoc(saved.document); setOpenedName(saved.name); setFilename(saved.name); setExists(true); remember();
      setNames(previous => [...new Set([...previous, saved.name])].sort((a, b) => a.localeCompare(b, "ru", { numeric: true })));
      setNotice(`Сохранено: DOCS/${saved.name}. Повторная правка — через «Инструменты → Протокол».`);
      props.onChanged?.({ task, name: saved.name });
    } catch (failure) { setError(failure.message); }
    finally { writeAbort = null; setSaving(false); props.onBusyChange?.(false); }
  }
  async function deleteFile() {
    if (busy() || !saved || !exists() || filename().trim() !== saved.name) return;
    const task = props.task, name = saved.name;
    if (!window.confirm(`Удалить файл DOCS/${name} из задания «${doc().taskPath}»?\nЧерновик и комментарии останутся в текущем задании. Исходные картинки и анимации сохранятся.`)) return;
    writeAbort = new AbortController();
    const operation = deleteTaskProtocol(task, name, saved.html, { signal: writeAbort.signal });
    setDeleting(true); props.onBusyChange?.(true); setError(""); setNotice("");
    try {
      await operation;
      saved = null; setExists(false); setNames(previous => previous.filter(value => value !== name)); remember();
      setNotice(`Удалён файл DOCS/${name}. Черновик сохранён; «Сохранить в DOCS» создаст файл заново.`);
      props.onChanged?.({ task, name });
    } catch (failure) { setError(failure.message); }
    finally { writeAbort = null; setDeleting(false); props.onBusyChange?.(false); }
  }
  return <dialog ref={dialog} class="viewer-movie-dialog protocol-dialog" aria-label={title()}
    aria-busy={busy()} onCancel={event => { event.preventDefault(); close(); }}>
    <h2>{title()}</h2>
    <p class="viewer-movie-note">Один HTML-файл в DOCS. Комментарии и несохранённые правки сохраняются при закрытии окна в пределах текущего задания.</p>
    <Show when={exists()} fallback={<p class="viewer-movie-note">Новый протокол: геометрия, сводки, отмеченные материалы, тексты DOCS и анимации.</p>}>
      <p class="viewer-movie-note">В существующий протокол добавляются только отмеченные материалы и вставки из буфера — после сводок и перед анимациями.</p>
    </Show>
    <fieldset disabled={busy()} style={{ border: "0", padding: "0", margin: "0" }}>
      <Show when={names().length}>
        <label>Открыть протокол <select aria-label="Открыть существующий протокол" value={names().includes(openedName()) ? openedName() : ""}
          onChange={event => { if (event.currentTarget.value) void read(event.currentTarget.value); }}>
          <option value="" disabled>Выберите файл</option>
          <For each={names()}>{name => <option value={name}>{name}</option>}</For>
        </select></label>
      </Show>
      <Show when={openedName()}><p class="viewer-movie-note">Файл: DOCS/{openedName()} <button type="button" onClick={() => void read(openedName(), true)}>Перечитать</button></p></Show>
      <label>Имя файла для сохранения <input type="text" aria-label="Имя файла протокола" value={filename()}
        onInput={event => { setFilename(event.currentTarget.value); remember(); }} /></label>
      <Show when={doc()}>
        <p class="viewer-movie-note">Задание в протоколе: {doc()?.taskPath}</p>
        <div class="protocol-dialog-toolbar">
          <button type="button" disabled={!additions().length} onClick={addMarked}>Добавить отмеченные ({additions().length})</button>
          <button type="button" onClick={() => void paste("image")}>Вставить рисунок</button>
          <button type="button" onClick={() => void paste("text")}>Вставить текст</button>
          <button type="button" onClick={preview}>Просмотр HTML</button>
        </div>
        <Show when={!doc()?.blocks.length}><p>Отметьте нужные виды флажком «В протокол» или вставьте рисунок либо текст из буфера.</p></Show>
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
            <Show when={canCommentProtocolBlock(block())}>
              <label>Комментарий<textarea aria-label={`Комментарий: ${block()?.title}`} maxLength="10000" value={block()?.comment}
                onInput={event => changeComment(id, event.currentTarget.value)} /></label>
            </Show>
          </section>;
        }}</For>
      </Show>
    </fieldset>
    <Show when={loading()}><p role="status">Чтение протокола…</p></Show>
    <Show when={pasting()}><p role="status">Чтение буфера обмена…</p></Show>
    <Show when={error()}><p role="alert" class="viewer-movie-error">{error()}</p></Show>
    <Show when={notice()}><p role="status" class="viewer-movie-saved">{notice()}</p></Show>
    <div class="viewer-movie-actions"><button type="button" disabled={busy() || !doc()} onClick={() => void save()}>
      {saving() ? "Сохранение…" : "Сохранить в DOCS"}</button>
      <Show when={exists()}><button type="button" disabled={busy() || !saved || filename().trim() !== saved.name} onClick={() => void deleteFile()}>
        {deleting() ? "Удаление…" : "Удалить файл протокола"}</button></Show>
      <button type="button" disabled={saving() || deleting()} onClick={close}>Закрыть</button></div>
  </dialog>;
}
