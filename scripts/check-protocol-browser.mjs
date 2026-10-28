import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import h5wasm from "h5wasm/node";
import { execFileSync } from "node:child_process";
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
const clip = join(temporary, "original.webm");
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=4", "-frames:v", "8",
  "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-an", "-y", clip]);
results.set("original.webm", await readFile(clip));
results.set("preview.gif", Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
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
  page.on("console", message => { if (message.text().includes("will never be disposed")) errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/test/browser/protocol.html`);
  await page.waitForFunction(() => window.protocolReady);
  const passed = text => { checks.push(text); console.log(`PASS ${checks.length}: ${text}`); };
  const tab = title => page.locator(".tabs-header").getByRole("button", { name: title, exact: true });
  const mark = () => page.getByRole("checkbox", { name: "В протокол", exact: true });
  const ready = () => page.waitForFunction(() => { const input = document.querySelector('input[aria-label="В протокол"]'); return input && !input.disabled; });
  const capture = async () => {
    await ready(); if (await mark().isChecked()) await mark().uncheck(); await mark().check();
    await page.waitForFunction(() => { const input = document.querySelector('input[aria-label="В протокол"]'); return input?.checked && !input.disabled; });
  };
  const dialog = () => page.locator(".protocol-dialog[open]");
  const opened = async () => { await dialog().waitFor(); await page.waitForFunction(() => document.querySelector('.protocol-dialog[open]')?.getAttribute('aria-busy') === 'false'); };
  const tools = async () => { await page.locator(".viewer-tools-trigger").click(); await page.getByRole("menuitem", { name: "Протокол", exact: true }).click(); await opened(); };
  const close = () => dialog().getByRole("button", { name: "Закрыть", exact: true }).click();
  const save = async () => { await dialog().getByRole("button", { name: "Сохранить в DOCS", exact: true }).click(); await dialog().getByText(/^Сохранено:/).waitFor(); };
  const imageBlocks = () => dialog().locator('.protocol-block').filter({ has: page.locator('img'), hasNot: page.locator('.protocol-scene-preview') });
  const imageComment = () => imageBlocks().first().getByRole('textbox');
  const removeFile = async accept => {
    page.once('dialog', async prompt => {
      assert.match(prompt.message(), /DOCS\/protocol.html/); assert.match(prompt.message(), /Task A/);
      if (accept) await prompt.accept(); else await prompt.dismiss();
    });
    await dialog().getByRole('button', { name: 'Удалить файл протокола', exact: true }).click();
  };
  const loadTask = async name => {
    await tab("Выбор задания").click(); await page.getByRole("option", { name: new RegExp(name) }).dblclick(); await page.waitForFunction(value => document.querySelector(".task-path")?.textContent.endsWith(value), name);
    await page.waitForFunction(() => document.querySelector('.tabs-header button[aria-current="page"]')?.textContent === 'Источники / Поле 3D');
  };
  await page.getByRole("button", { name: "Выбрать диск с проектами" }).click();
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await page.getByLabel("Список проектов", { exact: true }).selectOption("Project");
  await loadTask("Task A"); await capture();
  const permissionsBefore = await page.evaluate(() => protocolFixture.permissionCalls.length);
  await tools();
  await dialog().getByRole('heading', { name: 'Создать протокол', exact: true }).waitFor();
  assert.equal(await dialog().locator('.protocol-block').count(), 6);
  assert.equal(await dialog().locator('video').count(), 1);
  await page.waitForFunction(() => document.querySelector('.protocol-block video')?.videoWidth === 96);
  const snapshotId = await imageBlocks().first().getAttribute('data-block-id');
  await imageComment().fill('Черновик до первого сохранения');
  const firstInput = await imageComment().getAttribute('aria-label');
  await close(); assert.equal(await page.evaluate(() => protocolFixture.exists()), false);
  await tools();
  assert.equal(await dialog().getByLabel(firstInput, { exact: true }).inputValue(), 'Черновик до первого сохранения');
  assert.equal(await imageBlocks().first().getAttribute('data-block-id'), snapshotId);
  assert.equal(await dialog().locator('.protocol-block').count(), 6);
  assert.equal(await page.evaluate(() => protocolFixture.permissionCalls.length), permissionsBefore);
  await save();
  let original = await page.evaluate(() => protocolFixture.document());
  assert.equal(original.blocks[3].comment, 'Черновик до первого сохранения');
  assert.deepEqual(original.blocks.map(b => b.source ?? b.kind), ['scene', 'summary', 'summary', 'image', 'docs', 'video']);
  passed('new protocol includes geometry, summaries, marked snapshot, DOCS and playable WebM; closing without Save retains comments');

  await imageComment().fill('Несохранённая правка существующего протокола');
  await close(); await tab('Рабочие точки').click(); await tab('Источники / Поле 3D').click(); await ready();
  await page.evaluate(() => protocolFixture.mutateSources());
  await capture(); await tools();
  await dialog().getByRole('heading', { name: 'Редактировать протокол', exact: true }).waitFor();
  assert.equal(await dialog().locator('.protocol-block').count(), 7);
  assert.equal(await imageComment().inputValue(), 'Несохранённая правка существующего протокола');
  assert.equal(await dialog().getByText('New automatic document must not be added', { exact: true }).count(), 0);
  assert.equal(await dialog().getByText('New input summary must not replace the saved one', { exact: true }).count(), 0);
  assert.deepEqual(await page.evaluate(() => protocolFixture.document()), original, 'opening never writes the saved file');
  await save();
  const updated = await page.evaluate(() => protocolFixture.document());
  assert.equal(updated.id, original.id); assert.equal(updated.createdAt, original.createdAt);
  assert.deepEqual(updated.blocks.slice(0, 3), original.blocks.slice(0, 3));
  assert.deepEqual(updated.blocks.slice(-2), original.blocks.slice(-2));
  assert.deepEqual(updated.blocks.map(b => b.source ?? b.kind), ['scene', 'summary', 'summary', 'image', 'image', 'docs', 'video']);
  original = updated;
  await close(); await tools(); assert.equal(await dialog().locator('.protocol-block').count(), 7);
  passed('existing HTML supplies all automatic blocks; only newly checked snapshots are inserted between summaries and animations without duplicates');

  await imageComment().fill('Комментарий остаётся при перечитывании');
  await page.evaluate(() => protocolFixture.external());
  await dialog().getByRole('button', { name: 'Сохранить в DOCS', exact: true }).click();
  await dialog().getByRole('alert').filter({ hasText: 'изменён' }).waitFor();
  await dialog().getByRole('button', { name: 'Перечитать', exact: true }).click(); await opened();
  assert.equal(await imageComment().inputValue(), 'Комментарий остаётся при перечитывании');
  await save();
  passed('external file changes block Save; explicit refresh preserves unsaved comments and allows subsequent Save');

  await imageComment().fill('Несохранённый комментарий при повторной загрузке задания');
  await close(); await loadTask('Task A'); await tools();
  assert.equal(await imageComment().inputValue(), 'Несохранённый комментарий при повторной загрузке задания');
  passed('reloading the same task directory preserves unsaved comments even when FileSystemHandle objects differ');

  const beforeCancel = await page.evaluate(() => protocolFixture.file());
  await removeFile(false);
  assert.equal(await page.evaluate(() => protocolFixture.file()), beforeCancel);
  await page.evaluate(() => protocolFixture.permission('denied')); await removeFile(true);
  await dialog().getByRole('alert').filter({ hasText: 'Разрешите' }).waitFor();
  assert.equal(await page.evaluate(() => protocolFixture.file()), beforeCancel);
  await page.evaluate(() => protocolFixture.permission('granted'));
  await page.evaluate(() => protocolFixture.external()); await removeFile(true);
  await dialog().getByRole('alert').filter({ hasText: 'изменён' }).waitFor();
  assert.equal(await page.evaluate(() => protocolFixture.exists()), true);
  passed('deletion confirmation names the exact file and task; cancellation, denied permission and changed files preserve the HTML');

  await dialog().getByRole('button', { name: 'Перечитать', exact: true }).click(); await opened();
  await imageComment().fill('Черновик после удаления файла');
  const inventory = await page.evaluate(() => protocolFixture.inventory());
  await removeFile(true); await dialog().getByText(/^Удалён файл/).waitFor();
  assert.equal(await page.evaluate(() => protocolFixture.exists()), false);
  assert.deepEqual(await page.evaluate(() => protocolFixture.inventory()), inventory.filter(([name]) => name !== '/DOCS/protocol.html'));
  assert.equal(await imageComment().inputValue(), 'Черновик после удаления файла');
  assert.equal(await dialog().getByRole('button', { name: 'Удалить файл протокола' }).count(), 0);
  await close();
  await tab('Выбор задания').click(); await page.getByRole('tab', { name: /^DOCS/ }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('select[aria-label="Документ DOCS"] option')].some(o => o.value === 'protocol.html'));
  await tab('Источники / Поле 3D').click(); await tools();
  await dialog().getByRole('heading', { name: 'Создать протокол', exact: true }).waitFor();
  assert.equal(await imageComment().inputValue(), 'Черновик после удаления файла');
  assert.equal(await dialog().locator('.protocol-block').count(), 7);
  await save();
  assert.equal((await page.evaluate(() => protocolFixture.document())).blocks[3].comment, 'Черновик после удаления файла');
  passed('only the selected HTML is deleted, DOCS refreshes, and the retained draft can recreate it without rereading source animations');

  await dialog().getByLabel('Имя файла протокола', { exact: true }).fill('second.html');
  assert.equal(await dialog().getByRole('button', { name: 'Удалить файл протокола' }).isDisabled(), true);
  await save();
  await imageComment().fill('Отдельный комментарий второго файла'); await save();
  await dialog().getByLabel('Открыть существующий протокол', { exact: true }).selectOption('protocol.html'); await opened();
  assert.equal(await imageComment().inputValue(), 'Черновик после удаления файла');
  assert.equal(await dialog().getByLabel('Имя файла протокола', { exact: true }).inputValue(), 'protocol.html');
  await dialog().getByLabel('Открыть существующий протокол', { exact: true }).selectOption('second.html'); await opened();
  assert.equal(await imageComment().inputValue(), 'Отдельный комментарий второго файла');
  await dialog().getByLabel('Открыть существующий протокол', { exact: true }).selectOption('protocol.html'); await opened();
  passed('multiple protocol files are selectable and keep independent comment drafts; editing a Save-As name disables deletion of a different file');

  await page.setViewportSize({ width: 1100, height: 600 });
  await page.screenshot({ path: `${output}/protocol-edit-1100.png` });
  await page.setViewportSize({ width: 1500, height: 900 });
  await close(); await loadTask('Task B');
  assert.equal(await mark().isChecked(), false); await tools();
  await dialog().getByRole('heading', { name: 'Создать протокол', exact: true }).waitFor();
  assert.equal(await imageBlocks().count(), 0);
  assert.ok((await dialog().locator('textarea').evaluateAll(nodes => nodes.map(n => n.value))).every(v => v === ''));
  assert.match(await dialog().getByText(/^Задание в протоколе:/).innerText(), /Task B/);
  await close(); await loadTask('Task A'); await tools();
  await dialog().getByRole('heading', { name: 'Редактировать протокол', exact: true }).waitFor();
  assert.equal(await imageComment().inputValue(), 'Черновик после удаления файла');
  assert.equal(await dialog().locator('.protocol-block').count(), 7);
  passed('switching tasks starts a separate draft and selection; returning to Task A reads its own saved protocol');

  await close(); await page.evaluate(() => protocolFixture.removeResults());
  await page.reload(); await page.waitForFunction(() => window.protocolReady);
  await page.getByRole('button', { name: 'Выбрать диск с проектами' }).click();
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await page.getByLabel('Список проектов', { exact: true }).selectOption('Project');
  await loadTask('Task A'); await tools();
  await dialog().getByRole('heading', { name: 'Редактировать протокол', exact: true }).waitFor();
  assert.equal(await imageComment().inputValue(), 'Черновик после удаления файла');
  assert.equal(await dialog().locator('.protocol-block').count(), 7);
  passed('existing protocol opens after a browser reload without HDF5 result files and despite a corrupt new source video');

  const html = await page.evaluate(() => protocolFixture.file());
  await writeFile(`${output}/protocol.html`, html);
  const offline = await browser.newContext({ javaScriptEnabled: false, offline: true });
  const view = await offline.newPage(); await view.setContent(html, { waitUntil: 'load' });
  assert.equal(await view.locator('img').count(), 3);
  assert.equal(await view.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), true);
  await view.waitForFunction(() => document.querySelector('video')?.videoWidth === 96);
  await view.screenshot({ path: `${output}/standalone.png`, fullPage: true }); await offline.close();
  passed('the edited standalone HTML retains its geometry poster, both snapshots and playable embedded animation offline');
  assert.deepEqual(errors, []);
  await writeFile(`${output}/result.json`, JSON.stringify({ checks, errors }, null, 2));
  console.log(`PASS ${checks.length} scenarios: ${output}/result.json`);
} catch (failure) {
  await page?.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {});
  await writeFile(`${output}/failure.json`, JSON.stringify({ checks, errors, failure: failure.stack, body: await page?.locator("body").innerText().catch(() => "") }, null, 2));
  throw failure;
} finally { await browser?.close(); await server.close(); await rm(temporary, { recursive: true, force: true }); }
