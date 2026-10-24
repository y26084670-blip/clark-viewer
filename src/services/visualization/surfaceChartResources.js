import * as THREE from "three";

export function surfaceFootprint({ width, height, coordinates }) {
  const origin = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3(), point = new THREE.Vector3();
  let physical = coordinates?.length === width * height * 3;
  let length1 = width - 1, length2 = height - 1;
  if (physical) {
    origin.fromArray(coordinates);
    u.fromArray(coordinates, (width - 1) * height * 3).sub(origin);
    v.fromArray(coordinates, (height - 1) * 3).sub(origin);
    length1 = u.length(); length2 = v.length();
    u.normalize(); v.addScaledVector(u, -v.dot(u));
    physical = Number.isFinite(length1 + length2 + v.length()) && length1 > 0 && v.length() > length2 * 1e-12;
    v.normalize();
  }
  const xy = new Float64Array(width * height * 2);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < width; i++) for (let j = 0; j < height; j++) {
    const k = i * height + j;
    if (physical) point.fromArray(coordinates, k * 3).sub(origin);
    const x = physical ? point.dot(u) : i, y = physical ? point.dot(v) : j;
    if (!Number.isFinite(x + y)) throw new Error("Площадка содержит нечисловые координаты");
    xy[k * 2] = x; xy[k * 2 + 1] = y;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  // One scale for both axes preserves lengths, angles and nonuniform spacing.
  const scale = 2 / Math.max(maxX - minX, maxY - minY, Number.MIN_VALUE);
  for (let k = 0; k < xy.length; k += 2) {
    xy[k] = (xy[k] - (minX + maxX) / 2) * scale;
    xy[k + 1] = (xy[k + 1] - (minY + maxY) / 2) * scale;
  }
  return { xy, physical, length1, length2, halfWidth: (maxX - minX) * scale / 2, halfHeight: (maxY - minY) * scale / 2 };
}

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
  const valueLimits = { min, max };
  // Display limits affect height/colour and the legend, never the saved values.
  const range = grid.displayRange;
  if (range && Number.isFinite(range.minimum) && Number.isFinite(range.maximum) && range.minimum <= range.maximum) {
    min = range.minimum; max = range.maximum;
  }
  const footprint = surfaceFootprint(grid);
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
    positions.setXYZ(k, footprint.xy[k * 2], footprint.xy[k * 2 + 1], fraction * 1.5);
    color.setHSL(.66 * (1 - Math.max(0, Math.min(1, fraction))), .9, .48); color.toArray(colors.array, k * 3);
  }
  positions.needsUpdate = true; colors.needsUpdate = true;
  surface.geometry.computeBoundingBox(); surface.geometry.computeBoundingSphere();
  surface.userData.valueLimits = valueLimits;
  surface.userData.limits = { min, max }; surface.visible = true;
  surface.userData.footprint = footprint;
  return surface;
}

export function updateSurfaceLabel(sprite, text, position, createCanvas = () => document.createElement("canvas")) {
  if (!sprite) {
    const canvas = createCanvas(); canvas.width = 1536; canvas.height = 192;
    const material = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false });
    sprite = new THREE.Sprite(material); sprite.scale.set(4.5, .57, 1);
  }
  if (sprite.userData.text !== text) {
    const canvas = sprite.material.map.image, context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#000000"; context.font = "72px sans-serif"; context.textAlign = "center";
    context.fillText(text, 768, 120); sprite.material.map.needsUpdate = true;
    sprite.userData.text = text;
  }
  sprite.position.copy(position); sprite.visible = true;
  return sprite;
}

// Text lives in a high-resolution atlas. Reduce the displayed font by two
// typographic points (8/3 CSS px), rather than subtracting two atlas texels.
export function resizeSurfaceLabels(labels, camera, viewportHeight) {
  const pixelsPerWorldUnit = viewportHeight / (camera.top - camera.bottom);
  const previousFontPx = .57 * 72 / 192 * pixelsPerWorldUnit;
  const factor = Math.max(.1, 1 - (2 * 96 / 72) / previousFontPx);
  for (const label of labels) label.scale.set(4.5 * factor, .57 * factor, 1);
}

export function disposeSurfaceObject(object) {
  if (!object) return;
  for (const child of [...object.children]) disposeSurfaceObject(child);
  object.removeFromParent();
  // Three.js sprites share a built-in quad; only their texture/material belong
  // to this chart. Mesh and axes geometries are owned by this instance.
  if (!object.isSprite) object.geometry?.dispose();
  object.material?.map?.dispose(); object.material?.dispose();
}
