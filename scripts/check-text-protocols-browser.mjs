import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { TEXT_PROTOCOLS } from "../src/services/taskTextProtocols.js";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.env.CHECK_OUTPUT || "/tmp/clark-text-protocols-check";
await mkdir(output, { recursive: true });
const server = await createServer({ root, cacheDir: `${output}/vite-cache`, server: { host: "127.0.0.1", port: 0, hmr: false } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const errors = [], checks = [], names = TEXT_PROTOCOLS.map(p => p.name);
const pass = message => { checks.push(message); console.log(`PASS ${checks.length}: ${message}`); };
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  page.setDefaultTimeout(20000); page.on("pageerror", e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/test/browser/textProtocols.html`);
  await page.waitForFunction(() => window.textProtocolsReady);
  const button = page.getByRole("button", { name: "Протоколы...", exact: true });
  assert.equal(await button.isDisabled(), true);
  await page.getByRole("button", {name:"Выбрать диск с проектами",exact:true}).click();
  await page.getByRole("button", {name:"Продолжить",exact:true}).click();
  await page.getByRole("combobox",{name:"Список проектов",exact:true}).selectOption("Project");
  const row = name => page.locator('.task-status-row').filter({has:page.locator('.task-status-label',{hasText:new RegExp(`^(?:▶\\s*)?${name}$`)})});
  await row("A").click();await page.getByRole("button",{name:"Загрузить для просмотра",exact:true}).click();
  await page.waitForFunction(()=>textProtocolFixture.loaded()==="A");
  await row("B").click();
  // A is loaded and already has all five protocols; B is selected and has none.
  await page.evaluate(() => textProtocolFixture.seed("A"));
  const buttonBox = await button.boundingBox(), refreshBox = await page.getByRole("button", { name:"Обновить список заданий",exact:true }).boundingBox();
  assert.ok(buttonBox.x + buttonBox.width <= refreshBox.x && Math.abs(buttonBox.y-refreshBox.y)<4);
  assert.equal(await button.evaluate(e => getComputedStyle(e).fontWeight), "400");
  assert.match(await button.getAttribute("title"), /протоколы расчёта выделенного задания/);
  assert.equal(await page.locator('.task-media-panel .task-text-protocols-button').count(),0);
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Протоколы расчёта", exact:true });
  const action = label => dialog.getByRole("button", {name:label,exact:true});
  const ready = async label => { await action(label).waitFor(); await page.waitForFunction(label => [...document.querySelectorAll('.task-text-protocols-actions button')].some(b=>b.textContent===label&&!b.disabled), label); };
  const status = text => dialog.getByRole("status").filter({hasText:text}).waitFor();
  await ready("Создать");
  assert.equal(await dialog.locator("button").count(), 2);
  assert.equal(await dialog.locator(".task-text-protocols-name").textContent(), "B");
  const dialogBox=await dialog.boundingBox(),actionBox=await action("Создать").boundingBox();
  assert.equal(dialogBox.width,360);assert.ok(actionBox.x-dialogBox.x<20);
  await page.screenshot({ path: `${output}/dialog-create.png` });
  await action("Отмена").click();assert.equal(await button.evaluate(e => e === document.activeElement),true);
  pass("Heading button left of refresh, normal weight, calculation tooltip, 360px panel and two left-aligned actions; selected B determines Create despite loaded A's files");

  await button.click();await ready("Создать");await action("Создать").click();
  await status("Создано протоколов: 5.");await ready("Удалить");
  const texts = await page.evaluate(async names => Object.fromEntries(await Promise.all(names.map(async n => [n, await textProtocolFixture.text("B", `output3XX/${n}`)]))), names);
  for (const [name, text] of Object.entries(texts)) await writeFile(`${output}/${name}`, text);
  for (const text of Object.values(texts)) assert.equal((text.match(/iDTK/g) || []).length, 2);
  const vtsp = texts["prot-field-vtsp.txt"].split("\n").find(l => /^\s+1\s+1/.test(l)).trim().split(/\s+/).map(Number);
  assert.deepEqual(vtsp.slice(10), [7, 3, 10, 90, .5, 5, .1]);
  assert.ok(await page.evaluate(() => textProtocolFixture.binariesUnchanged("B")));
  for (const name of names) assert.equal(await page.evaluate(n=>textProtocolFixture.text("A",`output3XX/${n}`),name),"previous");
  await page.screenshot({path:`${output}/dialog-delete.png`});
  pass("Real worker creates all five legacy-formatted files for B only, with both time steps and VTSP; action changes to Delete");

  await action("Удалить").click();await status("Удалено протоколов: 5.");await ready("Создать");
  assert.ok(!(await page.evaluate(() => textProtocolFixture.list("B"))).some(n => names.includes(n)));
  for (const name of ["prot-force.txt", "prot-psi.txt", "prot-QKV.txt", "prot-iter.txt"]) assert.equal(await page.evaluate(n => textProtocolFixture.text("B", `output3XX/${n}`), name), `keep ${name}`);
  assert.ok(await page.evaluate(() => textProtocolFixture.binariesUnchanged("B")));
  assert.equal(await page.evaluate(() => textProtocolFixture.text("B", "DOCS/README.txt")), "Documentation");
  pass("Batch Delete changes back to Create, preserving HDF5, integral protocols, DOCS and other tasks");

  await action("Отмена").click();await page.evaluate(() => textProtocolFixture.seedSingle("B"));await button.click();await ready("Удалить");
  assert.equal(await action("Создать").count(),0);
  await action("Удалить").click();await status("Удалено протоколов: 1.");await ready("Создать");
  pass("One empty accepted protocol in selected B is sufficient for Delete");

  await page.evaluate(() => textProtocolFixture.seedSingle("B"));
  await action("Создать").click();await status("Состав протоколов изменился");await ready("Удалить");
  assert.equal(await page.evaluate(()=>textProtocolFixture.text("B","output3XX/prot-source-M.txt")),"");
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); });await ready("Удалить");
  await page.evaluate(async () => { await textProtocolFixture.clear("B"); window.dispatchEvent(new Event("focus")); });await ready("Создать");
  pass("External changes are rechecked before mutation and on focus; an outdated Create click never deletes a newly appeared file");

  await page.evaluate(() => textProtocolFixture.corrupt("B"));await action("Создать").click();
  await dialog.getByRole("alert").waitFor();await ready("Создать");
  assert.ok(!(await page.evaluate(() => textProtocolFixture.list("B"))).some(n => names.includes(n)));
  await page.evaluate(() => textProtocolFixture.restore("B"));
  await page.keyboard.press("Escape");assert.equal(await dialog.count(),0);
  await row("A").click();await button.click();await ready("Удалить");
  assert.equal(await dialog.locator(".task-text-protocols-name").textContent(),"A");
  await action("Отмена").click();
  pass("Damaged HDF5 leaves no protocols and keeps Create; Escape/Cancel close the panel; selecting A yields Delete");
  assert.equal(await page.evaluate(()=>textProtocolFixture.loaded()),"A");
  assert.equal(await page.evaluate(()=>textProtocolFixture.loadCount()),1);
  assert.deepEqual(errors, []);
  await writeFile(`${output}/results.json`,JSON.stringify({checks,errors},null,2));
  console.log(`BROWSER_OK ${checks.length}/${checks.length}`);
} catch (error) {
  await page.screenshot({path:`${output}/failure.png`,fullPage:true});
  await writeFile(`${output}/results.json`,JSON.stringify({checks,errors,failure:error.stack},null,2));throw error;
} finally { await browser.close(); await server.close(); }
