import test from "node:test";
import assert from "node:assert/strict";
import { isListShortcutTarget, selectAllListItems } from "../src/services/listKeyboard.js";

function keyEvent(overrides = {}) {
  return { code: "KeyA", key: "a", ctrlKey: true, target: { tagName: "DIV" },
    prevented: 0, stopped: 0,
    preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; }, ...overrides };
}

test("Ctrl+A selects all data rows in the receiving list in any keyboard layout", () => {
  const records = Array.from({ length: 2000 }, (_, index) => ({ id: index + 1 }));
  for (const key of ["a", "ф", "q", "α"]) {
    const event = keyEvent({ key });
    const selected = { elements: [], regions: [9001] };
    let notifications = 0;
    assert.equal(selectAllListItems(event, { records, onSelect: ids => {
      selected.elements = ids; notifications++;
    } }), true);
    assert.deepEqual(selected.elements, records.map(record => record.id));
    assert.deepEqual(selected.regions, [9001]);
    assert.equal(notifications, 1);
    assert.equal(event.prevented, 1);
    assert.equal(event.stopped, 1);
  }
});

test("Select-all uses the physical key and rejects different modifiers and consumed events", () => {
  for (const overrides of [
    { code: "KeyQ", key: "a" }, { code: "", key: "a" }, { code: undefined },
    { ctrlKey: false }, { altKey: true }, { metaKey: true }, { shiftKey: true },
    { isComposing: true }, { defaultPrevented: true },
  ]) {
    const event = keyEvent(overrides);
    let called = false;
    assert.equal(selectAllListItems(event, { records: [{ id: 1 }], onSelect: () => { called = true; } }), false);
    assert.equal(called, false);
    assert.equal(event.prevented, 0);
    assert.equal(event.stopped, 0);
  }
});

test("Text fields keep their native selection; single-selection lists are not expanded", () => {
  const targets = [
    { tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" },
    { tagName: "DIV", isContentEditable: true },
    { tagName: "SPAN", closest: () => ({ contentEditable: "true" }) },
  ];
  for (const target of targets) {
    assert.equal(isListShortcutTarget(target), false);
    const event = keyEvent({ target });
    assert.equal(selectAllListItems(event, { onSelect: () => assert.fail("Must preserve text editing") }), false);
    assert.equal(event.prevented, 0);
  }
  const single = keyEvent();
  assert.equal(selectAllListItems(single, { multiple: false,
    records: [{ id: 1 }, { id: 2 }], onSelect: () => assert.fail("Single selection") }), false);
  assert.equal(single.prevented, 0);
});

test("Select-all handles empty lists and the current replacement data", () => {
  let selected;
  assert.equal(selectAllListItems(keyEvent(), { onSelect: ids => { selected = ids; } }), true);
  assert.deepEqual(selected, []);
  const replacement = [{ id: 8 }, { id: 0 }, { id: 12 }];
  selectAllListItems(keyEvent(), { records: replacement, onSelect: ids => { selected = ids; } });
  assert.deepEqual(selected, [8, 0, 12]);
});
