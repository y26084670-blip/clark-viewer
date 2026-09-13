import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import h5wasm from "h5wasm/node";
import { Hdf5ResultFile } from "../src/services/results/hdf5ResultFile.js";
import { elementLayout, QUANTITIES, regionLayout } from "../src/services/results/resultMappings.js";
import { planResultSampling } from "../src/services/results/resultSampling.js";
import { readObjectFrames } from "../src/services/results/resultRequests.js";
import { vectorScene } from "../src/services/results/resultPlots.js";

const base = { id: 1, recordIndex: 0, name: "Элемент", targ: 0, xapName: "сталь", rv: 0,
  dp: [[8], [1], [1]], symLs: 4, symAs: 1, symPs: 1, symKya: 0, symKyp: 0 };
const sampledRows = plan => plan.ranges.flatMap(range => Array.from({ length: Math.ceil(range.count / range.every) },
  (_, index) => range.start - plan.object.start + index * range.every));

test("3D sampling retains every inner symmetry image within the global budget", () => {
  const record = { ...base, dp: [[7], [3], [2]], symAs: 2, symPs: 3 };
  const second = { ...base, id: 2, dp: [[1], [1], [1]], symLs: 2 };
  const objects = [{ record, start: 17, count: 1008 }, { record: second, start: 1025, count: 2 }];
  const plans = planResultSampling(objects, QUANTITIES.M, 75);
  let total = 0;
  plans.forEach(plan => {
    const layout = elementLayout(plan.object.record);
    const rows = sampledRows(plan);
    total += rows.length;
    assert.equal(new Set(rows).size, rows.length);
    assert.ok(rows.every(row => row >= 0 && row < layout.count));
    const images = new Set(rows.map(row => {
      const { ls, as, ps } = layout.indices(row);
      return `${ls}/${as}/${ps}`;
    }));
    assert.equal(images.size, layout.copies.reduce((a, b) => a * b, 1));
  });
  assert.ok(total <= 75);
  assert.equal(plans[1].ranges.length, 1, "small complete objects need one contiguous read");
  assert.throws(() => planResultSampling(objects, QUANTITIES.M, 25), /Сократите выделение/);

  // The old stride of four would retain only LS=1 for this ordinary layout.
  const simple = planResultSampling([{ record: base, start: 0, count: 32 }], QUANTITIES.M, 8)[0];
  assert.deepEqual([...new Set(sampledRows(simple).map(row => row % 4))], [0, 1, 2, 3]);
});

test("Area sampling covers outer LS blocks; large sources use a few bounded slices", () => {
  const record = { ...base, dp: [[4], [3]], symLs: 3 };
  const object = { record, start: 25, count: regionLayout(record).count };
  const plan = planResultSampling([object], QUANTITIES.Bs, 6)[0];
  assert.deepEqual(sampledRows(plan), [0, 6, 12, 18, 24, 30]);
  assert.equal(plan.ranges.length, 3);

  const large = { ...base, dp: [[2_000_000], [1], [1]], symLs: 8 };
  const largePlan = planResultSampling([{ record: large, start: 0, count: 16_000_000 }], QUANTITIES.M, 5000)[0];
  assert.equal(largePlan.ranges.length, 8);
  assert.equal(sampledRows(largePlan).length, 5000);
  assert.ok(largePlan.ranges.every(range => range.every > 1));

  const geometric = { ...base, symAs: 5, symPs: 7, symKya: -1, symKyp: 1 };
  const independent = planResultSampling([{ record: geometric, start: 0, count: 32 }], QUANTITIES.M, 4)[0];
  assert.equal(independent.ranges.length, 4, "do not invent unsaved source AS/PS images");
  const virtual = { ...geometric, targ: 3 };
  const full = planResultSampling([{ record: virtual, start: 0, count: 1120 }], QUANTITIES.Bv, 140)[0];
  assert.equal(full.ranges.length, 140, "virtual result files save all geometric images");
});

for (const Type of [Float32Array, Float64Array]) {
  test(`Sampled ${Type.name} HDF5 retains source coordinates, values and image provenance`, async () => {
    await h5wasm.ready;
    const directory = await mkdtemp(join(tmpdir(), "e3d-viewer-sampling-"));
    const path = join(directory, "MH.h5");
    let handle;
    try {
      const records = [{ ...base, dp: [[3], [2], [2]], symLs: 3, symAs: 2, symPs: 2 },
        { ...base, id: 2, recordIndex: 1, dp: [[2], [1], [1]], symLs: 2, symPs: 2 }];
      const rows = [], expected = [], starts = [], counts = [];
      for (const record of records) {
        const start = expected.length;
        starts.push(start + 1);
        for (let i1 = 0; i1 < record.dp[0][0]; i1++) for (let i2 = 0; i2 < record.dp[1][0]; i2++)
          for (let i3 = 0; i3 < record.dp[2][0]; i3++) for (let ls = 0; ls < record.symLs; ls++)
            for (let as = 0; as < record.symAs; as++) for (let ps = 0; ps < record.symPs; ps++) {
              const values = [100 * record.id + i1 + .25, 10 * ls + i2 + .5, i3 + ps + .75,
                ls + 1, as + 2, ps + 3, i1 + 4, i2 + 5, i3 + 6];
              rows.push(...values);
              expected.push({ values, instance: { ls, as, ps } });
            }
        counts.push(expected.length - start);
      }
      handle = new h5wasm.File(path, "w");
      const header = handle.create_group("HEADER");
      for (const [name, value] of Object.entries({ columns: 3n, arrCount: 2n, hasCoo: 1n })) {
        header.create_dataset({ name, data: new BigInt64Array([value]), shape: [] });
      }
      header.create_dataset({ name: "inds1", data: new BigInt64Array(starts.map(BigInt)) });
      header.create_dataset({ name: "numbs", data: new BigInt64Array(counts.map(BigInt)) });
      handle.create_dataset({ name: "000000", data: new Type(rows), shape: [expected.length, 9] });
      handle.close();
      handle = new h5wasm.File(path, "r");
      const file = new Hdf5ResultFile("MH", handle);
      let reads = 0;
      const task = { elements: records, regions: [], metadata: { MH: file.metadata },
        reader: { read: request => { reads++; return file.read(request); } } };
      const frames = await readObjectFrames({ task, quantityKey: "M", selected: [1, 2], time: 0, budget: 40 });
      assert.ok(frames.reduce((sum, result) => sum + result.frame.count, 0) <= 40);
      assert.equal(reads, 13, "12 source images plus one complete small object");
      let sceneOffset = 0;
      const scene = vectorScene(frames, QUANTITIES.M);
      frames.forEach(({ frame, record }, objectIndex) => {
        assert.ok(frame.values instanceof Type);
        const images = new Set();
        for (let row = 0; row < frame.count; row++) {
          const saved = expected[starts[objectIndex] - 1 + (frame.rowIndices?.[row] ?? row)];
          const vector = scene.vectors[sceneOffset++];
          assert.deepEqual(Array.from(frame.values.subarray(row * 9, row * 9 + 9)), saved.values);
          assert.deepEqual(vector.origin, saved.values.slice(0, 3));
          assert.deepEqual(vector.vector, saved.values.slice(3, 6));
          assert.deepEqual(vector.instance, saved.instance);
          images.add(`${vector.instance.ls}/${vector.instance.as}/${vector.instance.ps}`);
        }
        assert.equal(images.size, record.symLs * record.symAs * record.symPs);
      });
    } finally {
      handle?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
