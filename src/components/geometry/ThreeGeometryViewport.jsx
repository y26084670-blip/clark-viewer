import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";

import {
  instanceVisible,
  primitiveVisible,
} from "../../services/visualization/geometryRenderFilters.js";
import {
  DEFAULT_DISCRETIZATION_LIMITS,
  buildElementDiscretization,
  buildRegionDiscretization,
  countElementDiscretization,
  countRegionDiscretization,
} from "../../services/visualization/geometryDiscretization.js";
import {
  GEOMETRY_CAMERA_COMMANDS,
  INITIAL_GEOMETRY_CAMERA_FRAME,
  orientGeometryCamera,
  normalizeGeometryCameraCommand,
} from "../../services/visualization/geometryCameraView.js";
import { fitCameraToVisibleObjects } from "../../services/visualization/geometryCameraFit.js";
import { resultVectorLength } from "../../services/visualization/resultVectorScale.js";
import {
  findPointMetadataRange,
  findVertexMetadataRange,
  formatDiscretizationPointTooltip,
  formatGeometryTooltip,
  formatResultScalarTooltip,
  formatResultVectorTooltip,
  resultHitScalar,
  resultHitVector,
  formatVertexTooltip,
  geometryHitInstance,
  pointHitMetadata,
  vertexHitMetadata,
} from "../../services/visualization/geometryPicking.js";
import {
  GEOMETRY_MATERIAL_KINDS,
  contrastingGeometryEdgeColor,
  geometryMaterialStyle as resolveGeometryMaterialStyle,
} from "../../services/visualization/geometryMaterialStyle.js";
import {
  resultScalarColor,
  normalizeResultPalette,
  resultScalarLegendBackground,
} from "../../services/visualization/resultScalarColors.js";

import { updateResultVolumeMeshes } from "../../services/visualization/resultVolumeRenderer.js";
import { updateResultSurfaceMeshes } from "../../services/visualization/resultSurfaceRenderer.js";
import { loadStreamlineRenderer, resizeStreamlineMaterials, streamlinePointerHandlers, updateStreamlineMeshes } from "../../services/visualization/resultStreamlineRenderer.js";
import { captureMovieCanvas } from "../../services/movie/movieCanvas.js";
import { captureRenderedMovieFrame, createRenderedFrameGate, restoreMovieCamera, snapshotMovieCamera } from "../../services/movie/renderedFrameGate.js";

export const GEOMETRY_INSTANCE_BUDGET = 20_000;
export const GEOMETRY_DISCRETIZATION_SEGMENT_BUDGET =
  DEFAULT_DISCRETIZATION_LIMITS.lineSegments;
export const GEOMETRY_DISCRETIZATION_POINT_BUDGET =
  DEFAULT_DISCRETIZATION_LIMITS.points;

const INSTANCE_CATEGORIES = Object.freeze(["base", "copy", "mirror"]);
const DEFAULT_PROJECTION = "orthographic";
const PERSPECTIVE_FOV = 45;
const AXES_GIZMO_SIZE = 104;
const AXES_GIZMO_MARGIN = 8;
const VERTEX_POINT_SIZE = 9;
const DISCRETIZATION_POINT_SIZE = 8;
const DEGENERATE_POINT_SIZE = 13;
const PICK_INTERVAL_MS = 80;

function normalizeProjection(value) {
  return value === "perspective" ? "perspective" : DEFAULT_PROJECTION;
}

function instanceCategory(instance) {
  if (instance?.mirrorX || instance?.mirrorY) return "mirror";
  if (
    Number(instance?.ls ?? 0) === 0 &&
    Number(instance?.as ?? 0) === 0 &&
    Number(instance?.ps ?? 0) === 0
  ) {
    return "base";
  }
  return "copy";
}

function materialStyle(primitive, category, mode) {
  const isElement = primitive.kind === "element-volume";
  const original = category === "base";
  const palette = isElement
    ? resolveGeometryMaterialStyle(primitive.materialKind, original)
    : {
        color: original ? 0xd99043 : 0xffb65e,
        edgeColor: contrastingGeometryEdgeColor(original ? 0xd99043 : 0xffb65e),
      };

  return {
    ...palette,
    opacity: mode === "translucent"
      ? primitive.kind === "region-line" ? 0.68 : 0.42
      : 1,
  };
}

function renderObjectCost(primitive, mode, showEdges) {
  const shape = primitiveRenderShape(primitive);
  if (
    shape !== "surface" ||
    mode === "wireframe" ||
    !showEdges
  ) {
    return 1;
  }

  return 2;
}

function disposeMaterial(material) {
  if (Array.isArray(material)) {
    for (const item of material) item?.dispose?.();
    return;
  }
  material?.map?.dispose?.();
  for (const texture of material?.userData?.resultOwnedTextures ?? []) texture.dispose();
  material?.dispose?.();
}

function disposeObject(root) {
  root?.traverse?.((object) => {
    if (object.isInstancedMesh) object.dispose();
    object.geometry?.dispose?.();
    disposeMaterial(object.material);
  });
}

function sourceInstanceKey(source, instance) {
  return [
    source?.recordIndex,
    Number(instance?.ls ?? 0),
    Number(instance?.as ?? 0),
    Number(instance?.ps ?? 0),
    Number(instance?.mirrorX ?? 0),
    Number(instance?.mirrorY ?? 0),
  ].join(":");
}

function sourceVectorRoot(THREE, previousRoot, style) {
  const root = previousRoot ?? new THREE.Group();
  root.name = "prescribed-source-vectors";
  if (root.userData.style !== style) {
    for (const child of [...root.children]) {
      root.remove(child);
      disposeObject(child);
    }
    root.userData.style = style;
    root.userData.colorLegend = null;
  }
  return root;
}

function createPrescribedSourceVectors(
  THREE,
  vectors,
  acceptedInstances,
  sceneDiagonal,
  style,
  scales,
  maximumMagnitude,
  colorOverride,
  previousRoot = null,
  palette = "Viridis",
  lengthReference = null,
) {
  const root = sourceVectorRoot(THREE, previousRoot, style);
  if (style === "points") {
    const points = acceptedInstances
      ? vectors.filter(item => acceptedInstances.has(sourceInstanceKey(item.source, item.instance)))
      : vectors;
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const point of points) {
      minimum = Math.min(minimum, point.magnitude);
      maximum = Math.max(maximum, point.magnitude);
    }
    const previous = root.getObjectByName("result-vector-color-nodes");
    const nodes = updateResultPoints(THREE, previous, points, {
      colorMap: true, minimum, maximum, palette,
      size: DISCRETIZATION_POINT_SIZE * prescribedSourceScale(scales?.magnetization),
    });
    if (nodes.parent !== root) root.add(nodes);
    root.userData.colorLegend = points.length ? {
      minimum, maximum, quantity: `Модуль · ${points[0].quantity}`, unit: points[0].unit, palette,
    } : null;
    return root;
  }
  const maximum = maximumMagnitude ?? { current: 0, magnetization: 0 };
  const positions = { current: [], magnetization: [] };
  const thinVectors = { current: [], magnetization: [] };
  const solidArrows = { current: [], magnetization: [] };
  if (maximumMagnitude == null) {
    for (const item of vectors) {
      maximum[item.kind] = Math.max(maximum[item.kind], item.magnitude);
    }
  }

  const direction = new THREE.Vector3();
  const origin = new THREE.Vector3();
  const tip = new THREE.Vector3();


  for (const item of vectors) {
    if (acceptedInstances && !acceptedInstances.has(sourceInstanceKey(item.source, item.instance))) {
      continue;
    }
    // Apply the user scale after the base limit so it can enlarge the arrows.
    const length = resultVectorLength(item, scales[item.kind], maximum, sceneDiagonal, lengthReference);
    if (!(length > 0) || !Number.isFinite(length)) continue;

    if (style === "solid") {
      solidArrows[item.kind].push({ item, length });
      continue;
    }

    const target = positions[item.kind];
    thinVectors[item.kind].push(item);
    origin.fromArray(item.origin);
    direction.set(
      item.vector[0] / item.magnitude,
      item.vector[1] / item.magnitude,
      item.vector[2] / item.magnitude,
    );
    tip.copy(origin).addScaledVector(direction, length);
    target.push(origin.x, origin.y, origin.z, tip.x, tip.y, tip.z);
  }

  const capacityFor = count => 2 ** Math.ceil(Math.log2(Math.max(1, count)));
  for (const [kind, color] of [["current", colorOverride ?? 0xff0000], ["magnetization", colorOverride ?? 0x00cc44]]) {
    if (style === "solid") {
      const arrows = solidArrows[kind];
      const meshes = ["shaft", "head"].map(part => {
        const name = `prescribed-source-${kind}-${part}`;
        let mesh = root.getObjectByName(name);
        if (!mesh && arrows.length === 0) return null;
        if (!mesh || mesh.instanceMatrix.count < arrows.length) {
          const geometry = mesh?.geometry ?? (part === "shaft"
            ? new THREE.CylinderGeometry(1, 1, 1, 8)
            : new THREE.ConeGeometry(1, 1, 12));
          const material = mesh?.material ?? new THREE.MeshLambertMaterial({
            color, depthTest: true, depthWrite: true, transparent: true, opacity: 1,
          });
          if (mesh) { root.remove(mesh); mesh.dispose(); }
          mesh = new THREE.InstancedMesh(geometry, material, capacityFor(arrows.length));
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          mesh.name = name;
          mesh.renderOrder = 14;
          root.add(mesh);
        }
        mesh.material.color.setHex(color);
        mesh.userData.resultVectors = arrows.map(({ item }) => item);
        mesh.count = arrows.length;
        mesh.visible = arrows.length > 0;
        return mesh;
      });
      const [shafts, heads] = meshes;
      if (arrows.length === 0) continue;
      const up = new THREE.Vector3(0, 1, 0);
      const rotation = new THREE.Quaternion();
      const position = new THREE.Vector3();
      const scale = new THREE.Vector3();
      const matrix = new THREE.Matrix4();
      for (let index = 0; index < arrows.length; index += 1) {
        const { item, length } = arrows[index];
        origin.fromArray(item.origin);
        direction.set(...item.vector).divideScalar(item.magnitude).normalize();
        rotation.setFromUnitVectors(up, direction);
        const shaftLength = length * 0.75;
        position.copy(origin).addScaledVector(direction, shaftLength * 0.5);
        scale.set(length * 0.025, shaftLength, length * 0.025);
        shafts.setMatrixAt(index, matrix.compose(position, rotation, scale));
        const headLength = length * 0.25;
        position.copy(origin).addScaledVector(direction, shaftLength + headLength * 0.5);
        scale.set(length * 0.125, headLength, length * 0.125);
        heads.setMatrixAt(index, matrix.compose(position, rotation, scale));
      }
      for (const mesh of meshes) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
      continue;
    }
    const values = positions[kind];
    const name = `prescribed-source-${kind}`;
    let lines = root.getObjectByName(name);
    if (!lines && values.length === 0) continue;
    if (!lines) {
      lines = new THREE.LineSegments(new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({
          color, depthTest: true, depthWrite: false, transparent: true, opacity: 1,
        }));
      lines.name = name;
      lines.renderOrder = 14;
      // Active drawRange may occupy only part of the retained allocation.
      lines.frustumCulled = false;
      root.add(lines);
    }
    let attribute = lines.geometry.getAttribute("position");
    if (!attribute || attribute.array.length < values.length) {
      lines.geometry.dispose();
      lines.geometry = new THREE.BufferGeometry();
      attribute = new THREE.BufferAttribute(new Float32Array(capacityFor(values.length / 3) * 3), 3);
      attribute.setUsage(THREE.DynamicDrawUsage);
      lines.geometry.setAttribute("position", attribute);
    }
    lines.material.color.setHex(color);
    lines.userData.resultVectors = thinVectors[kind];
    attribute.array.set(values);
    attribute.needsUpdate = true;
    lines.geometry.setDrawRange(0, values.length / 3);
    lines.visible = values.length > 0;
    lines.geometry.computeBoundingSphere();
  }
  return root;
}

// Retain a fixed reference frame: motion never compounds Float32 round-off from
// the preceding displayed step. Each range is contiguous per physical image.
function captureMotionBuffer(THREE, object, ranges, worldPositions = null) {
  const attribute = object.geometry.getAttribute("position");
  attribute.setUsage(THREE.DynamicDrawUsage);
  return {
    object, worldPositions,
    reference: new Float64Array(worldPositions ?? attribute.array),
    ranges: ranges.map(range => ({
      ...range,
      inverses: range.instances.map(instance => new THREE.Matrix4().fromArray(instance.matrix).invert()),
    })),
  };
}

function updateMotionBuffer(THREE, buffer, resolveInstances) {
  const attribute = buffer.object.geometry.getAttribute("position");
  const matrix = new THREE.Matrix4();
  const vertex = new THREE.Vector3();
  for (const range of buffer.ranges) {
    const instances = resolveInstances(range.source, range.instances);
    const span = (range.end - range.start) / instances.length;
    for (let image = 0; image < instances.length; image += 1) {
      matrix.fromArray(instances[image].matrix).multiply(range.inverses[image]);
      for (let index = 0; index < span; index += 1) {
        const offset = (range.start + image * span + index) * 3;
        vertex.fromArray(buffer.reference, offset).applyMatrix4(matrix);
        vertex.toArray(attribute.array, offset);
        if (buffer.worldPositions) vertex.toArray(buffer.worldPositions, offset);
      }
    }
  }
  attribute.needsUpdate = true;
  buffer.object.geometry.computeBoundingBox();
  buffer.object.geometry.computeBoundingSphere();
}

export { createPrescribedSourceVectors, captureMotionBuffer, updateMotionBuffer };

function prescribedSourceScale(value) {
  const scale = Number(value ?? 1);
  return Number.isFinite(scale) ? Math.max(0.1, Math.min(10, scale)) : 1;
}

// A lit spherical sprite keeps the same pixel-sized footprint as "Узлы".
// One shared texture avoids a sphere mesh (and per-camera matrix updates) per node.
function resultSphereTexture(THREE) {
  const side = 64;
  const pixels = new Uint8Array(side * side * 4);
  const light = new THREE.Vector3(-0.4, 0.5, 1).normalize();
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const nx = (x + 0.5) / side * 2 - 1;
    const ny = (y + 0.5) / side * 2 - 1;
    const radiusSquared = nx * nx + ny * ny;
    if (radiusSquared > 1) continue;
    const nz = Math.sqrt(1 - radiusSquared);
    const brightness = 0.38 + 0.62 * Math.max(0, nx * light.x + ny * light.y + nz * light.z);
    const offset = (y * side + x) * 4;
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = Math.round(255 * brightness);
    pixels[offset + 3] = 255;
  }
  const texture = new THREE.DataTexture(pixels, side, side, THREE.RGBAFormat);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function updateResultPoints(THREE, previous, points, {
  scalar = false, colorMap = false, minimum, maximum, color = 0x44ccff, palette = "Viridis",
  size = colorMap ? DISCRETIZATION_POINT_SIZE : scalar ? 9 : 4,
} = {}) {
  const colored = scalar || colorMap;
  let nodes = previous;
  if (!nodes) {
    let pointMaterial;
    if (colored) {
      let texture;
      if (colorMap) texture = resultSphereTexture(THREE);
      else {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 32;
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.beginPath();
        context.arc(16, 16, 15.5, 0, Math.PI * 2);
        context.fill();
        texture = new THREE.CanvasTexture(canvas);
      }
      pointMaterial = new THREE.PointsMaterial({
        map: texture,
        vertexColors: true,
        size,
        sizeAttenuation: false,
        alphaTest: 0.5,
        transparent: !colorMap,
        depthTest: true,
        depthWrite: true,
        toneMapped: false,
      });
    } else pointMaterial = new THREE.PointsMaterial({
      color, size, sizeAttenuation: false, depthTest: true, depthWrite: false,
    });
    nodes = new THREE.Points(new THREE.BufferGeometry(), pointMaterial);
    nodes.name = scalar ? "result-scalar-nodes" : colorMap ? "result-vector-color-nodes" : "result-vector-nodes";
    nodes.renderOrder = 14;
  }
  let positions = nodes.geometry.getAttribute("position");
  if (!positions || positions.count < points.length) {
    const capacity = 2 ** Math.ceil(Math.log2(Math.max(1, points.length)));
    nodes.geometry.dispose();
    nodes.geometry = new THREE.BufferGeometry();
    positions = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    nodes.geometry.setAttribute("position", positions);
    if (colored) nodes.geometry.setAttribute("color",
      new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
  }
  const colors = nodes.geometry.getAttribute("color");
  const rgb = new THREE.Color();
  points.forEach((item, index) => {
    positions.array.set(item.origin, index * 3);
    if (colored) {
      rgb.setRGB(...resultScalarColor(colorMap ? item.magnitude : item.value, minimum, maximum, palette), THREE.SRGBColorSpace);
      rgb.toArray(colors.array, index * 3);
    }
  });
  positions.needsUpdate = true;
  if (colored) colors.needsUpdate = true;
  else nodes.material.color.setHex(color);
  nodes.material.size = size;
  nodes.geometry.setDrawRange(0, points.length);
  nodes.geometry.computeBoundingSphere();
  nodes.visible = points.length > 0;
  nodes.userData[scalar ? "resultScalars" : "resultVectors"] = points;
  return nodes;
}

export { updateResultPoints };

/** Retained Three.js roots, one independent normalization domain per result category. */
export function resultLayerRoots(states) {
  return [...states.values()].flatMap(state => [state.vectorRoot, state.scalarRoot].filter(Boolean));
}

function releaseResultRoot(root) {
  if (!root) return;
  root.removeFromParent();
  disposeObject(root);
}

export function updateResultLayers(THREE, previous, definitions, {
  filters = {}, colorMap = false, style = "thin", scale = 1,
  palette = "Viridis", opacity = 1,
} = {}) {
  const next = new Map();
  const visible = item => primitiveVisible(item, filters.objectModes, filters.selections)
    && instanceVisible(item.instance, filters.symmetry);
  for (const layer of definitions ?? []) {
    if (!layer || layer.state && layer.state !== "ready") continue;
    const scene = layer.scene ?? null, scalarScene = layer.scalarScene ?? null;
    if (!scene && !scalarScene) continue;
    const key = layer.key;
    // The three categories are independent; a repeated key must never share roots.
    if (next.has(key)) continue;
    const old = previous.get(key);
    const volumeFields = layer.volumeFields ?? null;
    const vectorStyle = colorMap ? (volumeFields ? "volume" : "points") : style;
    const signature = [scene, scalarScene, volumeFields, layer.color, layer.quantityKey,
      layer.groupLabel, filters, colorMap, vectorStyle, scale, palette, opacity, layer.vectorLengthReference];
    if (old && signature.every((value, index) => Object.is(value, old.signature[index]))) {
      next.set(key, old);
      continue;
    }
    const state = { key, signature, scene, vectorStyle, scale,
      vectorRoot: old?.vectorRoot ?? null, scalarRoot: old?.scalarRoot ?? null, legends: [] };
    const color = layer.color ?? 0x44ccff;
    if (scene) {
      const vectors = scene.vectors.filter(visible);
      let legend = null;
      if (vectorStyle === "volume") {
        state.vectorRoot = sourceVectorRoot(THREE, state.vectorRoot, "volume");
        const domains = volumeFields.domains.filter(visible);
        const surfaces = (volumeFields.surfaces ?? []).filter(visible);
        let minimum = Infinity, maximum = -Infinity;
        for (const vector of vectors) {
          minimum = Math.min(minimum, vector.magnitude);
          maximum = Math.max(maximum, vector.magnitude);
        }
        updateResultVolumeMeshes(THREE, state.vectorRoot, domains,
          { minimum, maximum, palette, opacity });
        updateResultSurfaceMeshes(THREE, state.vectorRoot, surfaces,
          { minimum, maximum, palette, opacity });
        const fallback = (volumeFields.fallbackPoints ?? []).filter(visible);
        // Unrendered fallback samples must not become invisible picking targets.
        // Successful domains retain their saved nodes, never boundary support nodes.
        const pickVectors = [...new Set([...domains, ...surfaces].flatMap(domain => domain.points ?? []).concat(fallback))].filter(visible);
        const pickNodes = updateResultPoints(THREE,
          state.vectorRoot.getObjectByName("result-volume-pick-nodes"), pickVectors);
        pickNodes.name = "result-volume-pick-nodes";
        pickNodes.material.colorWrite = false;
        if (pickNodes.parent !== state.vectorRoot) state.vectorRoot.add(pickNodes);
        const fallbackNodes = updateResultPoints(THREE,
          state.vectorRoot.getObjectByName("result-volume-fallback-nodes"), fallback,
          { colorMap: true, minimum, maximum, palette, size: DISCRETIZATION_POINT_SIZE });
        fallbackNodes.name = "result-volume-fallback-nodes";
        if (fallbackNodes.parent !== state.vectorRoot) state.vectorRoot.add(fallbackNodes);
        if (vectors.length) legend = { minimum, maximum,
          quantity: `Модуль · ${vectors[0].quantity}`, unit: vectors[0].unit, palette };
      } else {
        state.vectorRoot = createPrescribedSourceVectors(THREE, vectors, null,
          scene.sceneDiagonal, vectorStyle,
          { current: scale, magnetization: scale },
          scene.maximumMagnitude, color, state.vectorRoot, palette, layer.vectorLengthReference);
        if (vectorStyle === "points") legend = state.vectorRoot.userData.colorLegend;
        else {
          const nodes = updateResultPoints(THREE,
            state.vectorRoot.getObjectByName("result-vector-nodes"), vectors, { color });
          if (nodes.parent !== state.vectorRoot) state.vectorRoot.add(nodes);
        }
      }
      state.vectorRoot.name = `result-${key}-vectors`;
      state.vectorRoot.visible = true;
      if (legend) state.legends.push({ ...legend, key: `${key}:vector`, groupLabel: layer.groupLabel });
    } else {
      releaseResultRoot(state.vectorRoot);
      state.vectorRoot = null;
    }
    if (scalarScene) {
      const validScalar = item => Number.isFinite(item.value)
        && item.origin?.length === 3 && Array.from(item.origin).every(Number.isFinite) && visible(item);
      const points = scalarScene.points.filter(validScalar);
      const { minimum, maximum, quantity, unit } = scalarScene;
      if (Number.isFinite(minimum) && Number.isFinite(maximum)) {
        const volume = Boolean(volumeFields);
        if (state.scalarRoot && (volume ? state.scalarRoot.isPoints : !state.scalarRoot.isPoints)) {
          releaseResultRoot(state.scalarRoot);
          state.scalarRoot = null;
        }
        if (volume) {
          state.scalarRoot ??= new THREE.Group();
          state.scalarRoot.userData.style = "volume";
          const domains = volumeFields.domains.filter(visible);
          const surfaces = (volumeFields.surfaces ?? []).filter(visible);
          updateResultVolumeMeshes(THREE, state.scalarRoot, domains,
            { minimum, maximum, palette, opacity });
          updateResultSurfaceMeshes(THREE, state.scalarRoot, surfaces,
            { minimum, maximum, palette, opacity });
          const fallback = (volumeFields.fallbackPoints ?? []).filter(validScalar);
          // Only original saved nodes and the displayed fallback belong to
          // picking. Interpolation support vertices and proxy boxes do not.
          const saved = [...new Set([...domains, ...surfaces].flatMap(domain => domain.points ?? []).concat(fallback))].filter(validScalar);
          const pickNodes = updateResultPoints(THREE,
            state.scalarRoot.getObjectByName("result-scalar-volume-pick-nodes"), saved,
            { scalar: true, minimum, maximum, palette, size: DISCRETIZATION_POINT_SIZE });
          pickNodes.name = "result-scalar-volume-pick-nodes";
          pickNodes.material.colorWrite = false;
          pickNodes.material.depthWrite = false;
          if (pickNodes.parent !== state.scalarRoot) state.scalarRoot.add(pickNodes);
          const fallbackNodes = updateResultPoints(THREE,
            state.scalarRoot.getObjectByName("result-scalar-volume-fallback-nodes"), fallback,
            { scalar: true, minimum, maximum, palette, size: DISCRETIZATION_POINT_SIZE });
          fallbackNodes.name = "result-scalar-volume-fallback-nodes";
          // The shared saved-node target already covers these markers.
          fallbackNodes.raycast = () => {};
          if (fallbackNodes.parent !== state.scalarRoot) state.scalarRoot.add(fallbackNodes);
          state.scalarRoot.name = `result-${key}-scalars`;
        } else {
          state.scalarRoot = updateResultPoints(THREE, state.scalarRoot, points,
            { scalar: true, minimum, maximum, palette,
              size: DISCRETIZATION_POINT_SIZE * prescribedSourceScale(scale) });
        }
        if (points.length) state.legends.push({ key: `${key}:scalar`, groupLabel: layer.groupLabel,
          minimum, maximum, quantity, unit, palette });
      } else {
        releaseResultRoot(state.scalarRoot);
        state.scalarRoot = null;
      }
    } else {
      releaseResultRoot(state.scalarRoot);
      state.scalarRoot = null;
    }
    next.set(key, state);
  }
  for (const [key, state] of previous) if (!next.has(key)) {
    releaseResultRoot(state.vectorRoot);
    releaseResultRoot(state.scalarRoot);
  }
  return next;
}

/** Each result layer keeps its own pixel picking radius, including small scalars. */
export function intersectResultLayers(raycaster, states, unitsPerPixel) {
  const hits = [];
  for (const state of states.values()) {
    for (const root of [state.vectorRoot, state.scalarRoot]) {
      if (!root) continue;
      const targets = [];
      root.traverseVisible(object => {
        if (object.isPoints || object.isLineSegments || object.isMesh) targets.push(object);
      });
      if (root === state.vectorRoot) {
        raycaster.params.Points.threshold = unitsPerPixel * resultPointPickRadius(state.scene, root, state.scale);
        hits.push(...raycaster.intersectObjects(targets, false));
      } else {
        for (const target of targets) {
          raycaster.params.Points.threshold = unitsPerPixel * Math.max(2, (target.material?.size ?? DISCRETIZATION_POINT_SIZE) / 2);
          hits.push(...raycaster.intersectObject(target, false));
        }
      }
    }
  }
  return hits.sort((a, b) => a.distance - b.distance);
}

export function resultPointPickRadius(currentResultScene, resultVectorRoot, scale) {
  return currentResultScene && resultVectorRoot?.visible && resultVectorRoot.userData.style === "points"
    ? Math.max(2, DISCRETIZATION_POINT_SIZE * prescribedSourceScale(scale) / 2) : 9;
}

export function applyViewerGeometryOpacity(layers, value, defaults = new WeakMap()) {
  const opacity = value ?? 1;
  for (const [root, enabled, hasEdges] of layers) {
    if (!root) continue;
    root.visible = enabled && (opacity > 0 || Boolean(hasEdges && root.getObjectByName("surface-edges")));
    root.traverse(object => {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        let initial = defaults.get(material);
        if (!initial) {
          initial = { opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite };
          defaults.set(material, initial);
        }
        const edge = object.name === "surface-edges";
        material.opacity = edge ? 1 : initial.opacity * opacity;
        material.depthWrite = !edge && initial.depthWrite && opacity >= 1;
        const transparent = edge || initial.transparent || material.opacity < 1;
        if (material.transparent !== transparent) { material.transparent = transparent; material.needsUpdate = true; }
        if (edge && Number.isFinite(object.userData.surfaceColor)) {
          // Choose contrast against the visible fill/background mixture, so a black
          // contour on a bright solid does not disappear against the dark empty scene.
          const fill = object.userData.surfaceColor, background = 0x141a20;
          let visibleColor = 0;
          for (const shift of [16, 8, 0]) visibleColor |= Math.round(((fill >> shift) & 255) * opacity + ((background >> shift) & 255) * (1 - opacity)) << shift;
          material.color.setHex(contrastingGeometryEdgeColor(visibleColor));
        }
      }
    });
  }
}

function validMatrix(value) {
  return value?.length === 16 && Array.from(value).every(Number.isFinite);
}

function topologyVertices(primitive) {
  return primitive.controlVertices ?? primitive.vertices ?? [];
}

function triangleHasMeasure(vertices, first, second, third) {
  const firstOffset = first * 3;
  const secondOffset = second * 3;
  const thirdOffset = third * 3;
  const left = [
    vertices[secondOffset] - vertices[firstOffset],
    vertices[secondOffset + 1] - vertices[firstOffset + 1],
    vertices[secondOffset + 2] - vertices[firstOffset + 2],
  ];
  const right = [
    vertices[thirdOffset] - vertices[firstOffset],
    vertices[thirdOffset + 1] - vertices[firstOffset + 1],
    vertices[thirdOffset + 2] - vertices[firstOffset + 2],
  ];
  const scale = Math.max(
    ...left.map(Math.abs),
    ...right.map(Math.abs),
  );
  if (!(scale > 0) || !Number.isFinite(scale)) return false;

  const lx = left[0] / scale;
  const ly = left[1] / scale;
  const lz = left[2] / scale;
  const rx = right[0] / scale;
  const ry = right[1] / scale;
  const rz = right[2] / scale;
  return lx * ry - ly * rx !== 0 ||
    ly * rz - lz * ry !== 0 ||
    lz * rx - lx * rz !== 0;
}

function hasNonzeroTriangle(primitive) {
  const vertices = primitive.vertices ?? [];
  const indices = primitive.indices ?? [];
  for (let index = 0; index + 2 < indices.length; index += 3) {
    if (triangleHasMeasure(
      vertices,
      indices[index],
      indices[index + 1],
      indices[index + 2],
    )) {
      return true;
    }
  }
  return false;
}

function nonzeroTopologyPositions(primitive) {
  const vertices = topologyVertices(primitive);
  const indices = primitive.edgeIndices ?? [];
  const positions = [];

  for (let index = 0; index + 1 < indices.length; index += 2) {
    const firstOffset = indices[index] * 3;
    const secondOffset = indices[index + 1] * 3;
    const dx = vertices[secondOffset] - vertices[firstOffset];
    const dy = vertices[secondOffset + 1] - vertices[firstOffset + 1];
    const dz = vertices[secondOffset + 2] - vertices[firstOffset + 2];
    if (dx === 0 && dy === 0 && dz === 0) continue;

    positions.push(
      vertices[firstOffset],
      vertices[firstOffset + 1],
      vertices[firstOffset + 2],
      vertices[secondOffset],
      vertices[secondOffset + 1],
      vertices[secondOffset + 2],
    );
  }

  return new Float64Array(positions);
}

function primitiveRenderShape(primitive) {
  if (
    primitive.kind !== "region-line" &&
    hasNonzeroTriangle(primitive)
  ) {
    return "surface";
  }
  return nonzeroTopologyPositions(primitive).length > 0 ? "line" : "point";
}

function mergedTopologyLineGeometry(THREE, primitive, instances) {
  const sourcePositions = nonzeroTopologyPositions(primitive);
  const vertexSpan = sourcePositions.length / 3;
  if (vertexSpan === 0) return null;

  const positions = [];
  appendTransformedPositions(THREE, sourcePositions, instances, positions);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3),
  );
  return { geometry, vertexSpan };
}

function mergedDegeneratePointGeometry(THREE, primitive, instances) {
  const vertices = topologyVertices(primitive);
  if (vertices.length < 3) return null;

  const positions = [];
  appendTransformedPositions(
    THREE,
    new Float64Array(vertices.slice(0, 3)),
    instances,
    positions,
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3),
  );
  return { geometry, vertexSpan: 1 };
}

function mergedGeometry(THREE, primitive, instances) {
  const sourceVertices = primitive.vertices ?? [];
  const sourceIndices = primitive.indices ?? [];
  const sourceVertexCount = Math.floor(sourceVertices.length / 3);
  if (sourceVertexCount === 0 || sourceVertices.length % 3 !== 0) return null;

  const positions = new Float32Array(sourceVertices.length * instances.length);
  const indexCount = sourceIndices.length;
  const totalVertexCount = sourceVertexCount * instances.length;
  const IndexArray = totalVertexCount > 65_535 ? Uint32Array : Uint16Array;
  const indices = indexCount > 0
    ? new IndexArray(indexCount * instances.length)
    : null;
  const matrix = new THREE.Matrix4();
  const vertex = new THREE.Vector3();
  const isSurface = primitive.kind !== "region-line";

  instances.forEach((instance, instanceIndex) => {
    matrix.fromArray(instance.matrix);
    const vertexOffset = instanceIndex * sourceVertexCount;
    const positionOffset = instanceIndex * sourceVertices.length;

    for (let index = 0; index < sourceVertexCount; index += 1) {
      const sourceOffset = index * 3;
      vertex.set(
        sourceVertices[sourceOffset],
        sourceVertices[sourceOffset + 1],
        sourceVertices[sourceOffset + 2],
      );
      vertex.applyMatrix4(matrix);
      const targetOffset = positionOffset + sourceOffset;
      positions[targetOffset] = vertex.x;
      positions[targetOffset + 1] = vertex.y;
      positions[targetOffset + 2] = vertex.z;
    }

    if (!indices) return;
    const targetIndexOffset = instanceIndex * indexCount;
    const reflected = isSurface && matrix.determinant() < 0;
    if (reflected && indexCount % 3 === 0) {
      for (let index = 0; index < indexCount; index += 3) {
        indices[targetIndexOffset + index] =
          vertexOffset + sourceIndices[index];
        indices[targetIndexOffset + index + 1] =
          vertexOffset + sourceIndices[index + 2];
        indices[targetIndexOffset + index + 2] =
          vertexOffset + sourceIndices[index + 1];
      }
      return;
    }

    for (let index = 0; index < indexCount; index += 1) {
      indices[targetIndexOffset + index] =
        vertexOffset + sourceIndices[index];
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (indices) geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

function mergedRegionBoundaryGeometry(THREE, primitive, instances) {
  const vertices = primitive.controlVertices;
  if (!vertices || vertices.length !== 12) return null;

  const order = [0, 1, 1, 2, 2, 3, 3, 0];
  const sourcePositions = new Float64Array(order.length * 3);
  for (let index = 0; index < order.length; index += 1) {
    const sourceOffset = order[index] * 3;
    const targetOffset = index * 3;
    sourcePositions[targetOffset] = vertices[sourceOffset];
    sourcePositions[targetOffset + 1] = vertices[sourceOffset + 1];
    sourcePositions[targetOffset + 2] = vertices[sourceOffset + 2];
  }

  const positions = [];
  appendTransformedPositions(
    THREE,
    sourcePositions,
    instances,
    positions,
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3),
  );
  return { geometry, vertexSpan: order.length };
}

function mergedWireframeGeometry(
  THREE,
  primitive,
  instances,
  boundaryOnly = false,
) {
  if (boundaryOnly && primitive.kind === "region-surface") {
    return mergedRegionBoundaryGeometry(THREE, primitive, instances);
  }

  const sourceVertices = primitive.vertices ?? [];
  const sourceIndices = primitive.indices ?? [];
  if (sourceVertices.length === 0 || sourceIndices.length === 0) return null;

  const sourceGeometry = new THREE.BufferGeometry();
  sourceGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(sourceVertices), 3),
  );
  sourceGeometry.setIndex(Array.from(sourceIndices));
  const sourceEdges = new THREE.EdgesGeometry(sourceGeometry);
  sourceGeometry.dispose();

  const sourcePositions = sourceEdges.getAttribute("position");
  const vertexSpan = sourcePositions?.count ?? 0;
  if (vertexSpan === 0) {
    sourceEdges.dispose();
    return null;
  }

  const positions = new Float32Array(
    sourcePositions.array.length * instances.length,
  );
  const matrix = new THREE.Matrix4();
  const vertex = new THREE.Vector3();
  instances.forEach((instance, instanceIndex) => {
    matrix.fromArray(instance.matrix);
    const targetOffset = instanceIndex * sourcePositions.array.length;
    for (let index = 0; index < vertexSpan; index += 1) {
      vertex.fromBufferAttribute(sourcePositions, index).applyMatrix4(matrix);
      const offset = targetOffset + index * 3;
      positions[offset] = vertex.x;
      positions[offset + 1] = vertex.y;
      positions[offset + 2] = vertex.z;
    }
  });
  sourceEdges.dispose();

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return { geometry, vertexSpan };
}

function appendSurfaceEdges(
  THREE,
  surface,
  primitive,
  instances,
  style,
  mode,
) {
  const wireframe = mergedWireframeGeometry(
    THREE,
    primitive,
    instances,
    true,
  );
  if (!wireframe) return;

  const edges = new THREE.LineSegments(
    wireframe.geometry,
    new THREE.LineBasicMaterial({
      color: style.edgeColor,
      depthTest: true,
      depthWrite: false,
      linewidth: 1,
      opacity: 1,
      transparent: false,
    }),
  );
  edges.name = "surface-edges";
  edges.userData.surfaceColor = style.color;
  // Keep contours after transparent volumes while preserving depth occlusion.
  edges.material.transparent = true;
  edges.renderOrder = 20;
  surface.add(edges);
}

function renderableFor(
  THREE,
  primitive,
  instances,
  category,
  mode,
  showEdges,
) {
  const style = materialStyle(primitive, category, mode);
  const virtual = primitive.materialKind === GEOMETRY_MATERIAL_KINDS.VIRTUAL;
  const renderShape = primitiveRenderShape(primitive);
  const showSurfaceEdges = renderShape === "surface" && showEdges === true;
  let object;
  let pickKind;
  let pickSpan;
  if (renderShape === "point") {
    const point = mergedDegeneratePointGeometry(THREE, primitive, instances);
    if (!point) return null;
    object = new THREE.Points(
      point.geometry,
      new THREE.PointsMaterial({
        color: style.color,
        depthTest: true,
        depthWrite: mode !== "translucent",
        opacity: style.opacity,
        size: DEGENERATE_POINT_SIZE,
        sizeAttenuation: false,
        transparent: style.opacity < 1,
      }),
    );
    pickKind = "points";
    pickSpan = point.vertexSpan;
  } else if (renderShape === "line") {
    const lines = mergedTopologyLineGeometry(THREE, primitive, instances);
    if (!lines) return null;
    object = new THREE.LineSegments(
      lines.geometry,
      new THREE.LineBasicMaterial({
        color: style.color,
        depthTest: true,
        depthWrite: mode !== "translucent",
        opacity: style.opacity,
        transparent: style.opacity < 1,
      }),
    );
    pickKind = "lines";
    pickSpan = lines.vertexSpan;
  } else if (mode === "wireframe") {
    const wireframe = mergedWireframeGeometry(
      THREE,
      primitive,
      instances,
      true,
    );
    if (!wireframe) return null;
    object = new THREE.LineSegments(
      wireframe.geometry,
      new THREE.LineBasicMaterial({
        color: virtual ? style.edgeColor : style.color,
        opacity: style.opacity,
        transparent: style.opacity < 1,
      }),
    );
    pickKind = "lines";
    pickSpan = wireframe.vertexSpan;
  } else {
    const geometry = mergedGeometry(THREE, primitive, instances);
    if (!geometry) return null;
    object = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({
        color: style.color,
        opacity: style.opacity,
        transparent: style.opacity < 1,
        depthWrite: mode !== "translucent",
        flatShading: true,
        polygonOffset: showSurfaceEdges,
        polygonOffsetFactor: showSurfaceEdges ? 1 : 0,
        polygonOffsetUnits: showSurfaceEdges ? 1 : 0,
        side: THREE.DoubleSide,
      }),
    );
    if (showSurfaceEdges) {
      appendSurfaceEdges(
        THREE,
        object,
        primitive,
        instances,
        style,
        mode,
      );
    }
    pickKind = "mesh";
    pickSpan = Math.floor((primitive.indices?.length ?? 0) / 3);
  }

  object.name = `${primitive.source?.schemaId ?? "geometry"}:` +
    `${primitive.source?.recordIndex ?? "?"}:${category}`;
  object.userData = {
    category,
    instanceCount: instances.length,
    pick: {
      instances,
      kind: pickKind,
      span: pickSpan,
    },
    primitiveKind: primitive.kind,
    renderShape,
    source: primitive.source,
    surfaceEdgesShown: showSurfaceEdges,
  };
  return object;
}

// Render every selected primitive within the instance expansion budget. Surface
// edges are decoration and must not consume a separate object quota.
export function createGeometryObjects(THREE, sceneModel, filters, mode, showEdges,
  budget = GEOMETRY_INSTANCE_BUDGET, onObject = () => {}) {
  let remaining = budget;
  let selectedInstances = 0;
  let renderedInstances = 0;
  let renderedPrimitives = 0;
  let invalidInstances = 0;

  for (const primitive of sceneModel?.primitives ?? []) {
    if (!primitiveVisible(
      primitive,
      filters?.objectModes,
      filters?.selections,
    )) {
      continue;
    }
    const instances = primitive.instances ?? [];

    for (const category of INSTANCE_CATEGORIES) {
      const categoryInstances = instances.filter(
        (instance) =>
          instanceCategory(instance) === category &&
          instanceVisible(instance, filters?.symmetry),
      );
      const validInstances = categoryInstances.filter(
        (instance) => validMatrix(instance.matrix),
      );
      const objectCost = renderObjectCost(primitive, mode, showEdges);
      selectedInstances += categoryInstances.length;
      invalidInstances += categoryInstances.length - validInstances.length;
      if (
        remaining <= 0 ||
        validInstances.length === 0
      ) {
        continue;
      }

      const accepted = validInstances.slice(0, remaining);
      const object = renderableFor(
        THREE,
        primitive,
        accepted,
        category,
        mode,
        showEdges,
      );
      if (!object) continue;
      onObject(object, primitive, accepted);
      renderedPrimitives += objectCost;
      renderedInstances += accepted.length;
      remaining -= accepted.length;
    }
  }
  return { budget, invalidInstances, renderedInstances, renderedPrimitives,
    selectedInstances, truncated: selectedInstances - invalidInstances > renderedInstances };
}

function appendVertexBatch(THREE, primitive, instances, positions, ranges) {
  const sourceVertices = primitive.controlVertices ?? primitive.vertices ?? [];
  const sourceVertexCount = Math.floor(sourceVertices.length / 3);
  if (sourceVertexCount === 0) return;

  const start = positions.length / 3;
  const matrix = new THREE.Matrix4();
  const vertex = new THREE.Vector3();

  for (const instance of instances) {
    matrix.fromArray(instance.matrix);
    for (let index = 0; index < sourceVertexCount; index += 1) {
      const offset = index * 3;
      vertex.set(
        sourceVertices[offset],
        sourceVertices[offset + 1],
        sourceVertices[offset + 2],
      ).applyMatrix4(matrix);
      positions.push(vertex.x, vertex.y, vertex.z);
    }
  }

  ranges.push({
    end: positions.length / 3,
    instances,
    source: primitive.source,
    sourceVertexCount,
    start,
  });
}

function createVertexPoints(THREE, positions) {
  if (positions.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3),
  );
  geometry.computeBoundingSphere();
  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: 0xffee75,
      depthTest: true,
      depthWrite: false,
      size: VERTEX_POINT_SIZE,
      sizeAttenuation: false,
    }),
  );
  points.name = "geometry-vertices";
  points.renderOrder = 20;
  return points;
}

function discretizationMetrics(primitive) {
  const descriptor = primitive?.discretization;
  const counts = descriptor?.counts;

  if (descriptor?.kind === "element-cells") {
    return countElementDiscretization(counts);
  }
  if (
    descriptor?.kind === "region-grid" ||
    descriptor?.kind === "region-line"
  ) {
    return countRegionDiscretization(counts, {
      isLine: descriptor.kind === "region-line",
    });
  }
  return null;
}

function buildDiscretizationLayer(primitive, layer, limit) {
  const descriptor = primitive?.discretization;
  const vertices = primitive?.controlVertices ?? primitive?.vertices;
  const options = {
    includeLines: layer === "lines",
    includePoints: layer === "points",
    limits: {
      lineSegments: layer === "lines" ? limit : 0,
      points: layer === "points" ? limit : 0,
    },
  };

  if (descriptor?.kind === "element-cells") {
    return buildElementDiscretization(
      vertices,
      descriptor.counts,
      options,
    );
  }
  if (
    descriptor?.kind === "region-grid" ||
    descriptor?.kind === "region-line"
  ) {
    return buildRegionDiscretization(
      vertices,
      descriptor.counts,
      {
        ...options,
        isLine: descriptor.kind === "region-line",
      },
    );
  }
  return null;
}

function appendTransformedPositions(
  THREE,
  sourcePositions,
  instances,
  targetPositions,
) {
  const sourcePointCount = Math.floor((sourcePositions?.length ?? 0) / 3);
  if (sourcePointCount === 0 || sourcePositions.length % 3 !== 0) return;

  const matrix = new THREE.Matrix4();
  const point = new THREE.Vector3();
  for (const instance of instances) {
    matrix.fromArray(instance.matrix);
    for (let index = 0; index < sourcePointCount; index += 1) {
      const offset = index * 3;
      point.set(
        sourcePositions[offset],
        sourcePositions[offset + 1],
        sourcePositions[offset + 2],
      ).applyMatrix4(matrix);
      targetPositions.push(point.x, point.y, point.z);
    }
  }
}

function appendDiscretizationPointBatch(
  THREE,
  primitive,
  instances,
  sourcePositions,
  positions,
  ranges,
) {
  const sourcePointCount = Math.floor(sourcePositions.length / 3);
  if (sourcePointCount === 0) return;

  const start = positions.length / 3;
  appendTransformedPositions(
    THREE,
    sourcePositions,
    instances,
    positions,
  );
  ranges.push({
    end: positions.length / 3,
    grid: primitive.discretization,
    instances,
    source: primitive.source,
    sourcePointCount,
    start,
  });
}

function createDiscretizationLines(THREE, positions) {
  if (positions.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3),
  );
  geometry.computeBoundingSphere();
  const lines = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      color: 0x72d5ff,
      depthTest: true,
      depthWrite: false,
      opacity: 0.92,
      transparent: true,
    }),
  );
  lines.name = "geometry-discretization-lines";
  lines.renderOrder = 12;
  return lines;
}

function createDiscretizationPoints(THREE, positions) {
  if (positions.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(positions), 3),
  );
  geometry.computeBoundingSphere();
  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: 0xffcf59,
      depthTest: true,
      depthWrite: false,
      size: DISCRETIZATION_POINT_SIZE,
      sizeAttenuation: false,
    }),
  );
  points.name = "geometry-discretization-points";
  points.renderOrder = 21;
  return points;
}

function createAxisLabel(THREE, text, color) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = color;
  context.font = "bold 40px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, 32, 33);

  const texture = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    depthTest: false,
    depthWrite: false,
    map: texture,
    transparent: true,
  }));
  sprite.scale.set(0.34, 0.34, 0.34);
  sprite.renderOrder = 4;
  return sprite;
}

function createAxisArrow(THREE, direction, color, label, cssColor) {
  const root = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
  });
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 0.72, 12),
    material,
  );
  shaft.position.y = 0.36;
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(0.11, 0.28, 16),
    material.clone(),
  );
  head.position.y = 0.86;
  root.add(shaft, head);
  root.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction,
  );

  const labelSprite = createAxisLabel(THREE, label, cssColor);
  labelSprite.position.set(0, 1.17, 0);
  root.add(labelSprite);
  return root;
}

function createAxesGizmo(THREE) {
  const root = new THREE.Group();
  root.name = "screen-axes-gizmo";
  root.add(
    createAxisArrow(
      THREE,
      new THREE.Vector3(1, 0, 0),
      0xf05252,
      "X",
      "#ff6b6b",
    ),
    createAxisArrow(
      THREE,
      new THREE.Vector3(0, 1, 0),
      0x4bc26b,
      "Y",
      "#62dc82",
    ),
    createAxisArrow(
      THREE,
      new THREE.Vector3(0, 0, 1),
      0x4c8ff2,
      "Z",
      "#75aaff",
    ),
  );
  return root;
}

function worldUnitsPerPixel(camera, target, viewportHeight) {
  const height = Math.max(1, viewportHeight);
  if (camera.isOrthographicCamera) {
    return Math.abs(camera.top - camera.bottom) /
      Math.max(camera.zoom * height, 1e-9);
  }

  const distance = Math.max(camera.position.distanceTo(target), 1e-9);
  const verticalFov = camera.fov * Math.PI / 180;
  return 2 * distance * Math.tan(verticalFov / 2) / height;
}

function createCamera(THREE, projection, aspect) {
  const camera = projection === "perspective"
    ? new THREE.PerspectiveCamera(
      PERSPECTIVE_FOV,
      aspect,
      0.01,
      1_000_000,
    )
    : new THREE.OrthographicCamera(
      -aspect,
      aspect,
      1,
      -1,
      0.01,
      1_000_000,
    );

  camera.position.fromArray(INITIAL_GEOMETRY_CAMERA_FRAME.offset);
  camera.up.fromArray(INITIAL_GEOMETRY_CAMERA_FRAME.up);
  return camera;
}

function resizeCameraProjection(camera, aspect) {
  if (camera.isOrthographicCamera) {
    const halfHeight = Math.max((camera.top - camera.bottom) / 2, 1e-9);
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
  } else {
    camera.aspect = aspect;
  }
  camera.updateProjectionMatrix();
}

export function ThreeGeometryViewport(props) {
  let host;
  let renderer;
  let threeScene;
  let axesScene;
  let axesCamera;
  let axesRoot;
  let camera;
  let controls;
  let geometryRoot;
  let helperRoot;
  let resultLayers = [];
  let streamlines = [], selectedStreamline = null, streamlineRoot = null;
  let streamlineWidth = 2, streamlineColorMap = true;
  let resultLayerStates = new Map();
  let resultVectorScale = 1;
  let resultVectorColorMap = false;
  let activeResultFilters = {};
  let prescribedSourceRoot;
  let prescribedSourceScene = null;
  let prescribedSourcesVisible = false;
  let prescribedSourceStyle = "thin";
  let resultVectorStyle = "thin";
  let currentSourceScale = 1;
  let magnetizationSourceScale = 1;
  let acceptedSourceInstances = new Set();
  let vertexPoints;
  let vertexWorldPositions = new Float64Array(0);
  let vertexBatches = [];
  let vertexRanges = [];
  let discretizationLines;
  let discretizationPoints;
  let discretizationPointRanges = [];
  let discretizationWorldPositions = new Float64Array(0);
  let discretizationBatches = [];
  let discretizationLineCache = new Map();
  let discretizationPointCache = new Map();
  let geometryPickTargets = [];
  let motionBuffers = [];
  let geometryContext = null;
  let currentBounds;
  let resizeObserver;
  let raycaster;
  let pointerNdc;
  let pendingPointer;
  let handlePointerMove;
  let handlePointerLeave;
  let handlePointerDown, handleClick, handleDoubleClick;
  let handleControlsStart;
  let handleControlsEnd;
  let renderFrame = 0;
  let rendering = false;
  let pendingResize = true;
  let pendingGeometry = null;
  let sourcesDirty = false;
  let vectorsDirty = false;
  let pickFrame = 0;
  let pickTimer = 0;
  let lastPickTime = Number.NEGATIVE_INFINITY;
  let viewportWidth = 1;
  let viewportHeight = 1;
  let verticesVisible = false;
  let discretizationLinesVisible = false;
  let discretizationPointsVisible = false;
  let discretizationLinesMaterialized = false;
  let discretizationPointsMaterialized = false;
  let activeRenderMode = "solid";
  let geometryOpacity = null;
  let resultPalette = "Viridis";
  const geometryMaterialDefaults = new WeakMap();
  let baseRenderStats = {
    budget: GEOMETRY_INSTANCE_BUDGET,
    invalidInstances: 0,
    renderedInstances: 0,
    renderedPrimitives: 0,
    selectedInstances: 0,
    truncated: false,
  };
  let discretizationStats = {
    lineSegments: 0,
    linesTruncated: false,
    points: 0,
    pointsTruncated: false,
  };
  let controlsInteracting = false;
  let contextLost = false;
  let disposed = false;
  let movieSnapshot = null;
  let captureFrameKey;
  const captureGate = createRenderedFrameGate();
  let hasFramedGeometry = false;
  let activeProjection = DEFAULT_PROJECTION;
  let OrbitControlsClass;
  let THREE;

  const [ready, setReady] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");
  const [renderedCount, setRenderedCount] = createSignal(0);
  const [hoverTooltip, setHoverTooltip] = createSignal(null);
  const [scalarLegends, setScalarLegends] = createSignal([]);

  const reportError = (value) => {
    const message = value instanceof Error ? value.message : String(value);
    setError(message);
    props.onError?.(message);
    captureGate.fail(new Error(message));
  };

  const publishRenderStats = () => {
    const linesTruncated = discretizationLinesVisible &&
      discretizationStats.linesTruncated;
    const pointsTruncated = discretizationPointsVisible &&
      discretizationStats.pointsTruncated;
    props.onRenderStats?.({
      ...baseRenderStats,
      discretizationLineSegments: discretizationLinesVisible
        ? discretizationStats.lineSegments
        : 0,
      discretizationPoints: discretizationPointsVisible
        ? discretizationStats.points
        : 0,
      discretizationTruncated: linesTruncated || pointsTruncated,
    });
  };

  const renderNow = () => {
    if (!renderer || !threeScene || !camera || disposed || contextLost || rendering) return;
    if (renderFrame) { cancelAnimationFrame(renderFrame); renderFrame = 0; }
    rendering = true;
    try {
      if (pendingResize && !movieSnapshot) applyRendererSize();
      if (pendingGeometry) {
        const {sceneModel, filters, mode, showEdges} = pendingGeometry;
        pendingGeometry = null;
        untrack(() => replaceGeometry(sceneModel, filters, mode, showEdges));
      }
      if (sourcesDirty) { sourcesDirty = false; replacePrescribedSources(); }
      if (vectorsDirty) { vectorsDirty = false; replaceResultLayers(); }
      if (!movieSnapshot && (!hasFramedGeometry || props.autoFit === true)) hasFramedGeometry = fitVisibleObjects();
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, viewportWidth, viewportHeight);
      renderer.clear(true, true, true);
      renderer.render(threeScene, camera);

      if (axesScene && axesCamera && axesRoot && controls) {
        const size = axesGizmoSize();
        const direction = camera.position.clone().sub(controls.target);
        if (direction.lengthSq() < 1e-12) direction.set(1, 1, 1);
        axesCamera.position.copy(direction.normalize().multiplyScalar(5));
        axesCamera.up.copy(camera.up);
        axesCamera.lookAt(0, 0, 0);
        axesCamera.updateMatrixWorld();

        renderer.clearDepth();
        renderer.setScissor(
          AXES_GIZMO_MARGIN,
          AXES_GIZMO_MARGIN,
          size,
          size,
        );
        renderer.setViewport(
          AXES_GIZMO_MARGIN,
          AXES_GIZMO_MARGIN,
          size,
          size,
        );
        renderer.setScissorTest(true);
        renderer.render(axesScene, axesCamera);
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, viewportWidth, viewportHeight);
      }
      captureGate.rendered(captureFrameKey);
    } catch (error) { reportError(error); }
    finally { rendering = false; }
  };
  const requestRender = () => {
    if (!renderer || !threeScene || !camera || renderFrame || rendering || disposed) return;
    renderFrame = requestAnimationFrame(() => { renderFrame = 0; renderNow(); });
  };

  const captureAdapter = {
    prepare({ signal } = {}) {
      signal?.throwIfAborted();
      if (!ready() || disposed || contextLost || error()) throw new Error(error() || "3D-окно ещё не готово");
      if (movieSnapshot) return;
      renderNow();
      if (error()) throw new Error(error());
      clearHoverTooltip();
      movieSnapshot = { ...snapshotMovieCamera(camera, controls), hasFramedGeometry };
    },
    renderReady(expectedKey, { signal } = {}) {
      if (disposed || contextLost || error()) return Promise.reject(new Error(error() || "3D-окно недоступно"));
      const completion = captureGate.wait(expectedKey, { signal });
      requestRender();
      return completion;
    },
    capture(expectedKey, { caption } = {}) {
      if (!movieSnapshot || disposed || contextLost || error()) throw new Error(error() || "Захват 3D-окна не подготовлен");
      return captureRenderedMovieFrame(captureGate, expectedKey, renderNow, () =>
        captureMovieCanvas(renderer.domElement, { caption, overlay: drawMovieLegends }));
    },
    restore() {
      if (!movieSnapshot) return;
      const snapshot = movieSnapshot; movieSnapshot = null;
      if (disposed || !camera || !controls) return;
      restoreMovieCamera(camera, controls, snapshot);
      hasFramedGeometry = snapshot.hasFramedGeometry;
      pendingResize = true;
      requestRender();
    },
  };

  const drawMovieLegends = (context, { width, height }) => {
    const legends = scalarLegends();
    if (!legends.length) return;
    const boxWidth = Math.min(300, width - 16);
    const boxHeight = Math.min(86, (height - 16) / legends.length);
    context.font = "12px sans-serif";
    context.textBaseline = "top";
    legends.forEach((legend, index) => {
      const x = width - boxWidth - 8, y = 8 + index * boxHeight;
      context.fillStyle = "rgba(27, 34, 41, .95)";
      context.fillRect(x, y, boxWidth, boxHeight - 4);
      context.fillStyle = "#f1f5f8";
      context.fillText(`${legend.groupLabel ? `${legend.groupLabel} · ` : ""}${legend.quantity}`, x + 7, y + 6, boxWidth - 14);
      context.fillText(legend.unit, x + 7, y + 23, boxWidth - 14);
      const gradient = context.createLinearGradient(x + 7, 0, x + boxWidth - 7, 0);
      for (let stop = 0; stop <= 20; stop++) {
        const rgb = resultScalarColor(legend.minimum === legend.maximum ? 10 : stop, 0, 20, legend.palette)
          .map(value => Math.round(value * 255));
        gradient.addColorStop(stop / 20, `rgb(${rgb.join(",")})`);
      }
      context.fillStyle = gradient; context.fillRect(x + 7, y + 41, boxWidth - 14, 10);
      context.fillStyle = "#f1f5f8";
      context.fillText(Number(legend.minimum.toPrecision(6)).toString(), x + 7, y + 57);
      context.textAlign = "right";
      context.fillText(Number(legend.maximum.toPrecision(6)).toString(), x + boxWidth - 7, y + 57);
      context.textAlign = "left";
    });
  };

  const createOrbitControls = (target) => {
    const nextControls = new OrbitControlsClass(camera, renderer.domElement);
    nextControls.enableDamping = false;
    nextControls.screenSpacePanning = true;
    if (target) nextControls.target.copy(target);
    nextControls.addEventListener("change", requestRender);
    nextControls.addEventListener("start", handleControlsStart);
    nextControls.addEventListener("end", handleControlsEnd);
    nextControls.update();
    return nextControls;
  };

  const rebuildOrbitControls = () => {
    const target = controls.target.clone();
    controls.removeEventListener("change", requestRender);
    controls.removeEventListener("start", handleControlsStart);
    controls.removeEventListener("end", handleControlsEnd);
    controls.dispose();
    controls = createOrbitControls(target);
  };

  const resizeRenderer = () => { pendingResize = true; requestRender(); };
  const applyRendererSize = () => {
    if (movieSnapshot) return;
    pendingResize = false;
    if (!host || !renderer || !camera) return;
    const width = Math.max(1, Math.floor(host.clientWidth));
    const height = Math.max(1, Math.floor(host.clientHeight));
    if (width === viewportWidth && height === viewportHeight) return;
    viewportWidth = width; viewportHeight = height;
    renderer.setSize(viewportWidth, viewportHeight, false);
    resizeStreamlineMaterials(streamlineRoot, viewportWidth, viewportHeight);
    resizeCameraProjection(camera, viewportWidth / viewportHeight);
    if (
      props.autoFit === true
      && controls
    ) {
      fitVisibleObjects();
    }
    setHoverTooltip(null);
    requestRender();
  };

  const fitVisibleObjects = (target, padding) => fitCameraToVisibleObjects(
    THREE, camera, controls, [geometryRoot, helperRoot], { target, padding },
  );

  const cancelPendingPick = () => {
    pendingPointer = null;
    if (pickFrame) cancelAnimationFrame(pickFrame);
    if (pickTimer) clearTimeout(pickTimer);
    pickFrame = 0;
    pickTimer = 0;
  };

  const clearHoverTooltip = () => {
    cancelPendingPick();
    setHoverTooltip(null);
  };

  const axesGizmoSize = () => Math.max(
    1,
    Math.min(
      AXES_GIZMO_SIZE,
      viewportWidth - 2 * AXES_GIZMO_MARGIN,
      viewportHeight - 2 * AXES_GIZMO_MARGIN,
    ),
  );

  const float64PointCoordinates = (positions, globalIndex) => {
    const offset = globalIndex * 3;
    if (
      !Number.isSafeInteger(globalIndex) ||
      globalIndex < 0 ||
      offset + 2 >= positions.length
    ) {
      return null;
    }

    return positions.subarray(offset, offset + 3);
  };

  const showTooltip = (text, x, y) => {
    const lines = String(text).split("\n");
    const longestLineLength = Math.max(1, ...lines.map((line) => line.length));
    const widthEstimate = Math.min(390, Math.max(180, longestLineLength * 6));
    const charactersPerLine = Math.max(1, Math.floor(widthEstimate / 6));
    const lineCount = lines.reduce(
      (count, line) => count + Math.max(
        1,
        Math.ceil(line.length / charactersPerLine),
      ),
      0,
    );
    const heightEstimate = 18 + lineCount * 15;
    const left = x + 14 + widthEstimate <= viewportWidth
      ? x + 14
      : Math.max(8, x - widthEstimate - 14);
    const top = y + 14 + heightEstimate <= viewportHeight
      ? y + 14
      : Math.max(8, y - heightEstimate - 14);
    setHoverTooltip({ left, text, top });
  };

  const pickAtPointer = (pointer, action = "hover") => {
    if (
      !pointer ||
      !renderer ||
      !camera ||
      !controls ||
      !raycaster ||
      !pointerNdc
    ) {
      setHoverTooltip(null);
      return;
    }

    const bounds = renderer.domElement.getBoundingClientRect();
    const x = pointer.clientX - bounds.left;
    const y = pointer.clientY - bounds.top;
    if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) {
      setHoverTooltip(null);
      return;
    }

    const gizmoSize = axesGizmoSize();
    if (
      x <= AXES_GIZMO_MARGIN + gizmoSize &&
      y >= bounds.height - AXES_GIZMO_MARGIN - gizmoSize
    ) {
      setHoverTooltip(null);
      return;
    }

    pointerNdc.set(
      x / Math.max(bounds.width, 1) * 2 - 1,
      -(y / Math.max(bounds.height, 1)) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNdc, camera);
    const unitsPerPixel = worldUnitsPerPixel(
      camera,
      controls.target,
      bounds.height,
    );
    raycaster.params.Line.threshold = unitsPerPixel * 5;
    raycaster.params.Line2 = { threshold: 10 }; // Full width grows by 5 CSS px on either side.
    raycaster.params.Points.threshold = unitsPerPixel * 9;

    if (props.resultPickingOnly) {
      // Report saved nodes, including for an intersection on a scaled vector.
      const hits = intersectResultLayers(raycaster, resultLayerStates, unitsPerPixel);
      const geometryHit = activeRenderMode === "solid" && (geometryOpacity ?? 1) >= 1
        ? raycaster.intersectObjects(geometryPickTargets, false)[0] : null;
      const hit = hits.find(candidate => !geometryHit || candidate.distance <= geometryHit.distance + unitsPerPixel * 5);
      const scalar = resultHitScalar(hit);
      const vector = resultHitVector(hit);
      if (action === "seed") {
        if (vector?.source?.schemaId === "elements") props.onResultNodeDoubleClick?.(vector);
        return;
      }
      if (action === "select") {
        const lines = streamlineRoot?.children.filter(child => child.visible) ?? [];
        const lineHits = raycaster.intersectObjects(lines, false).filter(candidate =>
          !geometryHit || candidate.distance <= geometryHit.distance + unitsPerPixel * 5);
        // A visible seed marker takes precedence over another curve crossing it.
        const lineHit = lineHits.find(candidate => candidate.object.userData.streamlineStart) ?? lineHits[0];
        props.onSelectStreamline?.(lineHit?.object.userData.streamlineId ?? null);
        return;
      }
      if (scalar) showTooltip(formatResultScalarTooltip(scalar), x, y);
      else if (vector) showTooltip(formatResultVectorTooltip(vector, { showMagnitude: resultVectorColorMap }), x, y);
      else setHoverTooltip(null);
      return;
    }

    const geometryHit = geometryOpacity !== 0
      ? raycaster.intersectObjects(geometryPickTargets, false)[0] ?? null
      : null;
    const discretizationHit =
      discretizationPoints?.visible
        ? raycaster.intersectObject(discretizationPoints, false)[0] ?? null
        : null;
    const vertexHit = vertexPoints?.visible
      ? raycaster.intersectObject(vertexPoints, false)[0] ?? null
      : null;
    const pointIsVisible = (hit) =>
      activeRenderMode !== "solid" ||
      (geometryOpacity ?? 1) < 1 ||
      !geometryHit ||
      hit.distance <= geometryHit.distance + unitsPerPixel * 9;

    if (
      discretizationHit &&
      Number.isSafeInteger(discretizationHit.index) &&
      pointIsVisible(discretizationHit)
    ) {
      const range = findPointMetadataRange(
        discretizationPointRanges,
        discretizationHit.index,
      );
      const coordinates = float64PointCoordinates(
        discretizationWorldPositions,
        discretizationHit.index,
      );
      if (range && coordinates) {
        const metadata = pointHitMetadata(range, discretizationHit.index);
        if (metadata) {
          showTooltip(
            formatDiscretizationPointTooltip(
              range.source,
              metadata,
              coordinates,
            ),
            x,
            y,
          );
          return;
        }
      }
    }

    if (
      vertexHit &&
      Number.isSafeInteger(vertexHit.index) &&
      pointIsVisible(vertexHit)
    ) {
      const range = findVertexMetadataRange(vertexRanges, vertexHit.index);
      const coordinates = float64PointCoordinates(
        vertexWorldPositions,
        vertexHit.index,
      );
      if (range && coordinates) {
        const metadata = vertexHitMetadata(range, vertexHit.index);
        if (metadata) {
          showTooltip(
            formatVertexTooltip(
              range.source,
              metadata.vertexIndex,
              coordinates,
              metadata.instance,
            ),
            x,
            y,
          );
          return;
        }
      }
    }

    if (geometryHit?.object?.userData?.source) {
      const hitPoint = geometryHit.point;
      showTooltip(
        formatGeometryTooltip(
          geometryHit.object.userData.source,
          geometryHitInstance(geometryHit),
          hitPoint ? [hitPoint.x, hitPoint.y, hitPoint.z] : null,
        ),
        x,
        y,
      );
      return;
    }

    setHoverTooltip(null);
  };

  const queuePointerPick = (event) => {
    if (movieSnapshot) return;
    if (controlsInteracting) return;
    pendingPointer = {
      clientX: event.clientX,
      clientY: event.clientY,
    };
    if (pickFrame || pickTimer) return;

    const scheduleFrame = () => {
      pickTimer = 0;
      if (!pendingPointer || controlsInteracting) return;
      pickFrame = requestAnimationFrame(() => {
        pickFrame = 0;
        const pointer = pendingPointer;
        pendingPointer = null;
        lastPickTime = performance.now();
        pickAtPointer(pointer);
      });
    };
    const delay = Math.max(0, PICK_INTERVAL_MS - (
      performance.now() - lastPickTime
    ));
    if (delay > 0) {
      pickTimer = window.setTimeout(scheduleFrame, delay);
    } else {
      scheduleFrame();
    }
  };

  // Explicit edges retain full opacity, including when the filled surface vanishes.
  // Other geometry overlays follow geometry transparency; result points remain opaque.
  const updateGeometryOpacity = () => {
    applyViewerGeometryOpacity([
      [geometryRoot, true, true], [vertexPoints, verticesVisible],
      [discretizationLines, discretizationLinesVisible], [discretizationPoints, discretizationPointsVisible],
    ], geometryOpacity, geometryMaterialDefaults);
    for (const state of resultLayerStates.values()) state.vectorRoot?.traverse(object => {
      if (object.name === "result-volume-domain") object.material.uniforms.uOpacity.value = geometryOpacity ?? 1;
    });
  };

  const materializeVertexPoints = () => {
    if (!THREE || !helperRoot || vertexPoints) return;

    const positions = [];
    vertexRanges = [];
    for (const batch of vertexBatches) {
      appendVertexBatch(
        THREE,
        batch.primitive,
        batch.instances,
        positions,
        vertexRanges,
      );
    }

    vertexWorldPositions = new Float64Array(positions);
    vertexPoints = createVertexPoints(THREE, positions);
    if (vertexPoints) {
      vertexPoints.visible = verticesVisible;
      helperRoot.add(vertexPoints);
      if (props.geometryRevision) motionBuffers.push(captureMotionBuffer(THREE, vertexPoints, vertexRanges, vertexWorldPositions));
    }
  };

  const updateSurfacePolygonOffset = () => {
    const helperLinesShown = discretizationLinesVisible &&
      Boolean(discretizationLines);
    const helperPointsShown = discretizationPointsVisible &&
      Boolean(discretizationPoints);
    geometryRoot?.traverse?.((object) => {
      if (!object?.isMesh) return;
      const enabled = object.userData?.surfaceEdgesShown === true ||
        helperLinesShown || helperPointsShown;
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of materials) {
        if (!material) continue;
        material.polygonOffset = enabled;
        material.polygonOffsetFactor = enabled ? 1 : 0;
        material.polygonOffsetUnits = enabled ? 1 : 0;
      }
    });
  };

  const layerInstanceCount = (instances, cost, remaining) => {
    if (!Number.isSafeInteger(cost) || cost < 0) return 0;
    if (cost === 0) return instances.length;
    return Math.min(instances.length, Math.floor(remaining / cost));
  };

  const materializeDiscretizationLines = () => {
    if (
      !THREE ||
      !helperRoot ||
      discretizationLinesMaterialized
    ) {
      return;
    }
    discretizationLinesMaterialized = true;

    const budget = Math.max(
      0,
      Math.floor(
        props.discretizationSegmentBudget ??
        GEOMETRY_DISCRETIZATION_SEGMENT_BUDGET,
      ),
    );
    const positions = [];
    const motionRanges = [];
    let remaining = budget;
    let truncated = false;

    for (const batch of discretizationBatches) {
      const metrics = discretizationMetrics(batch.primitive);
      const cost = metrics?.lineSegments;
      const acceptedCount = layerInstanceCount(
        batch.instances,
        cost,
        remaining,
      );
      if (acceptedCount < batch.instances.length) truncated = true;
      if (acceptedCount === 0 || cost === 0) continue;

      let built = discretizationLineCache.get(batch.primitive);
      if (!built) {
        built = buildDiscretizationLayer(
          batch.primitive,
          "lines",
          cost,
        );
        discretizationLineCache.set(batch.primitive, built);
      }
      if (!built?.ok) {
        truncated = true;
        continue;
      }

      const start = positions.length / 3;
      appendTransformedPositions(
        THREE,
        built.lines,
        batch.instances.slice(0, acceptedCount),
        positions,
      );
      motionRanges.push({start, end: positions.length / 3,
        source: batch.primitive.source, instances: batch.instances.slice(0, acceptedCount)});
      remaining -= cost * acceptedCount;
    }

    discretizationLines = createDiscretizationLines(THREE, positions);
    if (discretizationLines) {
      discretizationLines.visible = discretizationLinesVisible;
      helperRoot.add(discretizationLines);
      if (props.geometryRevision) motionBuffers.push(captureMotionBuffer(THREE, discretizationLines, motionRanges));
    }
    discretizationStats.lineSegments = positions.length / 6;
    discretizationStats.linesTruncated = truncated;
    updateGeometryOpacity();
    updateSurfacePolygonOffset();
    publishRenderStats();
  };

  const materializeDiscretizationPoints = () => {
    if (
      !THREE ||
      !helperRoot ||
      discretizationPointsMaterialized
    ) {
      return;
    }
    discretizationPointsMaterialized = true;

    const budget = Math.max(
      0,
      Math.floor(
        props.discretizationPointBudget ??
        GEOMETRY_DISCRETIZATION_POINT_BUDGET,
      ),
    );
    const positions = [];
    discretizationPointRanges = [];
    let remaining = budget;
    let truncated = false;

    for (const batch of discretizationBatches) {
      const metrics = discretizationMetrics(batch.primitive);
      const cost = metrics?.points;
      const acceptedCount = layerInstanceCount(
        batch.instances,
        cost,
        remaining,
      );
      if (acceptedCount < batch.instances.length) truncated = true;
      if (acceptedCount === 0 || cost === 0) continue;

      let built = discretizationPointCache.get(batch.primitive);
      if (!built) {
        built = buildDiscretizationLayer(
          batch.primitive,
          "points",
          cost,
        );
        discretizationPointCache.set(batch.primitive, built);
      }
      if (!built?.ok) {
        truncated = true;
        continue;
      }

      appendDiscretizationPointBatch(
        THREE,
        batch.primitive,
        batch.instances.slice(0, acceptedCount),
        built.points,
        positions,
        discretizationPointRanges,
      );
      remaining -= cost * acceptedCount;
    }

    discretizationWorldPositions = new Float64Array(positions);
    discretizationPoints = createDiscretizationPoints(THREE, positions);
    if (discretizationPoints) {
      discretizationPoints.visible = discretizationPointsVisible;
      helperRoot.add(discretizationPoints);
      if (props.geometryRevision) motionBuffers.push(captureMotionBuffer(THREE, discretizationPoints,
        discretizationPointRanges, discretizationWorldPositions));
    }
    discretizationStats.points = positions.length / 3;
    discretizationStats.pointsTruncated = truncated;
    updateGeometryOpacity();
    updateSurfacePolygonOffset();
    publishRenderStats();
  };

  const switchProjection = (value) => {
    const projection = normalizeProjection(value);
    if (
      movieSnapshot || !ready() ||
      !THREE ||
      !camera ||
      !controls ||
      projection === activeProjection
    ) {
      return;
    }

    const width = Math.max(1, Math.floor(host?.clientWidth ?? 1));
    const height = Math.max(1, Math.floor(host?.clientHeight ?? 1));
    const preservedTarget = controls.target.clone();
    const nextCamera = createCamera(THREE, projection, width / height);
    nextCamera.position.copy(camera.position);
    nextCamera.up.copy(camera.up);
    camera = nextCamera;
    activeProjection = projection;
    controls.object = camera;

    if (!fitVisibleObjects(preservedTarget)) {
      controls.update();
    }
    requestRender();
  };

  const replacePrescribedSources = () => {
    if (!THREE || !helperRoot) return;
    if (prescribedSourceRoot) prescribedSourceRoot.visible = prescribedSourcesVisible && Boolean(prescribedSourceScene);
    if (prescribedSourcesVisible && prescribedSourceScene) {
      const sceneDiagonal = prescribedSourceScene.sceneDiagonal ?? (
        currentBounds?.isEmpty() === false
          ? currentBounds.getSize(new THREE.Vector3()).length()
          : 0
      );
      prescribedSourceRoot = createPrescribedSourceVectors(
        THREE,
        prescribedSourceScene.vectors,
        acceptedSourceInstances,
        sceneDiagonal,
        prescribedSourceStyle,
        { current: currentSourceScale, magnetization: magnetizationSourceScale },
        prescribedSourceScene.maximumMagnitude,
        undefined, prescribedSourceRoot,
      );
      prescribedSourceRoot.visible = true;
      if (prescribedSourceRoot.parent !== helperRoot) helperRoot.add(prescribedSourceRoot);
    }
    requestRender();
  };

  // Result xyz and vectors are already in the global coordinate system.
  // Apply display filters only; never reapply motion, amplitudes or symmetry.
  const replaceResultLayers = () => {
    if (!THREE || !helperRoot) return;
    clearHoverTooltip();
    resultLayerStates = updateResultLayers(THREE, resultLayerStates, resultLayers, {
      filters: activeResultFilters, colorMap: resultVectorColorMap, style: resultVectorStyle,
      scale: resultVectorScale, palette: resultPalette, opacity: geometryOpacity ?? 1,
    });
    for (const root of resultLayerRoots(resultLayerStates)) {
      if (root.parent !== helperRoot) helperRoot.add(root);
    }
    streamlineRoot ??= new THREE.Group();
    streamlineRoot.name = "result-streamlines";
    updateStreamlineMeshes(THREE, streamlineRoot, streamlines, { filters: activeResultFilters, selected: selectedStreamline,
      width: streamlineWidth, colorMap: streamlineColorMap, palette: resultPalette, resolution: [viewportWidth, viewportHeight] });
    setScalarLegends([...resultLayerStates.values()].flatMap(state => state.legends).concat(streamlineRoot.userData.colorLegends));
    if (streamlineRoot.parent !== helperRoot) helperRoot.add(streamlineRoot);
    requestRender();
  };

  const updateMovingGeometry = (sceneModel, filters, mode, showEdges) => {
    const revision = props.geometryRevision;
    const context = geometryContext;
    // Only a time projection of the same source model may reuse topology.
    // Preview callers without a revision continue to use full replacement.
    if (!revision || !context || revision !== context.revision
      || filters !== context.filters || mode !== context.mode || showEdges !== context.showEdges
      || props.instanceBudget !== context.instanceBudget
      || props.discretizationSegmentBudget !== context.segmentBudget
      || props.discretizationPointBudget !== context.pointBudget
      || sceneModel?.primitives?.length !== context.primitiveCount) return false;
    const key = source => `${source.schemaId}:${source.recordIndex}`;
    const images = new Map(sceneModel.primitives.map(p => [key(p.source),
      new Map(p.instances.map(i => [sourceInstanceKey(p.source, i), i]))]));
    const resolve = (source, instances) => instances.map(i =>
      images.get(key(source))?.get(sourceInstanceKey(source, i)));
    // Validate every reference before writing any retained buffer.
    for (const buffer of motionBuffers) for (const range of buffer.ranges) {
      if (resolve(range.source, range.instances).some(i => !i || !validMatrix(i.matrix))) return false;
    }
    for (const buffer of motionBuffers) updateMotionBuffer(THREE, buffer, resolve);
    for (const object of geometryPickTargets) {
      object.userData.pick.instances = resolve(object.userData.source, object.userData.pick.instances);
    }
    for (const range of [...vertexRanges, ...discretizationPointRanges]) {
      range.instances = resolve(range.source, range.instances);
    }
    // Retain local discretization caches; only their world transforms change.
    for (const batch of vertexBatches) batch.instances = resolve(batch.primitive.source, batch.instances);
    for (const batch of discretizationBatches) batch.instances = resolve(batch.primitive.source, batch.instances);
    currentBounds = new THREE.Box3().setFromObject(geometryRoot);
    if (!movieSnapshot && props.autoFit === true && !currentBounds.isEmpty()) {
      fitVisibleObjects();
    }
    clearHoverTooltip();
    sourcesDirty = vectorsDirty = true;
    requestRender();
    return true;
  };

  const replaceGeometry = (sceneModel, filters, mode, showEdges) => {
    if (!ready() || !THREE || !threeScene) return;
    if (updateMovingGeometry(sceneModel, filters, mode, showEdges)) return;
    geometryContext = null; motionBuffers = [];
    activeRenderMode = mode;
    activeResultFilters = filters ?? {};

    if (geometryRoot) {
      threeScene.remove(geometryRoot);
      disposeObject(geometryRoot);
    }
    if (helperRoot) {
      for (const layer of [prescribedSourceRoot, streamlineRoot, ...resultLayerRoots(resultLayerStates)]) {
        if (layer) helperRoot.remove(layer);
      }
      threeScene.remove(helperRoot);
      disposeObject(helperRoot);
    }

    acceptedSourceInstances = new Set();

    geometryRoot = new THREE.Group();
    geometryRoot.name = "geometry-root";
    helperRoot = new THREE.Group();
    helperRoot.name = "geometry-helpers";
    threeScene.add(geometryRoot, helperRoot);
    for (const layer of [prescribedSourceRoot, streamlineRoot, ...resultLayerRoots(resultLayerStates)]) {
      if (layer) helperRoot.add(layer);
    }
    geometryPickTargets = [];
    vertexBatches = [];
    vertexRanges = [];
    vertexPoints = null;
    vertexWorldPositions = new Float64Array(0);
    discretizationBatches = [];
    discretizationLines = null;
    discretizationPoints = null;
    discretizationPointRanges = [];
    discretizationWorldPositions = new Float64Array(0);
    discretizationLineCache = new Map();
    discretizationPointCache = new Map();
    discretizationLinesMaterialized = false;
    discretizationPointsMaterialized = false;
    discretizationStats = {
      lineSegments: 0,
      linesTruncated: false,
      points: 0,
      pointsTruncated: false,
    };
    clearHoverTooltip();

    const budget = Math.max(
      1,
      Math.floor(props.instanceBudget ?? GEOMETRY_INSTANCE_BUDGET),
    );
    const stats = createGeometryObjects(THREE, sceneModel, filters, mode, showEdges,
      budget, (object, primitive, accepted) => {
        geometryRoot.add(object);
        geometryPickTargets.push(object);
        object.traverse(child => {
          if (!props.geometryRevision || !child.geometry?.getAttribute("position")) return;
          motionBuffers.push(captureMotionBuffer(THREE, child, [{
            start: 0, end: child.geometry.getAttribute("position").count,
            source: primitive.source, instances: accepted,
          }]));
        });

        if (primitive.source?.schemaId === "elements") {
          for (const instance of accepted) {
            acceptedSourceInstances.add(
              sourceInstanceKey(primitive.source, instance),
            );
          }
        }
        vertexBatches.push({ instances: accepted, primitive });
        if (primitive.discretization) {
          discretizationBatches.push({ instances: accepted, primitive });
        }
      });

    currentBounds = new THREE.Box3().setFromObject(geometryRoot);

    baseRenderStats = stats;
    setRenderedCount(stats.renderedInstances);
    if (verticesVisible) materializeVertexPoints();
    if (discretizationLinesVisible) materializeDiscretizationLines();
    if (discretizationPointsVisible) materializeDiscretizationPoints();
    geometryContext = {
      revision: props.geometryRevision, filters, mode, showEdges,
      instanceBudget: props.instanceBudget,
      segmentBudget: props.discretizationSegmentBudget, pointBudget: props.discretizationPointBudget,
      primitiveCount: sceneModel?.primitives?.length ?? 0,
    };
    sourcesDirty = vectorsDirty = true;
    updateGeometryOpacity();
    publishRenderStats();
    if (!contextLost) {
      setError("");
      props.onError?.("");
    }
    requestRender();
  };

  const fitAll = () => {
    if (movieSnapshot || !ready()) return;
    clearHoverTooltip();
    fitVisibleObjects(undefined, props.fitAllPadding);
    requestRender();
  };

  const applyViewRequest = (request) => {
    const command = normalizeGeometryCameraCommand(request?.command);
    if (movieSnapshot || !ready() || !command) return;
    if (command === GEOMETRY_CAMERA_COMMANDS.FIT_ALL) {
      fitAll();
      return;
    }

    if (!orientGeometryCamera(camera, controls, command)) return;
    rebuildOrbitControls();
    if (command === GEOMETRY_CAMERA_COMMANDS.RESET_OBLIQUE) {
      fitVisibleObjects(undefined, props.fitAllPadding);
    }
    clearHoverTooltip();
    requestRender();
  };

  onMount(() => {
    props.onCaptureReady?.(captureAdapter);
    void Promise.all([
      import("three"),
      import("three/addons/controls/OrbitControls.js"),
      loadStreamlineRenderer(),
    ]).then(([threeModule, controlsModule]) => {
      if (disposed || !host) return;
      THREE = threeModule;
      threeScene = new THREE.Scene();
      threeScene.background = new THREE.Color(0x141a20);
      axesScene = new THREE.Scene();
      axesCamera = new THREE.OrthographicCamera(
        -1.35,
        1.35,
        1.35,
        -1.35,
        0.1,
        20,
      );
      axesRoot = createAxesGizmo(THREE);
      axesScene.add(axesRoot);
      activeProjection = normalizeProjection(props.projection);
      camera = createCamera(THREE, activeProjection, 1);
      raycaster = new THREE.Raycaster();
      pointerNdc = new THREE.Vector2();

      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: "high-performance",
      });
      renderer.autoClear = false;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
      host.append(renderer.domElement);

      OrbitControlsClass = controlsModule.OrbitControls;
      handleControlsStart = () => {
        controlsInteracting = true;
        clearHoverTooltip();
      };
      handleControlsEnd = () => {
        controlsInteracting = false;
      };
      controls = createOrbitControls();

      handlePointerMove = queuePointerPick;
      handlePointerLeave = clearHoverTooltip;
      renderer.domElement.addEventListener("pointermove", handlePointerMove);
      renderer.domElement.addEventListener("pointerleave", handlePointerLeave);
      const lineHandlers = streamlinePointerHandlers(pickAtPointer, () => movieSnapshot || !props.resultPickingOnly);
      handlePointerDown = lineHandlers.pointerdown;
      handleClick = lineHandlers.click; handleDoubleClick = lineHandlers.dblclick;
      renderer.domElement.addEventListener("pointerdown", handlePointerDown);
      renderer.domElement.addEventListener("click", handleClick);
      renderer.domElement.addEventListener("dblclick", handleDoubleClick);

      threeScene.add(new THREE.AmbientLight(0xffffff, 1.25));
      const light = new THREE.DirectionalLight(0xffffff, 0.55);
      light.position.set(1, -1, 2);
      threeScene.add(light);

      const handleContextLost = (event) => {
        event.preventDefault();
        contextLost = true;
        reportError("Контекст WebGL потерян");
      };
      const handleContextRestored = () => {
        contextLost = false;
        setError("");
        props.onError?.("");
        requestRender();
      };
      renderer.domElement.addEventListener("webglcontextlost", handleContextLost);
      renderer.domElement.addEventListener(
        "webglcontextrestored",
        handleContextRestored,
      );
      renderer.domElement.__geometryContextHandlers = {
        handleContextLost,
        handleContextRestored,
      };

      resizeObserver = new ResizeObserver(resizeRenderer);
      resizeObserver.observe(host);
      resizeRenderer();
      setReady(true);
      setLoading(false);
    }).catch((loadError) => {
      if (disposed) return;
      setLoading(false);
      reportError(loadError);
    });
  });

  createEffect(() => {
    verticesVisible = props.showVertices === true;
    if (!ready()) return;
    if (verticesVisible && !vertexPoints) materializeVertexPoints();
    if (vertexPoints) vertexPoints.visible = verticesVisible;
    updateGeometryOpacity();
    clearHoverTooltip();
    requestRender();
  });

  createEffect(() => {
    discretizationLinesVisible = props.showDiscretizationLines === true;
    if (!ready()) return;
    if (
      discretizationLinesVisible &&
      !discretizationLinesMaterialized
    ) {
      materializeDiscretizationLines();
    }
    if (discretizationLines) {
      discretizationLines.visible = discretizationLinesVisible;
    }
    updateGeometryOpacity();
    updateSurfacePolygonOffset();
    clearHoverTooltip();
    publishRenderStats();
    requestRender();
  });

  createEffect(() => {
    discretizationPointsVisible = props.showCentersAndNodes === true;
    if (!ready()) return;
    if (
      discretizationPointsVisible &&
      !discretizationPointsMaterialized
    ) {
      materializeDiscretizationPoints();
    }
    if (discretizationPoints) {
      discretizationPoints.visible = discretizationPointsVisible;
    }
    updateGeometryOpacity();
    updateSurfacePolygonOffset();
    clearHoverTooltip();
    publishRenderStats();
    requestRender();
  });

  createEffect(() => {
    prescribedSourceScene = props.prescribedSourceScene ?? null;
    prescribedSourcesVisible = props.showPrescribedSources === true;
    prescribedSourceStyle = props.prescribedSourceStyle === "solid" ? "solid" : "thin";
    currentSourceScale = prescribedSourceScale(props.currentSourceScale);
    magnetizationSourceScale = prescribedSourceScale(props.magnetizationSourceScale);
    if (!ready()) return;
    sourcesDirty = true;
    requestRender();
  });

  createEffect(() => {
    // Older preview callers can still supply one result scene.
    resultLayers = props.resultLayers ?? [{ key: "result", scene: props.resultVectorScene,
      scalarScene: props.resultScalarScene, volumeFields: props.resultVolumeFields,
      color: props.resultVectorColor }];
    resultPalette = normalizeResultPalette(props.resultPalette);
    resultVectorColorMap = props.resultVectorColorMap === true;
    resultVectorStyle = props.resultVectorStyle === "solid" ? "solid" : "thin";
    resultVectorScale = props.resultVectorScale ?? 1;
    streamlines = props.resultStreamlines ?? [];
    selectedStreamline = props.selectedStreamline ?? null;
    streamlineWidth = props.streamlineWidth ?? 2;
    streamlineColorMap = props.streamlineColorMap !== false;
    if (!ready()) return;
    vectorsDirty = true;
    requestRender();
  });

  createEffect(() => {
    const opacity = props.geometryOpacity;
    geometryOpacity = typeof opacity === "number" && Number.isFinite(opacity)
      ? Math.max(0, Math.min(1, opacity)) : null;
    if (!ready()) return;
    updateGeometryOpacity();
    clearHoverTooltip();
    requestRender();
  });

  createEffect(() => {
    const sceneModel = props.scene;
    props.geometryRevision;
    props.instanceBudget;
    props.discretizationSegmentBudget; props.discretizationPointBudget;
    const filters = props.filters;
    const mode = props.mode ?? "solid";
    const showEdges = props.showEdges !== false;
    if (!ready()) return;

    pendingGeometry = {sceneModel, filters, mode, showEdges};
    requestRender();
  });

  createEffect(() => {
    const projection = props.projection;
    if (ready()) switchProjection(projection);
  });

  createEffect(() => {
    const request = props.viewRequest;
    if (ready()) applyViewRequest(request);
  });

  createEffect(() => {
    captureFrameKey = props.captureFrameKey;
    if (ready()) requestRender();
  });

  onCleanup(() => {
    disposed = true;
    captureGate.close();
    props.onCaptureReady?.(null);
    setReady(false);
    resizeObserver?.disconnect();
    if (renderFrame) cancelAnimationFrame(renderFrame);
    cancelPendingPick();
    controls?.removeEventListener("change", requestRender);
    controls?.removeEventListener("start", handleControlsStart);
    controls?.removeEventListener("end", handleControlsEnd);
    controls?.dispose();
    disposeObject(geometryRoot);
    // Streamline borders share their parent's geometry: release it once through
    // the owning renderer before the generic helper traversal.
    if (THREE && streamlineRoot) updateStreamlineMeshes(THREE, streamlineRoot, []);
    disposeObject(helperRoot);
    disposeObject(axesRoot);
    if (renderer?.domElement) {
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("click", handleClick);
      renderer.domElement.removeEventListener("dblclick", handleDoubleClick);
      const handlers = renderer.domElement.__geometryContextHandlers;
      if (handlers) {
        renderer.domElement.removeEventListener(
          "webglcontextlost",
          handlers.handleContextLost,
        );
        renderer.domElement.removeEventListener(
          "webglcontextrestored",
          handlers.handleContextRestored,
        );
      }
    }
    renderer?.renderLists?.dispose?.();
    renderer?.dispose?.();
    renderer?.forceContextLoss?.();
    renderer?.domElement?.remove();
    renderer = null;
    threeScene = null;
    axesScene = null;
    axesCamera = null;
    axesRoot = null;
    raycaster = null;
    pointerNdc = null;
  });

  return (
    <div
      ref={(element) => (host = element)}
      class="three-geometry-viewport"
      role="img"
      aria-label="Трёхмерная геометрия элементов и областей"
      aria-busy={loading()}
    >
      <Show when={loading()}>
        <div class="geometry-viewport-overlay">Загрузка 3D-модуля…</div>
      </Show>
      <Show when={!loading() && !error() && renderedCount() === 0}>
        <div class="geometry-viewport-overlay">
          Нет геометрии для текущих настроек
        </div>
      </Show>
      <Show when={error()}>
        <div class="geometry-viewport-overlay geometry-viewport-error" role="alert">
          3D-представление недоступно: {error()}
        </div>
      </Show>
      <Show when={!error() && scalarLegends().length}>
        <div class="geometry-scalar-legends">
          <For each={scalarLegends()}>{(legend) => (
            <div class="geometry-scalar-legend" aria-label={`Цветовая шкала: ${legend.groupLabel ? `${legend.groupLabel} · ` : ""}${legend.quantity}, ${legend.unit}`}>
              <Show when={legend.groupLabel}><strong>{legend.groupLabel}</strong></Show>
              <div>{legend.quantity}, {legend.unit}</div>
              <div class="geometry-scalar-legend-gradient" style={{ background: resultScalarLegendBackground(legend.minimum, legend.maximum, legend.palette) }} />
              <div class="geometry-scalar-legend-limits">
                <span>{Number(legend.minimum.toPrecision(6)).toString()}</span>
                <span>{Number(legend.maximum.toPrecision(6)).toString()}</span>
              </div>
            </div>
          )}</For>
        </div>
      </Show>
      <Show when={hoverTooltip()} keyed>
        {(tooltip) => (
          <div
            class="geometry-viewport-tooltip"
            role="tooltip"
            style={{
              left: `${tooltip.left}px`,
              top: `${tooltip.top}px`,
            }}
          >
            {tooltip.text}
          </div>
        )}
      </Show>
    </div>
  );
}
