import { batch, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { TabulatorFull } from "tabulator-tables";
import { isListShortcutTarget, selectAllListItems } from "../services/listKeyboard.js";
import "./ObjectList.css";

export function ObjectList(props) {
  let host, table, applying = false, revision = 0;
  const [built, setBuilt] = createSignal(false);
  const [activePreset, setActivePreset] = createSignal(null);
  let presetButtons = new Map();
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
  function synchronizePresetButtons() {
    const key = activePreset();
    const selected = new Set(props.selected ?? []);
    if (key) {
      const expected = props.presetSelection?.(key) ?? [];
      if (!expected.length || selected.size !== expected.length || expected.some(id => !selected.has(id))) {
        setActivePreset(null);
      }
    }
    for (const [key, { button, preset }] of presetButtons) {
      const pressed = activePreset() === key;
      button.disabled = !(props.presetSelection?.(key) ?? []).length;
      button.classList.toggle("is-active", pressed);
      button.setAttribute("aria-pressed", String(pressed));
      button.title = preset.title + (pressed ? ". Повторное нажатие — снять выделение" : "");
      button.setAttribute("aria-label", button.title);
    }
  }
  function nameHeading() {
    if (!props.selectionPresets?.length) return "Название";
    const heading = document.createElement("div");
    heading.className = "object-list-name-heading";
    const label = document.createElement("span");
    label.textContent = "Название"; heading.append(label);
    const controls = document.createElement("div");
    controls.className = "object-list-presets";
    // Keep list focus and keyboard selection handlers off header controls.
    controls.addEventListener("pointerdown", event => event.stopPropagation());
    controls.addEventListener("mousedown", event => event.stopPropagation());
    controls.addEventListener("keydown", event => event.stopPropagation());
    presetButtons = new Map();
    for (const preset of props.selectionPresets) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "object-list-preset";
      button.textContent = preset.label; button.title = preset.title;
      button.setAttribute("aria-label", preset.title);
      button.addEventListener("click", event => {
        event.stopPropagation();
        const matching = props.presetSelection?.(preset.key) ?? [];
        if (!matching.length) return;
        const key = activePreset() === preset.key ? null : preset.key;
        const selected = key ? matching : [];
        batch(() => {
          setActivePreset(key);
          if (built() && !applying) synchronizeSelection(selected);
          // Retain the desired selection even while replaceData is pending.
          props.onSelect?.(selected);
          synchronizePresetButtons();
        });
      });
      presetButtons.set(preset.key, { button, preset });
      controls.append(button);
    }
    heading.append(controls);
    synchronizePresetButtons();
    return heading;
  }
  function handleKeyDown(event) {
    if (!built()) return;
    selectAllListItems(event, {
      records: props.records ?? [], multiple: props.multiple !== false,
      onSelect: selected => {
        setActivePreset(null);
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
    setActivePreset(null);
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
      columnDefaults: { headerSort: false },
      columns: [{ title: "№", field: "id", width: 52, hozAlign: "right" },
        { title: "Название", titleFormatter: nameHeading, field: "name", minWidth: props.selectionPresets?.length ? 150 : 130, formatter: "plaintext" }],
    });
    table.on("tableBuilt", () => setBuilt(true));
    table.on("rowSelectionChanged", rows => {
      if (!applying) {
        setActivePreset(null);
        props.onSelect?.(rows.map(row => row.id));
      }
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
  createEffect(synchronizePresetButtons);
  onCleanup(() => { revision++; table?.destroy(); });
  return <section class="object-list" tabIndex="0" aria-label={props.title}
    onPointerDown={focusList} onKeyDown={handleKeyDown}>
    <div class="list-heading">{props.title}</div>
    <div class="object-table" ref={host} onClick={clearSelectionOnEmptyClick} />
  </section>;
}
