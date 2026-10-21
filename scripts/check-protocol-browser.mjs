import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import h5wasm from "h5wasm/node";
import gifenc from "gifenc";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.CHECK_OUTPUT || "/tmp/clark-protocol-check";
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "protocol-hdf5-")), results = new Map();
await h5wasm.ready;
for (const name of ["MH", "JE", "HS", "AS"]) {
  const path = join(temporary, `${name}.h5`), file = new h5wasm.File(path, "w"), header = file.create_group("HEADER");
  const source = name === "MH" || name === "JE", count = source ? 16 : 18, stride = source ? 9 : 6;
  for (const [key, value] of Object.entries({ columns: 3n, arrCount: source ? 2n : 1n, hasCoo: 1n })) {
    header.create_dataset({ name: key, data: new BigInt64Array([value]), shape: [] });
  }
  header.create_dataset({ name: "inds1", data: new BigInt64Array([1n]) });
  header.create_dataset({ name: "numbs", data: new BigInt64Array([BigInt(count)]) });
  for (let step = 0; step <= 2; step++) {
    const values = new Float64Array(count * stride);
    for (let i = 0; i < count; i++) {
      const node = source ? Math.floor(i / 2) : i % 9;
      const x = source ? Math.floor(node / 4) + .5 : Math.floor(node / 3);
      const y = source ? Math.floor(node / 2) % 2 + .5 : node % 3;
      values.set([x, y, source ? node % 2 + .5 : 3, 1 + x + step, 2 + y + step, 3 + x * y + step], i * stride);
      if (source) values.set([2 + x, 3 + y, 4 + step], i * stride + 6);
    }
    file.create_dataset({ name: String(step).padStart(6, "0"), data: values, shape: [count, stride] });
  }
  file.close(); results.set(`${name}.h5`, await readFile(path));
}
const gif = gifenc.GIFEncoder();
for (const index of [0, 1, 0]) gif.writeFrame(new Uint8Array(80 * 60).fill(index), 80, 60,
  { palette: [[30, 70, 180], [230, 160, 60]], delay: 700, repeat: -1 });
gif.finish(); results.set("preview.gif", gif.bytes());
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0 },
  optimizeDeps: { entries: ["test/browser/protocol.html"] }, cacheDir: `${output}/vite-cache`,
  plugins: [{ name: "protocol-fixtures", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const data = results.get(req.url?.replace(/^\/test-results\//, ""));
      if (!req.url?.startsWith("/test-results/") || !data) return next();
      res.setHeader("Content-Type", "application/octet-stream"); res.end(data);
    });
  } }] });
await server.listen();
let browser, page;
const checks = [], errors = [];
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  page.setDefaultTimeout(20000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/test/browser/protocol.html`);
  await page.waitForFunction(() => window.protocolReady);
  const tab = title => page.locator(".tabs-header").getByRole("button", { name: title, exact: true });
  const mark = () => page.getByRole("checkbox", { name: "В протокол", exact: true });
  const ready = () => page.waitForFunction(() => { const input = document.querySelector('input[aria-label="В протокол"]'); return input && !input.disabled; });
  const capture = async () => {
    await ready(); await mark().click();
    await page.waitForFunction(() => { const input = document.querySelector('input[aria-label="В протокол"]'); return input?.checked && !input.disabled; });
  };
  const tools = async () => { await page.locator(".viewer-tools-trigger").click(); await page.getByRole("menuitem", { name: "Создать протокол", exact: true }).click(); };
  const dialog = () => page.getByRole("dialog", { name: "Создать протокол", exact: true });
  const save = async () => { await dialog().getByRole("button", { name: "Сохранить в DOCS" }).click(); await dialog().getByText(/^Сохранено:/).waitFor(); };
  await page.getByRole("button", { name: "Выбрать каталог с проектами" }).click();
  await page.getByLabel("Список проектов", { exact: true }).selectOption("Project");
  await page.getByRole("option", { name: /Task A/ }).dblclick();
  await ready();
  await page.setViewportSize({ width: 1100, height: 600 });
  const position = await mark().locator("..").boundingBox();
  assert.ok(position.x >= 0 && position.x + position.width <= 1100, JSON.stringify(position));
  const help = await page.locator(".sources-fields-toolbar > .geometry-material-help-button").boundingBox();
  assert.ok(position.x + position.width <= help.x && help.x + help.width <= 1100, JSON.stringify({ position, help }));
  await page.screenshot({ path: `${output}/sources-1100x600.png` });
  await page.setViewportSize({ width: 1500, height: 900 });
  await capture(); checks.push("real 3D renderer captures selected sources and restores its camera");
  await tab("Рабочие точки").click();
  await page.locator(".tabulator-row").filter({ hasText: "Steel cube" }).click(); await capture();
  await tab("Поле на линиях").click(); await ready();
  await page.locator(".tabulator-row").filter({ hasText: "Plane" }).click();
  await page.getByRole("button", { name: /Локальные образы/ }).click();
  const all = page.getByRole("checkbox", { name: "Все локальные образы", exact: true });
  assert.equal(await all.isChecked(), true);
  assert.equal(await page.getByLabel("Номер локального образа LS").isDisabled(), true);
  await all.uncheck(); await page.getByLabel("Номер локального образа LS").fill("2");
  await page.getByLabel("Номер локального образа LS").press("Tab");
  await page.keyboard.press("Escape"); await capture();
  await tab("Поле в областях").click(); await capture();
  checks.push("working points, LS menu default/number and combined XYZ surface capture");
  await tab("Графики").click();
  await page.getByRole("button", { name: "Добавить график", exact: true }).click();
  await ready();
  assert.equal((await mark().locator("..").innerText()).trim(), "");
  await page.getByRole("button", { name: "Развернуть", exact: true }).click();
  assert.match(await mark().locator("..").innerText(), /В протокол/);
  await capture();
  await page.getByRole("button", { name: "Свернуть", exact: true }).click();
  checks.push("constructor checkbox has compact tooltip and expanded caption; full plot is captured");
  await tools(); await dialog().locator(".protocol-block").nth(5).waitFor();
  assert.equal(await dialog().locator(".protocol-block").count(), 6);
  await dialog().getByLabel("Комментарий: Рабочие точки M(H)", { exact: true }).fill("Проверено позднее: <М> & H");
  await save();
  let original = await page.evaluate(() => protocolFixture.document());
  assert.equal(original.blocks.length, 6);
  assert.equal(original.blocks.filter(block => block.kind === "image").length, 5);
  assert.equal(original.blocks[0].text, '{"mpiRanks":4,"machine":"fixture"}\n');
  await page.screenshot({ path: `${output}/protocol-dialog.png` });
  await dialog().getByRole("button", { name: "Закрыть", exact: true }).click();
  await tab("Поле на линиях").click(); await ready();
  await mark().click(); await capture();
  await tools(); await dialog().getByLabel("Открыть существующий протокол").selectOption("protocol.html");
  await dialog().locator(".protocol-block").nth(5).waitFor();
  await dialog().getByRole("button", { name: "Добавить отмеченные (1)", exact: true }).click();
  assert.equal(await dialog().locator(".protocol-block").count(), 7);
  await save();
  const appended = await page.evaluate(() => protocolFixture.document());
  assert.deepEqual(appended.blocks.slice(0, 6), original.blocks);
  original = appended;
  await dialog().getByRole("button", { name: "Закрыть", exact: true }).click();
  checks.push("adding a fresh snapshot to an existing protocol preserves all previous blocks and comments without duplicates");
  await tab("Выбор задания").click(); await page.getByRole("option", { name: /Task B/ }).dblclick(); await ready();
  assert.equal(await mark().isChecked(), false);
  for (const title of ["Рабочие точки", "Поле на линиях", "Поле в областях"]) { await tab(title).click(); await mark().waitFor(); assert.equal(await mark().isChecked(), false); }
  checks.push("all selections reset on a successful load of another task");
  await page.evaluate(() => protocolFixture.removeResults()); await page.reload(); await page.waitForFunction(() => window.protocolReady);
  await page.getByRole("button", { name: "Выбрать каталог с проектами" }).click();
  await page.getByLabel("Список проектов", { exact: true }).selectOption("Project");
  await page.getByRole("option", { name: /Task A/ }).dblclick();
  await tools(); await dialog().getByLabel("Открыть существующий протокол").selectOption("protocol.html");
  await dialog().locator(".protocol-block").nth(6).waitFor();
  assert.equal(await dialog().getByLabel("Комментарий: Рабочие точки M(H)").inputValue(), "Проверено позднее: <М> & H");
  const deletedId = await dialog().locator(".protocol-block").nth(1).getAttribute("data-block-id");
  await dialog().locator(".protocol-block").nth(1).getByRole("button", { name: "Удалить блок" }).click();
  await dialog().getByLabel("Комментарий: Рабочие точки M(H)").fill("Редакция без результатов расчёта");
  await save();
  const amended = await page.evaluate(() => protocolFixture.document());
  assert.equal(amended.id, original.id); assert.equal(amended.createdAt, original.createdAt);
  assert.deepEqual(amended.blocks.map(block => block.id), original.blocks.map(block => block.id).filter(id => id !== deletedId));
  assert.equal(amended.blocks[1].dataUrl, original.blocks[2].dataUrl);
  checks.push("reload and missing HDF5 do not prevent opening an old protocol, removing a block or editing a comment");
  const html = await page.evaluate(() => protocolFixture.file());
  await writeFile(`${output}/protocol.html`, html);
  const offline = await browser.newContext({ javaScriptEnabled: false, offline: true });
  const view = await offline.newPage(); await view.setContent(html, { waitUntil: "load" });
  assert.equal(await view.locator("img").count(), 5);
  assert.equal(await view.locator("img").evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), true);
  await view.screenshot({ path: `${output}/standalone.png`, fullPage: true }); await offline.close();
  checks.push("saved HTML renders all remaining images offline with JavaScript disabled");
  assert.deepEqual(errors, []);
  await writeFile(`${output}/result.json`, JSON.stringify({ checks, errors }, null, 2));
  console.log(`PASS ${checks.length} scenarios: ${output}/result.json`);
} catch (failure) {
  await page?.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {});
  await writeFile(`${output}/failure.json`, JSON.stringify({ checks, errors, failure: failure.stack, body: await page?.locator("body").innerText().catch(() => "") }, null, 2));
  throw failure;
} finally { await browser?.close(); await server.close(); await rm(temporary, { recursive: true, force: true }); }
