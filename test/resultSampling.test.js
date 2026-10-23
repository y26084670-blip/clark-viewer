import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import h5wasm from "h5wasm/node";
import { Hdf5ResultFile } from "../src/services/results/hdf5ResultFile.js";
import { QUANTITIES } from "../src/services/results/resultMappings.js";
import { readObjectFrames } from "../src/services/results/resultRequests.js";
import { vectorScene } from "../src/services/results/resultPlots.js";

const base = { id: 1, recordIndex: 0, name: "Элемент", targ: 0, xapName: "сталь", rv: 0,
  dp: [[8], [1], [1]], symLs: 4, symAs: 1, symPs: 1, symKya: 0, symKyp: 0 };
for (const Type of [Float32Array, Float64Array]) {
  test(`Complete ${Type.name} HDF5 retains source coordinates, values and image provenance`, async () => {
    await h5wasm.ready;
    const directory = await mkdtemp(join(tmpdir(), "e3d-viewer-sampling-"));
    const path = join(directory, "MH.h5");
    let handle;
    try {
      const records = [{ ...base, dp: [[30], [20], [2]], symLs: 3, symAs: 2, symPs: 2 },
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
      const frames = await readObjectFrames({ task, quantityKey: "M", selected: [1, 2], time: 0, budget: 1 });
      assert.equal(frames.reduce((sum, result) => sum + result.frame.count, 0), expected.length);
      assert.equal(reads, 2, "one full read for each object, including every saved image");
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
