import * as THREE from "three";

// Time steps share one topology. Keep the mesh, material and GPU buffers while
// replacing only the saved values; picking needs refreshed bounds as well.
export function updateSurfaceMesh(surface, grid) {
  const { width, height, values } = grid;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2
    || values.length !== width * height) throw new Error("Некорректная сетка поверхности");
  let min = Infinity, max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error("Поверхность содержит нечисловые значения");
    min = Math.min(min, value); max = Math.max(max, value);
  }
  if (!surface) surface = new THREE.Mesh(new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  if (surface.userData.width !== width || surface.userData.height !== height) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(values.length * 3), 3)
      .setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(values.length * 3), 3)
      .setUsage(THREE.DynamicDrawUsage));
    const IndexArray = values.length > 65535 ? Uint32Array : Uint16Array;
    const indices = new IndexArray((width - 1) * (height - 1) * 6);
    let offset = 0;
    for (let i = 0; i < width - 1; i++) for (let j = 0; j < height - 1; j++) {
      const a = i * height + j, b = a + height;
      indices.set([a, b, a + 1, b, b + 1, a + 1], offset); offset += 6;
    }
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    surface.geometry.dispose(); surface.geometry = geometry;
    surface.userData.width = width; surface.userData.height = height;
  }
  const positions = surface.geometry.getAttribute("position"), colors = surface.geometry.getAttribute("color");
  const span = max - min || Math.max(Math.abs(min), 1), color = new THREE.Color();
  for (let i = 0; i < width; i++) for (let j = 0; j < height; j++) {
    const k = i * height + j, fraction = (values[k] - min) / span;
    positions.setXYZ(k, 2 * i / (width - 1) - 1, 2 * j / (height - 1) - 1, fraction * 1.5);
    color.setHSL(.66 * (1 - fraction), .9, .48); color.toArray(colors.array, k * 3);
  }
  positions.needsUpdate = true; colors.needsUpdate = true;
  surface.geometry.computeBoundingBox(); surface.geometry.computeBoundingSphere();
  surface.userData.limits = { min, max }; surface.visible = true;
  return surface;
}

export function updateSurfaceLabel(sprite, text, position, createCanvas = () => document.createElement("canvas")) {
  if (!sprite) {
    const canvas = createCanvas(); canvas.width = 512; canvas.height = 64;
    const material = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false });
    sprite = new THREE.Sprite(material); sprite.scale.set(1.5, .19, 1);
  }
  if (sprite.userData.text !== text) {
    const canvas = sprite.material.map.image, context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#20262d"; context.font = "24px sans-serif"; context.textAlign = "center";
    context.fillText(text, 256, 40); sprite.material.map.needsUpdate = true;
    sprite.userData.text = text;
  }
  sprite.position.copy(position); sprite.visible = true;
  return sprite;
}

export function disposeSurfaceObject(object) {
  if (!object) return;
  object.removeFromParent();
  // Three.js sprites share a built-in quad; only their texture/material belong
  // to this chart. Mesh and axes geometries are owned by this instance.
  if (!object.isSprite) object.geometry?.dispose();
  object.material?.map?.dispose(); object.material?.dispose();
}
