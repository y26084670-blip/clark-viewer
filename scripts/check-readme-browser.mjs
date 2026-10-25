import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.CHECK_OUTPUT || "/tmp/clark-readme-check";
await mkdir(output, { recursive: true });
const server = await createServer({ root, cacheDir: `${output}/vite-cache`,
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE,
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 600 } });
  page.setDefaultTimeout(12000); page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/test/browser/taskMedia.html`);
  await page.waitForFunction(() => window.mediaReady);
  try {
    await access(`${root}/src/tabs/Tasks.css`);
    await page.addStyleTag({ url: "/src/tabs/Tasks.css?direct" });
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await page.getByRole("tab", { name: /^DOCS/ }).click();
  const preview = page.getByLabel("Содержимое документа DOCS", { exact: true });
  await page.waitForFunction(() => document.querySelector('[aria-label="Содержимое документа DOCS"]')?.value.includes("Строка 1"));

  const documentPicker = page.getByLabel("Документ DOCS", { exact: true });
  const createReadme = page.getByRole("button", { name: "Создать README.txt", exact: true });
  const editReadme = page.getByRole("button", { name: "Править", exact: true });
  const deleteReadme = page.getByRole("button", { name: "Удалить", exact: true });
  for (const name of ["notes.txt", "README.md"]) {
    await documentPicker.selectOption(name);
    await page.waitForFunction(() => !document.querySelector('[aria-label="Содержимое документа DOCS"]').getAttribute('aria-busy') || document.querySelector('[aria-label="Содержимое документа DOCS"]').getAttribute('aria-busy') === 'false');
    assert.equal(await createReadme.isDisabled(), true);
    assert.equal(await editReadme.isDisabled(), true);
    assert.equal(await deleteReadme.isDisabled(), true);
  }
  await page.evaluate(() => mediaFixture.pick("second"));
  await page.waitForFunction(() => document.querySelector('[aria-label="Документ DOCS"]').value === "README.md");
  assert.equal(await createReadme.isDisabled(), true);
  await documentPicker.selectOption("");
  assert.equal(await createReadme.isEnabled(), true);
  assert.equal(await editReadme.isDisabled(), true);
  assert.equal(await deleteReadme.isDisabled(), true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => !document.querySelector('[aria-label="Создать README.txt"]').disabled);
  assert.equal(await documentPicker.inputValue(), "");
  await page.evaluate(() => mediaFixture.pick("first"));
  await page.waitForFunction(() => document.querySelector('[aria-label="Документ DOCS"]').value === "README.txt");
  console.log("PASS README actions follow the selected file, including explicit creation when only other documents exist");

  const interactiveHtml = `<!doctype html><meta charset="utf-8"><title>Interactive DOCS</title>
    <h1>Интерактивный отчёт</h1><button id="advance">Изменить время</button><output id="value">0</output>
    <button id="download">Скачать CSV</button><script>
    window.reportReady = true;
    document.getElementById('advance').onclick=()=>document.getElementById('value').textContent++;
    document.getElementById('download').onclick=()=>{const a=document.createElement('a');
      a.href=URL.createObjectURL(new Blob(['current,value\\n1,2'],{type:'text/csv'}));a.download='report.csv';a.click();};
    </script>`;
  await page.evaluate(source => mediaFixture.put("DOCS/interactive.html", source), interactiveHtml);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => [...document.querySelector('[aria-label="Документ DOCS"]').options].some(o => o.value === "interactive.html"));
  await documentPicker.selectOption("interactive.html");
  await page.frameLocator('iframe[title="HTML-документ DOCS"]').getByRole('heading', {name:'Интерактивный отчёт'}).waitFor();
  assert.equal(await page.evaluate(() => window.reportReady), undefined);
  for (const button of [createReadme, editReadme, deleteReadme]) assert.equal(await button.isDisabled(), true);
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole('button', {name:'Открыть HTML в браузере',exact:true}).click();
  const popup = await popupPromise;
  await popup.waitForFunction(() => window.reportReady);
  assert.equal(await popup.evaluate(() => window.opener), null);
  await popup.getByRole('button', {name:'Изменить время'}).click();
  assert.equal(await popup.locator('#value').innerText(), '1');
  const downloadPromise = popup.waitForEvent('download');
  await popup.getByRole('button', {name:'Скачать CSV'}).click();
  assert.equal((await downloadPromise).suggestedFilename(), 'report.csv');
  await popup.reload(); await popup.waitForFunction(() => window.reportReady);
  assert.equal(await popup.locator('#value').innerText(), '0');
  await page.evaluate(() => mediaFixture.pick("second"));
  await popup.reload(); await popup.waitForFunction(() => window.reportReady);
  await popup.close();
  await page.evaluate(() => mediaFixture.pick("first"));
  await page.waitForFunction(() => document.querySelector('[aria-label="Документ DOCS"]').value === "README.txt");
  console.log("PASS HTML scripts, CSV download, reload and task switch in an independent browser tab");

  const editor = page.locator(".task-gif-dialog[open]");
  await page.getByRole("button", { name: "Править", exact: true }).click();
  const input = page.getByLabel("Текст README.txt", { exact: true });
  await input.fill("Новый текст\nТок 1 А");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  assert.equal(await input.inputValue(), "Новый текст\nТок 1 А");
  await editor.getByRole("button", { name: "Отмена", exact: true }).click();
  await editor.getByRole("button", { name: "Продолжить редактирование", exact: true }).click();
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector('[aria-label="Содержимое документа DOCS"]').value === "Новый текст\nТок 1 А");
  console.log("PASS edit, focus refresh, cancel prompt, resume and save with native file replacement");

  await page.getByRole("button", { name: "Править", exact: true }).click();
  await input.fill("Несохранённая правка");
  await page.evaluate(() => mediaFixture.put("DOCS/README.txt", "Внешняя правка"));
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  await editor.getByRole("alert").filter({ hasText: "изменён после открытия" }).waitFor();
  assert.equal(await input.inputValue(), "Несохранённая правка");
  await editor.getByRole("button", { name: "Отмена", exact: true }).click();
  await editor.getByRole("button", { name: "Не сохранять", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => document.querySelector('[aria-label="Содержимое документа DOCS"]').value === "Внешняя правка");
  console.log("PASS external edit conflict preserves both disk contents and unsaved editor text");

  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  await editor.getByRole("button", { name: "Отмена", exact: true }).click();
  assert.equal(await preview.inputValue(), "Внешняя правка");
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  await editor.getByRole("button", { name: "Удалить README.txt", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Создать README.txt", exact: true }).click();
  await input.fill("Создан заново");
  await page.evaluate(() => mediaFixture.permission("denied"));
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  await editor.getByRole("alert").filter({ hasText: "Нет разрешения" }).waitFor();
  await page.evaluate(() => mediaFixture.permission("granted"));
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector('[aria-label="Содержимое документа DOCS"]').value === "Создан заново");
  assert.equal(await page.getByRole("button", { name: "Создать README.txt", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("tab", { name: /^GIF/ }).isEnabled(), true);
  console.log("PASS delete confirmation, create, permission refusal/retry and busy-state release");
  await page.screenshot({ path: `${output}/readme-1100.png` });
  await page.evaluate(() => mediaFixture.pick("empty"));
  await page.getByRole("button", { name: "Создать README.txt", exact: true }).click();
  await input.fill("Новая папка DOCS");
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector('[aria-label="Содержимое документа DOCS"]').value === "Новая папка DOCS");
  console.log("PASS creating README when DOCS is absent");
  assert.deepEqual(errors, []);
} finally { await browser.close(); await server.close(); }
