import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { createTaskImageGalleryController } from "../../services/taskImageGalleryController.js";
import { listTaskDocs, readTaskDocsDocument, readTaskDocsImage } from "../../services/taskDocsService.js";
import { createTaskDocsTextController } from "../../services/taskDocsTextController.js";
import { TaskImageGallery } from "./TaskImageGallery.jsx";
import { TaskReadmeEditor } from "./TaskReadmeEditor.jsx";
import { TaskMediaDialog } from "./TaskMediaDialog.jsx";
import { openTaskHtmlDocument } from "../../services/taskDocsBrowser.js";

function staticHtmlPreview(source) {
  // A template is inert, so parsing cannot fetch resources or run code in Viewer.
  // The sandbox/CSP also isolate CSS, scripts, forms and all external resources.
  const template = document.createElement("template");
  template.innerHTML = source;
  template.content.querySelectorAll("base, meta, script, iframe, frame, frameset, object, embed, link, noscript")
    .forEach(node => node.remove());
  for (const node of template.content.querySelectorAll("[src], [srcset], [poster], [background]")) {
    if (!/^data:image\//i.test(node.getAttribute("src") ?? "")) node.removeAttribute("src");
    for (const name of ["srcset", "poster", "background"]) node.removeAttribute(name);
  }
  for (const node of template.content.querySelectorAll("[href], [xlink\\:href]")) {
    for (const name of ["href", "xlink:href"]) {
      const value = node.getAttribute(name);
      if (value && !value.startsWith("#")) node.removeAttribute(name);
    }
    node.removeAttribute("target");
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"></head><body>${template.innerHTML}</body></html>`;
}

export function TaskDocsGallery(props) {
  const [view, setView] = createSignal({ documents: [], selected: null, text: "", error: "", loading: false });
  const [readmeRequest, setReadmeRequest] = createSignal(null);
  const [readmeRevision, setReadmeRevision] = createSignal(0);
  const [selectReadmeAfterSave, setSelectReadmeAfterSave] = createSignal(false);
  const [expanded, setExpanded] = createSignal(null);
  const [creatingReadme, setCreatingReadme] = createSignal(false);
  const [openError, setOpenError] = createSignal("");
  const [documentCount, setDocumentCount] = createSignal(0);
  const controller = createTaskDocsTextController({ publish: setView, read: readTaskDocsDocument });
  const createDocsController = options => createTaskImageGalleryController({
    ...options, read: readTaskDocsImage, list: async (task, args) => {
      try {
        const result = await listTaskDocs(task, args);
        args.signal?.throwIfAborted();
        setDocumentCount(result.documents.length);
        return result.images;
      } catch (error) {
        if (!args.signal?.aborted) setDocumentCount(0);
        throw error;
      }
    },
  });
  let opener, previousTask, previousActive, previousRefreshKey, initialized = false;
  const disabled = () => props.active === false || props.visible === false || !props.taskHandle || props.disabled;
  const readme = () => view().documents.find(entry => entry.name.toLowerCase() === "readme.txt");
  const createTarget = () => !readme() && (creatingReadme() || !view().selected);
  const selected = () => createTarget() ? null : view().selected;
  const readmeSelected = () => selected()?.name.toLowerCase() === "readme.txt";
  const actionsDisabled = () => disabled() || view().loading || Boolean(readmeRequest()) || Boolean(view().error);
  const isHtml = () => /\.html?$/i.test(selected()?.name ?? "");
  const expandLabel = () => isHtml() ? "Открыть HTML в браузере" : "Развернуть документ";
  const format = () => isHtml() ? "HTML · просмотр" : /\.md$/i.test(view().selected?.name ?? "") ? "исходный Markdown · UTF-8" : "обычный текст · UTF-8";
  const html = createMemo(() => isHtml() && props.active !== false && props.visible !== false && !view().loading && !view().error
    ? staticHtmlPreview(view().text) : "");
  const status = () => !props.taskHandle ? "Выберите задание" : view().loading ? "Чтение документа…"
    : openError() || view().error || (creatingReadme() && !readme() ? "README.txt ещё не создан" : view().selected ? "" : "В DOCS нет документов TXT/MD/HTML");
  createEffect(on(() => [props.taskHandle, props.active], () => setDocumentCount(0)));
  createEffect(on(() => props.taskHandle, () => setCreatingReadme(false)));
  createEffect(on(() => [props.taskHandle, view().selected?.name], () => setOpenError("")));
  createEffect(() => {
    if (!creatingReadme() || !readme()) return;
    setCreatingReadme(false);
    controller.select(readme().name);
  });
  createEffect(() => controller.setDisplayActive(props.visible !== false));
  createEffect(() => {
    const task = props.taskHandle, active = props.active !== false, refreshKey = [props.refreshKey, readmeRevision()];
    const sameContext = initialized && task === previousTask && active === previousActive;
    controller.setContext(task, active);
    if (sameContext && (refreshKey[0] !== previousRefreshKey?.[0] || refreshKey[1] !== previousRefreshKey?.[1])) controller.refresh();
    previousTask = task; previousActive = active; previousRefreshKey = refreshKey; initialized = true;
  });
  createEffect(() => {
    const request = expanded();
    if (request && (disabled() || request.task !== props.taskHandle || request.name !== view().selected?.name)) setExpanded(null);
  });
  onMount(() => {
    const refresh = () => controller.refresh();
    window.addEventListener("focus", refresh);
    onCleanup(() => window.removeEventListener("focus", refresh));
  });
  createEffect(() => {
    if (!selectReadmeAfterSave() || view().loading) return;
    const entry = view().documents.find(item => item.name.toLowerCase() === "readme.txt");
    if (selectReadmeAfterSave() === "create" && !entry) {
      setSelectReadmeAfterSave(false); setCreatingReadme(true); controller.select("");
    } else if (selectReadmeAfterSave() === "read" && entry) {
      setSelectReadmeAfterSave(false); setCreatingReadme(false); controller.select(entry.name);
    }
  });
  onCleanup(() => controller.dispose());

  return <>
    <TaskImageGallery taskHandle={props.taskHandle} active={props.active} visible={props.visible}
      disabled={props.disabled} refreshKey={[props.refreshKey, readmeRevision()]} onCountChange={count => props.onCountChange?.(count + documentCount())}
      label="DOCS" emptyMessage="В DOCS нет изображений PNG, JPEG или WebP"
      createController={createDocsController} onRefresh={() => controller.refresh()} />
    <section class="task-docs-text-panel" aria-label="Документы задания">
      <div class="task-docs-toolbar">
        <select aria-label="Документ DOCS" value={createTarget() ? "" : view().selected?.name ?? ""}
          disabled={disabled() || view().loading} onChange={event => {
            setCreatingReadme(event.currentTarget.value === "");
            setOpenError("");
            controller.select(event.currentTarget.value);
          }}>
          <Show when={!readme()}><option value="">README.txt (создать)</option></Show>
          <For each={view().documents}>{entry => <option value={entry.name}>{entry.name}</option>}</For>
        </select>
        <button type="button" title={expandLabel()} aria-label={expandLabel()}
          disabled={disabled() || !selected() || view().loading || Boolean(view().error)} onClick={event => {
            setOpenError("");
            if (isHtml()) {
              try { openTaskHtmlDocument(view().text); }
              catch (error) { setOpenError(error?.message ?? String(error)); }
              return;
            }
            opener = event.currentTarget; setExpanded({ task: props.taskHandle, name: view().selected.name });
          }}>⤢</button>
      </div>
      <div class="task-readme-actions" aria-label="Управление README.txt">
        <button type="button" aria-label="Создать README.txt" title="Создать README.txt" disabled={actionsDisabled() || !createTarget()}
          onClick={event => setReadmeRequest({ task: props.taskHandle, mode: "create", opener: event.currentTarget })}>Создать</button>
        <button type="button" disabled={actionsDisabled() || !readmeSelected()}
          onClick={event => setReadmeRequest({ task: props.taskHandle, mode: "edit", opener: event.currentTarget })} title="Править README.txt">Править</button>
        <button type="button" disabled={actionsDisabled() || !readmeSelected()}
          onClick={event => setReadmeRequest({ task: props.taskHandle, mode: "delete", opener: event.currentTarget })} title="Удалить README.txt">Удалить</button>
      </div>
      <div class="task-docs-status" role={view().error || openError() ? "alert" : "status"}>
        {status() || format()}
      </div>
      <Show when={isHtml()} fallback={<textarea class="task-media-text" aria-label="Содержимое документа DOCS" readOnly wrap="off"
        spellcheck={false} value={createTarget() ? "" : view().text} aria-busy={view().loading} />}>
        <Show when={html()}><iframe class="task-docs-html" title="HTML-документ DOCS" sandbox="" referrerPolicy="no-referrer" srcdoc={html()} /></Show>
      </Show>
    </section>
    <Show when={readmeRequest()} keyed>{request => <TaskReadmeEditor request={request}
      onBusyChange={props.onBusyChange} onClose={() => setReadmeRequest(null)}
      onChanged={() => {
        setSelectReadmeAfterSave(request.mode === "delete" ? "create" : "read");
        setReadmeRevision(value => value + 1);
      }} />}</Show>
    <TaskMediaDialog open={Boolean(expanded())} title={view().selected ? `${view().selected.name} — ${format()}` : ""}
      opener={() => opener} onClose={() => setExpanded(null)} closeLabel="Закрыть просмотр документа"
      renderBody={() => <textarea class="task-media-text task-docs-expanded" aria-label="Полный текст документа DOCS"
        readOnly wrap="off" spellcheck={false} value={view().text} aria-busy={view().loading} />} />
  </>;
}
