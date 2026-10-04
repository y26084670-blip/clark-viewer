import {geometryCameraCommandFromKeyboardEvent,isGeometryCameraShortcutTarget} from "./visualization/geometryCameraView.js";

// Mounted only by the active 3D tab. Capture precedes range/select native keys.
export function installSourcesFieldsKeyboard(owner,{blocked,time,maxTime,setTime,view}) {
  function keydown(event) {
    if(blocked() || event.defaultPrevented || event.isComposing
      || owner.document?.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')
      || !isGeometryCameraShortcutTarget(event.target,{allowControls:true}))return;
    if((event.code==="ArrowLeft"||event.code==="ArrowRight")
      && !event.ctrlKey&&!event.altKey&&!event.metaKey&&!event.shiftKey) {
      event.preventDefault();
      setTime(Math.max(0,Math.min(maxTime(),time()+(event.code==="ArrowLeft"?-1:1))));return;
    }
    const command=geometryCameraCommandFromKeyboardEvent(event,{allowControls:true});
    if(command){event.preventDefault();view(command);}
  }
  owner.addEventListener("keydown",keydown,true);
  return ()=>owner.removeEventListener("keydown",keydown,true);
}
