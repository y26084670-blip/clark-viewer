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

test("presets replace the selection by physical purpose and prescribed targets take precedence", () => {
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
  const body = source.slice(source.indexOf("  function nameHeading()"), source.indexOf("  function handleKeyDown("));
  const document = { createElement: tagName => ({
    tagName, children: [], events: {}, attributes: {},
    append(child) { this.children.push(child); },
    addEventListener(name, handler) { this.events[name] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; },
  }) };
  const synchronized = [];
  const make = new Function("props", "document", "synchronizeSelection", "initialApplying",
    `let applying = initialApplying; const built = () => true; ${body} return nameHeading();`);
  return { heading: make(props, document, ids => synchronized.push(ids), initialApplying), synchronized };
}

test("header buttons preserve subscript labels, tooltips, sorting isolation and pending selection", () => {
  const selected = [];
  const props = { records, selectionPresets: ELEMENT_SELECTION_PRESETS,
    presetSelection: key => selectElementPreset(props.records, {}, key),
    onSelect: ids => selected.push(ids) };
  const { heading, synchronized } = header(props);
  assert.equal(heading.children[0].textContent, "Название");
  const controls = heading.children[1];
  assert.deepEqual(controls.children.map(button => button.textContent), ["M", "M₀", "J", "J₀", "Virt"]);
  for (const button of controls.children) {
    assert.equal(button.type, "button"); assert.ok(button.title);
    assert.equal(button.attributes["aria-label"], button.title);
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
