import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  createTrafficStore, createTrafficTracker, installTrafficTracking, formatTrafficMegabytes,
} from "../src/services/trafficService.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 12, 12);

function browser(indexedDB = new IDBFactory(), initial = {}, worker = false) {
  const observers = [];
  class Observer {
    static supportedEntryTypes = worker ? ["resource"] : ["resource", "navigation"];
    constructor(callback) { this.callback = callback; this.records = []; observers.push(this); }
    observe({ type }) { this.type = type; }
    takeRecords() { const records = this.records; this.records = []; return records; }
    disconnect() { this.disconnected = true; }
    deliver(entries) { this.callback({ getEntries: () => entries }); }
  }
  return {
    indexedDB, IDBKeyRange, observers, PerformanceObserver: Observer,
    performance: { timeOrigin: NOW - 1000, getEntriesByType: type => initial[type] || [] },
  };
}

function entry(name, bytes, extra = {}) {
  return { name: `https://example.test/clark-editor/${name}`, transferSize: bytes,
    entryType: "resource", startTime: 100, responseEnd: 500, ...extra };
}

function record(id, age, bytes, application = "editor") {
  return { id, application, time: NOW - age, bytes };
}

test("periods include their exact boundary, exclude future data and separate applications", async () => {
  const environment = browser();
  const store = createTrafficStore(environment);
  await store.append([
    record("now", 0, 5), record("day", DAY, 10), record("over-day", DAY + 1, 20),
    record("week", 7 * DAY, 40), record("over-week", 7 * DAY + 1, 80),
    record("month", 30 * DAY, 160), record("over-month", 30 * DAY + 1, 320),
    record("future", -1, 999), record("viewer", 0, 777, "viewer"),
  ]);
  const tracker = createTrafficTracker("editor", { environment, store, now: () => NOW });
  assert.equal(await tracker.total("day"), 15);
  assert.equal(await tracker.total("week"), 75);
  assert.equal(await tracker.total("month"), 315);
  await tracker.stop();
});

test("a new tab or browser session reads the persisted history", async () => {
  const indexedDB = new IDBFactory();
  const first = createTrafficTracker("viewer", {
    environment: browser(indexedDB, { resource: [entry("module.js", 1234)] }), now: () => NOW,
  });
  await first.stop();
  const reopened = createTrafficTracker("viewer", { environment: browser(indexedDB), now: () => NOW });
  assert.equal(await reopened.total("month"), 1234);
  await reopened.stop();
});

test("concurrent tabs and a worker retain every transfer without overwriting totals", async () => {
  const indexedDB = new IDBFactory();
  const trackers = Array.from({ length: 12 }, (_, index) => createTrafficTracker("editor", {
    environment: browser(indexedDB, { resource: [entry("same-module.js", 100 + index)] }, index === 11),
    now: () => NOW,
  }));
  await Promise.all(trackers.map(tracker => tracker.stop()));
  assert.equal(await createTrafficStore(browser(indexedDB)).total("editor", NOW - DAY, NOW), 1266);
});

test("navigation and resources count once across buffered replay and takeRecords", async () => {
  const resource = entry("main.js", 1000);
  const navigation = entry("", 300, { entryType: "navigation", startTime: 0, responseEnd: 50 });
  const environment = browser(undefined, { resource: [resource], navigation: [navigation] });
  const tracker = createTrafficTracker("editor", { environment, now: () => NOW });
  const resources = environment.observers.find(observer => observer.type === "resource");
  resources.deliver([resource, { ...resource }]);
  resources.records.push(entry("late.wasm", 4000, { startTime: 200, responseEnd: 700 }));
  assert.equal(await tracker.total("day"), 5300);
  assert.equal(await tracker.total("day"), 5300);
  await tracker.stop();
});

test("network size is used; cache, hidden sizes, local files and invalid sizes add nothing", async () => {
  const entries = [
    entry("gzip.js", 1200, { encodedBodySize: 900, decodedBodySize: 5000 }),
    entry("revalidated.js", 300), entry("cache.js", 0, { decodedBodySize: 9000 }),
    entry("external.js", 0), entry("bad.js", NaN), entry("negative.js", -100),
    entry("blob", 2000, { name: "blob:https://example.test/local-file" }),
    entry("file", 3000, { name: "file:///task/result.h5" }),
    entry("data", 4000, { name: "data:application/octet-stream;base64,AAAA" }),
  ];
  const tracker = createTrafficTracker("viewer", { environment: browser(undefined, { resource: entries }), now: () => NOW });
  assert.equal(await tracker.total("day"), 1500);
  await tracker.stop();
});

test("workers share the application's history and do not need navigation entries", async () => {
  const indexedDB = new IDBFactory();
  const worker = createTrafficTracker("viewer", {
    environment: browser(indexedDB, { resource: [entry("codec.wasm", 5000)] }, true), now: () => NOW,
  });
  assert.equal(await worker.total("day"), 5000);
  await worker.stop();
  const editor = createTrafficTracker("editor", { environment: browser(indexedDB), now: () => NOW });
  assert.equal(await editor.total("month"), 0);
  await editor.stop();
});

test("retention deletes old records but retains the complete last 30 days", async () => {
  const environment = browser();
  const store = createTrafficStore(environment);
  await store.append([record("old", 32 * DAY, 10), record("boundary", 31 * DAY, 20),
    record("month", 30 * DAY, 30), record("viewer-old", 40 * DAY, 40, "viewer")]);
  const tracker = createTrafficTracker("editor", { environment, store, now: () => NOW });
  assert.equal(await tracker.total("month"), 30);
  assert.equal(await store.total("editor", 0, NOW), 50);
  assert.equal(await store.total("viewer", 0, NOW), 0);
  await tracker.stop();
});

test("duplicate initialization returns the existing observers and counts no extra bytes", async () => {
  const environment = browser(undefined, { resource: [entry("main.js", 1000)] });
  environment.performance.timeOrigin = Date.now() - 1000;
  const first = installTrafficTracking("editor", environment);
  assert.equal(installTrafficTracking("editor", environment), first);
  assert.equal(environment.observers.length, 2);
  assert.equal(await first.total("day"), 1000);
  await first.stop();
});

test("storage failures stay isolated from application startup and are reported when queried", async () => {
  const environment = browser();
  environment.indexedDB = { open() { throw new DOMException("Disabled", "SecurityError"); } };
  const tracker = createTrafficTracker("editor", { environment, now: () => NOW });
  await assert.rejects(tracker.total("day"), /Disabled/);
  await tracker.stop();
});

test("unsupported measurement is not reported as zero traffic", async () => {
  const environment = browser();
  environment.PerformanceObserver = undefined;
  const tracker = createTrafficTracker("editor", { environment, now: () => NOW });
  await assert.rejects(tracker.total("day"), /Измерение трафика недоступно/);
  await tracker.stop();
});

test("queries use the time of download, not the time of opening About", async () => {
  const old = entry("yesterday.js", 2000, { responseEnd: 100 });
  const environment = browser(undefined, { resource: [old] });
  environment.performance.timeOrigin = NOW - DAY - 200;
  const tracker = createTrafficTracker("editor", { environment, now: () => NOW });
  assert.equal(await tracker.total("day"), 0);
  assert.equal(await tracker.total("week"), 2000);
  await tracker.stop();
});

test("decimal megabytes have three fractional digits", () => {
  assert.equal(formatTrafficMegabytes(0), "0.000");
  assert.equal(formatTrafficMegabytes(1000), "0.001");
  assert.equal(formatTrafficMegabytes(1_000_000), "1.000");
});
