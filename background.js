// Service worker mínimo: el popup sigue siendo default_popup (chrome.action.onClicked
// no dispara mientras haya un default_popup configurado, así que no compite con eso).
// El botón "Abrir en ventana" del popup crea/enfoca la ventana independiente
// directamente vía chrome.windows.create/update; acá solo se limpia el puntero
// {windowId, tabId} guardado en storage.local cuando el usuario cierra la pestaña
// que esa ventana está inspeccionando — el popup no puede hacerlo porque se cierra
// solo al perder el foco (justo lo que pasa al abrir la ventana nueva).
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get("inspectorWindow", (data) => {
    if (data.inspectorWindow?.tabId === tabId) {
      chrome.storage.local.remove("inspectorWindow");
    }
  });
});
