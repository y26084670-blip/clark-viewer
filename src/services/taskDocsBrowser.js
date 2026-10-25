// Called synchronously from the user's click, after the document has loaded.
// Keep the original HTML so scripts, controls and downloads work in its own tab.
export function openTaskHtmlDocument(source) {
  const tab = window.open("", "_blank");
  if (!tab) throw new Error("Браузер заблокировал вкладку документа. Разрешите всплывающие окна и повторите открытие.");
  let url;
  try {
    tab.opener = null;
    url = URL.createObjectURL(new Blob([source], { type: "text/html;charset=utf-8" }));
    tab.location.replace(url);
    // A task switch or component unmount must not invalidate a still-open tab.
    // Revoking on load would also break Reload in the document's browser tab.
    const timer = window.setInterval(() => {
      if (!tab.closed) return;
      window.clearInterval(timer);
      URL.revokeObjectURL(url);
    }, 1000);
  } catch (error) {
    if (url) URL.revokeObjectURL(url);
    tab.close();
    throw error;
  }
}
