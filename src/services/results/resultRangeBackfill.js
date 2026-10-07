import { mapResultObjects } from "./resultMappings.js";
import { isFmm } from "./fmmCharacteristics.js";
import { resultRangeChannels } from "./resultRanges.js";
import { RANGE_BACKFILL_FILES } from "./resultRangeBackfillCore.js";

function unusableRangeReason(ranges) {
  if (!ranges) return "неизвестная причина";
  if (ranges.state === "partial") return "неполные данные";
  if (ranges.state === "stale") return "устаревшие данные";
  if (ranges.state === "invalid") return "данные повреждены";
  if (ranges.state === "unsupported") return "неподдерживаемый формат";
  if (ranges.state === "building") return "подготовка не завершена";
  return ranges.reason || "неизвестная причина";
}

function hasResultObjects(metadata) {
  const numbs = metadata?.header?.numbs;
  return Array.isArray(numbs) && numbs.some(count => Number(count) > 0);
}

function hasCompleteSteps(metadata, lastStep) {
  const steps = metadata?.steps ?? [];
  return steps.length === lastStep + 1 && steps.every((step, index) => step.index === index);
}

function applicability(name, channels, record) {
  return channels.map(channel => {
    const quantity = channel.id.split(".")[0];
    if (name === "MH") return quantity === "M" || quantity === "H" && record.targ === 0 || quantity === "MHdot" && isFmm(record);
    if (name === "JE") return quantity === "J" || record.targ === 0;
    if (name === "Q") return record.targ === 0;
    return true;
  });
}

export function resultRangeBackfillPlan(task, name) {
  const metadata = task?.metadata?.[name];
  if (!metadata || metadata.error) throw new Error(metadata?.error || `${name}.h5: метаданные недоступны`);
  const objects = mapResultObjects(task, name, metadata.header);
  const channels = resultRangeChannels(name);
  return {
    name,
    objectIds: objects.map(item => item.record.id),
    applicability: objects.flatMap(item => applicability(name, channels, item.record)),
    objectKind: ["HS", "AS"].includes(name) ? "regions" : ["HV", "AV"].includes(name) ? "virtual" : "elements",
    timeStep: task.general.timeStep,
    lastStep: task.general.countTimeSteps,
  };
}

function runWorker(worker, payload, { signal, onProgress }) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException("Операция отменена", "AbortError")); };
    const message = event => {
      if (event.data?.id !== id) return;
      if (event.data.progress) { onProgress?.(event.data.progress); return; }
      cleanup();
      event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result);
    };
    const error = event => { cleanup(); reject(new Error(event.message || "Ошибка HDF5 worker")); };
    function cleanup() {
      worker.removeEventListener("message", message);
      worker.removeEventListener("error", error);
      signal?.removeEventListener("abort", abort);
    }
    worker.addEventListener("message", message);
    worker.addEventListener("error", error);
    signal?.addEventListener("abort", abort, { once: true });
    worker.postMessage({ id, ...payload });
  });
}

/** Backfill only truly missing HEADER/RANGES. Existing invalid/partial/stale indexes are diagnostic data and are never overwritten. */
export async function backfillTaskResultRanges(task, { signal, onProgress } = {}) {
  if (!task?.handle) throw new Error("Задание не загружено");
  const permissionPromise = task.handle.requestPermission?.({ mode: "readwrite" });
  if (!permissionPromise) throw new Error("Браузер не поддерживает запись в выбранный каталог задания");
  const permission = await permissionPromise;
  if (permission !== "granted") throw new DOMException("Нет разрешения на запись в каталог задания", "NotAllowedError");
  if (signal?.aborted) throw signal.reason ?? new DOMException("Операция отменена", "AbortError");
  const output = await task.handle.getDirectoryHandle("output3XX");
  const existingRunIds = [...new Set(RANGE_BACKFILL_FILES
    .map(name => task.metadata?.[name]?.ranges)
    .filter(ranges => ranges?.available && ranges.state === "complete")
    .map(ranges => ranges.runId))];
  if (existingRunIds.length > 1) throw new Error("Существующие HDF5 содержат разные run_id; автоматическая дозапись запрещена");
  const runId = existingRunIds[0] ?? `viewer-backfill-${crypto.randomUUID?.() ?? Date.now()}`;
  const jobs = [], created = [], problems = [];
  let readyFiles = 0, dataFiles = 0;
  for (const name of RANGE_BACKFILL_FILES) {
    const metadata = task.metadata?.[name];
    if (!task.files?.[name] || !metadata || metadata.error) continue;
    if (!hasResultObjects(metadata) || !(metadata.steps?.length)) continue;
    dataFiles++;
    const ranges = metadata.ranges;
    if (ranges?.available) { readyFiles++; continue; }
    if (ranges?.state && ranges.state !== "missing") {
      problems.push({ name, state: "problem",
        message: `минмакс присутствует, но не используется: ${unusableRangeReason(ranges)}` });
      continue;
    }
    if (!hasCompleteSteps(metadata, task.general.countTimeSteps)) {
      problems.push({ name, state: "problem", message: "неполные данные" });
      continue;
    }
    const fileHandle = await output.getFileHandle(`${name}.h5`);
    jobs.push({ name, fileHandle, plan: { ...resultRangeBackfillPlan(task, name), runId } });
  }
  if (!jobs.length) {
    if (!problems.length && dataFiles > 0 && readyFiles === dataFiles) {
      return [{ state: "all-ready", message: "Файлы уже содержат данные минимакса" }];
    }
    if (!problems.length) return [{ state: "no-data", message: "Нет данных для подготовки минимакса" }];
    return problems;
  }
  const worker = new Worker(new URL("./resultRangeBackfill.worker.js", import.meta.url), { type: "module" });
  const terminate = () => worker.terminate();
  signal?.addEventListener("abort", terminate, { once: true });
  try {
    for (let index = 0; index < jobs.length; index++) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Операция отменена", "AbortError");
      const job = jobs[index];
      onProgress?.({ phase: "file", name: job.name, file: index + 1, files: jobs.length, step: 0, total: job.plan.lastStep + 1 });
      const result = await runWorker(worker, { action: "backfill", fileHandle: job.fileHandle, plan: job.plan }, {
        signal, onProgress: progress => onProgress?.({ ...progress, name: job.name, file: index + 1, files: jobs.length }),
      });
      created.push({ name: job.name, state: "created", message: "подготовлено" });
    }
    return [...created, ...problems];
  } finally {
    signal?.removeEventListener("abort", terminate);
    worker.terminate();
  }
}
