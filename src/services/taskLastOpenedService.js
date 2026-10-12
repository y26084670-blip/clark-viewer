export const LAST_OPENED_TASK_FILES = Object.freeze({
  editor: "clark.editor-last-task.json",
  viewer: "clark.viewer-last-task.json",
});

export function sortTaskDirectories(entries) {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }));
}

const queues = new WeakMap();
function enqueue(root, filename, action) {
  let files = queues.get(root);
  if (!files) queues.set(root, files = new Map());
  const pending = (files.get(filename) ?? Promise.resolve()).catch(() => {}).then(action);
  files.set(filename, pending);
  return pending;
}

function parseRecord(text) {
  const record = JSON.parse(text);
  if (record?.version !== 1) throw new Error("Неизвестный формат служебного файла.");
  if (record.projectIndex === null && record.taskIndex === null) return null;
  if (![record.projectIndex, record.taskIndex].every(value => Number.isSafeInteger(value) && value >= 1)) {
    throw new Error("Некорректные номера проекта или задания.");
  }
  return { projectIndex: record.projectIndex, taskIndex: record.taskIndex };
}

async function writeRecord(root, filename, positions, isCurrent) {
  if (!isCurrent()) return false;
  const file = await root.getFileHandle(filename, { create: true });
  if (!isCurrent()) return false;
  const writable = await file.createWritable();
  try {
    if (isCurrent()) {
      await writable.write(JSON.stringify({ version: 1, projectIndex: null, taskIndex: null, ...positions }) + "\n");
      if (isCurrent()) {
        await writable.close();
        return true;
      }
    }
    await writable.abort();
    return false;
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

// Each root selection is a session. Delayed reads and writes cannot update a later session.
export function createLastOpenedTaskHistory({ app, onChange, onNotice }) {
  const filename = LAST_OPENED_TASK_FILES[app];
  if (!filename) throw new Error("Неизвестное приложение.");
  let root = null, session = 0, revision = 0;
  const current = (handle, generation, request) => root === handle && session === generation && revision === request;
  const notice = (action, error) => onNotice(`Не удалось ${action} отметку последнего задания: ${error?.message || String(error)}`);

  return {
    async open(handle) {
      root = handle;
      const generation = ++session, request = ++revision;
      const isCurrent = () => current(handle, generation, request);
      onChange(null);
      onNotice("");
      return enqueue(handle, filename, async () => {
        if (!isCurrent()) return;
        try {
          let positions;
          try {
            const file = await handle.getFileHandle(filename);
            positions = parseRecord(await (await file.getFile()).text());
          } catch (error) {
            if (error?.name !== "NotFoundError") throw error;
            try {
              await writeRecord(handle, filename, null, isCurrent);
            } catch (writeError) {
              if (isCurrent()) notice("сохранить", writeError);
            }
            positions = null;
          }
          if (isCurrent()) onChange(positions);
        } catch (error) {
          if (isCurrent()) notice("прочитать", error);
        }
      });
    },

    capture(projects, projectName, tasks, task) {
      if (!root || task?.isDemo) return null;
      const projectIndex = projects.findIndex(item => item.name === projectName) + 1;
      const taskIndex = tasks.findIndex(item => item.handle === task?.handle) + 1;
      if (!projectIndex || !taskIndex) return null;
      return { root, session, projectIndex, taskIndex };
    },

    async remember(snapshot) {
      if (!snapshot || snapshot.root !== root || snapshot.session !== session) return false;
      const handle = root, generation = session, request = ++revision;
      const isCurrent = () => current(handle, generation, request);
      const positions = { projectIndex: snapshot.projectIndex, taskIndex: snapshot.taskIndex };
      onChange(positions);
      onNotice("");
      return enqueue(handle, filename, async () => {
        try {
          return await writeRecord(handle, filename, positions, isCurrent);
        } catch (error) {
          if (isCurrent()) notice("сохранить", error);
          return false;
        }
      });
    },

    dispose() { root = null; session++; revision++; },
  };
}
