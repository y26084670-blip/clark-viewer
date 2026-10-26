import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import h5wasm from "h5wasm/node";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(path.join(root, "__element_line_check_"));
const output = process.env.CHECK_OUTPUT || "/tmp/clark-element-line-check";
await mkdir(output, { recursive: true });
const elements = [{ id: 1, recordIndex: 0, name: "Поворот и неравномерная сетка", targ: 0, model: 0, rv: 1,
  dp: [[4], [2], [5]], symLs: 2, symAs: 2, symPs: 2, symKya: 0, symKyp: 0 },
{ id: 2, recordIndex: 1, name: "Один поперечный слой", targ: 0, model: 0, rv: 1,
  dp: [[4], [1], [5]], symLs: 1, symAs: 1, symPs: 1, symKya: 0, symKyp: 0 }];
const checks = [], errors = [], passed = message => { checks.push(message); console.log(`PASS ${checks.length}: ${message}`); };
let server, browser, page;
try {
  await h5wasm.ready;
  const file = new h5wasm.File(path.join(directory, "JE.h5"), "w"), header = file.create_group("HEADER");
  for (const [key, value] of Object.entries({ columns: 3n, arrCount: 2n, hasCoo: 1n }))
    header.create_dataset({ name: key, data: new BigInt64Array([value]), shape: [] });
  header.create_dataset({ name: "inds1", data: new BigInt64Array([1n, 321n]) });
  header.create_dataset({ name: "numbs", data: new BigInt64Array([320n, 20n]) });
  for (const step of [0, 2, 5]) {
    const rows = [];
    for (const record of elements) for (let i = 0; i < 4; i++) for (let j = 0; j < record.dp[1][0]; j++) for (let k = 0; k < 5; k++)
      for (let ls = 0; ls < record.symLs; ls++) for (let az = 0; az < record.symAs; az++) for (let ps = 0; ps < record.symPs; ps++) {
        const x = [0, .2, 1.4, 3.1][i], y = [0, 1.3][j], z = [0, .3, 1.5, 2.6, 4.2][k];
        const value = step * 1000 + i * 100 + j * 10 + k + ls * 500 + az * 50 + ps * 5;
        rows.push([20 + 3 * x - 4 * y + ls * 100, -5 + 4 * x + 3 * y + az * 100, 10 + 2 * z + ps * 100,
          value, -2 * value, 3 * value, 1, 2, 3]);
      }
    file.create_dataset({ name: String(step).padStart(6, "0"), data: new Float64Array(rows.flat()), shape: [340, 9] });
  }
  file.close();
  await writeFile(path.join(directory, "index.html"), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/scripts/test-support/elementLineBrowserFixture.jsx"></script></body></html>');
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  server = await createServer({ configFile: false, root, plugins: [solid()], server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(elements => {
    window.__lineElements = elements; window.__lineText = [];
    const draw = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
      if (/начало|Конец|График 1 · №/.test(text)) window.__lineText.push({ text, font: this.font });
      return draw.call(this, text, ...args);
    };
  }, elements);
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${path.basename(directory)}/index.html`);
  await page.waitForFunction(() => !!window.__line);
  const x = page.locator('fieldset').nth(0), y = page.locator('fieldset').nth(1);
  const add = page.getByRole("button", { name: "Добавить график", exact: true }), append = page.getByRole("button", { name: "Добавить кривую", exact: true });
  const snapshot = () => page.evaluate(() => window.__line.snapshot());
  const waitSeries = (plot, count) => page.waitForFunction(({ plot, count }) => window.__line.snapshot().plots[plot]?.series.length === count, { plot, count });
  await x.getByLabel("Величина").selectOption("element-distance");
  const direction = x.getByLabel("Направление отрезка"), element = x.getByLabel("Элемент для отрезка");
  assert.equal(await direction.inputValue(), "2");
  assert.equal(await x.getByLabel("Поперечный индекс i1").inputValue(), "2");
  assert.equal(await x.getByLabel("Поперечный индекс i2").inputValue(), "1");
  assert.equal(await y.getByText("Точка в файле результата").count(), 0);
  assert.deepEqual(await y.getByLabel("Момент времени профиля").locator("option").allTextContents(), ["№0 · t = 0 с", "№2 · t = 0.5 с", "№5 · t = 1.25 с"]);
  passed("Distance mode offers element name/number, middle transverse indices and only saved time numbers/values");

  await direction.selectOption("0");
  await x.getByLabel("Поперечный индекс i2").fill("2"); await x.getByLabel("Поперечный индекс i3").fill("4");
  assert.equal(await x.getByLabel("Поперечный индекс i3").evaluate(e => e === document.activeElement), true);
  await x.locator("summary").click();
  for (const kind of ["LS", "AS", "PS"]) await x.getByLabel(`Образ ${kind}`).fill("2");
  await y.getByLabel("Момент времени профиля").selectOption("2");
  await add.click(); await waitSeries(0, 3);
  let state = await snapshot(), plot = state.plots[0];
  assert.deepEqual(plot.series[0].map(p => p.y), [2568, 2668, 2768, 2868]);
  plot.series[0].forEach((p, i) => assert.ok(Math.abs(p.x - [0, 1, 7, 15.5][i]) < 1e-10));
  assert.equal(plot.xmin, 0); assert.ok(Math.abs(plot.xmax - 15.5) < 1e-10);
  assert.match(plot.xLabel, /Расстояние.*мм/); assert.equal(await page.evaluate(() => __line.reads.length), 1);
  const notes = await page.evaluate(() => __lineText);
  assert.ok(notes.some(n => /начало.*114.8; 98.9; 115.2/.test(n.text) && n.font.startsWith("10px")));
  assert.ok(notes.some(n => /Конец.*124.1; 111.3; 115.2/.test(n.text)));
  passed("Real HDF5 worker reads one strided slice for three signed components; rotated nonuniform distances span exactly 0…L with canvas endpoint labels");

  await y.getByRole("button", { name: "Следующий сохранённый момент" }).click();
  await append.click(); await waitSeries(0, 6);
  await page.evaluate(() => __line.setTime(0));
  state = await snapshot();
  assert.ok(state.plots[0].series[0].every(p => p.step === 2 && p.time === .5));
  assert.ok(state.plots[0].series[3].every(p => p.step === 5 && p.time === 1.25));
  assert.equal(state.plots[0].series[3][0].y, 5568); assert.equal(state.movie, false);
  assert.equal(state.plots[0].id, plot.id); assert.equal(state.plots[0].labels.length, 6);
  passed("Adding another saved moment preserves previous profiles and chart identity; global time never adds a misleading moving marker or movie");

  await page.locator(".constructor-plot canvas").click({ button: "right" });
  await page.getByRole("button", { name: "Копировать таблицу", exact: true }).click();
  const table = await page.evaluate(() => navigator.clipboard.readText());
  const tableRows = table.split("\n").slice(1).map(line => line.split("\t"));
  assert.equal(Number(tableRows[0][0]), 0); assert.ok(Math.abs(Number(tableRows.at(-1)[0]) - 15.5) < 1e-10);
  assert.equal(Number(tableRows[0][1]), 2568); assert.equal(Number(tableRows[0][7]), 5568);
  await page.locator(".chart-toolbar strong").click();
  await page.getByLabel("В протокол", { exact: true }).check();
  await page.waitForFunction(() => Object.values(__line.entries()).some(e => e?.dataUrl));
  const entry = await page.evaluate(() => Object.values(__line.entries()).find(e => e?.dataUrl));
  assert.match(entry.comment, /^№2: t=0.5 с; №5: t=1.25 с/); assert.doesNotMatch(entry.comment, /Шаг 0/);
  await writeFile(path.join(output, "profile-protocol.png"), Buffer.from(entry.dataUrl.split(",")[1], "base64"));
  passed("Copied data retain distances and all curves; the real protocol PNG contains endpoint labels and the profiles' fixed times");

  await x.getByLabel("Поперечный индекс i2").fill("0"); await append.click();
  assert.match(await page.locator(".constructor-error").first().innerText(), /Индекс i2.*1.*2/);
  assert.equal((await snapshot()).plots[0].series.length, 6);
  await x.getByRole("button", { name: "Середина", exact: true }).click();
  assert.equal(await x.getByLabel("Поперечный индекс i2").inputValue(), "1");
  assert.equal(await x.getByLabel("Поперечный индекс i3").inputValue(), "3");
  await element.selectOption("2"); await direction.selectOption("0");
  assert.equal(await x.getByLabel("Поперечный индекс i2").isDisabled(), true);
  assert.equal(await x.getByLabel("Поперечный индекс i2").inputValue(), "1");
  assert.equal(await x.getByLabel("Поперечный индекс i3").getAttribute("max"), "5");
  assert.equal(await direction.locator('option[value="1"]').evaluate(e => e.disabled), true,
    await direction.evaluate(e => e.outerHTML));
  assert.equal(await x.locator("summary").count(), 0);
  passed("Invalid indices leave existing curves intact; middle/reset, direction changes and single-layer limits remain consistent");

  await page.evaluate(() => __line.setShown(false)); await page.evaluate(() => __line.setShown(true));
  await waitSeries(0, 6);
  state = await snapshot(); plot = state.plots[0];
  assert.equal(state.movie, false); assert.equal(plot.series[0][0].y, 2568);
  const legend = await page.evaluate(() => __line.legendPoint());
  await page.mouse.click(legend.x, legend.y);
  assert.equal((await snapshot()).plots[0].visible[0], false);
  await page.mouse.click(legend.x, legend.y);
  assert.equal((await snapshot()).plots[0].visible[0], true);
  await page.getByRole("button", { name: "Развернуть", exact: true }).click();
  await page.keyboard.press("Escape");
  assert.equal((await snapshot()).plots[0].id, plot.id);
  passed("Profiles survive tab remount; the latest whole-row legend toggling and expand/collapse continue to work");

  await x.getByLabel("Величина").selectOption("element-distance");
  await page.screenshot({ path: path.join(output, "profile-controls.png"), fullPage: true });
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.screenshot({ path: path.join(output, "profile-narrow.png"), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []); await page.evaluate(() => __line.close());
  passed("Narrow layout has no page overflow or browser errors");
  await writeFile(path.join(output, "browser.json"), JSON.stringify({ checks, errors }, null, 2));
  console.log(`BROWSER_OK ${checks.length}/${checks.length}`);
} catch (error) {
  await page?.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(path.join(output, "browser.json"), JSON.stringify({ checks, errors, failure: error.stack }, null, 2));
  console.error(error); process.exitCode = 1;
} finally { await browser?.close(); await server?.close(); await rm(directory, { recursive: true, force: true }); }
