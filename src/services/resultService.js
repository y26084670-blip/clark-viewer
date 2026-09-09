export class ResultService {
  constructor() {
    this.worker = new Worker(new URL("../workers/hdf5.worker.js", import.meta.url), { type: "module" });
    this.sequence = 0;
    this.pending = new Map();
    this.worker.onmessage = ({ data }) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      data.error ? request.reject(new Error(data.error)) : request.resolve(data.result);
    };
    this.worker.onerror = event => this.fail(new Error(event.message || "Ошибка модуля чтения HDF5"));
  }
  request(action, data = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, action, ...data });
    });
  }
  open(files) { return this.request("open", { files }); }
  read(data) { return this.request("read", data); }
  history(data) { return this.request("history", data); }
  fail(error) { for (const request of this.pending.values()) request.reject(error); this.pending.clear(); }
  close() { this.fail(new Error("Задание закрыто")); this.worker.terminate(); }
}
