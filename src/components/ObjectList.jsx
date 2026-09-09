import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { TabulatorFull } from "tabulator-tables";

export function ObjectList(props) {
  let host, table, applying = false, revision = 0;
  const [built, setBuilt] = createSignal(false);
  function synchronizeSelection(selected = props.selected ?? []) {
    const wanted = selected.filter(id => (props.records ?? []).some(row => row.id === id));
    const actual = table.getSelectedData().map(row => row.id);
    if (actual.length === wanted.length && actual.every(id => wanted.includes(id))) return;
    applying = true;
    table.deselectRow(); table.selectRow(wanted);
    applying = false;
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
  return <section class="object-list"><div class="list-heading">{props.title}</div><div class="object-table" ref={host} /></section>;
}
