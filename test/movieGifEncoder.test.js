import test from "node:test";
import assert from "node:assert/strict";
import { Worker as NodeWorker } from "node:worker_threads";
import { createMovieGifEncoder } from "../src/services/movie/movieGifEncoder.js";
import { createMovieGifSession } from "../src/services/movie/movieGifCore.js";
import { validateMovieFrame } from "../src/services/movie/movieFrame.js";

function frame(color = [255, 0, 0], width = 8, height = 4) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...color, 255], i);
  return { width, height, data };
}

// A small independent GIF reader: parses extensions, local/global palettes and
// LZW image data. Tests compare decoded pixels, not the encoder's own indexes.
function decodeGif(bytes) {
  let at = 0;
  const byte = () => bytes[at++];
  const word = () => byte() | byte() << 8;
  const text = count => String.fromCharCode(...bytes.subarray(at, at += count));
  const palette = packed => Array.from({ length: 1 << ((packed & 7) + 1) }, () => [byte(), byte(), byte()]);
  const blocks = () => {
    const parts = [];
    for (let length = byte(); length; length = byte()) parts.push(...bytes.subarray(at, at += length));
    return Uint8Array.from(parts);
  };
  assert.equal(text(6), "GIF89a");
  const width = word(), height = word(), packed = byte();
  byte(); byte();
  const globalPalette = packed & 128 ? palette(packed) : null;
  let delay = 0, loop = null, disposal = 0;
  const frames = [];
  for (let separator = byte(); separator !== 0x3b; separator = byte()) {
    assert.ok(at <= bytes.length, "GIF must have a trailer");
    if (separator === 0x21) {
      const label = byte();
      if (label === 0xf9) {
        assert.equal(byte(), 4);
        disposal = (byte() >> 2) & 7; delay = word() * 10;
        byte(); assert.equal(byte(), 0);
      } else if (label === 0xff) {
        const name = text(byte()), extension = blocks();
        if (name === "NETSCAPE2.0") loop = extension[1] | extension[2] << 8;
      } else blocks();
      continue;
    }
    assert.equal(separator, 0x2c);
    assert.equal(word(), 0); assert.equal(word(), 0);
    const frameWidth = word(), frameHeight = word(), imagePacked = byte();
    assert.equal(imagePacked & 64, 0, "test reader expects non-interlaced images");
    const colors = imagePacked & 128 ? palette(imagePacked) : globalPalette;
    const minimumBits = byte(), compressed = blocks(), clear = 1 << minimumBits, end = clear + 1;
    let bit = 0, bits = minimumBits + 1, next = end + 1, dictionary, previous = null;
    const reset = () => {
      dictionary = Array.from({ length: clear }, (_, i) => [i]);
      bits = minimumBits + 1; next = end + 1; previous = null;
    };
    reset();
    const indices = [];
    while (bit + bits <= compressed.length * 8) {
      let code = 0;
      for (let i = 0; i < bits; i++, bit++) code |= ((compressed[bit >> 3] >> (bit & 7)) & 1) << i;
      if (code === end) break;
      if (code === clear) { reset(); continue; }
      const entry = dictionary[code] ?? (code === next && previous ? [...previous, previous[0]] : null);
      assert.ok(entry, "LZW dictionary reference must exist");
      indices.push(...entry);
      if (previous && next < 4096) {
        dictionary[next++] = [...previous, entry[0]];
        if (next === 1 << bits && bits < 12) bits++;
      }
      previous = entry;
    }
    assert.equal(indices.length, frameWidth * frameHeight);
    frames.push({ width: frameWidth, height: frameHeight, delay, disposal,
      pixels: indices.map(index => colors[index]) });
  }
  assert.equal(at, bytes.length, "no trailing data beyond the GIF trailer");
  return { width, height, loop, frames };
}

function realWorkerFactory() {
  const moduleUrl = new URL("../src/workers/movieGif.worker.js", import.meta.url).href;
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

test("real GIF worker writes every frame in order with exact delays, opaque colors and infinite loop", async () => {
  let created = 0;
  const encoder = createMovieGifEncoder({ workerFactory: () => { created++; return realWorkerFactory(); } });
  assert.equal(created, 0, "worker must be lazy");
  try {
    const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255]], delays = [20, 100, 60000];
    for (let i = 0; i < colors.length; i++) {
      const source = frame(colors[i]);
      const progress = await encoder.addFrame(source, { delayMs: delays[i] });
      assert.equal(source.data.byteLength, 0, "RGBA ownership transfers out of the UI thread");
      assert.equal(progress.frames, i + 1);
    }
    assert.equal(created, 1, "all frames use one long-lived worker");
    const blob = await encoder.finish();
    assert.equal(blob.type, "image/gif");
    const decoded = decodeGif(new Uint8Array(await blob.arrayBuffer()));
    assert.deepEqual([decoded.width, decoded.height, decoded.loop], [8, 4, 0]);
    assert.equal(decoded.frames.length, 3);
    for (let i = 0; i < colors.length; i++) {
      assert.equal(decoded.frames[i].delay, delays[i]);
      assert.equal(decoded.frames[i].disposal, 1);
      for (const pixel of decoded.frames[i].pixels) assert.deepEqual(pixel, colors[i]);
    }
    await assert.rejects(encoder.finish(), /закрыт/);
  } finally { encoder.close(); }
});

test("GIF decoder checks real spatial pixels and LZW dictionary growth", () => {
  const source = frame([0, 0, 0], 128, 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const i = (y * 128 + x) * 4;
    source.data.set(x % 3 === 0 ? [255, 0, 0] : y % 2 ? [0, 255, 0] : [0, 0, 255], i);
  }
  const session = createMovieGifSession();
  session.addFrame(source, { delayMs: 120 });
  const decoded = decodeGif(session.finish());
  for (let i = 0; i < 128 * 128; i++) assert.deepEqual(decoded.frames[0].pixels[i], [...source.data.subarray(i * 4, i * 4 + 3)]);
});

test("RGBA subviews do not introduce pixels from the surrounding buffer", () => {
  const source = new Uint8Array([0, 0, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255]);
  const session = createMovieGifSession();
  session.addFrame({ width: 1, height: 1, data: source.subarray(4, 8) }, { delayMs: 100 });
  assert.deepEqual(decodeGif(session.finish()).frames[0].pixels, [[255, 0, 0]]);
});

test("GIF limits reject invalid data, delay, changing view and oversized output", () => {
  for (const delayMs of [0, 10, 21, 100.5, 60010, Infinity]) {
    assert.throws(() => validateMovieFrame(frame(), delayMs), /Интервал/);
  }
  assert.throws(() => validateMovieFrame(frame([0, 0, 0], 1281, 1), 100), /Размер/);
  assert.throws(() => validateMovieFrame({ width: 2, height: 2, data: new Uint8Array(15) }, 100), /RGBA/);
  const changed = createMovieGifSession();
  changed.addFrame(frame(), { delayMs: 100 });
  assert.throws(() => changed.addFrame(frame([0, 0, 0], 9, 4), { delayMs: 100 }), /Размер вида изменился/);
  assert.throws(() => changed.finish(), /завершена/);
  const bounded = createMovieGifSession({ maxBytes: 60 });
  assert.throws(() => bounded.addFrame(frame(), { delayMs: 100 }), /128 МиБ/);
  assert.throws(() => createMovieGifSession().finish(), /нет кадров/);
});

class ManualWorker {
  postMessage(data, transfer) { this.sent = { data, transfer }; }
  terminate() { this.terminated = true; }
}

test("GIF facade rejects concurrency and closes pending work without accepting late replies", async () => {
  const worker = new ManualWorker(), encoder = createMovieGifEncoder({ workerFactory: () => worker });
  const first = encoder.addFrame(frame(), { delayMs: 100 });
  const reply = worker.onmessage;
  await assert.rejects(encoder.addFrame(frame(), { delayMs: 100 }), /ещё обрабатывается/);
  reply({ data: { id: 999, result: {} } });
  encoder.close();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(worker.terminated, true);
  reply({ data: { id: 1, result: {} } });
  await assert.rejects(encoder.addFrame(frame(), { delayMs: 100 }), /закрыт/);
});

test("GIF worker runtime and encoding failures release resources and reject further frames", async () => {
  for (const mode of ["runtime", "message", "encoding"]) {
    const worker = new ManualWorker(), encoder = createMovieGifEncoder({ workerFactory: () => worker });
    const pending = encoder.addFrame(frame(), { delayMs: 100 });
    if (mode === "runtime") worker.onerror({ message: "failed" });
    else if (mode === "message") worker.onmessageerror();
    else worker.onmessage({ data: { id: 1, error: "failed to encode" } });
    await assert.rejects(pending);
    assert.equal(worker.terminated, true);
    await assert.rejects(encoder.finish(), /закрыт/);
    encoder.close();
  }
});
