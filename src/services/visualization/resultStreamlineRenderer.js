import { primitiveVisible, instanceVisible } from "./geometryRenderFilters.js";
import { normalizeResultPalette, resultScalarColor } from "./resultScalarColors.js";

let Line2, LineGeometry, LineMaterial, rendererModules;
// Keep Three.js out of the initial application bundle, just like the viewport's
// existing renderer and controls. Loading the modules creates no GPU resources.
export function loadStreamlineRenderer() {
  return rendererModules ??= Promise.all([
    import("three/addons/lines/Line2.js"),
    import("three/addons/lines/LineGeometry.js"),
    import("three/addons/lines/LineMaterial.js"),
  ]).then(([line, geometry, material]) => {
    Line2=line.Line2; LineGeometry=geometry.LineGeometry; LineMaterial=material.LineMaterial;
  }).catch(error => { rendererModules=null; throw error; });
}

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

const pathVisible = (path, filters) => primitiveVisible(path, filters.objectModes, filters.selections)
  && instanceVisible(path.instance, filters.symmetry);

// One scale per physical quantity, shared by every visible line of that kind.
// Keep it independent of the point/volume display's selection and sampling.
function colorRanges(lines, filters) {
  const ranges = new Map();
  for (const line of lines) {
    const key = line.quantityKey ?? line.id;
    for (const path of line.paths) {
      if (!pathVisible(path, filters)) continue;
      for (const value of path.magnitudes ?? []) {
        if (!Number.isFinite(value) || value < 0) continue;
        if (!ranges.has(key)) ranges.set(key, { minimum: Infinity, maximum: -Infinity,
          key: `streamline:${key}`, groupLabel: "Линии", quantity: `Модуль · ${line.quantity ?? key}`, unit: line.unit ?? "" });
        const range = ranges.get(key);
        range.minimum = Math.min(range.minimum, value); range.maximum = Math.max(range.maximum, value);
      }
    }
  }
  return ranges;
}

function lineMaterial(color = 0xffffff) {
  return new LineMaterial({ color, worldUnits: false, linewidth: 2, transparent: true,
    depthWrite: false, depthTest: true, toneMapped: false });
}

function selectionOutline(object) {
  if (object.children.length) return;
  // Two slim contrasting borders remain distinguishable on both the dark scene
  // and every palette colour. They share geometry but never recolour the field.
  for (const [color, order, extra] of [[0xffdd38, 23, 4], [0x141a20, 24, 2]]) {
    const border = new Line2(object.geometry, lineMaterial(color));
    border.name = "result-streamline-outline"; border.renderOrder = order;
    border.userData.widthExtra = extra;
    border.raycast = () => {};
    object.add(border);
  }
}

export const STREAMLINE_START_SIZE = 12;

function startMarkerTexture(THREE) {
  const side=64, pixels=new Uint8Array(side*side*4);
  for(let y=0;y<side;y++)for(let x=0;x<side;x++) {
    const distance=(Math.abs(x+.5-side/2)+Math.abs(y+.5-side/2))/(side/2);
    const offset=(y*side+x)*4, shade=distance<.72?255:20;
    pixels[offset]=pixels[offset+1]=pixels[offset+2]=shade;
    pixels[offset+3]=Math.round(255*Math.max(0,Math.min(1,(1-distance)*side/2+.5)));
  }
  const texture=new THREE.DataTexture(pixels,side,side,THREE.RGBAFormat);
  texture.colorSpace=THREE.SRGBColorSpace;
  texture.magFilter=texture.minFilter=THREE.LinearFilter;
  texture.needsUpdate=true;
  return texture;
}

function createStartMarker(THREE, texture) {
  const geometry=new THREE.BufferGeometry().setAttribute("position",new THREE.Float32BufferAttribute([0,0,0],3));
  const material=new THREE.PointsMaterial({map:texture,size:STREAMLINE_START_SIZE,sizeAttenuation:false,
    transparent:true,alphaTest:.05,depthWrite:false,depthTest:true,toneMapped:false});
  const marker=new THREE.Points(geometry,material);
  marker.name="result-streamline-start";marker.renderOrder=26;
  marker.userData.streamlineStart=true;
  marker.userData.viewportSize=new THREE.Vector2(1,1);
  // A world-space Points threshold grows/shrinks on screen with depth. Test the
  // actual 2D diamond in CSS pixels in both camera projections instead.
  const world=new THREE.Vector3(),projected=new THREE.Vector3(),rayPoint=new THREE.Vector3(),rayScreen=new THREE.Vector3();
  marker.raycast=(raycaster,intersections)=>{
    if(!marker.visible||!raycaster.camera)return;
    world.setFromMatrixPosition(marker.matrixWorld);
    projected.copy(world).applyMatrix4(raycaster.camera.matrixWorldInverse);
    if(projected.z>=0)return;
    projected.copy(world).project(raycaster.camera);
    if(projected.z < -1 || projected.z > 1)return;
    raycaster.ray.closestPointToPoint(world,rayPoint);
    rayScreen.copy(rayPoint).project(raycaster.camera);
    const size=marker.userData.viewportSize;
    const pixels=(Math.abs(projected.x-rayScreen.x)*size.x+Math.abs(projected.y-rayScreen.y)*size.y)/2;
    if(!Number.isFinite(pixels)||pixels>material.size/2+2)return;
    const distance=raycaster.ray.origin.distanceTo(rayPoint);
    if(distance<raycaster.near||distance>raycaster.far)return;
    intersections.push({distance,distanceToRay:world.distanceTo(rayPoint),point:world.clone(),index:0,object:marker});
  };
  return marker;
}

export function resizeStreamlineMaterials(root, width, height) {
  root?.traverse(object => {
    if (object.isLine2) object.material.resolution.set(Math.max(1, width), Math.max(1, height));
    if (object.userData.streamlineStart) object.userData.viewportSize.set(Math.max(1,width),Math.max(1,height));
  });
}

export function updateStreamlineMeshes(THREE,root,lines=[],{
  filters={},selected=null,width=2,colorMap=true,palette="Rainbow",resolution=[1,1],
}={}) {
  width = Number.isFinite(width) ? Math.max(1, Math.min(10, width)) : 2;
  palette = normalizeResultPalette(palette);
  const ranges = colorMap ? colorRanges(lines, filters) : new Map();
  const rgb = new THREE.Color();
  const old=new Map(root.children.map(object=>[object.userData.streamlinePart,object]));
  for(const line of lines)for(let i=0;i<line.paths.length;i++) {
    const path=line.paths[i],key=`${line.id}:${i}`;
    if (path.positions.length < 6) continue;
    let object=old.get(key);old.delete(key);
    if(!object) {
      object=new Line2(new LineGeometry(),lineMaterial());
      object.name="result-streamline";object.userData.streamlinePart=key;object.renderOrder=25;root.add(object);
    }
    if(object.userData.path!==path) {
      const count = path.positions.length / 3 - 1;
      if(object.geometry.getAttribute("instanceStart")?.count !== count) {
        object.geometry.dispose(); object.geometry=new LineGeometry();
        object.geometry.setPositions(new Float32Array(path.positions.length));
        object.geometry.setColors(new Float32Array(path.positions.length).fill(1));
        object.geometry.getAttribute("instanceStart").data.setUsage(THREE.DynamicDrawUsage);
        object.geometry.getAttribute("instanceColorStart").data.setUsage(THREE.DynamicDrawUsage);
        for (const border of object.children) border.geometry=object.geometry;
      }
      const origin=Array.from(path.positions.subarray(0,3));object.position.fromArray(origin);
      const starts=object.geometry.getAttribute("instanceStart"),ends=object.geometry.getAttribute("instanceEnd");
      for(let n=0;n<=count;n++) {
        const x=path.positions[n*3]-origin[0],y=path.positions[n*3+1]-origin[1],z=path.positions[n*3+2]-origin[2];
        if(n<count)starts.setXYZ(n,x,y,z);
        if(n>0)ends.setXYZ(n-1,x,y,z);
      }
      starts.data.needsUpdate=true;
      object.geometry.computeBoundingBox();object.geometry.computeBoundingSphere();
      object.userData.path=path;
    }
    const range = ranges.get(line.quantityKey ?? line.id);
    const colored = !!(colorMap && range && path.magnitudes?.length === path.positions.length / 3);
    const colorKey = `${palette}:${range?.minimum}:${range?.maximum}`;
    if (colored && (object.userData.colorPath !== path || object.userData.colorKey !== colorKey)) {
      const starts=object.geometry.getAttribute("instanceColorStart"),ends=object.geometry.getAttribute("instanceColorEnd");
      for(let n=0;n<path.magnitudes.length;n++) {
        const value=path.magnitudes[n];
        if(Number.isFinite(value) && value>=0) rgb.setRGB(...resultScalarColor(value,range.minimum,range.maximum,palette),THREE.SRGBColorSpace);
        else rgb.setHex(0xf4f4f4); // An undefined boundary value must not become a false zero.
        if(n<starts.count)starts.setXYZ(n,rgb.r,rgb.g,rgb.b);
        if(n>0)ends.setXYZ(n-1,rgb.r,rgb.g,rgb.b);
      }
      starts.data.needsUpdate=true;
      object.userData.colorPath=path;object.userData.colorKey=colorKey;
    }
    if(object.material.vertexColors!==colored) {object.material.vertexColors=colored;object.material.needsUpdate=true;}
    object.material.color.setHex(colored?0xffffff:0xf4f4f4);
    object.material.linewidth=width;
    object.userData.streamlineId=line.id;
    object.visible=pathVisible(path,filters);
    if(selected===line.id)selectionOutline(object);
    for(const border of object.children) {
      border.visible=selected===line.id; border.material.linewidth=width+border.userData.widthExtra;
    }
  }
  let hasMarkers=false;
  for(const line of lines) {
    if(line.error || line.start?.length!==3 || !line.start.every(Number.isFinite))continue;
    const key=`start:${line.id}`;
    let marker=old.get(key);old.delete(key);
    if(!marker) {
      root.userData.startMarkerTexture ??= startMarkerTexture(THREE);
      marker=createStartMarker(THREE,root.userData.startMarkerTexture);
      marker.userData.streamlinePart=key;root.add(marker);
    }
    hasMarkers=true;
    marker.position.fromArray(line.start);
    marker.userData.streamlineId=line.id;
    marker.material.color.setHex(selected===line.id?0xffdd38:0xffffff);
    marker.visible=pathVisible(line,filters);
  }
  for(const object of old.values()) {
    root.remove(object);object.geometry.dispose();object.material.dispose();
    for(const border of object.children)border.material.dispose();
  }
  if(!hasMarkers && root.userData.startMarkerTexture) {
    root.userData.startMarkerTexture.dispose();delete root.userData.startMarkerTexture;
  }
  resizeStreamlineMaterials(root,...resolution);
  root.userData.colorLegends=[...ranges.values()].map(range=>({...range,palette}));
  return root;
}
