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
