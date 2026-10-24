import test from "node:test";
import assert from "node:assert/strict";
import LibAV from "@libav.js/variant-webm-vp9";
import { createMovieWebmCore } from "../src/services/movie/movieWebmCore.js";
import { convertTaskGifs } from "../src/services/movie/convertTaskGifs.js";

test("real VP9 encoder uses CRF 30 without bitrate cap, preserves odd dimensions and variable timestamps", async () => {
  const lib = await LibAV.LibAV({ noworker: true, nothreads: true });
  try {
    const init = lib.ff_init_encoder;
    lib.ff_init_encoder = (name, options) => {
      assert.equal(name, "libvpx-vp9"); assert.equal(options.options.crf, "30");
      assert.equal(options.ctx.bit_rate, 0); assert.deepEqual(options.time_base, [1, 1000]);
      return init(name, options);
    };
    const core = createMovieWebmCore(lib);
    for (const [i, delayMs] of [100, 230, 400].entries()) {
      const data = new Uint8ClampedArray(9 * 7 * 4);
      for (let k = 0; k < data.length; k += 4) data.set([i * 90, 50, 130, 255], k);
      await core.addFrame({ width: 9, height: 7, data }, { delayMs });
    }
    const bytes = await core.finish();
    assert.deepEqual([...bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
    assert.ok(new TextDecoder().decode(bytes).includes("V_VP9"));
    await lib.writeFile("check.webm", bytes);
    const [context, streams] = await lib.ff_init_demuxer_file("check.webm");
    assert.equal(streams.length, 1); assert.equal(streams[0].metadata.DURATION, "00:00:00.730000000");
    assert.equal(await lib.AVCodecParameters_width(streams[0].codecpar), 9);
    assert.equal(await lib.AVCodecParameters_height(streams[0].codecpar), 7);
    const packet = await lib.av_packet_alloc(), [, packets] = await lib.ff_read_frame_multi(context, packet);
    assert.deepEqual(packets[0].map(item => item.pts), [0, 100, 330]);
    const [, decoder, decodePacket, decodeFrame] = await lib.ff_init_decoder(streams[0].codec_id, { codecpar: streams[0].codecpar });
    const frames = await lib.ff_decode_multi(decoder, decodePacket, decodeFrame, packets[0], true);
    assert.equal(frames.length, 3); assert.ok(frames.every(frame => frame.width === 9 && frame.height === 7));
  } finally { lib.terminate(); }
});

function conversionFixture() {
  const entries = ["one.gif", "existing.webm", "two.GIF"].map(name => ({ name, handle: { name } }));
  const saved = [], reads = [], progress = [], encoders = [];
  const task = { requestPermission: () => Promise.resolve("granted") };
  const options = { list: async () => entries, read: async handle => { reads.push(handle.name); return new Blob([handle.name]); },
    save: async (_task, blob, name) => { saved.push(name); return { name }; }, onProgress: value => progress.push(value),
    createEncoder: () => { const encoder = { closed: false, async convertGif(buffer, onProgress) {
      onProgress({ completed: 1, total: 1 }); return { blob: new Blob([buffer], { type: "video/webm" }) };
    }, close() { this.closed = true; } }; encoders.push(encoder); return encoder; } };
  return { task, options, saved, reads, progress, encoders, entries };
}

test("batch conversion includes all task GIFs, skips WebM and never deletes sources", async () => {
  const h = conversionFixture(), names = h.entries.map(entry => entry.name);
  await convertTaskGifs(h.task, h.options);
  assert.deepEqual(h.reads, ["one.gif", "two.GIF"]); assert.deepEqual(h.saved, ["one.webm", "two.webm"]);
  assert.deepEqual(h.entries.map(entry => entry.name), names);
  assert.ok(h.encoders.every(encoder => encoder.closed)); assert.equal(h.progress.at(-1).completed, 2);
});

test("conversion cancellation closes the active encoder and leaves completed files saved", async () => {
  const h = conversionFixture(), abort = new AbortController();
  h.options.onProgress = value => { if (value.phase === "saved") abort.abort(); };
  await assert.rejects(convertTaskGifs(h.task, { ...h.options, signal: abort.signal }), { name: "AbortError" });
  assert.deepEqual(h.saved, ["one.webm"]); assert.equal(h.encoders.length, 1); assert.ok(h.encoders[0].closed);
  assert.equal(h.entries.length, 3);
});

test("denied conversion permission prevents file reads and encoding", async () => {
  const h = conversionFixture(); h.task.requestPermission = async () => "denied";
  await assert.rejects(convertTaskGifs(h.task, h.options), /разрешение/);
  assert.equal(h.reads.length, 0); assert.equal(h.encoders.length, 0);
});
