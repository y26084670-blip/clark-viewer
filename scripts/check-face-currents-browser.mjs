// Exercise the actual Solid dialog, frame controller, native clipboard and CSS.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.CHECK_OUTPUT || "/tmp/clark-face-currents-check";
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ root, cacheDir: `${output}/vite-cache`,
  optimizeDeps: { entries: ["test/browser/faceCurrents.html"] },
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
await server.listen();
let browser;
const checks = [], errors = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log("PASS", name); };
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
  const context = await browser.newContext({ locale: "ru-RU", viewport: { width: 1280, height: 900 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/test/browser/faceCurrents.html`);
  const panel = page.getByRole("dialog");
  const mode = page.getByRole("checkbox", { name: "Сумма", exact: true });
  const sum = page.getByRole("textbox", { name: "Сумма выделенных ячеек, А" });
  const cells = panel.locator("tbody tr").first().locator("td button");
  const copy = panel.getByRole("button", { name: "Копировать", exact: true });
  const close = panel.getByRole("button", { name: "Закрыть", exact: true });
  const waitSum = value => page.waitForFunction(value => document.querySelector(".face-currents-sum-value")?.value === value, value);
  async function open() {
    await page.getByRole("button", { name: "Открыть инструмент" }).click();
    await cells.first().waitFor();
  }
  await open();
  check("sum starts unchecked, zero and read-only; cells cannot be selected", !await mode.isChecked()
    && await sum.isDisabled() && await sum.inputValue() === "0" && await sum.evaluate(node => node.readOnly)
    && await cells.first().isDisabled());
  check("decimal point in Russian locale, four significant digits and tiny nonzero values",
    await cells.first().textContent() === "1.235" && await cells.nth(4).textContent() === "1.235e-8");
  check("inactive sum mode does not dim the values", await cells.first().evaluate(node => getComputedStyle(node).opacity) === "1");
  const copyBox = await copy.boundingBox(), closeBox = await close.boundingBox();
  check("Copy and Close have the same width", copyBox.width === closeBox.width);
  check("action labels fit with horizontal padding", await panel.locator("header button").evaluateAll(buttons => buttons.every(button => {
    const range = document.createRange(); range.selectNodeContents(button);
    const style = getComputedStyle(button);
    return range.getBoundingClientRect().width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      <= button.clientWidth;
  })));
  const modeBox = await mode.boundingBox(), sumBox = await sum.boundingBox();
  check("controls are ordered Sum, value, Copy, Close", modeBox.x < sumBox.x && sumBox.x < copyBox.x && copyBox.x < closeBox.x);
  check("initial panel is on the left", (await panel.boundingBox()).x === 8);

  await mode.check(); await cells.first().locator("..").click({ position: { x: 1, y: 1 } }); await waitSum("1.2346");
  check("clicking the cell edge selects and displays five significant digits", await cells.first().getAttribute("aria-pressed") === "true"
    && await cells.first().evaluate(node => node.parentElement.classList.contains("is-selected")));
  await cells.nth(1).click(); await waitSum("0.00006789");
  check("sum uses original numbers, not four-digit cell text", await sum.inputValue() === "0.00006789");
  await cells.first().click(); await waitSum("-1.2345");
  check("second click deselects one cell", await cells.first().getAttribute("aria-pressed") === "false");
  await cells.first().focus(); await page.keyboard.press("Space"); await waitSum("0.00006789");
  await page.keyboard.press("Enter"); await waitSum("-1.2345");
  check("keyboard Space and Enter toggle cells", await cells.first().getAttribute("aria-pressed") === "false");
  check("missing sections remain unavailable", await cells.nth(5).isDisabled());
  await cells.first().click(); await waitSum("0.00006789");
  await copy.click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const rows = text.split(/\r?\n/).map(row => row.split("\t"));
  check("native clipboard exports the complete table with headers and original decimal-point numbers",
    rows.length === 26 && rows.every(row => row.length === 19)
    && rows[1][8] === "1.23456789" && rows[1][9] === "-1.2345" && rows[1][13] === "");

  await panel.evaluate(node => { node.style.width = "700px"; });
  await page.evaluate(() => {
    const scroll = document.querySelector(".face-currents-scroll"); scroll.scrollTop = 80; scroll.scrollLeft = 120;
    window.faceNodes = { table: scroll.firstElementChild, cell: scroll.querySelector("td"), top: scroll.scrollTop, left: scroll.scrollLeft };
    faceCurrentsFixture.delay(true); faceCurrentsFixture.step(1);
  });
  await page.waitForFunction(() => faceCurrentsFixture.pending().includes(1));
  check("loading keeps the displayed frame and its sum", await sum.inputValue() === "0.00006789"
    && (await panel.locator(".face-currents-step").textContent()).includes("Показан шаг 0"));
  await page.evaluate(() => { faceCurrentsFixture.step(2); faceCurrentsFixture.resolve(1); });
  await page.waitForFunction(() => faceCurrentsFixture.pending().includes(2));
  check("an obsolete response does not change the sum", await sum.inputValue() === "0.00006789");
  await page.evaluate(() => faceCurrentsFixture.resolve(2)); await waitSum("0.00020367");
  check("selection follows the successfully displayed time frame", await cells.first().getAttribute("aria-pressed") === "true"
    && (await panel.locator(".face-currents-step").textContent()).includes("t = 0.004"));
  check("time update preserves table nodes and scroll position", await page.evaluate(() => {
    const scroll = document.querySelector(".face-currents-scroll");
    return scroll.firstElementChild === faceNodes.table && scroll.querySelector("td") === faceNodes.cell
      && scroll.scrollTop === faceNodes.top && scroll.scrollLeft === faceNodes.left;
  }));
  await page.evaluate(() => faceCurrentsFixture.step(3));
  await page.waitForFunction(() => faceCurrentsFixture.pending().includes(3));
  await page.evaluate(() => faceCurrentsFixture.reject(3)); await waitSum("—");
  check("failed frame does not show a stale sum or permit copying", await sum.isDisabled() && await copy.isDisabled());
  await page.evaluate(() => { faceCurrentsFixture.delay(false); faceCurrentsFixture.step(4); }); await waitSum("0.00033945");
  check("selection resumes when valid data arrives", await cells.first().getAttribute("aria-pressed") === "true");
  await mode.uncheck(); await waitSum("0");
  check("turning Sum off clears every selection", await panel.locator("td.is-selected").count() === 0);
  await mode.check(); await waitSum("0");
  check("reenabling Sum does not restore old cells", await panel.locator('[aria-pressed="true"]').count() === 0);
  await cells.first().click(); await waitSum("6.1728");
  await close.click(); await panel.waitFor({ state: "hidden" }); await open();
  check("reopening the tool resets Sum and selection", !await mode.isChecked() && await sum.inputValue() === "0"
    && await panel.locator("td.is-selected").count() === 0);

  for (const width of [480, 960, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(() => {
      const panel = document.querySelector(".element-face-currents").getBoundingClientRect();
      return panel.x >= 0 && panel.right <= innerWidth;
    });
    const bounds = await panel.boundingBox();
    for (const control of [mode, sum, copy, close]) {
      const box = await control.boundingBox();
      assert.ok(box.x >= bounds.x && box.x + box.width <= bounds.x + bounds.width + 1);
    }
    check(`controls fit at viewport ${width}px and action widths match`, (await copy.boundingBox()).width === (await close.boundingBox()).width);
  }
  const before = await panel.boundingBox();
  await page.mouse.move(before.x + before.width - 3, before.y + before.height - 3);
  await page.mouse.down(); await page.mouse.move(before.x + before.width + 100, before.y + before.height + 30); await page.mouse.up();
  const after = await panel.boundingBox();
  check("resizing by the right corner keeps the left edge", after.width > before.width + 50 && after.x === before.x);
  const handle = await panel.locator(".geometry-overlay-drag-handle").boundingBox();
  await page.mouse.move(handle.x + 25, handle.y + 12); await page.mouse.down();
  await page.mouse.move(handle.x + 105, handle.y + 52); await page.mouse.up();
  check("header dragging remains available", (await panel.boundingBox()).x > after.x + 50);
  await mode.check(); await cells.first().click();
  await page.screenshot({ path: `${output}/panel.png` });
  check("no browser errors", errors.length === 0);
  await writeFile(`${output}/result.json`, JSON.stringify({ browser: browser.version(), checks, errors }, null, 2));
} finally {
  await browser?.close(); await server.close();
}
