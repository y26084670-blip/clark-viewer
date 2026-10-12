import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ELEMENT_SELECTION_PRESETS, selectElementPreset } from "../src/services/elementSelectionPresets.js";

const records = [
  { id: 1, targ: 0, xapName: "steel", rv: 0 },
  { id: 2, targ: 0, xapName: "steel", rv: 1 },
  { id: 3, targ: 0, xapName: "  ", rv: 1 },
  { id: 4, targ: 1, model: 2, xapName: "steel", rv: 1 },
  { id: 5, targ: 2, model: 2, xapName: "steel", rv: 1 },
  { id: 6, targ: 3, model: 2, xapName: "steel", rv: 1 },
  { id: 7, targ: 0, xapName: "", rv: 0 },
  { id: 8, targ: 0, model: 2, xapName: "", rv: 0 },
];

test("presets identify physical purpose and prescribed targets take precedence", () => {
  assert.deepEqual(selectElementPreset(records, {}, "M"), [1, 2, 8]);
  assert.deepEqual(selectElementPreset(records, {}, "M0"), [4]);
  assert.deepEqual(selectElementPreset(records, {}, "J"), [2, 3, 8]);
  assert.deepEqual(selectElementPreset(records, {}, "J0"), [5]);
  assert.deepEqual(selectElementPreset(records, {}, "Virt"), [6]);
  assert.deepEqual(selectElementPreset([], {}, "M"), []);
  assert.deepEqual(selectElementPreset(records, {}, "other"), []);
  assert.equal(records[3].targ, 1);
});

test("unknown HTS quantities follow canonical/legacy subsystem flags and explicit disabling", () => {
  for (const prefix of ["hts", "htc"]) for (const [mu, ro] of [[false, false], [true, false], [false, true], [true, true]]) {
    const general = { [prefix + "Mu"]: mu, [prefix + "Ro"]: ro };
    assert.deepEqual(selectElementPreset(records, general, "M"), mu ? [1, 2, 8] : [1, 2]);
    assert.deepEqual(selectElementPreset(records, general, "J"), ro ? [2, 3, 8] : [2, 3]);
  }
  const general = { htsMu: 0, htsRo: 1, htcMu: true, htcRo: false };
  assert.deepEqual(selectElementPreset(records, general, "M"), [1, 2]);
  assert.deepEqual(selectElementPreset(records, general, "J"), [2, 3, 8]);
});

test("presets include offscreen rows and use current data without assuming contiguous IDs", () => {
  const many = Array.from({ length: 2000 }, (_, i) => ({ id: i * 3, targ: i % 2 ? 3 : 1 }));
  assert.deepEqual(selectElementPreset(many, {}, "Virt"), many.filter(row => row.targ === 3).map(row => row.id));
  assert.deepEqual(selectElementPreset([{ id: 9001, targ: 2 }], {}, "J0"), [9001]);
});

function header(props, initialApplying = false) {
  // Exercise the actual Tabulator title formatter without a browser/Tabulator
  // layout engine; only standard DOM construction and event propagation are needed.
  const source = readFileSync(new URL("../src/components/ObjectList.jsx", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("  function synchronizePresetButtons()"), source.indexOf("  function handleKeyDown("));
  const document = { createElement: tagName => ({
    tagName, children: [], events: {}, attributes: {},
    append(child) { this.children.push(child); },
    addEventListener(name, handler) { this.events[name] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; },
    classList: { values: new Set(), toggle(name, enabled) { if (enabled) this.values.add(name); else this.values.delete(name); } },
  }) };
  const synchronized = [];
  const make = new Function("props", "document", "synchronizeSelection", "initialApplying",
    `let applying = initialApplying, active = new Set(), presetButtons = new Map();
    const built = () => true, activePresets = () => active, setActivePresets = value => { active = value; };
    const batch = run => run(); ${body}
    return { heading: nameHeading(), refresh: synchronizePresetButtons, rebuild: nameHeading };`);
  return { ...make(props, document, ids => synchronized.push(ids), initialApplying), synchronized };
}

test("header buttons preserve subscript labels, tooltips, event isolation and pending selection", () => {
  const selected = [];
  const props = { records, selectionPresets: ELEMENT_SELECTION_PRESETS,
    presetSelection: key => selectElementPreset(props.records, {}, key),
    onSelect: ids => { selected.push(ids); props.selected = ids; } };
  const { heading, synchronized } = header(props);
  assert.equal(heading.children[0].textContent, "Название");
  const controls = heading.children[1];
  assert.deepEqual(controls.children.map(button => button.textContent), ["M", "M₀", "J", "J₀", "Virt"]);
  for (const button of controls.children) {
    assert.equal(button.type, "button"); assert.ok(button.title);
    assert.equal(button.attributes["aria-label"], button.title);
    assert.equal(button.attributes["aria-pressed"], "false");
  }
  let stopped = 0;
  const event = { stopPropagation() { stopped++; } };
  controls.events.pointerdown(event); controls.events.keydown(event);
  controls.children[4].events.click(event);
  assert.equal(stopped, 3); assert.deepEqual(selected.at(-1), [6]); assert.deepEqual(synchronized.at(-1), [6]);
  props.records = [{ id: 4001, targ: 2 }];
  controls.children[3].events.click(event); assert.deepEqual(selected.at(-1), [4001]);
  const pending = header(props, true);
  pending.heading.children[1].children[3].events.click(event);
  assert.deepEqual(pending.synchronized, []); assert.deepEqual(selected.at(-1), [4001]);
  assert.equal(header({}).heading, "Название");
});

test("presets toggle independently and keep M/J overlaps selected while either group is enabled", () => {
  const selected = [];
  const props = { records, selected: [], selectionPresets: ELEMENT_SELECTION_PRESETS,
    presetSelection: key => selectElementPreset(props.records, {}, key),
    onSelect: ids => { selected.push(ids); props.selected = ids; } };
  const ui = header(props), buttons = ui.heading.children[1].children;
  const click = index => buttons[index].events.click({ stopPropagation() {} });
  const pressed = () => buttons.filter(button => button.attributes["aria-pressed"] === "true").map(button => button.textContent);
  for (let index = 0; index < buttons.length; index++) {
    click(index);
    assert.deepEqual(pressed(), [buttons[index].textContent]);
    assert.equal(buttons[index].classList.values.has("is-active"), true);
    assert.match(buttons[index].title, /Повторное нажатие/);
    click(index); assert.deepEqual(props.selected, []); assert.deepEqual(pressed(), []);
    assert.equal(buttons[index].classList.values.has("is-active"), false);
  }
  click(0); click(2);
  assert.deepEqual(props.selected, [1, 2, 8, 3]); assert.deepEqual(pressed(), ["M", "J"]);
  click(0); assert.deepEqual(props.selected, [2, 8, 3]); assert.deepEqual(pressed(), ["J"]);
  click(2); assert.deepEqual(props.selected, []); assert.deepEqual(pressed(), []);
  click(2); click(0);
  assert.deepEqual(props.selected, [2, 3, 8, 1]); assert.deepEqual(pressed(), ["M", "J"]);
  click(2); assert.deepEqual(props.selected, [2, 8, 1]); assert.deepEqual(pressed(), ["M"]);
  props.selected = [2]; ui.refresh(); assert.deepEqual(pressed(), []);
  click(4); props.records = []; props.selected = []; ui.refresh();
  assert.deepEqual(pressed(), []); assert.ok(buttons.every(button => button.disabled));
  const before = selected.length; click(4); assert.equal(selected.length, before);
});

test("toggle-off is retained while Tabulator data replacement is pending", () => {
  const props = { records, selected: [], selectionPresets: ELEMENT_SELECTION_PRESETS,
    presetSelection: key => selectElementPreset(records, {}, key), onSelect: ids => { props.selected = ids; } };
  const ui = header(props, true), buttons = ui.heading.children[1].children, button = buttons[0];
  button.events.click({ stopPropagation() {} }); assert.deepEqual(props.selected, [1, 2, 8]);
  assert.equal(button.attributes["aria-pressed"], "true");
  button.events.click({ stopPropagation() {} }); assert.deepEqual(props.selected, []);
  assert.equal(button.attributes["aria-pressed"], "false"); assert.deepEqual(ui.synchronized, []);
  for (const index of [0, 2, 0]) buttons[index].events.click({ stopPropagation() {} });
  assert.deepEqual(props.selected, [2, 8, 3]);
  assert.equal(buttons[0].attributes["aria-pressed"], "false");
  assert.equal(buttons[2].attributes["aria-pressed"], "true");
  assert.deepEqual(ui.synchronized, []);
});

test("all five groups accumulate without duplicates and remove only their own unprotected elements", () => {
  const props = { records, selected: [7], selectionPresets: ELEMENT_SELECTION_PRESETS,
    presetSelection: key => selectElementPreset(records, {}, key), onSelect: ids => { props.selected = ids; } };
  const ui = header(props), buttons = ui.heading.children[1].children;
  const click = index => buttons[index].events.click({ stopPropagation() {} });
  for (let index = 0; index < buttons.length; index++) click(index);
  assert.deepEqual(new Set(props.selected), new Set(records.map(row => row.id)));
  assert.equal(props.selected.length, 8);
  assert.ok(buttons.every(button => button.attributes["aria-pressed"] === "true"));
  click(0); assert.deepEqual(new Set(props.selected), new Set([2, 3, 4, 5, 6, 7, 8]));
  assert.ok(buttons.slice(1).every(button => button.attributes["aria-pressed"] === "true"));
  click(1); click(3); click(4); assert.deepEqual(new Set(props.selected), new Set([2, 3, 7, 8]));
  click(2); assert.deepEqual(props.selected, [7]);
});

test("manual additions keep enabled groups; partial manual deselection releases only the affected group", () => {
  const props = { records, selected: [], selectionPresets: ELEMENT_SELECTION_PRESETS,
    presetSelection: key => selectElementPreset(records, {}, key), onSelect: ids => { props.selected = ids; } };
  const ui = header(props), buttons = ui.heading.children[1].children;
  for (const index of [0, 2]) buttons[index].events.click({ stopPropagation() {} });
  props.selected = [...props.selected, 7]; ui.refresh();
  assert.equal(buttons[0].attributes["aria-pressed"], "true");
  assert.equal(buttons[2].attributes["aria-pressed"], "true");
  props.selected = props.selected.filter(id => id !== 1); ui.refresh();
  assert.equal(buttons[0].attributes["aria-pressed"], "false");
  assert.equal(buttons[2].attributes["aria-pressed"], "true");
  buttons[2].events.click({ stopPropagation() {} }); assert.deepEqual(props.selected, [7]);
  props.selected = []; ui.refresh();
  assert.ok(buttons.every(button => button.attributes["aria-pressed"] === "false"));
});

test("current complete selection and header rebuilds preserve independent button states", () => {
  const props = { records, selected: records.map(row => row.id), selectionPresets: ELEMENT_SELECTION_PRESETS,
    presetSelection: key => selectElementPreset(records, {}, key), onSelect: ids => { props.selected = ids; } };
  const ui = header(props), buttons = ui.heading.children[1].children;
  for (const index of [0, 2]) buttons[index].events.click({ stopPropagation() {} });
  assert.deepEqual(props.selected, records.map(row => row.id));
  const rebuilt = ui.rebuild().children[1].children;
  assert.equal(rebuilt[0].attributes["aria-pressed"], "true");
  assert.equal(rebuilt[2].attributes["aria-pressed"], "true");
  rebuilt[0].events.click({ stopPropagation() {} });
  assert.deepEqual(props.selected, [2, 3, 4, 5, 6, 7, 8]);
  assert.equal(rebuilt[2].attributes["aria-pressed"], "true");
});

test("every object-list column disables Tabulator sorting", () => {
  const source = readFileSync(new URL("../src/components/ObjectList.jsx", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("    table = new TabulatorFull"), source.indexOf('    table.on("tableBuilt"'));
  let options;
  const TabulatorFull = class { constructor(host, config) { options = config; } };
  new Function("TabulatorFull", "host", "props", "nameHeading", `let table; ${body}`)(TabulatorFull, {}, {}, () => "Название");
  assert.equal(options.columnDefaults.headerSort, false);
  assert.deepEqual(options.columns.map(column => column.field), ["id", "name"]);
  assert.ok(options.columns.every(column => column.headerSort !== true));
});
