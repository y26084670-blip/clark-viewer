import test from "node:test";
import assert from "node:assert/strict";
import { captureMovieCanvas, movieCanvasSize, MOVIE_CAPTION_HEIGHT } from "../src/services/movie/movieCanvas.js";

test("movie canvas preserves the complete view aspect and includes its caption within the pixel limit", () => {
  assert.deepEqual(movieCanvasSize(2560, 1440), { width: 1280, height: 752 });
  assert.deepEqual(movieCanvasSize(1000, 2000), { width: 464, height: 960 });
  assert.deepEqual(movieCanvasSize(320, 200), { width: 320, height: 232 });
  assert.throws(() => movieCanvasSize(0, 100), /изображения/);
  assert.throws(() => movieCanvasSize(NaN, 100), /изображения/);
});

test("capture copies the canvas synchronously, clips overlays below the caption, then reads RGBA", () => {
  const calls = [], source = { width: 2000, height: 1000 };
  const output = { width: 1280, height: 672, data: new Uint8ClampedArray(1280 * 672 * 4) };
  const context = Object.fromEntries(["fillRect", "drawImage", "save", "translate", "beginPath", "rect", "clip", "restore", "fillText"]
    .map(name => [name, (...args) => calls.push([name, ...args])]));
  context.getImageData = (...args) => { calls.push(["getImageData", ...args]); return output; };
  const canvas = { getContext: () => context };
  const captured = captureMovieCanvas(source, { caption: "Шаг 2 / 5 · t = 0.1 с", canvasFactory: () => canvas,
    overlay: (ctx, size) => { assert.equal(ctx, context); calls.push(["overlay", size]); } });
  assert.equal(captured, output, "capture must not defer the WebGL copy to a promise");
  assert.deepEqual([canvas.width, canvas.height], [1280, 672]);
  assert.deepEqual(calls.find(call => call[0] === "drawImage"), ["drawImage", source, 0, MOVIE_CAPTION_HEIGHT, 1280, 640]);
  assert.deepEqual(calls.find(call => call[0] === "translate"), ["translate", 0, 32]);
  assert.deepEqual(calls.find(call => call[0] === "overlay"), ["overlay", { width: 1280, height: 640 }]);
  assert.ok(calls.findIndex(call => call[0] === "drawImage") < calls.findIndex(call => call[0] === "overlay"));
  assert.ok(calls.findIndex(call => call[0] === "clip") < calls.findIndex(call => call[0] === "overlay"));
  assert.deepEqual(calls.at(-1), ["getImageData", 0, 0, 1280, 672]);
});
