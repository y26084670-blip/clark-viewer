import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

export function thinVectorSegment(hit) {
  const object = hit?.object, attribute = object?.geometry?.getAttribute("position");
  if (!object?.isLineSegments || !object.userData.resultVectors || !Number.isInteger(hit.index) || !attribute) return null;
  const vertices = (object.userData.segmentsPerVector ?? 1) * 2;
  const start = Math.floor(hit.index / vertices) * vertices;
  if (start + vertices > Math.min(attribute.count, object.geometry.drawRange.count)) return null;
  return { object, start, vertices };
}

// Native WebGL lines are one drawing-buffer pixel wide in Chromium; linewidth
// on LineBasicMaterial is ignored. Draw only the hovered vector as a wide line.
export function createThinVectorHover({ scene, requestRender }) {
  let overlay, current = null, ratio = 1;
  function clear() {
    if (!current) return;
    current = null; overlay.visible = false; requestRender();
  }
  return {
    clear,
    set(hit) {
      const next = thinVectorSegment(hit);
      if (!next) { clear(); return; }
      const attribute = next.object.geometry.getAttribute("position");
      if (current?.object === next.object && current.start === next.start && current.version === attribute.version) return;
      if (!overlay) {
        overlay = new LineSegments2(new LineSegmentsGeometry().setPositions(new Float32Array(30)), new LineMaterial({
          worldUnits: false, linewidth: 1 / ratio + 3, depthTest: true, depthWrite: false, transparent: true,
        }));
        overlay.name = "hovered-thin-vector"; overlay.renderOrder = 15;
        overlay.frustumCulled = false; overlay.matrixAutoUpdate = false;
        scene.add(overlay);
      }
      const positions = [];
      for (let i = next.start; i < next.start + next.vertices; i++) positions.push(attribute.getX(i), attribute.getY(i), attribute.getZ(i));
      const buffer = overlay.geometry.getAttribute("instanceStart").data;
      buffer.array.fill(0); buffer.array.set(positions); buffer.needsUpdate = true;
      overlay.geometry.instanceCount = next.vertices / 2;
      overlay.geometry.computeBoundingBox(); overlay.geometry.computeBoundingSphere();
      overlay.material.color.copy(next.object.material.color);
      overlay.material.opacity = next.object.material.opacity;
      next.object.updateWorldMatrix(true, false); overlay.matrix.copy(next.object.matrixWorld);
      overlay.visible = true; current = { ...next, version: attribute.version }; requestRender();
    },
    resize(width, height, pixelRatio = 1) {
      ratio = pixelRatio;
      if (!overlay) return;
      overlay.material.resolution.set(width, height);
      // Native line: one physical pixel. Add three CSS pixels at every DPR.
      overlay.material.linewidth = 1 / ratio + 3;
    },
    dispose() {
      current = null;
      overlay?.removeFromParent(); overlay?.geometry.dispose(); overlay?.material.dispose();
    },
  };
}
