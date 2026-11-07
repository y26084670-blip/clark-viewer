import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({ root, server: { host: "127.0.0.1", port: 0, hmr: false } });
const profile = await mkdtemp(join(tmpdir(), "clark-viewer-disk-focus-"));
let context;
try {
  await server.listen();
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/__disk-focus*", route => route.fulfill({ contentType: "text/html",
    body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/test/browser/projectDisk.fixture.jsx"></script>' }));
  const url = `http://127.0.0.1:${server.httpServer.address().port}/__disk-focus`;
  const picker = "Выбрать диск с проектами", proceed = "Продолжить", allow = "Разрешить доступ к диску «Диск Д»";
  const dialog = page.locator(".task-disk-dialog");
  const focused = name => page.waitForFunction(name => {
    const button = document.activeElement;
    return button?.tagName === "BUTTON" && !button.disabled && button.textContent.trim() === name;
  }, name);
  const enter = async name => { await focused(name); await page.keyboard.press("Enter"); };
  const finish = async () => {
    await enter(proceed);
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await page.locator("#projectCatalog").evaluate(el => el === document.activeElement), true);
  };

  await page.goto(url);
  await page.waitForFunction(() => window.diskFixture?.ready);
  for (const mode of ["cancel", "denied", "disk"]) {
    await page.evaluate(mode => diskFixture.mode(mode), mode);
    await enter(picker);
  }
  await focused(proceed);
  assert.equal(await page.evaluate(() => diskFixture.calls.length), 3);
  await page.keyboard.press("Tab");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await focused("Закрыть");
  await page.keyboard.press("Shift+Tab");
  await finish();
  console.log("PASS disk selection, cancellation, retry and Continue using Enter");

  await page.reload();
  await page.waitForFunction(() => document.querySelector("#projectCatalog")?.value === "clark.viewer"
    && !document.querySelector(".task-disk-dialog-actions button").disabled);
  assert.equal(await page.evaluate(() => diskFixture.calls.length), 0);
  await enter(picker);
  await finish();
  console.log("PASS F5 with a silently restored disk still focuses the picker");

  await page.evaluate(async () => {
    const storage = await navigator.storage.getDirectory();
    const disk = await storage.getDirectoryHandle("Диск Д", { create: true });
    await disk.getDirectoryHandle("clark.projects", { create: true });
    const { saveProjectDisk } = await import("/src/services/projectDiskAccessService.js");
    await saveProjectDisk(disk);
  });
  await page.goto(url + "?permission=prompt");
  await dialog.getByRole("button", { name: allow }).waitFor();
  await focused(picker);
  await page.keyboard.press("Tab");
  await page.evaluate(() => diskFixture.requestResult("denied"));
  await enter(allow);
  await dialog.getByRole("status").filter({ hasText: "не разрешён" }).waitFor();
  await page.evaluate(() => diskFixture.requestResult("granted"));
  await enter(allow);
  await finish();
  assert.deepEqual(await page.evaluate(() => diskFixture.requests.map(request => request.active)), [true, true]);
  console.log("PASS saved-disk permission, denial and keyboard retry");

  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#projectCatalog")?.value === "clark.projects"
    && !document.querySelector(".task-disk-dialog-actions button").disabled);
  await page.evaluate(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("Empty", { create: true });
  });
  await enter(picker);
  await focused("Закрыть");
  assert.equal(await dialog.getByRole("button", { name: proceed }).isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log("PASS empty disk keeps Continue disabled");
} finally {
  await context?.close();
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
