import {geometryCameraCommandFromKeyboardEvent,isGeometryCameraShortcutTarget} from "./visualization/geometryCameraView.js";

export const AXIS_VIEW_ALT_RELEASE_GUARD_MS=700;

// Mounted only by the active 3D tab. Capture precedes range/select native keys.
export function installSourcesFieldsKeyboard(owner,{blocked,time,maxTime,setTime,view,now=()=>performance.now()}) {
  let axisViewsBlockedUntil=0;
  function keyup(event) {
    if(event.code==="AltLeft"||event.code==="AltRight") axisViewsBlockedUntil=now()+AXIS_VIEW_ALT_RELEASE_GUARD_MS;
  }
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
    if(command){
      const axisView=/^view-(positive|negative)-(x|y|z)$/.test(command);
      if(axisView&&now()<axisViewsBlockedUntil){event.preventDefault();return;}
      event.preventDefault();view(command);
    }
  }
  owner.addEventListener("keydown",keydown,true);
  owner.addEventListener("keyup",keyup,true);
  return ()=>{owner.removeEventListener("keydown",keydown,true);owner.removeEventListener("keyup",keyup,true);};
}
