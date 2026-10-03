// Use the browser's local wall clock, as in the task owner's file manager.
// The short prefix is supplied by the tab independently of its translated title.
export function movieFilename(prefix, date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("Некорректная дата создания GIF");
  const term = /^[a-z0-9_-]{1,32}$/i.test(String(prefix ?? "")) ? String(prefix) : "movie";
  const pad = value => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `${term}_${day}_${time}.gif`;
}
