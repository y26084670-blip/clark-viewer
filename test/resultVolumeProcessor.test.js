import test from "node:test";
import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import { createResultVolumeProcessor } from "../src/services/results/resultVolumeProcessor.js";
import { ResultVolumeLimitError } from "../src/services/visualization/resultVolumeField.js";

function domain(key = "test", planar = false, offset = 0) {
  const dimensions = [2, 2, planar ? 1 : 2], positions = [], values = [], points = [];
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < dimensions[2]; z++) {
    const origin = [x, y, z];
    positions.push(...origin); values.push(offset + x + 2 * y + 3 * z); points.push({ origin });
  }
  return { key, dimensions, positions: new Float64Array(positions), values: new Float64Array(values), points,
    source: { schemaId: "elements", recordIndex: 2 }, instance: { ls: 1, as: 2, ps: 3 } };
}

class ManualWorker {
  postMessage(data, transfer) { this.sent = { data, transfer }; }
  terminate() { this.terminated = true; }
}

test("volume processor is lazy, permits one job, and ignores an unrelated response", async () => {
  let count = 0;
  const worker = new ManualWorker();
  const processor = createResultVolumeProcessor({ workerFactory: () => { count++; return worker; } });
  assert.equal(count, 0);
  const grid = domain(), result = processor.process([grid]);
  assert.equal(count, 1);
  assert.equal(worker.sent.data.domains[0].points, undefined, "picking objects must not be cloned to the worker");
  assert.deepEqual(worker.sent.transfer, [grid.positions.buffer, grid.values.buffer]);
  await assert.rejects(processor.process([domain()]), /ещё выполняется/);
  worker.onmessage({ data: { id: -1, result: {} } });
  worker.onmessage({ data: { id: worker.sent.data.id, result: { domains: [{ key: grid.key }], fallbackDomainKeys: [] } } });
  const fields = await result;
  assert.equal(fields.domains[0].points, grid.points);
  assert.equal(fields.domains[0].source, grid.source);
  assert.equal(fields.domains[0].instance, grid.instance);
  processor.close(); assert.equal(worker.terminated, true);
});

test("volume processor cancels pending work and rejects late use after close", async () => {
  const worker = new ManualWorker();
  const processor = createResultVolumeProcessor({ workerFactory: () => worker });
  const pending = processor.process([domain()]);
  const late = worker.onmessage;
  processor.close();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(worker.terminated, true);
  late({ data: { id: 1, result: {} } });
  await assert.rejects(processor.process([domain()]), /закрыт/);
});

test("worker limit errors remain identifiable and runtime errors release resources", async () => {
  const worker = new ManualWorker();
  const processor = createResultVolumeProcessor({ workerFactory: () => worker });
  const first = processor.process([domain()]);
  worker.onmessage({ data: { id: 1, error: "limit", limit: true } });
  await assert.rejects(first, ResultVolumeLimitError);
  const second = processor.process([domain()]);
  worker.onerror({ message: "worker failed" });
  await assert.rejects(second, /worker failed/);
  assert.equal(worker.terminated, true);
  processor.close();
});

function realWorkerFactory() {
  const moduleUrl = new URL("../src/workers/resultVolume.worker.js", import.meta.url).href;
  const worker = new NodeWorker(`
    const { parentPort } = await import('node:worker_threads');
    globalThis.self = { postMessage: (data, transfer) => parentPort.postMessage(data, transfer) };
    await import(${JSON.stringify(moduleUrl)});
    parentPort.on('message', data => self.onmessage({ data }));
  `, { eval: true });
  const wrapper = {
    postMessage: (data, transfer) => worker.postMessage(data, transfer),
    terminate: () => worker.terminate(),
  };
  worker.on("message", data => wrapper.onmessage?.({ data }));
  worker.on("error", error => wrapper.onerror?.({ message: error.message }));
  worker.on("messageerror", () => wrapper.onmessageerror?.());
  return wrapper;
}

test("real volume worker transfers only output textures and updates the next frame", async () => {
  const processor = createResultVolumeProcessor({ workerFactory: realWorkerFactory });
  try {
    const solid = domain(), flat = domain("flat", true);
    const first = await processor.process([solid, flat]);
    assert.equal(solid.positions.byteLength, 0, "only the new grid buffers are transferred");
    assert.equal(first.domains.length, 1);
    assert.equal(first.domains[0].samplingPlan, undefined, "the heavy spatial plan stays in the worker");
    assert.equal(first.domains[0].points, solid.points);
    assert.equal(first.fallbackPoints.length, flat.points.length);
    assert.equal(first.fallbackPoints[0], flat.points[0]);
    assert.match(first.notice, /Плоские/);
    const next = await processor.process([domain("test", false, 10), domain("flat", true, 10)]);
    assert.equal(next.domains[0].values.length, first.domains[0].values.length);
    for (let i = 0; i < first.domains[0].values.length; i += 53) {
      assert.ok(Math.abs(next.domains[0].values[i] - first.domains[0].values[i] - 10) < 2e-6);
    }
    assert.equal(next.minimum, 10);
  } finally { processor.close(); }
});
