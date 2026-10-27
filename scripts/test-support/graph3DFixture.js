import { buildGeometryScene } from "../../src/services/visualization/geometrySceneModel.js";
import { trilinearElementPoint, bilinearRegionPoint } from "../../src/services/visualization/geometryDiscretization.js";

function graphPointOnPrimitive(primitive, n) {
  const dims = primitive.discretization.counts;
  return primitive.source.schemaId === "elements" ? trilinearElementPoint(primitive.vertices, (Math.floor(n / (dims[1] * dims[2])) + .5) / dims[0], (Math.floor(n / dims[2]) % dims[1] + .5) / dims[1], (n % dims[2] + .5) / dims[2]) : bilinearRegionPoint(primitive.controlVertices ?? primitive.vertices, Math.floor(n / dims[1]) / (dims[0] - 1), (n % dims[1]) / (dims[1] - 1));
}
import { applyMatrix4ToPoint } from "../../src/services/solver/rotation3d.js";
import { elementLayout, regionLayout, sourceRecords, expectedPointCount } from "../../src/services/results/resultMappings.js";

export function graph3DTask({ images = 2, mirror = -1, dimensions = [4, 3, 2], field = (p, time) => [p[0] + time, 2 * p[1] - time, -p[2] + 2 * time] } = {}) {
  const common = { dr: [[0], [0], [0]], symVi: [[0], [0], [0]], symR0: [[0], [0], [0]],
    symYl: 0, symYa: 0, symTx: 60, symLs: 1, symAs: 1, symPs: images, symKya: 0, symKyp: 0, indMove: 0 };
  const geo = [[0,0,0],[40,0,0],[0,20,0],[40,20,0],[0,0,10],[40,0,10],[0,20,10],[40,20,10]];
  const elements = [0, 1].map(recordIndex => ({ ...common, id: recordIndex + 1, recordIndex, name: `Проводник ${recordIndex + 1}`,
    geoType: 0, geo, dp: dimensions.map(n => [n]), dr: [[0], [recordIndex * 80], [0]], targ: 0, model: 0, rv: 1, xapName: "steel" }));
  const regions = [{ ...common, id: 1, recordIndex: 0, name: "Площадка", geoType: 0,
    geo: [[0,40,0],[40,40,0],[40,60,0],[0,60,0]], dp: [[5], [4]] }];
  const task = { name: "Графики 3D", general: { countTimeSteps: 2, timeStep: .25, mirrorSymmetryX: mirror, mirrorSymmetryY: -1 }, elements, regions, metadata: {} };
  const scene = buildGeometryScene(task), reads = [], buffers = {};
  if (scene.primitives.length !== 3) throw new Error(JSON.stringify(scene.diagnostics));
  for (const name of ["JE", "MH", "Q", "HS", "AS"]) {
    const records = sourceRecords(task, name), stride = name === "Q" ? 4 : ["JE", "MH"].includes(name) ? 9 : 6;
    const numbs = records.map(record => expectedPointCount(record, name)); let total = 0;
    const inds1 = numbs.map(n => { const first = total + 1; total += n; return first; });
    task.metadata[name] = { header: { stride, numbs, inds1, hasCoo: true, columns: name === "Q" ? 1 : 3, arrCount: stride === 9 ? 2 : 1 },
      steps: [0, 1, 2].map(index => ({ index, key: String(index).padStart(6, "0") })) };
    buffers[name] = [0, 1, 2].map(time => {
      const values = [];
      for (const record of records) {
        const region = name === "HS" || name === "AS", primitive = scene.primitives.find(p => p.source.schemaId === (region ? "regions" : "elements") && p.source.recordIndex === record.recordIndex);
        const layout = region ? regionLayout(record) : elementLayout(record);
        const nodes = region ? layout.planeCount : layout.dimensions.reduce((a, b) => a * b, 1);
        const rows = region ? Array.from({ length: layout.copies }, (_, ls) => Array.from({ length: nodes }, (_, node) => ({ node, ls, as: 0, ps: 0 }))).flat()
          : Array.from({ length: nodes }, (_, node) => Array.from({ length: images }, (_, ps) => ({ node, ls: 0, as: 0, ps }))).flat();
        for (const row of rows) {
          const instance = primitive.instances.find(i => i.ls === row.ls && (i.as ?? 0) === row.as && (i.ps ?? 0) === row.ps && !i.mirrorX && !i.mirrorY);
          const p = applyMatrix4ToPoint(instance.matrix, graphPointOnPrimitive(primitive, row.node));
          values.push(...p, ...(stride === 4 ? [p[0] - p[1] + time] : field(p, time)), ...(stride === 9 ? [2, -1, .5] : []));
        }
      }
      return new Float64Array(values);
    });
  }
  task.reader = { async read(request) {
    reads.push(request); const stride = task.metadata[request.name].header.stride, values = [], input = buffers[request.name][request.step];
    for (let row = request.start; row < request.start + request.count; row += request.every ?? 1) values.push(...input.subarray(row * stride, (row + 1) * stride));
    return { values: new Float64Array(values), count: values.length / stride, stride, every: request.every ?? 1 };
  } };
  const axis = { id: 1, source: { schemaId: "elements", recordIndex: 0 }, instance: { ls: 0, as: 0, ps: 0, mirrorX: 0, mirrorY: 0 }, points: [0, dimensions.reduce((a, b) => a * b, 1) - 1], up: [0,0,1] };
  return { task, scene, axis, reads, buffers };
}
