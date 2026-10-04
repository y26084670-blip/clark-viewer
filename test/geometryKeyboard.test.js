import test from "node:test";
import {installSourcesFieldsKeyboard} from "../src/services/sourcesFieldsKeyboard.js";
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

test("active 3D tab handles views and one time step from lists, selects, buttons and every range without moving focus",()=>{
  let handler,time=2,blocked=false,modal=false;const views=[];
  const owner={document:{querySelector:()=>modal},addEventListener:(name,fn,capture)=>{assert.equal(capture,true);handler=fn;},
    removeEventListener:(name,fn,capture)=>{assert.equal(fn,handler);assert.equal(capture,true);handler=null;}};
  const remove=installSourcesFieldsKeyboard(owner,{blocked:()=>blocked,time:()=>time,maxTime:()=>3,setTime:t=>time=t,view:v=>views.push(v)});
  const press=(code,target,extra={})=>{const event={code,key:"я",target,preventDefault(){this.defaultPrevented=true;},...extra};handler(event);return event;};
  for(const target of [{tagName:"DIV"},{tagName:"BUTTON"},{tagName:"SELECT"},{tagName:"INPUT",type:"range"},{tagName:"INPUT",type:"checkbox"}]) {
    time=2;assert.equal(press("ArrowRight",target).defaultPrevented,true);assert.equal(time,3);
    press("ArrowRight",target);assert.equal(time,3);press("ArrowLeft",target);assert.equal(time,2);
    press("KeyZ",target);assert.equal(views.at(-1),commands.VIEW_POSITIVE_Z);
  }
  for(const target of [{tagName:"INPUT",type:"text"},{tagName:"INPUT",type:"number"},{tagName:"TEXTAREA"},{isContentEditable:true}]) {
    assert.equal(press("ArrowRight",target).defaultPrevented,undefined);assert.equal(time,2);
  }
  const count=views.length;
  press("KeyA",{tagName:"DIV"},{ctrlKey:true});assert.equal(views.length,count);
  blocked=true;press("KeyZ",{});assert.equal(views.length,count);blocked=false;
  modal=true;press("ArrowLeft",{});assert.equal(time,2);remove();assert.equal(handler,null);
});
