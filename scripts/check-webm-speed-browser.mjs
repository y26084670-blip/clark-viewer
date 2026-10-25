// Real WebM decoder and native OPFS, using the shared task-media fixture.
// Embedded 6 s VP9 clip: ffmpeg color/drawbox, 160x100, 5 fps, CRF 30, no audio.
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const WEBM_BASE64 = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAWsEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggEeTbuMU6uEHFO7a1OsggWW7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMESJiEC3cAAAAAAAFlSua8GuAQAAAAAAADjXgQFzxYj1FrLY3x832ZyBACK1nIN1bmSIgQCGhVZfVlA5g4EBI+ODhAvrwgDgibCBoLqBZJqBAhJUw2dAgHNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjAuMTYuMTAwc3PaY8CLY8WI9Ray2N8fN9lnyKVFo4dFTkNPREVSRIeYTGF2YzYwLjMxLjEwMiBsaWJ2cHgtdnA5Z8ihRaOIRFVSQVRJT05Eh5MwMDowMDowNi4wMDAwMDAwMDAAH0O2dUOD54EAo0ElgQAAgIJJg0IACfAGNgg4JBwYPgABUH+Rpi2fEHLlndHFCkuPXa4zWUgAAHyByJwBVcjKDHHPPUcQWGzr5v3lUJoGM3XcFXWalsRiH2MWajGm1ODLHXjeYquJws4+pqsBUycY4Aw0AIkG/H0cnK7DtkIvUvY89srAFqDa0Z16IiGqPPK/pFR8kAVYyaQRf4YVPpzff6Y0MDye+E5R8iVO+EQofmHigDMECWzBK6AOau+bcTAswC8UGB/U49XLjd+W1v7cu9DvNyNQT3SyFM4rNyElFlOtJDOTe0t+/8OWaYe9wgqr9nvZ/agf8z1H3p8PDS5wnCoe3AJZOE9swjLjgP/hNDz8NUhq+ksFad9Y4ZAO6ZocUBlbwc/F4g3jhY078oZTKmCjloEAyACGAECSnBBPAAADIAAAWfgECICjloEBkACGAECSnBBNoAADIAAAWfgECICjloECWACGAECSnBBPAAADIAAAWfgECICjloEDIACGAECSnBBMQAADIAAAWfgECICjloED6ACGAECSnBBPAAADIAAAWfgECICjloEEsACGAECSnBBNoAADIAAAWfgECICjloEFeACGAECSnBBPAAADIAAAWfgECICjloEGQACGAECSnBBIoAADIAAAWfgECICjloEHCACGAECSnBBPAAADIAAAWfgECICjloEH0ACGAMCSnBBIoAADIAAAWfgECICjloEImACGAECSnBBPAAADIAAAWfgECICjloEJYACGAECSnBBMQAADIAAAWfgECICjloEKKACGAECSnBBPAAADIAAAWfgECICjloEK8ACGAECSnBBNoAADIAAAWfgECICjloELuACGAECSnBBPAAADIAAAWfgECICjloEMgACGAECSnBBIoAADIAAAWfgECICjloENSACGAECSnBBPAAADIAAAWfgECICjloEOEACGAECSnBBNoAADIAAAWfgECICjloEO2ACGAECSnBBPAAADIAAAWfgECICjloEPoACGAMCSnBBIoAADIAAAWfgECICjloEQaACGAECSnBBPAAADIAAAWfgECICjloERMACGAECSnBBNoAADIAAAWfgECICjloER+ACGAECSnBBPAAADIAAAWfgECICjloESwACGAECSnBBIoAADIAAAWfgECICjloETiACGAECSnBBPAAADIAAAWfgECIAfQ7Z15OeCFFCjloEAAACGAECSnBBNoAADIAAAWfgECICjloEAyACGAECSnBBPAAADIAAAWfgECICjloEBkACGAECSnBBMQAADIAAAWfgECICjloECWACGAECSnBBPAAADIAAAWfgECIAcU7trkbuPs4EAt4r3gQHxggGk8IED";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.CHECK_OUTPUT || "/tmp/clark-webm-speed-check";
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ root, cacheDir: `${output}/vite-cache`,
  optimizeDeps: { entries: ["test/browser/taskMedia.html"] },
  server: { host: "127.0.0.1", port: 0, hmr: false } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE,
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 600 } });
page.setDefaultTimeout(15000);
const checks = [], errors = [], timings = [];
page.on("pageerror", error => errors.push(error.message));
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log("PASS", name); };
const dialog = page.locator(".task-gif-dialog[open]");
const video = () => dialog.locator("video.task-webm-player");
const speed = () => dialog.getByRole("combobox", { name: "Скорость воспроизведения WebM" });
const rate = () => video().evaluate(node => node.playbackRate);
async function loaded(name) {
  await page.waitForFunction(name => {
    const node = document.querySelector(".task-gif-dialog[open] video.task-webm-player");
    return node?.getAttribute("aria-label") === name && node.readyState >= 2 && node.videoWidth === 160;
  }, name);
}
async function open(name) {
  await page.getByRole("button", { name: `Открыть ${name}`, exact: true }).first().click();
  await loaded(name);
}
async function close() {
  await dialog.getByRole("button", { name: /^Закрыть просмотр/ }).click();
  await dialog.waitFor({ state: "hidden" });
}
try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/test/browser/taskMedia.html`);
  await page.waitForFunction(() => window.mediaReady);
  try { await access(`${root}/src/tabs/Tasks.css`); await page.addStyleTag({ url: "/src/tabs/Tasks.css?direct" }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    await mediaFixture.put("output3XX/demo/00_first.webm", bytes);
    await mediaFixture.put("output3XX/demo/01_second.webm", bytes);
    mediaFixture.refresh();
  }, WEBM_BASE64);
  await open("00_first.webm");
  assert.deepEqual(await speed().locator("option").evaluateAll(nodes => nodes.map(node => [node.value, node.textContent])),
    [["0.1", "0,1×"], ["0.3", "0,3×"], ["0.5", "0,5×"], ["1", "1×"], ["2", "2×"]]);
  check("exact five speeds in the existing header; a new clip starts at 1×",
    await speed().inputValue() === "1" && await rate() === 1 && await dialog.locator("header .task-webm-speed").count() === 1);
  await video().evaluate(node => { node.pause(); node.currentTime = 1.25; });
  const src = await video().getAttribute("src");
  for (const value of ["0.1", "0.3", "0.5", "1", "2"]) {
    await speed().selectOption(value);
    const actual = await video().evaluate(node => ({ rate: node.playbackRate, paused: node.paused, time: node.currentTime, src: node.getAttribute("src") }));
    assert.equal(actual.rate, Number(value)); assert.equal(actual.paused, true); assert.equal(actual.time, 1.25); assert.equal(actual.src, src);
  }
  check("all speeds apply without seeking, restarting a paused clip or replacing its source", true);
  for (const value of ["0.1", "0.3", "0.5", "1", "2"]) {
    await speed().selectOption(value);
    const timing = await video().evaluate(async node => {
      node.currentTime = 1;
      await node.play();
      const startTime = node.currentTime, start = performance.now();
      await new Promise(resolve => setTimeout(resolve, 500));
      const elapsed = (performance.now() - start) / 1000, delta = node.currentTime - startTime;
      node.pause(); return { rate: node.playbackRate, elapsed, delta };
    });
    timings.push(timing);
    assert.ok(timing.delta > 0 && Math.abs(timing.delta - timing.elapsed * Number(value)) < 0.1, JSON.stringify(timing));
  }
  check("real media time progresses at every selected speed, including 0.1×", true);

  await speed().selectOption("0.3");
  const position = await video().evaluate(node => node.currentTime);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => !document.querySelector('.task-gif-gallery[aria-label="GIF / WebM выбранного задания"] .task-gif-grid')?.getAttribute("aria-busy")?.includes("true"));
  await dialog.getByRole("button", { name: "Восстановить размер", exact: true }).click();
  const bounds = await dialog.boundingBox();
  await speed().click(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  assert.equal(await speed().inputValue(), "0.5");
  const after = await dialog.boundingBox();
  assert.deepEqual(after, bounds);
  await speed().selectOption("0.3");
  await dialog.getByRole("button", { name: "Максимальный размер окна", exact: true }).click();
  check("refresh and maximize preserve rate/time; the selector does not drag or navigate the window",
    await rate() === 0.3 && await video().evaluate(node => node.currentTime) === position && await video().getAttribute("src") === src);
  for (const [width, height] of [[1100, 600], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    const box = await speed().boundingBox(), title = await dialog.locator("header").boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= title.y && box.y + box.height <= title.y + title.height);
    await page.screenshot({ path: `${output}/webm-speed-${width}x${height}.png` });
  }
  check("speed fits the header at 1100×600 and 1440×900", true);

  await dialog.locator(".task-gif-navigation-button.is-next").click(); await loaded("01_second.webm");
  assert.equal(await rate(), 1); assert.equal(await speed().inputValue(), "1");
  await speed().selectOption("2");
  await dialog.locator(".task-gif-navigation-button.is-previous").click(); await loaded("00_first.webm");
  assert.equal(await rate(), 1); assert.equal(await speed().inputValue(), "1");
  await speed().selectOption("0.1");
  await dialog.getByRole("button", { name: /^Закрыть просмотр/ }).focus();
  await page.keyboard.press("ArrowRight"); await loaded("01_second.webm");
  check("next, previous and keyboard navigation always reset the next clip to 1×", await rate() === 1 && await speed().inputValue() === "1");
  await speed().selectOption("0.5"); await close(); await open("01_second.webm");
  check("closing and reopening the same clip resets it to 1×", await rate() === 1 && await speed().inputValue() === "1");
  await dialog.locator(".task-gif-navigation-button.is-next").click();
  await dialog.locator("canvas").waitFor();
  check("GIF keeps its existing controls without the WebM speed selector", await speed().count() === 0 && await dialog.getByRole("checkbox", { name: "Циклически" }).count() === 1);
  await close();
  await page.getByRole("tab", { name: /^DOCS/ }).click();
  await page.getByRole("button", { name: "Открыть 01_sketch.png", exact: true }).first().click();
  check("DOCS image preview has no speed selector", await speed().count() === 0);
  await close();

  await page.getByRole("tab", { name: /^GIF/ }).click(); await open("00_first.webm");
  await speed().selectOption("0.3");
  await page.evaluate(() => mediaFixture.pick("empty"));
  await dialog.waitFor({ state: "hidden" });
  await page.evaluate(() => mediaFixture.pick("first")); await open("00_first.webm");
  check("changing tasks resets the playback speed", await rate() === 1);
  const bytesUnchanged = await page.evaluate(async original => {
    const storage = await navigator.storage.getDirectory();
    let directory = storage;
    for (const name of ["task-media-fixture", "Sketch", "output3XX", "demo"]) directory = await directory.getDirectoryHandle(name);
    for (const name of ["00_first.webm", "01_second.webm"]) {
      const bytes = new Uint8Array(await (await (await directory.getFileHandle(name)).getFile()).arrayBuffer());
      if (btoa(String.fromCharCode(...bytes)) !== original) return false;
    }
    return true;
  }, WEBM_BASE64);
  await page.evaluate(() => mediaFixture.mount(false));
  await page.waitForFunction(() => mediaFixture.stats().liveURLs.length === 0);
  assert.deepEqual(errors, []);
  check("source files remain byte-identical and closing the component releases every Blob URL", bytesUnchanged);
  await writeFile(`${output}/results.json`, JSON.stringify({ checks, timings, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  await writeFile(`${output}/failure.json`, JSON.stringify({ checks, timings, errors, failure: error.stack }, null, 2));
  throw error;
} finally { await browser.close(); await server.close(); }
