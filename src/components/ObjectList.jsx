import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { TabulatorFull } from "tabulator-tables";
import { isListShortcutTarget, selectAllListItems } from "../services/listKeyboard.js";

export function ObjectList(props) {
  let host, table, applying = false, revision = 0;
  const [built, setBuilt] = createSignal(false);
  function synchronizeSelection(selected = props.selected ?? []) {
    const available = new Set((props.records ?? []).map(row => row.id));
    const wanted = selected.filter(id => available.has(id));
    const wantedIds = new Set(wanted);
    const actual = table.getSelectedData().map(row => row.id);
    if (actual.length === wanted.length && actual.every(id => wantedIds.has(id))) return;
    applying = true;
    try { table.deselectRow(); table.selectRow(wanted); }
    finally { applying = false; }
  }
  function handleKeyDown(event) {
    if (!built()) return;
    selectAllListItems(event, {
      records: props.records ?? [], multiple: props.multiple !== false,
      onSelect: selected => {
        if (!applying) {
          applying = true;
          // Tabulator selects its complete row collection in one batch.
          try { table.selectRow(); } finally { applying = false; }
        }
        // Keep the desired selection even while replaceData is pending.
        props.onSelect?.(selected);
      },
    });
  }
  function focusList(event) {
    if (event.button === 0 && isListShortcutTarget(event.target)) {
      event.currentTarget.focus({ preventScroll: true });
    }
  }
  function clearSelectionOnEmptyClick(event) {
    const holder = event.target.closest?.(".tabulator-tableholder");
    if (!built() || !holder || event.target.closest?.(".tabulator-row")) return;
    // Header controls and rows are excluded above; scrollbar clicks must not
    // clear the selection either.
    const bounds = holder.getBoundingClientRect();
    const x = event.clientX - bounds.left - holder.clientLeft;
    const y = event.clientY - bounds.top - holder.clientTop;
    if (x < 0 || y < 0 || x >= holder.clientWidth || y >= holder.clientHeight) return;
    const previousApplying = applying;
    applying = true;
    try { table.deselectRow(); } finally { applying = previousApplying; }
    // Also update the desired selection while replaceData is pending.
    props.onSelect?.([]);
  }
  onMount(() => {
    table = new TabulatorFull(host, {
      height: "100%", layout: "fitColumns", index: "id",
      selectableRows: props.multiple === false ? 1 : true,
      selectableRowsRangeMode: "click", placeholder: "Нет объектов",
      columns: [{ title: "№", field: "id", width: 52, hozAlign: "right" },
        { title: "Название", field: "name", minWidth: 130, formatter: "plaintext" }],
    });
    table.on("tableBuilt", () => setBuilt(true));
    table.on("rowSelectionChanged", rows => {
      if (!applying) props.onSelect?.(rows.map(row => row.id));
    });
  });
  createEffect(() => {
    const records = props.records ?? [];
    if (!built()) return;
    const current = ++revision;
    applying = true;
    table.replaceData(records).then(() => {
      if (current !== revision) return;
      synchronizeSelection(); applying = false;
    }).catch(error => { if (current === revision) { applying = false; console.error("Не удалось обновить список объектов", error); } });
  });
  createEffect(() => {
    const selected = props.selected ?? [];
    if (built() && !applying) synchronizeSelection(selected);
  });
  onCleanup(() => { revision++; table?.destroy(); });
  return <section class="object-list" tabIndex="0" aria-label={props.title}
    onPointerDown={focusList} onKeyDown={handleKeyDown}>
    <div class="list-heading">{props.title}</div>
    <div class="object-table" ref={host} onClick={clearSelectionOnEmptyClick} />
  </section>;
}
