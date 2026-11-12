const DATABASE = "clark.traffic.v1";
const STORE = "transfers";
const DAY = 24 * 60 * 60 * 1000;
const RETENTION = 31 * DAY;
const TRACKERS = Symbol.for("clark.traffic.trackers.v1");

export const TRAFFIC_PERIODS = Object.freeze([
  { value: "day", label: "за сутки", duration: DAY },
  { value: "week", label: "за неделю", duration: 7 * DAY },
  { value: "month", label: "за месяц", duration: 30 * DAY },
]);

// Separate records avoid read/modify/write races between tabs and workers.
// Store only time, application and bytes; resource URLs stay in memory.
export function createTrafficStore(environment = globalThis) {
  let connection;
  function open() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
      let settled = false;
      const fail = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error || new Error("История трафика недоступна."));
      };
      const timer = setTimeout(() => fail(new Error("Хранилище трафика не отвечает.")), 5000);
      try {
        if (!environment.indexedDB) throw new Error("История трафика недоступна.");
        const request = environment.indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("applicationTime", ["application", "time"]);
          store.createIndex("time", "time");
        };
        request.onerror = () => fail(request.error);
        request.onblocked = () => fail(new Error("Хранилище трафика занято другой вкладкой."));
        request.onsuccess = () => {
          const database = request.result;
          if (settled) { database.close(); return; }
          settled = true;
          clearTimeout(timer);
          database.onversionchange = () => { database.close(); connection = undefined; };
          resolve(database);
        };
      } catch (error) { fail(error); }
    });
    return connection;
  }

  async function transaction(mode, operation) {
    const database = await open();
    return new Promise((resolve, reject) => {
      let result;
      try {
        const transaction = database.transaction(STORE, mode);
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(transaction.error || new Error("Запись трафика прервана."));
        transaction.onerror = () => reject(transaction.error || new Error("История трафика недоступна."));
        operation(transaction.objectStore(STORE), value => { result = value; });
      } catch (error) { reject(error); }
    });
  }

  return {
    append(records) {
      return transaction("readwrite", store => { for (const record of records) store.put(record); });
    },
    total(application, from, until) {
      return transaction("readonly", (store, result) => {
        let bytes = 0;
        const range = environment.IDBKeyRange.bound([application, from], [application, until]);
        const request = store.index("applicationTime").openCursor(range);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { result(bytes); return; }
          if (Number.isSafeInteger(cursor.value.bytes) && cursor.value.bytes > 0) bytes += cursor.value.bytes;
          cursor.continue();
        };
      });
    },
    prune(before) {
      return transaction("readwrite", store => {
        const request = store.index("time").openCursor(environment.IDBKeyRange.upperBound(before, true));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
        };
      });
    },
  };
}

export function createTrafficTracker(application, {
  environment = globalThis, store = createTrafficStore(environment), now = Date.now,
} = {}) {
  if (!["editor", "viewer"].includes(application)) throw new Error("Неизвестное приложение.");
  const session = environment.crypto?.randomUUID?.() || `${now()}:${Math.random()}`;
  const seen = new Set();
  const observers = [];
  let sequence = 0;
  let storageError;
  let measurementError;
  let stopped = false;
  let pending = Promise.resolve();

  function enqueue(operation) {
    pending = pending.then(operation).catch(error => { storageError = error; });
  }

  function capture(entries) {
    if (stopped) return;
    const records = [];
    for (const entry of entries) {
      if (!/^https?:\/\//i.test(entry.name) || !Number.isSafeInteger(entry.transferSize)
        || entry.transferSize <= 0 || !Number.isFinite(entry.responseEnd)) continue;
      const key = JSON.stringify([entry.entryType, entry.name, entry.startTime, entry.responseEnd]);
      if (seen.has(key)) continue;
      const time = environment.performance.timeOrigin + entry.responseEnd;
      if (!Number.isFinite(time)) continue;
      seen.add(key);
      records.push({ id: `${session}:${++sequence}`, application, time, bytes: entry.transferSize });
    }
    if (records.length) enqueue(() => store.append(records));
  }

  enqueue(() => store.prune(now() - RETENTION));
  for (const type of ["resource", "navigation"]) {
    try {
      if (!environment.PerformanceObserver) throw new Error("Измерение трафика недоступно в этом браузере.");
      const supported = environment.PerformanceObserver.supportedEntryTypes;
      if (supported && !supported.includes(type)) throw new Error("Измерение трафика недоступно в этом браузере.");
      const observer = new environment.PerformanceObserver(list => capture(list.getEntries()));
      observer.observe({ type, buffered: true });
      observers.push(observer);
      capture(environment.performance.getEntriesByType(type));
    } catch (error) {
      // Dedicated workers have resources but no navigation timeline.
      if (type === "resource") measurementError = error;
    }
  }

  return {
    async total(period) {
      const duration = TRAFFIC_PERIODS.find(option => option.value === period)?.duration;
      if (!duration) throw new Error("Неизвестный период трафика.");
      for (const observer of observers) capture(observer.takeRecords());
      await pending;
      if (measurementError || storageError) throw measurementError || storageError;
      const until = now();
      await store.prune(until - RETENTION);
      return store.total(application, until - duration, until);
    },
    async stop() {
      for (const observer of observers) { capture(observer.takeRecords()); observer.disconnect(); }
      stopped = true;
      await pending;
    },
  };
}

export function installTrafficTracking(application, environment = globalThis) {
  const trackers = environment[TRACKERS] ||= new Map();
  if (!trackers.has(application)) trackers.set(application, createTrafficTracker(application, { environment }));
  return trackers.get(application);
}

export function readTrafficTotal(application, period) {
  return installTrafficTracking(application).total(period);
}

export function formatTrafficMegabytes(bytes) {
  return (bytes / 1_000_000).toFixed(3);
}
