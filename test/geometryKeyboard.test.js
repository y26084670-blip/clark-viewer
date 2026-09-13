import test from "node:test";
import assert from "node:assert/strict";
import {
  GEOMETRY_CAMERA_COMMANDS as commands,
  geometryCameraCommandFromKeyboardEvent as cameraCommand,
} from "../src/services/visualization/geometryCameraView.js";

const shortcuts = [
  ["KeyA", ["a", "A", "ф", "q"], commands.FIT_ALL, null],
  ["KeyX", ["x", "X", "ч", "c"], commands.VIEW_POSITIVE_X, commands.VIEW_NEGATIVE_X],
  ["KeyY", ["y", "Y", "н", "z"], commands.VIEW_POSITIVE_Y, commands.VIEW_NEGATIVE_Y],
  ["KeyZ", ["z", "Z", "я", "y"], commands.VIEW_POSITIVE_Z, commands.VIEW_NEGATIVE_Z],
];

test("Camera shortcuts use the same physical key in Latin, Russian and other layouts", () => {
  for (const [code, characters, expected] of shortcuts) {
    for (const key of characters) {
      assert.equal(cameraCommand({ code, key }), expected, `${code}: ${key}`);
    }
    assert.equal(cameraCommand({ code }), expected);
  }
});

test("Ctrl reverses axis views in every layout and leaves Ctrl+A to the active list", () => {
  for (const [code, characters, , reversed] of shortcuts) {
    for (const key of characters) {
      assert.equal(cameraCommand({ code, key, ctrlKey: true }), reversed, `Ctrl+${code}: ${key}`);
    }
  }
});

test("Character matches cannot trigger camera commands from another or unidentified physical key", () => {
  for (const key of ["a", "x", "y", "z"]) {
    for (const code of [undefined, "", "Unidentified", "KeyQ", "Digit1", "Escape"]) {
      assert.equal(cameraCommand({ code, key }), null, `${code}: ${key}`);
    }
  }
  assert.equal(cameraCommand(null), null);
});

test("Camera commands respect forbidden modifiers, consumed events and IME composition", () => {
  for (const [code] of shortcuts) {
    for (const ctrlKey of [false, true]) {
      for (const guard of ["altKey", "metaKey", "shiftKey", "defaultPrevented", "isComposing"]) {
        assert.equal(cameraCommand({ code, ctrlKey, [guard]: true }), null, `${code}: ${guard}`);
      }
    }
  }
});

test("Editing text or selecting an input value does not move the camera", () => {
  const editingTargets = [
    { tagName: "INPUT" }, { tagName: "textarea" }, { tagName: "SELECT" },
    { tagName: "DIV", isContentEditable: true },
    { tagName: "SPAN", isContentEditable: true },
  ];
  for (const target of editingTargets) {
    for (const [code] of shortcuts) {
      for (const ctrlKey of [false, true]) {
        assert.equal(cameraCommand({ code, ctrlKey, target }), null, `${code}: ${target.tagName}`);
      }
    }
  }
  for (const target of [{ tagName: "DIV" }, { tagName: "CANVAS" }, { tagName: "BUTTON" }]) {
    assert.equal(cameraCommand({ code: "KeyA", target }), commands.FIT_ALL);
  }
});
