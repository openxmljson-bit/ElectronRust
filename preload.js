const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function unwrap(channel, args) {
  const r = await ipcRenderer.invoke(channel, args);
  if (r && typeof r === 'object' && 'ok' in r) {
    if (!r.ok) throw new Error(r.error || 'operation failed');
    return r.data;
  }
  return r;
}

contextBridge.exposeInMainWorld('oxj', {
  pickFile: () => ipcRenderer.invoke('pick-file'),
  loadFile: (tabId, p, force) => unwrap('load-file', { tabId, path: p, force }),
  query: (tabId, payload) => unwrap('query', { tabId, payload }),
  closeTab: (tabId) => unwrap('close-tab', tabId),
  cancelIngest: (tabId) => unwrap('cancel-ingest', tabId),
  downloadUrl: (url, auth) => unwrap('download-url', { url, auth }),
  clipboardToFile: () => unwrap('clipboard-to-file'),
  loadText: (p) => unwrap('load-text', p),
  saveText: (defaultName, text) => unwrap('save-text', { defaultName, text }),
  readFileText: (p) => unwrap('read-file-text', p),
  diffTabs: (tabA, tabB) => unwrap('diff-tabs', { tabA, tabB }),
  textToFile: (name, ext, text) => unwrap('text-to-file', { name, ext, text }),
  stats: () => ipcRenderer.invoke('stats'),
  cacheInfo: () => ipcRenderer.invoke('cache-info'),
  jqAvailable: () => ipcRenderer.invoke('jq-available'),
  buildIndex: (tabId) => unwrap('build-index', tabId),
  onIndexProgress: (cb) => ipcRenderer.on('index-progress', (_e, m) => cb(m)),
  runJq: (program, inputFile) => unwrap('run-jq', { program, inputFile }),
  clearCache: () => unwrap('clear-cache'),
  recents: () => ipcRenderer.invoke('recents'),
  clearRecents: () => ipcRenderer.invoke('clear-recents'),
  fileStat: (p) => ipcRenderer.invoke('file-stat', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onProgress: (cb) => ipcRenderer.on('ingest-progress', (_e, m) => cb(m)),
  onDocReady: (cb) => ipcRenderer.on('doc-ready', (_e, m) => cb(m)),
  onIngestError: (cb) => ipcRenderer.on('ingest-error', (_e, m) => cb(m)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, m) => cb(m)),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, m) => cb(m)),
});
