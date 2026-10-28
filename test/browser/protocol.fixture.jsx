// Real App, HDF5 worker, renderers and file writes. Only the native picker and
// permissions are replaced by a disposable OPFS workspace.
import { render } from "solid-js/web";
import App from "../../src/App.jsx";
import { parseProtocol } from "../../src/services/protocol/protocolDocument.js";
import "../../src/App.css";
import "tabulator-tables/dist/css/tabulator_simple.min.css";

const storage = await navigator.storage.getDirectory();
const disk = await storage.getDirectoryHandle("ProtocolWorkspace", { create: true });
const root = await disk.getDirectoryHandle("clark.protocol", { create: true });
const project = await root.getDirectoryHandle("Project", { create: true });
const permissionCalls = []; let permission = "granted";
FileSystemDirectoryHandle.prototype.queryPermission = async () => "granted";
FileSystemDirectoryHandle.prototype.requestPermission = async function(options) { permissionCalls.push([this.name, options]); return permission; };
window.showDirectoryPicker = async () => disk;
async function put(task, path, data) {
  const parts = path.split("/"), name = parts.pop(); let dir = task;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  const file = await dir.getFileHandle(name, { create: true }), writer = await file.createWritable();
  await writer.write(data); await writer.close();
}
const sym = { vi: [0,0,0], r0: [0,0,0], yl: 90, ya: 0, tx: 0, ls: 2, as: 1, ps: 1, kya: 0, kyp: 0 };
const element = { name: "Steel cube", geoType: 0, geo: [0,0,0,0,0,2,0,2,0,0,2,2,2,0,0,2,0,2,2,2,0,2,2,2],
  sym, dr: [0,0,0], dp: [2,2,2], vkan: [0,0,0], indCoil: 0, wCoil: 0, indAmp: 0, indMove: 0,
  model: 0, auto: true, targ: 0, take: true, rv: 1, med: [0,0,0,0,0,0], xapName: "steel", xapType: 1 };
const region = { name: "Plane", geoType: 0, geo: [0,0,3,0,2,3,2,0,3,2,2,3], sym, dr: [0,0,0], dp: [3,3], indMove: 0, auto: true };
const general = { countTimeSteps: 2, timeStep: .5, doubleFloat: true, mirrorSymmetryX: -1, mirrorSymmetryY: -1, fullAxialSymmetry: false };
const tasks = {};
for (const name of ["Task A", "Task B"]) {
  const task = tasks[name] = await project.getDirectoryHandle(name, { create: true });
  for (const [file, data] of Object.entries({ "general.txt": general, "kvs.txt": element, "tks.txt": region })) {
    await put(task, `input3XX/${file}`, JSON.stringify(data));
  }
  await put(task, "input3XX/xapLibFMM/steel.txt", JSON.stringify({ tabl: [0, 10, 100, 0, 50, 100] }));
  await put(task, "input3XX/_summary.txt", `Исходные данные ${name}`);
  await put(task, "output3XX/_summary_out.txt", `Расчёт ${name} завершён\nФайлы результатов:\nMH.h5`);
  await put(task, "DOCS/README.txt", `Описание ${name}`);
  await put(task, "output3XX/demo/original.webm", await (await fetch("/test-results/original.webm")).arrayBuffer());
  await put(task, "output3XX/conditions.json", '{"mpiRanks":4,"machine":"fixture"}\n');
  if (!localStorage.getItem("protocol-fixture-no-results")) for (const file of ["MH.h5", "JE.h5", "HS.h5", "AS.h5", "preview.gif"]) {
    await put(task, file.endsWith("gif") ? "output3XX/demo/preview.gif" : `output3XX/${file}`,
      await (await fetch(`/test-results/${file}`)).arrayBuffer());
  }
}
window.protocolFixture = {
  permissionCalls,
  permission(value) { permission = value; },
  async exists(name = "protocol.html", taskName = "Task A") {
    try { await (await tasks[taskName].getDirectoryHandle("DOCS")).getFileHandle(name); return true; }
    catch (error) { if (error.name === "NotFoundError") return false; throw error; }
  },
  async inventory() {
    const entries = [];
    async function visit(directory, path = "") {
      for await (const [name, handle] of directory.entries()) {
        const key = `${path}/${name}`;
        if (handle.kind === "directory") await visit(handle, key);
        else {
          const digest = await crypto.subtle.digest("SHA-256", await (await handle.getFile()).arrayBuffer());
          entries.push([key, Array.from(new Uint8Array(digest)).join(",")]);
        }
      }
    }
    await visit(tasks["Task A"]); return entries.sort(([a], [b]) => a.localeCompare(b));
  },
  async mutateSources() {
    await put(tasks["Task A"], "input3XX/_summary.txt", "New input summary must not replace the saved one");
    await put(tasks["Task A"], "DOCS/extra.txt", "New automatic document must not be added");
    await put(tasks["Task A"], "output3XX/demo/new-invalid.webm", "Not a WebM: editing must not try to read it");
  },
  async external() { await put(tasks["Task A"], "DOCS/protocol.html", (await this.file()) + "\n"); },
  async file(name = "protocol.html") { return (await (await (await tasks["Task A"].getDirectoryHandle("DOCS")).getFileHandle(name)).getFile()).text(); },
  async document(name) { return parseProtocol(await this.file(name)); },
  async removeResults() {
    const output = await tasks["Task A"].getDirectoryHandle("output3XX");
    for (const name of ["MH.h5", "JE.h5", "HS.h5", "AS.h5"]) await output.removeEntry(name);
    localStorage.setItem("protocol-fixture-no-results", "true");
  },
};
render(() => <App />, document.getElementById("root"));
window.protocolReady = true;
