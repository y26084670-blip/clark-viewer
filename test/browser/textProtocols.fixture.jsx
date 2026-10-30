import { render } from "solid-js/web";
import h5wasm from "h5wasm";
import { Tasks } from "../../src/tabs/Tasks.jsx";
import { TEXT_PROTOCOLS } from "../../src/services/taskTextProtocols.js";
import "../../src/App.css";

const root = await navigator.storage.getDirectory();
try { await root.removeEntry("clark.text-protocols-fixture", { recursive: true }); } catch (error) { if (error.name !== "NotFoundError") throw error; }
const workspace = await root.getDirectoryHandle("clark.text-protocols-fixture", { create: true });
const project = await workspace.getDirectoryHandle("Project", { create: true });
const tasks = {};
FileSystemDirectoryHandle.prototype.requestPermission = async () => "granted";
FileSystemDirectoryHandle.prototype.queryPermission = async () => "granted";
window.showDirectoryPicker = async () => root;
async function put(handle, path, data) {
  const parts = path.split("/"), name = parts.pop();
  for (const part of parts) handle = await handle.getDirectoryHandle(part, { create: true });
  const writer = await (await handle.getFileHandle(name, { create: true })).createWritable();
  await writer.write(data); await writer.close();
}
async function read(handle, path) {
  const parts = path.split("/"), name = parts.pop();
  for (const part of parts) handle = await handle.getDirectoryHandle(part);
  return (await handle.getFileHandle(name)).getFile();
}
const { FS } = await h5wasm.ready;
const sources = {
  MH: [[1, 2, 3, 3, 0, 0, 7, 0, 0], [4, 5, 6, 12, 13, 14, 0, 0, 0]],
  JE: [[1, 2, 3, 0, 3, 4, 0, .3, .4], [7, 8, 9, 10, 11, 12, 0, 0, 0]],
  HS: [[1, 2, 3, .1, .2, .3], [4, 5, 6, .4, .5, .6]],
  HV: [[7, 8, 9, .7, .8, .9]],
};
const original = {};
for (const name of ["A", "B"]) {
  const handle = await project.getDirectoryHandle(name, { create: true }); tasks[name] = handle;
  const element = { targ: 0, model: 2, rv: 1, xapName: "HTS", dp: [1, 1, 1], dr: [0, 0, 0],
    geo: [0,0,0, 1,0,0, 1,1,0, 0,1,0, 0,0,1, 1,0,1, 1,1,1, 0,1,1], vkan: [0, 0, 0], sym: { vi: [0, 0, 0], ls: 1, as: 1, ps: 1, kya: 0, kyp: 0 } };
  await put(handle, "input3XX/general.txt", JSON.stringify({ countTimeSteps: 1, timeStep: .5, doubleFloat: true }));
  await put(handle, "input3XX/kvs.txt", [element, { ...element, targ: 1, model: 0 },
    { ...element, targ: 2, model: 0 }, { ...element, targ: 3, model: 0, indAmp: 0 }].map(x => JSON.stringify(x)).join("\n"));
  await put(handle, "input3XX/tks.txt", JSON.stringify({ ...element, dp: [2, 1] }));
  await put(handle, "input3XX/xapLibHTS/HTS.txt", JSON.stringify({ JC0: 100, j_HC0: 100, JCa: 1, JCb: 1 }));
  for (const [family, rows] of Object.entries(sources)) {
    const h5 = new h5wasm.File(`/${family}.h5`, "w"), header = h5.create_group("HEADER"), stride = rows[0].length;
    const counts = family === "MH" || family === "JE" ? [1n, 1n] : [BigInt(rows.length)];
    for (const [key, value] of Object.entries({ columns: [3n], arrCount: [stride === 9 ? 2n : 1n], hasCoo: [1n],
      inds1: counts.map((_, i) => BigInt(i + 1)), numbs: counts })) header.create_dataset({ name: key, data: new BigInt64Array(value) });
    for (const step of [0, 1]) h5.create_dataset({ name: String(step).padStart(6, "0"), data: new Float64Array(rows.flat()), shape: [rows.length, stride] });
    h5.close();
    const bytes = FS.readFile(`/${family}.h5`); original[family] = bytes;
    await put(handle, `output3XX/${family}.h5`, bytes); FS.unlink(`/${family}.h5`);
  }
  for (const filename of ["prot-force.txt", "prot-psi.txt", "prot-QKV.txt", "prot-iter.txt"]) await put(handle, `output3XX/${filename}`, `keep ${filename}`);
  await put(handle, "DOCS/README.txt", "Documentation");
}
function Fixture() {
  let loadedHandle = null, loadCount = 0;
  window.textProtocolFixture = {
    loaded: () => loadedHandle?.name, loadCount: () => loadCount,
    seedSingle: (name, filename = "prot-source-M.txt") => put(tasks[name], `output3XX/${filename}`, ""),
    clear: async name => { const output = await tasks[name].getDirectoryHandle("output3XX"); for (const p of TEXT_PROTOCOLS) { try { await output.removeEntry(p.name); } catch (e) { if (e.name !== "NotFoundError") throw e; } } },
    text: async (name, path) => (await read(tasks[name], path)).text(),
    list: async name => { const output = await tasks[name].getDirectoryHandle("output3XX"); return Array.fromAsync(output.keys()); },
    seed: async name => { for (const p of TEXT_PROTOCOLS) await put(tasks[name], `output3XX/${p.name}`, "previous"); },
    corrupt: name => put(tasks[name], "output3XX/JE.h5", "invalid HDF5"),
    restore: name => put(tasks[name], "output3XX/JE.h5", original.JE),
    binariesUnchanged: async name => {
      for (const [family, bytes] of Object.entries(original)) {
        const actual = new Uint8Array(await (await read(tasks[name], `output3XX/${family}.h5`)).arrayBuffer());
        if (actual.length !== bytes.length || actual.some((b, i) => b !== bytes[i])) return false;
      }
      return true;
    },
  };
  return <div style={{ height: "100vh" }}>
    <Tasks active={true} onLoad={handle => { loadedHandle = handle; loadCount++; return true; }} />
  </div>;
}
render(() => <Fixture />, document.getElementById("root"));
window.textProtocolsReady = true;
