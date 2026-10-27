import { primitiveVisible, instanceVisible } from "./geometryRenderFilters.js";
import { graphSlicePatch, graphSurfaceIndices } from "./resultGraphField.js";
import { resultScalarColor } from "./resultScalarColors.js";
import { applyMatrix4ToPoint } from "../solver/rotation3d.js";
import { updateGraphContours } from "./resultGraphContours.js";

const RGB = [0xff0000, 0x00ff00, 0x0000ff];
const visible = (source, instance, filters) => primitiveVisible({ source }, filters?.objectModes, filters?.selections) && instanceVisible(instance, filters?.symmetry);
const dispose = object => object.traverse(child => { child.geometry?.dispose(); child.material?.dispose(); });
export function disposeGraphScene(root) { if (root) { dispose(root); root.clear(); } }
function geometry(THREE, positions, indices) {
  const result = new THREE.BufferGeometry();
  result.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  result.setIndex(new THREE.BufferAttribute(indices, 1)); result.computeVertexNormals(); result.computeBoundingSphere();
  return result;
}
function boundary(THREE, positions, dimensions, color, overlay = false) {
  const [n1, n2] = dimensions, ids = [];
  for (let i = 0; i < n1; i++) ids.push(i * n2);
  for (let j = 1; j < n2; j++) ids.push((n1 - 1) * n2 + j);
  for (let i = n1 - 2; i >= 0; i--) ids.push(i * n2 + n2 - 1);
  for (let j = n2 - 2; j > 0; j--) ids.push(j);
  const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ids.map(n => new THREE.Vector3(...positions.subarray(n * 3, n * 3 + 3)))),
    new THREE.LineBasicMaterial({ color, transparent: true, depthTest: !overlay, depthWrite: false }));
  line.renderOrder = overlay ? 36 : 3; return line;
}
function spanOf(surface) {
  const [n1, n2] = surface.dimensions, p = surface.positions;
  const distance = (a, b) => Math.hypot(...[0, 1, 2].map(k => p[a * 3 + k] - p[b * 3 + k]));
  return Math.max(1e-12, Math.min(distance(0, (n1 - 1) * n2), distance(0, n2 - 1)));
}
function buildGraph(THREE, graph, options) {
  const group = new THREE.Group(), bases = new Set();
  group.userData = { graph, style: JSON.stringify([options.scale, options.palette, options.active === graph.id]) };
  group.name = `surface-graph:${graph.id}`;
  for (const surface of graph.surfaces) {
    const image = new THREE.Group(); image.userData = { source: graph.source, instance: surface.instance };
    const positions = new Float32Array(surface.positions.length), colors = new Float32Array(positions.length);
    const factor = spanOf(surface) * .35 * options.scale / graph.referenceMaximum;
    const color = new THREE.Color();
    for (let n = 0; n < surface.values.length; n++) {
      const value = Number.isFinite(surface.values[n]) ? surface.values[n] : 0;
      for (let k = 0; k < 3; k++) positions[n * 3 + k] = surface.positions[n * 3 + k] + surface.normals[n * 3 + k] * value * factor;
      color.setRGB(...resultScalarColor(value, surface.minimum, surface.maximum, options.palette), THREE.SRGBColorSpace);
      colors.set(color.toArray(), n * 3);
    }
    const meshGeometry = geometry(THREE, positions, surface.indices);
    const uv = new Float32Array(surface.values.length * 2), [n1, n2] = surface.dimensions;
    for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) uv.set([i / (n1 - 1), j / (n2 - 1)], (i * n2 + j) * 2);
    meshGeometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    const rgb = graph.kind === "region" && graph.components === 3;
    if (!rgb) meshGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(meshGeometry, new THREE.MeshStandardMaterial({ color: rgb ? RGB[surface.component] : 0xffffff,
      vertexColors: !rgb, roughness: .72, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    mesh.name = "result-graph-surface"; mesh.userData = { graphId: graph.id, component: surface.component, surface, factor };
    image.add(mesh);
    const baseKey = JSON.stringify([surface.instance.ls, surface.instance.as, surface.instance.ps, surface.instance.mirrorX, surface.instance.mirrorY]);
    if (!bases.has(baseKey)) {
      bases.add(baseKey);
      const base = new THREE.Mesh(geometry(THREE, surface.positions, graphSurfaceIndices(surface.dimensions, new Float64Array(surface.values.length))),
        new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }));
      base.name = "result-graph-base"; base.renderOrder = -1; image.add(base);
      const frame = boundary(THREE, surface.positions, surface.dimensions, options.active === graph.id ? 0xffa000 : 0x607080, options.active === graph.id);
      frame.name = "result-graph-outline"; image.add(frame);
    }
    group.add(image);
  }
  return group;
}

/** White support planes, lit RGB area surfaces and palette-coloured slice surfaces. */
export function updateGraphScene(THREE, root, scene, graphs, options = {}) {
  const settings = { scale: 1, palette: "Rainbow", ...options };
  const retained = new Set();
  for (const graph of graphs) {
    const name = `surface-graph:${graph.id}`, style = JSON.stringify([settings.scale, settings.palette, settings.active === graph.id]);
    let group = root.getObjectByName(name);
    if (!group || group.userData.graph !== graph || group.userData.style !== style) {
      if (group) { root.remove(group); dispose(group); }
      group = buildGraph(THREE, graph, settings); root.add(group);
    }
    retained.add(group);
    for (const image of group.children) image.visible = visible(image.userData.source, image.userData.instance, settings.filters);
  }
  for (const child of [...root.children]) if (!retained.has(child)) { root.remove(child); dispose(child); }
  updateGraphContours(THREE, root, settings.contour, settings.contourPreview, settings.resolution);
  if (settings.selected) {
    const primitive = scene?.primitives.find(p => p.source.schemaId === "elements" && p.source.recordIndex === settings.selected.recordIndex);
    if (primitive) {
      const group = new THREE.Group(); group.name = "graph-selected-element";
      for (const instance of primitive.instances) {
        if (!visible(primitive.source, instance, settings.filters)) continue;
        const positions = new Float64Array(primitive.vertices.length);
        for (let n = 0; n < positions.length / 3; n++) positions.set(applyMatrix4ToPoint(instance.matrix, primitive.vertices.subarray(n * 3, n * 3 + 3)), n * 3);
        const tint = new THREE.Mesh(geometry(THREE, positions, primitive.indices), new THREE.MeshBasicMaterial({
          color: 0xffb640, transparent: true, opacity: .12, side: THREE.DoubleSide, depthTest: true, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        }));
        tint.name = "graph-element-tint"; tint.renderOrder = 34; group.add(tint);
      }
      root.add(group);
    }
  }
  const descriptor = settings.preview;
  if (descriptor) {
    const primitive = scene?.primitives.find(p => p.source.schemaId === "elements" && p.source.recordIndex === descriptor.recordIndex);
    if (primitive) {
      const flat = primitive.controlVertices ?? primitive.vertices;
      const vertices = Array.from({ length: flat.length / 3 }, (_, i) => Array.from(flat.slice(i * 3, i * 3 + 3)));
      try {
        const patch = graphSlicePatch(vertices, descriptor.direction, primitive.discretization.counts, descriptor.discrete);
        const group = new THREE.Group(); group.name = "graph-slice-preview";
        for (const instance of primitive.instances) {
          if (!visible(primitive.source, instance, settings.filters)) continue;
          const positions = new Float64Array(patch.positions.length);
          for (let n = 0; n < positions.length / 3; n++) positions.set(applyMatrix4ToPoint(instance.matrix, patch.positions.subarray(n * 3, n * 3 + 3)), n * 3);
          const mesh = new THREE.Mesh(geometry(THREE, positions, graphSurfaceIndices(patch.dimensions, new Float64Array(positions.length / 3))),
            new THREE.MeshBasicMaterial({ color: 0xffc340, transparent: true, opacity: .32, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
          mesh.renderOrder = 35; group.add(mesh, boundary(THREE, positions, patch.dimensions, 0xffa000, true));
        }
        root.add(group);
      } catch { /* Invalid geometry is already reported by the scene diagnostics. */ }
    }
  }
}
