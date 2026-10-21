import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Tasks } from "../../src/tabs/Tasks.jsx";
import "../../src/App.css";

const params = new URL(location.href).searchParams;
let permission = params.get("permission") || "granted", requestResult = "granted", release;
let pickerMode = "disk";
const calls = [], queries = [], requests = [];
const nativeQuery = FileSystemDirectoryHandle.prototype.queryPermission;
FileSystemDirectoryHandle.prototype.queryPermission = function(options) {
  if (this.name !== "Диск Д") return nativeQuery.call(this, options);
  queries.push(options);
  return permission === "delay" ? new Promise(resolve => { release = resolve; }) : Promise.resolve(permission);
};
FileSystemDirectoryHandle.prototype.requestPermission = function(options) {
  requests.push({ ...options, active: navigator.userActivation.isActive });
  permission = requestResult;
  return Promise.resolve(requestResult);
};
window.showDirectoryPicker = async options => {
  calls.push(options);
  if (pickerMode === "cancel") throw new DOMException("Cancelled", "AbortError");
  if (pickerMode === "denied") throw new DOMException("Denied", "NotAllowedError");
  const opfs = await navigator.storage.getDirectory();
  const disk = await opfs.getDirectoryHandle("Viewer disk", { create: true });
  const catalog = await disk.getDirectoryHandle("clark.viewer", { create: true });
  await catalog.getDirectoryHandle("Проект Viewer", { create: true });
  await disk.getDirectoryHandle("CLARK.APP", { create: true });
  return disk;
};
const [loaded, setLoaded] = createSignal(null);
let path = "";
window.diskFixture = { calls, queries, requests, path: () => path,
  mode(value) { pickerMode = value; },
  requestResult(value) { requestResult = value; },
  release() { release?.("granted"); },
};
render(() => <Tasks active={true} busy={false} loadedHandle={loaded()}
  onLoad={async (handle, label) => { setLoaded(handle); path = label; return true; }} />, document.getElementById("root"));
window.diskFixture.ready = true;
