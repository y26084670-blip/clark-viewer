// Clipboard access starts directly in the button's user activation. Inserted
// blocks use the existing image/text schema and remain self-contained in HTML.
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"];
const MAX_IMAGE_DATA_LENGTH = 16 * 1024 * 1024;

export async function protocolClipboardImage(blob, { signal, decode = globalThis.createImageBitmap,
  createCanvas = () => document.createElement("canvas") } = {}) {
  signal?.throwIfAborted();
  if (!blob?.size) throw new Error("В буфере обмена нет рисунка.");
  if (blob.size > MAX_IMAGE_DATA_LENGTH) throw new Error("Рисунок слишком большой для протокола. Уменьшите его размер.");
  let bitmap;
  try { bitmap = await decode(blob); }
  catch (failure) { signal?.throwIfAborted(); throw new Error("Не удалось прочитать рисунок из буфера обмена.", { cause: failure }); }
  try {
    signal?.throwIfAborted();
    const { width, height } = bitmap;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) {
      throw new Error("Размер рисунка для протокола не должен превышать 8192 × 8192 пикселей.");
    }
    const canvas = createCanvas(); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Браузер не смог подготовить рисунок для протокола.");
    context.drawImage(bitmap, 0, 0);
    const dataUrl = canvas.toDataURL("image/png");
    if (dataUrl.length > MAX_IMAGE_DATA_LENGTH) throw new Error("Рисунок слишком большой для протокола. Уменьшите его размер.");
    if (!dataUrl.startsWith("data:image/png;base64,")) throw new Error("Браузер не смог подготовить рисунок для протокола.");
    return { kind: "image", dataUrl, width, height };
  } finally { bitmap.close(); }
}

export async function readProtocolClipboard(kind, { signal, clipboard = globalThis.navigator?.clipboard,
  image = protocolClipboardImage } = {}) {
  signal?.throwIfAborted();
  if (!["image", "text"].includes(kind)) throw new Error("Неизвестный вид вставки из буфера обмена.");
  if (typeof clipboard?.[kind === "image" ? "read" : "readText"] !== "function") {
    throw new Error("Чтение буфера обмена недоступно. Откройте Viewer по HTTPS или localhost в браузере с поддержкой вставки.");
  }
  try {
    let content;
    if (kind === "text") {
      const text = await clipboard.readText();
      signal?.throwIfAborted();
      if (!text.trim()) throw new Error("В буфере обмена нет текста.");
      if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw new Error("Текст из буфера обмена превышает 2 МиБ.");
      content = { kind: "text", text };
    } else {
      const items = await clipboard.read();
      signal?.throwIfAborted();
      for (const item of items) {
        const type = IMAGE_TYPES.find(value => item.types.includes(value));
        if (!type) continue;
        const blob = await item.getType(type);
        signal?.throwIfAborted();
        content = await image(blob, { signal });
        break;
      }
      if (!content) throw new Error("В буфере обмена нет рисунка. Скопируйте изображение и повторите вставку.");
    }
    signal?.throwIfAborted();
    return { id: `clipboard-${kind}-${crypto.randomUUID()}`, title: kind === "image" ? "Рисунок из буфера" : "Текст из буфера",
      comment: "", ...content };
  } catch (failure) {
    signal?.throwIfAborted();
    if (["NotAllowedError", "SecurityError"].includes(failure.name)) {
      throw new Error("Разрешите Viewer чтение буфера обмена в браузере и повторите вставку.");
    }
    if (failure.name === "NotFoundError") throw new Error(kind === "image" ? "В буфере обмена нет рисунка." : "В буфере обмена нет текста.");
    throw failure;
  }
}
