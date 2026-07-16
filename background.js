// Sin default_popup en el manifest, chrome.action.onClicked dispara en cada
// click del icono — acá se crea o enfoca la ventana independiente que antes
// abría el botón ⧉ dentro del popup clásico (ese popup ya no existe: la
// única entrada a la extensión es este listener).
function createInspectorWindow(tab) {
  const url = `${chrome.runtime.getURL("popup.html")}?tabId=${tab.id}`;
  chrome.windows.create({ url, type: "popup", width: 520, height: 720 }, (win) => {
    const tabId = win?.tabs?.[0]?.id;
    if (tabId) chrome.storage.local.set({ inspectorWindow: { windowId: win.id, tabId } });
  });
}

chrome.action.onClicked.addListener((tab) => {
  chrome.storage.local.get("inspectorWindow", (data) => {
    const w = data.inspectorWindow;
    if (!w) {
      createInspectorWindow(tab);
      return;
    }
    chrome.windows.get(w.windowId, () => {
      if (chrome.runtime.lastError) {
        createInspectorWindow(tab);
      } else {
        chrome.windows.update(w.windowId, { focused: true });
      }
    });
  });
});

// Limpia el puntero {windowId, tabId} de storage.local cuando se cierra la
// pestaña que la ventana independiente está inspeccionando — la propia
// ventana no puede hacer esta limpieza de forma confiable en su propio
// cierre, así que la hace el service worker.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get("inspectorWindow", (data) => {
    if (data.inspectorWindow?.tabId === tabId) {
      chrome.storage.local.remove("inspectorWindow");
    }
  });
});
