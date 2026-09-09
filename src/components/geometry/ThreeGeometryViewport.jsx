import {
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
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
  geometryCameraFrame,
  normalizeGeometryCameraCommand,
} from "../../services/visualization/geometryCameraView.js";
import {
  findPointMetadataRange,
  findVertexMetadataRange,
  formatDiscretizationPointTooltip,
  formatGeometryTooltip,
  formatResultVectorTooltip,
  resultHitVector,
  formatVertexTooltip,
  geometryHitInstance,
  pointHitMetadata,
  vertexHitMetadata,
} from "../../services/visualization/geometryPicking.js";
import {
  GEOMETRY_MATERIAL_KINDS,
  geometryMaterialStyle as resolveGeometryMaterialStyle,
} from "../../services/visualization/geometryMaterialStyle.js";

export const GEOMETRY_INSTANCE_BUDGET = 20_000;
export const GEOMETRY_RENDER_OBJECT_BUDGET = 1_000;
export const GEOMETRY_DISCRETIZATION_SEGMENT_BUDGET =
  DEFAULT_DISCRETIZATION_LIMITS.lineSegments;
export const GEOMETRY_DISCRETIZATION_POINT_BUDGET =
  DEFAULT_DISCRETIZATION_LIMITS.points;

const INSTANCE_CATEGORIES = Object.freeze(["base", "copy", "mirror"]);
const DEFAULT_PROJECTION = "orthographic";
const PERSPECTIVE_FOV = 45;
const CAMERA_FRAME_PADDING = 1.08;
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
        edgeColor: 0x754817,
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

function createPrescribedSourceVectors(
  THREE,
  vectors,
  acceptedInstances,
  sceneDiagonal,
  style,
  scales,
  maximumMagnitude,
  colorOverride,
) {
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
  const headBase = new THREE.Vector3();
  const wing = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const side = new THREE.Vector3();
  const secondSide = new THREE.Vector3();
  const sceneLimit = sceneDiagonal > 0 ? 0.06 * sceneDiagonal : Infinity;

  for (const item of vectors) {
    if (acceptedInstances && !acceptedInstances.has(sourceInstanceKey(item.source, item.instance))) {
      continue;
    }
    // Apply the user scale after the base limit so it can enlarge the arrows.
    const length = Math.min(0.7 * item.characteristicSize, sceneLimit) *
      (item.magnitude / maximum[item.kind]) * scales[item.kind];
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

    // Four wings retain a visible arrowhead from every viewing direction.
    const headLength = length * 0.25;
    const headRadius = headLength * 0.5;
    headBase.copy(tip).addScaledVector(direction, -headLength);
    axis.set(Math.abs(direction.y) < 0.9 ? 0 : 1,
      Math.abs(direction.y) < 0.9 ? 1 : 0, 0);
    side.crossVectors(direction, axis).normalize();
    secondSide.crossVectors(direction, side).normalize();
    for (const tangent of [side, secondSide]) {
      for (const sign of [-1, 1]) {
        wing.copy(headBase).addScaledVector(tangent, sign * headRadius);
        target.push(tip.x, tip.y, tip.z, wing.x, wing.y, wing.z);
      }
    }
  }

  if (
    positions.current.length === 0 && positions.magnetization.length === 0 &&
    solidArrows.current.length === 0 && solidArrows.magnetization.length === 0
  ) {
    return null;
  }

  const root = new THREE.Group();
  root.name = "prescribed-source-vectors";
  for (const [kind, color] of [["current", colorOverride ?? 0xff0000], ["magnetization", colorOverride ?? 0x00cc44]]) {
    if (style === "solid") {
      const arrows = solidArrows[kind];
      if (arrows.length === 0) continue;
      const materialOptions = {
        color,
        depthTest: true,
        depthWrite: true,
        transparent: true,
        opacity: 1,
      };
      const shafts = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(1, 1, 1, 8),
        new THREE.MeshLambertMaterial(materialOptions),
        arrows.length,
      );
      const heads = new THREE.InstancedMesh(
        new THREE.ConeGeometry(1, 1, 12),
        new THREE.MeshLambertMaterial(materialOptions),
        arrows.length,
      );
      const up = new THREE.Vector3(0, 1, 0);
      const rotation = new THREE.Quaternion();
      const position = new THREE.Vector3();
      const scale = new THREE.Vector3();
      const matrix = new THREE.Matrix4();
      for (let index = 0; index < arrows.length; index += 1) {
        const { item, length } = arrows[index];
        origin.fromArray(item.origin);
        direction.set(
          item.vector[0] / item.magnitude,
          item.vector[1] / item.magnitude,
          item.vector[2] / item.magnitude,
        ).normalize();
        rotation.setFromUnitVectors(up, direction);

        const shaftLength = length * 0.75;
        position.copy(origin).addScaledVector(direction, shaftLength * 0.5);
        scale.set(length * 0.025, shaftLength, length * 0.025);
        shafts.setMatrixAt(index, matrix.compose(position, rotation, scale));

        const headLength = length * 0.25;
        position.copy(origin).addScaledVector(
          direction,
          shaftLength + headLength * 0.5,
        );
        scale.set(length * 0.125, headLength, length * 0.125);
        heads.setMatrixAt(index, matrix.compose(position, rotation, scale));
      }
      for (const [part, mesh] of [["shaft", shafts], ["head", heads]]) {
        mesh.name = `prescribed-source-${kind}-${part}`;
        mesh.renderOrder = 14;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        root.add(mesh);
      }
      continue;
    }
    if (positions[kind].length === 0) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(positions[kind]), 3),
    );
    const lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color,
        depthTest: true,
        depthWrite: false,
        transparent: true,
        opacity: 1,
      }),
    );
    lines.name = `prescribed-source-${kind}`;
    lines.userData.resultVectors = thinVectors[kind];
    lines.renderOrder = 14;
    root.add(lines);
  }
  return root;
}

function prescribedSourceScale(value) {
  const scale = Number(value ?? 1);
  return Number.isFinite(scale) ? Math.max(0.1, Math.min(10, scale)) : 1;
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

  const translucent = mode === "translucent";
  const edges = new THREE.LineSegments(
    wireframe.geometry,
    new THREE.LineBasicMaterial({
      color: style.edgeColor,
      depthTest: true,
      depthWrite: false,
      linewidth: 1,
      opacity: translucent ? 0.78 : 1,
      transparent: translucent,
    }),
  );
  edges.name = "surface-edges";
  edges.renderOrder = 2;
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

function normalizeFramePadding(value) {
  return Number.isFinite(value) && value >= 1
    ? value
    : CAMERA_FRAME_PADDING;
}

function fitCameraToBounds(
  THREE,
  camera,
  controls,
  bounds,
  targetOverride,
  framePadding,
) {
  if (!bounds || bounds.isEmpty()) return false;

  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const target = targetOverride?.clone?.() ?? sphere.center;
  const padding = normalizeFramePadding(framePadding);
  const radius = Math.max(
    sphere.radius + sphere.center.distanceTo(target),
    1e-6,
  );
  let distance;

  if (camera.isOrthographicCamera) {
    const aspect = Math.max(
      (camera.right - camera.left) / (camera.top - camera.bottom),
      1e-6,
    );
    const halfHeight = padding * radius * Math.max(1, 1 / aspect);
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.zoom = 1;
    distance = Math.max(radius * 3, 1);
  } else {
    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const horizontalFov = 2 * Math.atan(
      Math.tan(verticalFov / 2) * camera.aspect,
    );
    distance = padding * Math.max(
      radius / Math.tan(verticalFov / 2),
      radius / Math.tan(Math.max(horizontalFov, 1e-6) / 2),
    );
    if (sphere.radius === 0) distance = Math.max(distance, 1);
  }

  const direction = camera.position.clone().sub(controls.target);
  if (direction.lengthSq() < 1e-12) direction.set(1, 1, 1);
  direction.normalize();

  controls.target.copy(target);
  camera.position.copy(target).addScaledVector(direction, distance);
  camera.near = Math.max(radius / 10_000, 1e-5);
  camera.far = Math.max(distance + radius * 10, radius * 1_000, 1);
  camera.updateProjectionMatrix();
  controls.update();
  return true;
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

  camera.position.set(1, 1, 1);
  camera.up.set(0, 0, 1);
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
  let resultVectorRoot = null;
  let currentResultScene = null;
  let resultVectorScale = 1;
  let resultVectorColor = 0x44ccff;
  let activeResultFilters = {};
  let prescribedSourceRoot;
  let prescribedSourceScene = null;
  let prescribedSourcesVisible = false;
  let prescribedSourceStyle = "thin";
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
  let currentBounds;
  let resizeObserver;
  let raycaster;
  let pointerNdc;
  let pendingPointer;
  let handlePointerMove;
  let handlePointerLeave;
  let handleControlsStart;
  let handleControlsEnd;
  let renderFrame = 0;
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
  let baseRenderStats = {
    budget: GEOMETRY_INSTANCE_BUDGET,
    invalidInstances: 0,
    objectBudget: GEOMETRY_RENDER_OBJECT_BUDGET,
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
  let hasFramedGeometry = false;
  let activeProjection = DEFAULT_PROJECTION;
  let OrbitControlsClass;
  let THREE;

  const [ready, setReady] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");
  const [renderedCount, setRenderedCount] = createSignal(0);
  const [hoverTooltip, setHoverTooltip] = createSignal(null);

  const reportError = (value) => {
    const message = value instanceof Error ? value.message : String(value);
    setError(message);
    props.onError?.(message);
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

  const requestRender = () => {
    if (!renderer || !threeScene || !camera || renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
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

  const resizeRenderer = () => {
    if (!host || !renderer || !camera) return;
    viewportWidth = Math.max(1, Math.floor(host.clientWidth));
    viewportHeight = Math.max(1, Math.floor(host.clientHeight));
    renderer.setSize(viewportWidth, viewportHeight, false);
    resizeCameraProjection(camera, viewportWidth / viewportHeight);
    if (
      props.autoFit === true
      && controls
      && currentBounds
      && !currentBounds.isEmpty()
    ) {
      fitCameraToBounds(THREE, camera, controls, currentBounds);
    }
    setHoverTooltip(null);
    requestRender();
  };

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

  const pickAtPointer = (pointer) => {
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
    raycaster.params.Points.threshold = unitsPerPixel * 9;

    if (props.resultPickingOnly) {
      // Only currently displayed result primitives participate. The actual
      // intersection lies on a scaled arrow; the tip reports its saved origin.
      const hits = resultVectorRoot ? raycaster.intersectObject(resultVectorRoot, true) : [];
      const geometryHit = activeRenderMode === "solid"
        ? raycaster.intersectObjects(geometryPickTargets, false)[0] : null;
      const hit = hits.find(candidate => !geometryHit || candidate.distance <= geometryHit.distance + unitsPerPixel * 5);
      const item = resultHitVector(hit);
      if (item) showTooltip(formatResultVectorTooltip(item), x, y);
      else setHoverTooltip(null);
      return;
    }

    const geometryHit = raycaster.intersectObjects(
      geometryPickTargets,
      false,
    )[0] ?? null;
    const discretizationHit =
      discretizationPointsVisible && discretizationPoints
        ? raycaster.intersectObject(discretizationPoints, false)[0] ?? null
        : null;
    const vertexHit = verticesVisible && vertexPoints
      ? raycaster.intersectObject(vertexPoints, false)[0] ?? null
      : null;
    const pointIsVisible = (hit) =>
      activeRenderMode !== "solid" ||
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

      appendTransformedPositions(
        THREE,
        built.lines,
        batch.instances.slice(0, acceptedCount),
        positions,
      );
      remaining -= cost * acceptedCount;
    }

    discretizationLines = createDiscretizationLines(THREE, positions);
    if (discretizationLines) {
      discretizationLines.visible = discretizationLinesVisible;
      helperRoot.add(discretizationLines);
    }
    discretizationStats.lineSegments = positions.length / 6;
    discretizationStats.linesTruncated = truncated;
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
    }
    discretizationStats.points = positions.length / 3;
    discretizationStats.pointsTruncated = truncated;
    updateSurfacePolygonOffset();
    publishRenderStats();
  };

  const switchProjection = (value) => {
    const projection = normalizeProjection(value);
    if (
      !ready() ||
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

    if (currentBounds && !currentBounds.isEmpty()) {
      fitCameraToBounds(
        THREE,
        camera,
        controls,
        currentBounds,
        preservedTarget,
      );
    } else {
      controls.update();
    }
    requestRender();
  };

  const replacePrescribedSources = () => {
    if (!THREE || !helperRoot) return;
    if (prescribedSourceRoot) {
      helperRoot.remove(prescribedSourceRoot);
      disposeObject(prescribedSourceRoot);
      prescribedSourceRoot = null;
    }
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
      );
      if (prescribedSourceRoot) helperRoot.add(prescribedSourceRoot);
    }
    requestRender();
  };

  // Result xyz and vectors are already in the global coordinate system.
  // Apply display filters only; never reapply motion, amplitudes or symmetry.
  const replaceResultVectors = () => {
    if (!THREE || !helperRoot) return;
    clearHoverTooltip();
    if (resultVectorRoot) {
      helperRoot.remove(resultVectorRoot);
      disposeObject(resultVectorRoot);
      resultVectorRoot = null;
    }
    if (currentResultScene) {
      const vectors = currentResultScene.vectors.filter(item =>
        primitiveVisible(item, activeResultFilters.objectModes, activeResultFilters.selections)
        && instanceVisible(item.instance, activeResultFilters.symmetry));
      resultVectorRoot = createPrescribedSourceVectors(THREE, vectors, null,
        currentResultScene.sceneDiagonal, "thin",
        { current: resultVectorScale, magnetization: resultVectorScale },
        currentResultScene.maximumMagnitude, resultVectorColor);
      if (vectors.length) {
        resultVectorRoot ??= new THREE.Group();
        const positions = new Float32Array(vectors.length * 3);
        vectors.forEach((item, index) => positions.set(item.origin, index * 3));
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        const nodes = new THREE.Points(geometry, new THREE.PointsMaterial({
          color: resultVectorColor, size: 4, sizeAttenuation: false, depthTest: true, depthWrite: false,
        }));
        nodes.userData.resultVectors = vectors;
        nodes.renderOrder = 14;
        resultVectorRoot.add(nodes);
        helperRoot.add(resultVectorRoot);
      }
    }
    requestRender();
  };

  const replaceGeometry = (sceneModel, filters, mode, showEdges) => {
    if (!ready() || !THREE || !threeScene) return;
    activeRenderMode = mode;
    activeResultFilters = filters ?? {};

    if (geometryRoot) {
      threeScene.remove(geometryRoot);
      disposeObject(geometryRoot);
    }
    if (helperRoot) {
      threeScene.remove(helperRoot);
      disposeObject(helperRoot);
    }
    prescribedSourceRoot = null;
    resultVectorRoot = null;
    acceptedSourceInstances = new Set();

    geometryRoot = new THREE.Group();
    geometryRoot.name = "geometry-root";
    helperRoot = new THREE.Group();
    helperRoot.name = "geometry-helpers";
    threeScene.add(geometryRoot, helperRoot);
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
    const objectBudget = Math.max(
      1,
      Math.floor(
        props.objectBudget ?? GEOMETRY_RENDER_OBJECT_BUDGET,
      ),
    );
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
          renderedPrimitives + objectCost > objectBudget ||
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
        geometryRoot.add(object);
        geometryPickTargets.push(object);
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
        renderedPrimitives += objectCost;
        renderedInstances += accepted.length;
        remaining -= accepted.length;
      }
    }

    currentBounds = new THREE.Box3().setFromObject(geometryRoot);
    if (!currentBounds.isEmpty()) {
      if (!hasFramedGeometry || props.autoFit === true) {
        fitCameraToBounds(THREE, camera, controls, currentBounds);
        hasFramedGeometry = true;
      }
    } else {
      hasFramedGeometry = false;
    }

    const truncated = selectedInstances - invalidInstances > renderedInstances;
    baseRenderStats = {
      budget,
      objectBudget,
      invalidInstances,
      renderedInstances,
      renderedPrimitives,
      selectedInstances,
      truncated,
    };
    setRenderedCount(renderedInstances);
    if (verticesVisible) materializeVertexPoints();
    if (discretizationLinesVisible) materializeDiscretizationLines();
    if (discretizationPointsVisible) materializeDiscretizationPoints();
    replacePrescribedSources();
    replaceResultVectors();
    publishRenderStats();
    if (!contextLost) {
      setError("");
      props.onError?.("");
    }
    requestRender();
  };

  const fitAll = () => {
    if (!ready() || !currentBounds) return;
    clearHoverTooltip();
    fitCameraToBounds(
      THREE,
      camera,
      controls,
      currentBounds,
      undefined,
      props.fitAllPadding,
    );
    requestRender();
  };

  const applyViewRequest = (request) => {
    const command = normalizeGeometryCameraCommand(request?.command);
    if (!ready() || !currentBounds || !command) return;
    if (command === GEOMETRY_CAMERA_COMMANDS.FIT_ALL) {
      fitAll();
      return;
    }

    const frame = geometryCameraFrame(command);
    if (!frame) return;
    camera.up.fromArray(frame.up);
    camera.position.fromArray(frame.offset).add(controls.target);
    rebuildOrbitControls();
    fitCameraToBounds(THREE, camera, controls, currentBounds);
    clearHoverTooltip();
    requestRender();
  };

  onMount(() => {
    void Promise.all([
      import("three"),
      import("three/addons/controls/OrbitControls.js"),
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
    try {
      replacePrescribedSources();
    } catch (renderError) {
      reportError(renderError);
    }
  });

  createEffect(() => {
    currentResultScene = props.resultVectorScene ?? null;
    resultVectorScale = props.resultVectorScale ?? 1;
    resultVectorColor = props.resultVectorColor ?? 0x44ccff;
    if (!ready()) return;
    try { replaceResultVectors(); } catch (error) { reportError(error); }
  });

  createEffect(() => {
    const sceneModel = props.scene;
    const filters = props.filters;
    const mode = props.mode ?? "solid";
    const showEdges = props.showEdges !== false;
    if (!ready()) return;

    try {
      replaceGeometry(sceneModel, filters, mode, showEdges);
    } catch (renderError) {
      reportError(renderError);
    }
  });

  createEffect(() => {
    const projection = props.projection;
    if (ready()) switchProjection(projection);
  });

  createEffect(() => {
    const request = props.viewRequest;
    if (ready()) applyViewRequest(request);
  });

  onCleanup(() => {
    disposed = true;
    setReady(false);
    resizeObserver?.disconnect();
    if (renderFrame) cancelAnimationFrame(renderFrame);
    cancelPendingPick();
    controls?.removeEventListener("change", requestRender);
    controls?.removeEventListener("start", handleControlsStart);
    controls?.removeEventListener("end", handleControlsEnd);
    controls?.dispose();
    disposeObject(geometryRoot);
    disposeObject(helperRoot);
    disposeObject(axesRoot);
    if (renderer?.domElement) {
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
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
