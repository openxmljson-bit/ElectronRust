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
  loadFile: (tabId, p, force, format) => unwrap('load-file', { tabId, path: p, force, format }),
  query: (tabId, payload) => unwrap('query', { tabId, payload }),
  closeTab: (tabId) => unwrap('close-tab', tabId),
  cancelIngest: (tabId) => unwrap('cancel-ingest', tabId),
  downloadUrl: (url, auth) => unwrap('download-url', { url, auth }),
  httpRequest: (req) => unwrap('http-request', req),
  clipboardToFile: () => unwrap('clipboard-to-file'),
  setMenuState: (s) => ipcRenderer.send('menu-state', s),
  openHtmlInBrowser: (html) => unwrap('open-html', html),
  project: (args) => unwrap('project', args),
  onProjectProgress: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('project-progress', h);
    return () => ipcRenderer.removeListener('project-progress', h);
  },
  cancelProject: () => ipcRenderer.send('cancel-project'),
  loadText: (p, full) => unwrap('load-text', { path: p, full: !!full }),
  saveText: (defaultName, text) => unwrap('save-text', { defaultName, text }),
  readFileText: (p) => unwrap('read-file-text', p),
  diffTabs: (tabA, tabB) => unwrap('diff-tabs', { tabA, tabB }),
  textToFile: (name, ext, text) => unwrap('text-to-file', { name, ext, text }),
  stats: () => ipcRenderer.invoke('stats'),
  cacheInfo: () => ipcRenderer.invoke('cache-info'),
  buildIndex: (tabId) => unwrap('build-index', tabId),
  onIndexProgress: (cb) => ipcRenderer.on('index-progress', (_e, m) => cb(m)),
  clearCache: () => unwrap('clear-cache'),
  engineMode: () => ipcRenderer.invoke('engine-mode'),
  setEngineMode: (mode) => unwrap('set-engine-mode', mode),
  jqAvailable: () => ipcRenderer.invoke('jq-available'),
  jqRun: (tabId, filter, flags) => unwrap('jq-run', { tabId, filter, flags }),
  duckInvoke: (method, params) => unwrap('duck-invoke', { method, params }),
  onDuckEvent: (cb) => ipcRenderer.on('duck-event', (_e, ev) => cb(ev)),
  noteRecent: (p, format) => ipcRenderer.invoke('note-recent', { path: p, format }),
  recents: () => ipcRenderer.invoke('recents'),
  clearRecents: () => ipcRenderer.invoke('clear-recents'),
  removeRecent: (p) => ipcRenderer.invoke('remove-recent', p),
  license: {
    status: () => ipcRenderer.invoke('license-status'),
    activate: (email, key) => unwrap('license-activate', { email, key }),
    clear: () => ipcRenderer.invoke('license-clear'),
    store: () => ipcRenderer.invoke('open-store'),
    onRevoked: (cb) => ipcRenderer.on('license-revoked', () => cb()),
  },
  fileStat: (p) => ipcRenderer.invoke('file-stat', p),
  revealItem: (p) => ipcRenderer.invoke('reveal-item', p),
  onRecentsChanged: (cb) => ipcRenderer.on('recents-changed', () => cb()),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onProgress: (cb) => ipcRenderer.on('ingest-progress', (_e, m) => cb(m)),
  onDocReady: (cb) => ipcRenderer.on('doc-ready', (_e, m) => cb(m)),
  onIngestError: (cb) => ipcRenderer.on('ingest-error', (_e, m) => cb(m)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, m) => cb(m)),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, m) => cb(m)),
});
