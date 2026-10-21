import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.CHECK_OUTPUT || "/tmp/clark-task-media-check";
await mkdir(output, { recursive: true });
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false },
  optimizeDeps: { entries: ["test/browser/taskMedia.html"] }, cacheDir: `${output}/vite-cache` });
await server.listen();
let browser;
const checks = [], errors = [], forbiddenRequests = [];
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 600 } });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().includes("/forbidden-")) forbiddenRequests.push(request.url()); });
  page.setDefaultTimeout(10_000);
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/test/browser/taskMedia.html`);
  await page.waitForFunction(() => window.mediaReady);
  try {
    await access(`${root}/src/tabs/Tasks.css`);
    await page.addStyleTag({ url: "/src/tabs/Tasks.css?direct" });
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const gifTab = () => page.getByRole("tab", { name: /^GIF/ });
  const docsTab = () => page.getByRole("tab", { name: /^DOCS/ });
  const waitText = value => page.waitForFunction(value => document.querySelector('[aria-label="Содержимое документа DOCS"]').value.includes(value), value);
  await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]').textContent === "GIF (2)");
  await page.waitForFunction(() => [...document.querySelectorAll('[role="tab"]')].some(tab => tab.textContent === "DOCS (24)"));
  assert.equal(await page.evaluate(() => mediaFixture.stats().reads.some(name => /\.(png|jpeg|webp|txt|md|html?)$/i.test(name))), false);
  assert.equal(await page.evaluate(() => mediaFixture.stats().permission.length), 0);
  checks.push("hidden DOCS counts 19 images and 5 documents without reading bytes or requesting write permission");

  await docsTab().click(); await waitText("Строка 1:");
  await page.waitForFunction(() => [...document.querySelectorAll('[role="tabpanel"]:not([hidden]) .task-gif-thumbnail img')].length >= 2);
  assert.equal(await page.getByLabel("Документ DOCS").inputValue(), "README.txt");
  const initialReads = await page.evaluate(() => mediaFixture.stats().reads.filter(name => name.endsWith(".png")).length);
  assert.ok(initialReads < 19, "offscreen thumbnails must be lazy");
  await page.getByLabel("Содержимое документа DOCS", { exact: true }).evaluate(node => { node.scrollTop = 400; node.scrollLeft = 120; });
  const scroll = await page.getByLabel("Содержимое документа DOCS", { exact: true }).evaluate(node => [node.scrollTop, node.scrollLeft]);
  await page.locator('[role="tabpanel"]:not([hidden]) .task-gif-thumbnail').first().click();
  const dialog = page.locator(".task-gif-dialog[open]");
  await page.waitForFunction(() => document.querySelector(".task-gif-dialog[open] img")?.naturalWidth > 0);
  assert.ok(await dialog.evaluate(node => node.classList.contains("is-maximized")));
  assert.equal(await dialog.getByRole("button", { name: "Предыдущее изображение" }).isDisabled(), true);
  await dialog.getByRole("button", { name: "Следующее изображение" }).click();
  await page.waitForFunction(() => document.querySelector(".task-gif-dialog[open] h2").textContent === "02_model.jpeg");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector(".task-gif-dialog[open] h2").textContent === "03_sections.webp");
  await page.waitForFunction(() => document.querySelector(".task-gif-dialog[open] img")?.naturalWidth === 360);
  await dialog.getByRole("button", { name: "Восстановить размер" }).click();
  const beforeDrag = await dialog.boundingBox();
  const header = await dialog.locator("header").boundingBox();
  await page.mouse.move(header.x + 60, header.y + 12); await page.mouse.down(); await page.mouse.move(1099, 599); await page.mouse.up();
  const afterDrag = await dialog.boundingBox();
  assert.ok(afterDrag.x >= 0 && afterDrag.y >= 0 && afterDrag.x + afterDrag.width <= 1101 && afterDrag.y + afterDrag.height <= 601);
  assert.notEqual(afterDrag.x, beforeDrag.x);
  await dialog.getByRole("button", { name: "Максимальный размер окна" }).click();
  await dialog.getByRole("button", { name: "Восстановить размер" }).click();
  assert.ok(Math.abs((await dialog.boundingBox()).width - afterDrag.width) <= 1);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  assert.ok(await page.locator('[role="tabpanel"]:not([hidden]) .task-gif-thumbnail').first().evaluate(node => node === document.activeElement));
  assert.deepEqual(await page.getByLabel("Содержимое документа DOCS", { exact: true }).evaluate(node => [node.scrollTop, node.scrollLeft]), scroll);
  checks.push("PNG/JPEG/WebP, maximized preview, arrows, restore/drag, Escape/focus and independent README scroll");

  await page.getByLabel("Документ DOCS").selectOption("README.md"); await waitText("<script>");
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.getByRole("button", { name: "Развернуть документ" }).click();
  assert.ok((await dialog.getByLabel("Полный текст документа DOCS").inputValue()).startsWith("# Исходный Markdown"));
  assert.ok(await dialog.evaluate(node => node.classList.contains("is-maximized")));
  await page.keyboard.press("Escape");
  checks.push("Markdown remains literal text; text expands using the same window");

  await page.getByLabel("Документ DOCS", { exact: true }).selectOption("protocol.html");
  const inlineHtml = () => page.frameLocator('iframe[title="HTML-документ DOCS"]');
  await inlineHtml().getByRole("heading", { name: "Снимок поля", exact: true }).waitFor();
  assert.equal(await inlineHtml().locator("img").evaluate(img => img.complete && img.naturalWidth === 360), true);
  assert.equal(await inlineHtml().locator("table tbody td").count(), 2);
  await page.getByRole("button", { name: "Открыть протокол для редактирования", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => mediaFixture.stats().edits), [{ task: "Sketch", name: "protocol.html" }]);
  assert.equal(await page.locator("dialog[open]").count(), 0);
  await page.screenshot({ path: `${output}/docs-protocol-1100x600.png` });
  await page.getByLabel("Документ DOCS", { exact: true }).selectOption("legacy.HTM");
  await inlineHtml().getByRole("heading", { name: "Обычный HTML" }).waitFor();
  assert.equal(await inlineHtml().locator("h1").evaluate(node => getComputedStyle(node).color), "rgb(1, 2, 3)");
  assert.equal(await inlineHtml().locator("a").getAttribute("href"), null);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.getByRole("button", { name: "Развернуть документ", exact: true }).click();
  await page.frameLocator('iframe[title="Полный HTML-документ DOCS"]').getByRole("heading", { name: "Обычный HTML" }).waitFor();
  await dialog.getByRole("button", { name: "Закрыть просмотр документа" }).click();
  assert.deepEqual(forbiddenRequests, []);
  await gifTab().click();
  assert.equal(await page.locator("iframe").count(), 0);
  await docsTab().click(); await inlineHtml().getByRole("heading", { name: "Обычный HTML" }).waitFor();
  await page.getByLabel("Документ DOCS", { exact: true }).selectOption("README.txt"); await waitText("Строка 1:");
  checks.push("HTML image/table preview; protocols route directly to editing; other HTML expands without scripts, navigation or remote requests");


  await page.locator('[role="tabpanel"]:not([hidden]) .task-gif-grid').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.getByRole("button", { name: "Открыть 19_broken.png", exact: true }).first().click();
  await dialog.getByRole("alert").waitFor();
  assert.match(await dialog.innerText(), /не соответствует/); await page.keyboard.press("Escape");
  checks.push("corrupt image reports its own error without hiding the gallery");

  await page.evaluate(() => mediaFixture.pick("second")); await waitText("Только текст");
  assert.equal(await docsTab().innerText(), "DOCS (1)");
  assert.equal(await page.getByLabel("Документ DOCS").inputValue(), "README.md");
  await page.evaluate(() => mediaFixture.pick("htmlOnly"));
  await inlineHtml().getByRole("heading", { name: "Снимок поля", exact: true }).waitFor();
  assert.equal(await docsTab().innerText(), "DOCS (1)");
  await page.getByRole("button", { name: "Открыть протокол для редактирования", exact: true }).click();
  assert.deepEqual((await page.evaluate(() => mediaFixture.stats().edits)).at(-1), { task: "HtmlOnly", name: "protocol.html" });
  await page.evaluate(() => mediaFixture.pick("empty"));
  await page.getByText("В DOCS нет документов TXT/MD/HTML", { exact: true }).waitFor();
  await page.evaluate(() => mediaFixture.pick("restricted"));
  await page.locator('[role="tabpanel"]:not([hidden])').getByText("Нет доступа", { exact: true }).first().waitFor();
  checks.push("text-only and absent DOCS, changed task, and access-denied states");

  await page.evaluate(() => mediaFixture.pick("first")); await waitText("Строка 1:");
  await page.evaluate(() => mediaFixture.put("DOCS/README.txt", "Обновлённый README"));
  await page.getByRole("button", { name: "Обновить список DOCS" }).click(); await waitText("Обновлённый README");
  await page.evaluate(() => mediaFixture.put("DOCS/README.txt", "Повторный выбор"));
  await page.evaluate(() => mediaFixture.refresh()); await waitText("Повторный выбор");
  await page.evaluate(() => mediaFixture.put("DOCS/README.txt", "Возврат фокуса"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await waitText("Возврат фокуса");
  checks.push("manual refresh, reselection and window focus reload the document");

  await gifTab().click();
  await page.locator('[role="tabpanel"]:not([hidden]) .task-gif-thumbnail').first().click();
  await dialog.locator("canvas").waitFor({ state: "visible" });
  await page.keyboard.press("Space");
  await dialog.getByRole("button", { name: "Запустить GIF", exact: true }).waitFor();
  assert.equal(await dialog.isVisible(), true);
  await page.keyboard.down("Space"); await page.keyboard.down("Space"); await page.keyboard.up("Space");
  await dialog.getByRole("button", { name: "Остановить GIF", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Запустить GIF", exact: true }).waitFor();
  await dialog.getByRole("checkbox", { name: "Циклически" }).check();
  await dialog.getByRole("button", { name: "Остановить GIF", exact: true }).waitFor();
  await dialog.getByRole("checkbox", { name: "Циклически" }).uncheck();
  await dialog.getByRole("button", { name: "Остановить GIF", exact: true }).waitFor();
  checks.push("Space toggles playback once, does not close the dialog, and enabling loop restarts a finished GIF");
  await dialog.locator("header button").last().focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector(".task-gif-dialog[open] h2").textContent === "two.gif");
  assert.equal(await dialog.getByRole("button", { name: "Следующий GIF" }).isDisabled(), true);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Удалить one.gif", exact: true }).click();
  const confirm = page.locator(".task-gif-confirm[open]");
  assert.ok(await confirm.getByRole("button", { name: "Отмена", exact: true }).evaluate(node => node === document.activeElement));
  await confirm.getByRole("button", { name: "Отмена", exact: true }).click();
  assert.equal(await page.evaluate(() => mediaFixture.stats().permission.length), 0);
  await page.getByRole("button", { name: "Удалить one.gif", exact: true }).click();
  await confirm.getByRole("button", { name: "Удалить", exact: true }).click();
  await page.waitForFunction(() => !mediaFixture.stats().busy.at(-1));
  await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]').textContent === "GIF (1)");
  assert.equal(await page.evaluate(() => mediaFixture.exists("one.gif")), false);
  assert.deepEqual(await page.evaluate(() => mediaFixture.stats().busy), [true, false]);
  assert.deepEqual(await page.evaluate(() => mediaFixture.stats().permission), [{ mode: "readwrite" }]);
  checks.push("GIF playback/navigation, explicit deletion confirmation, permission call and busy release");

  await gifTab().focus(); await page.keyboard.press("ArrowRight");
  assert.equal(await docsTab().getAttribute("aria-selected"), "true");
  for (const [width, height] of [[1100, 600], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(() => {
      const grid = document.querySelector('[role="tabpanel"]:not([hidden]) .task-gif-grid');
      const bounds = grid.getBoundingClientRect();
      const visible = [...grid.querySelectorAll(".task-gif-cell")].filter(cell => {
        const rect = cell.getBoundingClientRect(); return rect.top < bounds.bottom && rect.bottom > bounds.top;
      });
      return visible.length > 0 && visible.every(cell => {
        const img = cell.querySelector("img"); return img?.complete && img.naturalWidth > 0;
      });
    });
    const layout = await page.locator(".task-media-panel").evaluate(panel => {
      const pane = panel.querySelector('[role="tabpanel"]:not([hidden])');
      const bounds = panel.getBoundingClientRect(), text = pane.querySelector("textarea").getBoundingClientRect();
      return { right: bounds.right, bottom: bounds.bottom, width: bounds.width, textHeight: text.height, overflow: pane.scrollHeight > pane.clientHeight + 1 };
    });
    assert.ok(layout.right <= width + 1 && layout.bottom <= height + 1 && layout.textHeight > 40 && !layout.overflow, JSON.stringify(layout));
    await page.screenshot({ path: `${output}/docs-${width}x${height}.png` });
  }
  await page.evaluate(() => mediaFixture.active(false));
  await page.waitForFunction(() => mediaFixture.stats().liveURLs.length === 0);
  await page.evaluate(() => mediaFixture.active(true)); await waitText("Возврат фокуса");
  await page.evaluate(() => mediaFixture.mount(false));
  await page.waitForFunction(() => mediaFixture.stats().liveURLs.length === 0);
  assert.equal(await page.locator("dialog[open]").count(), 0);
  assert.deepEqual(errors, []);
  checks.push("keyboard local tabs, 1100×600/1440×900 layout and full cleanup on app deactivation/unmount");
  await writeFile(`${output}/result.json`, JSON.stringify({ checks, errors }, null, 2));
  console.log(`PASS ${checks.length} browser scenarios: ${output}/result.json`);
} catch (error) {
  await writeFile(`${output}/failure.json`, JSON.stringify({ checks, errors, failure: error.stack }, null, 2));
  throw error;
} finally { await browser?.close(); await server.close(); }
