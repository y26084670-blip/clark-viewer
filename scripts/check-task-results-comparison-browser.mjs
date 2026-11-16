// Integrated Viewer menu/dialog check with real H5 files in an isolated OPFS.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import h5wasm from "h5wasm/node";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "clark-comparison-browser-"));
await h5wasm.ready;
const assets = new Map();
async function h5(task, name, columns, arrCount, hasCoo, rows) {
  const path = join(temporary, `${task}-${name}`), file = new h5wasm.File(path, "w");
  try {
    const header = file.create_group("HEADER");
    for (const [key, value] of Object.entries({ columns, arrCount, hasCoo })) header.create_dataset({ name: key, data: BigInt64Array.of(BigInt(value)), shape: [] });
    for (const step of [0, 2]) file.create_dataset({ name: String(step).padStart(6, "0"), data: new Float64Array(rows.flat()), shape: [rows.length, 3 * hasCoo + columns * arrCount] });
  } finally { file.close(); }
  assets.set(`/__comparison-data/${task}/${name}`, await readFile(path));
}
for (const task of [1, 2]) {
  await h5(task, "JE.h5", 3, 2, 1, [task === 1 ? [0, 0, 0, 1, 2, 2, 10, 10, 10] : [999, 999, 999, 2, 4, 4, 15, 15, 15]]);
  await h5(task, "HS.h5", 3, 1, 1, [[0, 0, 0, task === 1 ? 0 : 1, 0, 0]]);
  await h5(task, "MH.h5", 3, 2, 1, Array.from({ length: task }, () => [0, 0, 0, 0, 0, 0, 0, 0, 0]));
  await h5(task, "Q.h5", 1, 1, 1, [[0, 0, 0, 0]]);
  assets.set(`/__comparison-data/${task}/bad.h5`, Buffer.from("not HDF5"));
}
await h5(1, "PSI.h5", 1, 1, 0, [[1]]);
const html = '<html><body><div id="root"></div><script type="module" src="/test/browser/taskResultsComparison.fixture.jsx"></script></body></html>';
const server = await createServer({ root, base: "/clark-viewer/", cacheDir: join(temporary, "vite-cache"),
  server: { host: "127.0.0.1", port: Number(process.env.COMPARISON_PORT || 0), strictPort: false },
  plugins: [{ name: "comparison-browser-fixture", configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const path = request.url?.split("?")[0];
      if (assets.has(path)) { response.setHeader("Content-Type", "application/octet-stream"); response.end(assets.get(path)); return; }
      if (!path?.endsWith("/__comparison-fixture")) return next();
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(await server.transformIndexHtml(request.url, html));
    });
  } }],
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
if (process.argv.includes("--serve-only")) {
  console.log(`Comparison fixture: ${origin}/clark-viewer/__comparison-fixture`);
  await new Promise(() => {});
}
let browser, page;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || undefined, headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1050 }, permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
  const errors = [];
  page.setDefaultTimeout(20000); page.on("pageerror", error => { errors.push(error.message); console.error("Page error:", error.message); });
  page.on("console", message => { if (message.type() === "error") console.error("Browser:", message.text()); });
  page.on("response", response => { if (response.status() >= 400) console.error("HTTP", response.status(), response.url()); });
  await page.goto(`${origin}/clark-viewer/__comparison-fixture`);
  await page.waitForFunction(() => window.comparisonFixture?.ready);
  const access = page.locator(".task-disk-dialog");
  await access.getByRole("button", { name: "Выбрать диск с проектами", exact: true }).click();
  await access.getByRole("button", { name: "Продолжить", exact: true }).click();
  await page.locator("#listProject").selectOption("Project2");
  await page.getByRole("listbox",{name:"Список заданий",exact:true}).locator(".task-status-label").filter({ hasText: /^A$/ }).click();
  const tools = page.getByRole("button", { name: "Инструменты", exact: true });
  await tools.click();
  const menu = page.getByRole("menu", { name: "Инструменты", exact: true });
  assert.equal(await menu.getByRole("menuitem").last().textContent(), "Сравнить результаты");
  await menu.getByRole("menuitem", { name: "Сравнить результаты", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Сравнить результаты", exact: true });
  await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector('select[aria-label="Задание 1"]')?.value === "Project2/A");
  assert.equal(await dialog.getByRole("combobox", { name: "Задание 1", exact: true }).inputValue(),"Project2/A");
  await dialog.getByRole("combobox", { name: "Задание 2", exact: true }).selectOption("Project10/B");
  const report = dialog.getByRole("textbox", { name: "Результаты сравнения", exact: true });
  await page.waitForFunction(() => document.querySelector('[aria-label="Результаты сравнения"]')?.value.includes("Итоговое время"));
  const text = await report.inputValue();
  assert.match(text, /JE.h5 — J: 1.000000e\+0; E: 5.000000e-1/);
  assert.match(text, /HS.h5 — B: ∞ \(норма задания 1 равна 0\)/);
  assert.match(text, /Относительная невязка по норме задания 1; безразмерная/);
  assert.doesNotMatch(text, /А\/мм²|В\/м|Абсолютная СКН|нет данных/);
  assert.match(text, /MH.h5 — число записей различается: 2 \/ 4/);
  assert.match(text, /PSI.h5 — есть только в задании 1/);
  assert.match(text, /bad.h5 — ошибка:/); assert.match(text, /Q.h5 — Q: 0\n/);
  assert.match(text, /Полное:\t1\t2\nМатрицы:\t1.1\t2.1\nИсточники:\t1.2\t2.2\nПоле:\t1.3\t2.3/);
  async function checkHeight() {
    const layout = await dialog.evaluate(element => {
      const box = element.getBoundingClientRect(), report = element.querySelector("textarea");
      const close = element.querySelector("button").getBoundingClientRect();
      return { height: box.height, viewport: innerHeight, outerScroll: element.scrollHeight > element.clientHeight + 1,
        reportScroll: report.scrollHeight > report.clientHeight + 1, closeBottom: close.bottom };
    });
    assert.ok(Math.abs(layout.height - (layout.viewport - 24)) <= 1, JSON.stringify(layout));
    assert.equal(layout.outerScroll, false); assert.equal(layout.reportScroll, false);
    assert.ok(layout.closeBottom < layout.viewport);
  }
  await checkHeight();
  await page.setViewportSize({ width: 1500, height: 720 }); await checkHeight();
  await page.setViewportSize({ width: 1500, height: 1050 });
  await report.focus(); await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.press("ControlOrMeta+C");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text);
  await report.press("ArrowLeft");
  const out = process.env.CHECK_OUTPUT || "/tmp/clark-task-results-comparison";
  await mkdir(out, { recursive: true }); await page.screenshot({ path: join(out, "comparison.png") });
  await dialog.getByRole("combobox", { name: "Задание 1", exact: true }).selectOption("Project10/B");
  await dialog.getByRole("combobox", { name: "Задание 2", exact: true }).selectOption("Project2/A");
  await page.waitForFunction(() => document.querySelector('[aria-label="Результаты сравнения"]')?.value.includes("JE.h5 — J: 5.000000e-1; E: 3.333333e-1"));
  assert.match(await report.inputValue(), /Полное:\t2\t1\nМатрицы:\t2.1\t1.1\nИсточники:\t2.2\t1.2\nПоле:\t2.3\t1.3/);
  await dialog.getByRole("combobox", { name: "Задание 1", exact: true }).selectOption("Project2/A");
  await page.waitForFunction(() => document.querySelector('[aria-label="Результаты сравнения"]')?.value.includes("JE.h5 — J: 0; E: 0"));
  await dialog.getByRole("combobox", { name: "Задание 2", exact: true }).selectOption("Project10/B");
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await tools.waitFor({state:"visible"});
  assert.equal(await tools.evaluate(element=>element===document.activeElement),true);
  await page.getByRole("button",{name:"Графики",exact:true}).click();
  await tools.press("ArrowDown");
  await menu.waitFor();
  await menu.press("End");
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent),"Сравнить результаты");
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({state:"hidden"});
  assert.equal(await tools.evaluate(element=>element===document.activeElement),true);
  assert.deepEqual(errors, []);
  console.log("PASS: maximum height at 1050/720 px, relative norms against task 1, swapped/zero references, both timing formats, real H5, ordinary copy and cancellation");
} catch (error) {
  if (page) {
    console.error("Visible page:", (await page.locator("body").innerText()).slice(0, 9000));
    const out = process.env.CHECK_OUTPUT || "/tmp/clark-task-results-comparison";
    await mkdir(out, { recursive: true });
    await page.screenshot({ path: join(out, "failure.png") });
  }
  throw error;
} finally { await browser?.close(); await server.close(); await rm(temporary, { recursive: true, force: true }); }
