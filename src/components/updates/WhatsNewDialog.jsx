import { createMemo, createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { readProjectDisk, listProjectCatalogs } from "../../services/projectDiskAccessService.js";
import { NEWS_CATEGORIES, compareVersions, createChangeNotifications, updatesFeedUrl, safeUpdateUrl,
  readSavedInstalledVersion, saveInstalledVersion, findVersionContext, createVersionCheckRequest,
  waitForVersionCheck } from "../../services/changeNotifications.js";
import "./WhatsNewDialog.css";

const formatDate = value => value ? new Date(value).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) + " МСК" : "—";

export function WhatsNewDialog(props) {
  let storage;
  try { storage = window.localStorage; } catch { /* Use a session-only journal. */ }
  const feedUrl = props.feedUrl ?? updatesFeedUrl(props.app, import.meta.env.BASE_URL, location.href);
  const [state, setState] = createSignal({});
  const store = createChangeNotifications({ storage, eventTarget: window, url: feedUrl, onChange: setState });
  setState(store.snapshot());
  const [open, setOpen] = createSignal(false), [category, setCategory] = createSignal("interface");
  const [onlyUnread, setOnlyUnread] = createSignal(false);
  const [context, setContext] = createSignal(null), [installed, setInstalled] = createSignal(readSavedInstalledVersion(storage));
  const [versionBusy, setVersionBusy] = createSignal(false), [versionNotice, setVersionNotice] = createSignal("");
  let dialog, opener, closer, disposed = false, contextRevision = 0, checkController;
  const unread = key => { state(); return store.unread(key); };
  const entries = createMemo(() => { state(); return (state().feed?.entries ?? []).filter(item => item.category === category()
    && (!onlyUnread() || !store.isRead(item))); });
  const read = item => { state(); return store.isRead(item); };
  const recommended = () => state().feed?.recommendedClark;
  const comparison = () => compareVersions(installed()?.version, recommended()?.version);
  const versionLabel = () => {
    if (!installed()) return "Версия Clark не определена";
    if (!recommended()) return "Рекомендуемая версия Clark пока не указана";
    return comparison() === -1 ? "Рекомендуется обновить Clark"
      : comparison() === 0 ? "Установлена рекомендуемая версия Clark" : "Установлена более новая версия Clark. Обновление не требуется";
  };
  async function resolveContext() {
    const revision = ++contextRevision;
    try {
      let next;
      if (props.getVersionContext) next = await props.getVersionContext();
      else {
        const disk = await readProjectDisk();
        const allowed = disk && (typeof disk.queryPermission !== "function" || await disk.queryPermission({ mode: "read" }) === "granted");
        next = allowed ? await findVersionContext(await listProjectCatalogs(disk)) : null;
      }
      if (disposed || revision !== contextRevision) return;
      setContext(next);
      if (next?.installed && (!installed() || Date.parse(next.installed.checkedAt) > Date.parse(installed().checkedAt))) {
        setInstalled(next.installed); saveInstalledVersion(storage, next.installed);
      }
    } catch { if (!disposed && revision === contextRevision) setContext(null); }
  }
  function maybeRefresh() {
    if (Date.now() - (Date.parse(state().checkedAt) || 0) > 60000) void store.refresh();
    void resolveContext();
  }
  function show() {
    if (!dialog?.isConnected || dialog.open) return;
    setOpen(true); dialog.showModal(); closer?.focus(); maybeRefresh();
  }
  function close() { checkController?.abort(); dialog?.close(); }
  async function checkUpdates() {
    if (versionBusy()) return;
    setVersionNotice("");
    const request = createVersionCheckRequest(context());
    const controller = new AbortController();
    // Opening clark:// stays in the original user gesture; discovery was done earlier.
    if (request) {
      checkController = controller; setVersionBusy(true);
      try { (props.openNative ?? (uri => window.location.assign(uri)))(request.uri); }
      catch { setVersionBusy(false); setVersionNotice("Не удалось открыть Clark. Проверьте его установку."); }
    } else setVersionNotice("Чтобы проверить установленную версию, свяжите каталоги с Clark в Editor.");
    void store.refresh();
    if (!request || !versionBusy()) return;
    try {
      const snapshot = await waitForVersionCheck(request, { signal: controller.signal, timeoutMs: 30000 });
      if (disposed || checkController !== controller || controller.signal.aborted) return;
      setInstalled(snapshot); saveInstalledVersion(storage, snapshot);
      setVersionNotice(snapshot ? "Номер установленной версии получен от Clark."
        : "Локальный обработчик не сообщил номер версии. Обновите Clark и повторите связывание каталогов.");
    } catch (error) {
      if (!disposed && checkController === controller && error.name !== "AbortError") setVersionNotice(error.message);
    } finally { if (!disposed && checkController === controller) setVersionBusy(false); }
  }
  onMount(() => {
    maybeRefresh();
    window.addEventListener("focus", maybeRefresh);
    const onStorage = event => {
      if (event.key === "clark.updates.installed.v1") setInstalled(readSavedInstalledVersion(storage));
    };
    window.addEventListener("storage", onStorage);
    onCleanup(() => { window.removeEventListener("focus", maybeRefresh); window.removeEventListener("storage", onStorage); });
  });
  onCleanup(() => { disposed = true; contextRevision++; checkController?.abort(); store.dispose(); if (dialog?.open) dialog.close(); });

  return <>
    <button type="button" class="whats-new-button" ref={opener} onClick={show} aria-haspopup="dialog"
      aria-label={`Что нового${unread() ? `: непрочитанных ${unread()}` : ""}`}>
      Что нового <Show when={unread()}><span class="whats-new-count">{unread()}</span></Show>
    </button>
    <dialog ref={dialog} class="whats-new-dialog" aria-label="Что нового в Clark"
      onClose={() => { setOpen(false); checkController?.abort(); setVersionBusy(false); opener?.focus(); }}>
      <Show when={open()}>
        <div class="whats-new-heading"><h2>Что нового</h2>
          <button type="button" ref={closer} onClick={close} aria-label="Закрыть уведомления">Закрыть</button></div>
        <section class="whats-new-version" aria-label="Обновление Clark">
          <strong classList={{ "whats-new-important": comparison() === -1 }}>{versionLabel()}</strong>
          <div>Установлено: {installed()?.version ?? "—"}; {comparison() === -1 ? "доступно обновление" : "версия в журнале"}: {recommended()?.version ?? "—"}.</div>
          <Show when={installed()}><div class="whats-new-meta">Последняя проверка установленной версии: {formatDate(installed()?.checkedAt)}</div></Show>
          <div class="whats-new-version-actions">
            <button type="button" onClick={checkUpdates} disabled={state().loading || versionBusy()}>
              {versionBusy() ? "Ожидание Clark…" : "Проверить обновления"}</button>
            <Show when={recommended() && comparison() === -1}>
              <a href={safeUpdateUrl(recommended().installerUrl, feedUrl)} target="_blank" rel="noopener noreferrer">Скачать установщик</a>
            </Show>
          </div>
          <Show when={versionNotice()}><div role="status">{versionNotice()}</div></Show>
        </section>
        <div class="whats-new-categories" role="tablist" aria-label="Разделы уведомлений">
          <For each={Object.entries(NEWS_CATEGORIES)}>{([key, label]) => <button type="button" role="tab"
            aria-selected={category() === key} onClick={() => setCategory(key)}>{label} ({unread(key)})</button>}</For>
        </div>
        <div class="whats-new-filters">
          <label><input type="checkbox" checked={onlyUnread()} onChange={e => setOnlyUnread(e.currentTarget.checked)} /> Только непрочитанные</label>
          <button type="button" disabled={!unread(category())} onClick={() => store.markRead(state().feed?.entries.filter(item => item.category === category()) ?? [])}>
            Отметить раздел прочитанным</button>
        </div>
        <div class="whats-new-messages" role="tabpanel" aria-label={NEWS_CATEGORIES[category()]}>
          <For each={entries()}>{item => <article class="whats-new-entry" classList={{ unread: !read(item), important: item.importance === "important" }}>
            <div class="whats-new-entry-top">
              <div class="whats-new-entry-title"><h3>{item.title}<Show when={item.titleNote}>{" "}<span class="whats-new-entry-title-note">{item.titleNote}</span></Show></h3>
                <Show when={item.status}><span class="whats-new-entry-status">{item.status}</span></Show>
              </div>
              <span>{item.date}</span>
            </div>
            <Show when={item.importance === "important"}><strong class="whats-new-important">Влияет на результаты расчёта</strong></Show>
            <p>{item.summary}</p>
            <Show when={item.action}><p>{item.action}</p></Show>
            <Show when={item.limitations}><p><strong>Ограничения: </strong>{item.limitations}</p></Show>
            <Show when={item.versions}><div class="whats-new-meta">{Object.entries(item.versions).map(([name, version]) => `${name}: ${version}`).join("; ")}</div></Show>
            <div class="whats-new-entry-actions">
              <Show when={safeUpdateUrl(item.detailsUrl, feedUrl)}><a href={safeUpdateUrl(item.detailsUrl, feedUrl)} target="_blank" rel="noopener noreferrer">Подробнее</a></Show>
              <Show when={!read(item)} fallback={<span class="whats-new-meta">Прочитано</span>}>
                <button type="button" onClick={() => store.markRead([item])}>Прочитано</button>
              </Show>
            </div>
          </article>}</For>
          <Show when={!entries().length}><p>{state().loading && !state().feed ? "Загрузка журнала…" : "Уведомлений нет."}</p></Show>
        </div>
        <footer class="whats-new-footer" aria-live="polite">
          <Show when={state().error}><div>{state().error}</div></Show>
          <Show when={state().checkedAt}><div>Журнал проверен: {formatDate(state().checkedAt)}{state().source === "cache" ? " · сохранённая копия" : ""}</div></Show>
          <Show when={!state().persistent}><div>Отметки прочтения сохраняются только в текущей вкладке.</div></Show>
        </footer>
      </Show>
    </dialog>
  </>;
}
