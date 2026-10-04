import { primitiveVisible, instanceVisible } from "./geometryRenderFilters.js";

/** Keep orbit drags and right-button gestures out of selection/seed creation. */
export function streamlinePointerHandlers(pick, blocked) {
  let down=null;
  const action=name=>event=>{
    if(blocked()||event.button!==0||!down||down.button!==0
      ||Math.hypot(event.clientX-down.x,event.clientY-down.y)>4)return;
    pick(event,name);
  };
  return {pointerdown:event=>{down={x:event.clientX,y:event.clientY,button:event.button};},
    click:action("select"),dblclick:action("seed")};
}

export function updateStreamlineMeshes(THREE,root,lines,{filters={},selected=null}={}) {
  const old=new Map(root.children.map(object=>[object.userData.streamlinePart,object]));
  for(const line of lines??[])for(let i=0;i<line.paths.length;i++) {
    const path=line.paths[i],key=`${line.id}:${i}`;
    let object=old.get(key);old.delete(key);
    if(!object) {
      object=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0xffffff,depthWrite:false}));
      object.name="result-streamline";object.userData.streamlinePart=key;object.renderOrder=25;root.add(object);
    }
    if(object.userData.path!==path) {
      let attribute=object.geometry.getAttribute("position");
      if(!attribute||attribute.array.length!==path.positions.length) {
        object.geometry.dispose();object.geometry=new THREE.BufferGeometry();
        attribute=new THREE.BufferAttribute(new Float32Array(path.positions.length),3).setUsage(THREE.DynamicDrawUsage);
        object.geometry.setAttribute("position",attribute);
      }
      const origin=Array.from(path.positions.subarray(0,3));object.position.fromArray(origin);
      for(let k=0;k<path.positions.length;k++)attribute.array[k]=path.positions[k]-origin[k%3];
      attribute.needsUpdate=true;object.geometry.computeBoundingSphere();object.geometry.computeBoundingBox();
      object.userData.path=path;
    }
    object.userData.streamlineId=line.id;
    object.material.color.setHex(selected===line.id?0xffdd38:0xf4f4f4);
    object.visible=primitiveVisible(path,filters.objectModes,filters.selections)&&instanceVisible(path.instance,filters.symmetry);
  }
  for(const object of old.values()) {root.remove(object);object.geometry.dispose();object.material.dispose();}
  return root;
}
