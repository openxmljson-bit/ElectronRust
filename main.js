// NARIKJSON — Electron main process.
// Tabbed architecture: every tab owns its own Rust engine `serve` process
// (and, while loading, an `ingest` process), keyed by tabId.
const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, nativeTheme, shell, safeStorage, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const readline = require('readline');
const os = require('os');
const si = require('systeminformation');
const { DuckClient } = require('./duck-client');

// ---------------- DuckDB engine (delimited/tabular files) ----------------
// Lazily booted on first delimited open. Events are forwarded to the renderer.
let duck = null;
function duckEngine() {
  if (!duck) {
    duck = new DuckClient();
    duck.on('engine-event', (event) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('duck-event', event);
      }
    });
  }
  return duck;
}

// The macOS application menu (bold title, About / Hide / Quit) uses the app
// name. Keep it the clean "NARIKJSON" everywhere (folder path, dock, window);
// the braced "{N}ARIKJSON" branding is applied only to the menu item labels
// in buildMenu(), not to the app name itself.
app.setName('NARIKJSON');

// macOS uses "free" RAM aggressively for file caching, so os.freemem() is
// near-useless as an availability signal. systeminformation's mem.available
// (free + reclaimable cache) matches Activity Monitor's practical headroom.
async function availableMemBytes() {
  try {
    const m = await si.mem();
    return m.available || m.free || os.freemem();
  } catch {
    return os.freemem();
  }
}

const MAX_RECENTS = 15;

// Renderer-driven enable/disable state for the Export menu. Persisted here so
// rebuilds of the menu (buildMenu runs on many events) keep the right state.
let menuState = { hasDoc: false, hasMatches: false, hasTwoDocs: false };

// The currently running JSON DeepDive projection process (for cancellation).
let projProc = null;

const sessions = new Map(); // tabId -> { proc, pending: Map, file, dbPath, wc }
const ingests = new Map();  // tabId -> { proc, dbPath, wc, file }
const lastDb = new Map();   // tabId -> { dbPath, file, wc } — for auto-revival
const reviving = new Map(); // tabId -> Promise — serializes engine restarts
let reqSeq = 0;

function engineLog(line) {
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'engine.log'),
      new Date().toISOString() + ' ' + line + '\n'
    );
  } catch {}
}

// ---------------- auto-update (manual, Help → Check for Updates) ----------------
// Reads published releases from the public ElectronRust-Releases repo (see the
// "publish" block in package.json). No automatic checks — user-initiated only.
let updaterWired = false;
let updateBusy = false;

function wireUpdater() {
  if (updaterWired) return;
  updaterWired = true;
  autoUpdater.autoDownload = false;           // ask the user before downloading
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (err) => {
    updateBusy = false;
    const win = BrowserWindow.getFocusedWindow();
    dialog.showMessageBox(win, {
      type: 'error',
      message: 'Update check failed',
      detail: String((err && err.message) || err),
    });
  });
  autoUpdater.on('update-not-available', () => {
    updateBusy = false;
    const win = BrowserWindow.getFocusedWindow();
    dialog.showMessageBox(win, {
      type: 'info',
      message: "You're up to date",
      detail: 'NARIKJSON ' + app.getVersion() + ' is the latest version.',
    });
  });
  autoUpdater.on('update-available', async (info) => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: 'Update available',
      detail: 'Version ' + info.version + ' is available (you have ' + app.getVersion() + '). Download it now?',
    });
    if (res.response === 0) autoUpdater.downloadUpdate();
    else updateBusy = false;
  });
  autoUpdater.on('update-downloaded', async (info) => {
    updateBusy = false;
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: 'Update ready',
      detail: 'Version ' + info.version + ' has been downloaded. Restart to install?',
    });
    if (res.response === 0) setImmediate(() => autoUpdater.quitAndInstall());
  });
}

async function checkForUpdates(bw) {
  const win = bw || BrowserWindow.getFocusedWindow();
  if (!app.isPackaged) {
    dialog.showMessageBox(win, {
      type: 'info',
      message: 'Updates unavailable in development',
      detail: 'Auto-update only works in an installed build (DMG / installer / AppImage).',
    });
    return;
  }
  if (updateBusy) return;
  updateBusy = true;
  wireUpdater();
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    updateBusy = false; // 'error' event usually fires too, but guard anyway
  }
}

// ---------------- engine / paths ----------------
function engineBin() {
  const name = process.platform === 'win32' ? 'openjsonxml-engine.exe' : 'openjsonxml-engine';
  const dev = path.join(__dirname, 'rust-engine', 'target', 'release', name);
  if (fs.existsSync(dev)) return dev;
  const packaged = path.join(process.resourcesPath || '', 'engine', name);
  if (fs.existsSync(packaged)) return packaged;
  return null;
}

function dbCacheDir() {
  const d = path.join(app.getPath('userData'), 'dbcache');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function downloadsDir() {
  const d = path.join(app.getPath('userData'), 'downloads');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// YAML isn't a native engine format — parse it and write a temp JSON that the
// engine ingests. The tab still tracks the original .yaml path.
function yamlToTempJson(yamlPath) {
  let yaml;
  try { yaml = require('js-yaml'); }
  catch { throw new Error('YAML support needs a dependency — run: npm install'); }
  let obj;
  try { obj = yaml.load(fs.readFileSync(yamlPath, 'utf8')); }
  catch (e) { throw new Error('Could not parse YAML: ' + String((e && e.message) || e).split('\n')[0]); }
  const out = path.join(downloadsDir(), 'yamlconv_' + Date.now() + '.json');
  // Pretty-print so the Source view reflects the structure (arrays included),
  // not a minified single line.
  fs.writeFileSync(out, JSON.stringify(obj === undefined ? null : obj, null, 2));
  return out;
}
function isYamlFile(p) {
  const e = path.extname(p).toLowerCase();
  return e === '.yaml' || e === '.yml';
}

function dbPathFor(file) {
  const st = fs.statSync(file);
  const h = crypto
    .createHash('sha1')
    .update(`${file}|${st.size}|${Math.floor(st.mtimeMs)}`)
    .digest('hex')
    .slice(0, 20);
  return path.join(dbCacheDir(), h + '.db');
}

// ---------------- recents ----------------
function recentsPath() {
  return path.join(app.getPath('userData'), 'recents.json');
}
function getRecents() {
  try {
    return JSON.parse(fs.readFileSync(recentsPath(), 'utf8')).filter((r) => fs.existsSync(r.path));
  } catch {
    return [];
  }
}
// Notify every window so all three recents surfaces re-render.
function emitRecentsChanged() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('recents-changed');
  }
}

// Recents holds only real files the user opened/dropped. Everything the app
// generates — URL responses, converted YAML, clipboard imports, exports and
// fragment temps — lives in the internal downloads dir or the OS temp dir and
// is treated as scratch, so it never enters Recents.
function isTempPath(file) {
  const base = path.basename(file);
  if (base.startsWith('oxj_') || base.startsWith('narik_')) return true;
  try { if (file.startsWith(os.tmpdir() + path.sep)) return true; } catch {}
  if (file.startsWith(downloadsDir() + path.sep)) return true;
  return false;
}

function addRecent(file, format) {
  if (!file || isTempPath(file)) return;
  let list = getRecents().filter((r) => r.path !== file);
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}
  const entry = { path: file, size, at: Date.now() };
  // Remember a forced format (e.g. a .txt opened as a delimited table) so
  // reopening from Recents restores the table view instead of plain text.
  if (format === 'csv' || format === 'tsv') entry.format = format;
  list.unshift(entry);
  list = list.slice(0, MAX_RECENTS);
  try { fs.writeFileSync(recentsPath(), JSON.stringify(list)); } catch {}
  buildMenu();
  emitRecentsChanged();
}

function clearRecents() {
  try { fs.unlinkSync(recentsPath()); } catch {}
  buildMenu();
  emitRecentsChanged();
}

function removeRecent(file) {
  const list = getRecents().filter((r) => r.path !== file);
  try { fs.writeFileSync(recentsPath(), JSON.stringify(list)); } catch {}
  buildMenu();
  emitRecentsChanged();
}

// At startup, drop entries whose file is confirmed missing (moved/deleted).
function pruneRecent() {
  try {
    const raw = JSON.parse(fs.readFileSync(recentsPath(), 'utf8'));
    const kept = raw.filter((r) => {
      try { return fs.existsSync(r.path); } catch { return true; } // keep on transient error
    });
    if (kept.length !== raw.length) fs.writeFileSync(recentsPath(), JSON.stringify(kept));
  } catch {}
  buildMenu();
}

// ---------------- bookmarks (saved URL requests) ----------------
// A bookmark stores a full request (the same shape the renderer's builder uses:
// method/url/params/auth/headers/body) plus a name and usage metadata. Auth
// secrets (bearer token, basic password, api-key value) are never written in
// plaintext — they're encrypted with the OS keychain via safeStorage and stored
// as a base64 "enc:" blob, decrypted only when a bookmark is opened.
function bookmarksPath() {
  return path.join(app.getPath('userData'), 'bookmarks.json');
}
function canEncrypt() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}
// Fields inside request.auth that hold a secret, by auth type.
const AUTH_SECRET_FIELDS = { bearer: ['token'], basic: ['pass'], apikey: ['value', 'token'] };
function encField(v) {
  if (typeof v !== 'string' || v === '' || !canEncrypt()) return v;
  try { return 'enc:' + safeStorage.encryptString(v).toString('base64'); } catch { return v; }
}
function decField(v) {
  if (typeof v !== 'string' || !v.startsWith('enc:')) return v;
  try { return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); } catch { return ''; }
}
// Walk the secret fields for a request's auth and apply fn (enc/dec) in place.
function mapAuthSecrets(request, fn) {
  const a = request && request.auth;
  if (!a || !a.type) return request;
  for (const f of AUTH_SECRET_FIELDS[a.type] || []) {
    if (f in a) a[f] = fn(a[f]);
  }
  return request;
}
function readBookmarks() {
  try { return JSON.parse(fs.readFileSync(bookmarksPath(), 'utf8')); } catch { return []; }
}
function writeBookmarks(list) {
  try { fs.writeFileSync(bookmarksPath(), JSON.stringify(list)); } catch {}
}
function emitBookmarksChanged() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('bookmarks-changed');
  }
}
// Return bookmarks with secrets decrypted (for the renderer to open/edit).
function getBookmarks() {
  return readBookmarks().map((b) => ({ ...b, request: mapAuthSecrets({ ...b.request, auth: { ...(b.request && b.request.auth) } }, decField) }));
}
function newBookmarkId() {
  return 'bm_' + crypto.randomBytes(6).toString('hex');
}
// Add or update. If id matches an existing bookmark, replace it; otherwise
// insert. Secrets are encrypted before persisting.
function saveBookmark(bm) {
  const list = readBookmarks();
  const now = Date.now();
  const request = mapAuthSecrets({ ...bm.request, auth: { ...(bm.request && bm.request.auth) } }, encField);
  const idx = bm.id ? list.findIndex((x) => x.id === bm.id) : -1;
  if (idx >= 0) {
    list[idx] = { ...list[idx], name: bm.name, request, pinned: !!bm.pinned, updatedAt: now };
  } else {
    list.unshift({
      id: bm.id || newBookmarkId(), name: bm.name, request,
      pinned: !!bm.pinned, createdAt: now, updatedAt: now, lastUsedAt: 0, useCount: 0,
    });
  }
  writeBookmarks(list);
  emitBookmarksChanged();
  return list.find((x) => x.name === bm.name) || null;
}
function updateBookmarkMeta(id, patch) {
  const list = readBookmarks();
  const b = list.find((x) => x.id === id);
  if (!b) return;
  if (patch.name != null) b.name = patch.name;
  if (patch.pinned != null) b.pinned = !!patch.pinned;
  if (patch.touch) { b.lastUsedAt = Date.now(); b.useCount = (b.useCount || 0) + 1; }
  writeBookmarks(list);
  emitBookmarksChanged();
}
function removeBookmark(id) {
  writeBookmarks(readBookmarks().filter((x) => x.id !== id));
  emitBookmarksChanged();
}
function clearBookmarks() {
  try { fs.unlinkSync(bookmarksPath()); } catch {}
  emitBookmarksChanged();
}

// ---------------- cache management ----------------
// Sidecar index (dbcache/index.json) maps each DB file to its source path and
// last-used time, enabling orphan detection and LRU pruning.
function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
}

function cacheIndexPath() {
  return path.join(dbCacheDir(), 'index.json');
}
function readCacheIndex() {
  try { return JSON.parse(fs.readFileSync(cacheIndexPath(), 'utf8')); } catch { return {}; }
}
function writeCacheIndex(ix) {
  try { fs.writeFileSync(cacheIndexPath(), JSON.stringify(ix)); } catch {}
}
function indexTouch(dbPath, source) {
  const ix = readCacheIndex();
  const key = path.basename(dbPath);
  const prev = ix[key] || {};
  ix[key] = { ...prev, source: source || prev.source || null, lastUsed: Date.now() };
  writeCacheIndex(ix);
}

// Record how much a built FTS index added to a DB (measured as file growth).
function setIndexBytes(dbPath, bytes) {
  const ix = readCacheIndex();
  const key = path.basename(dbPath);
  const prev = ix[key] || {};
  ix[key] = { ...prev, indexBytes: Math.max(0, Math.round(bytes)) };
  writeCacheIndex(ix);
}

function inUseDbs() {
  const s = new Set();
  for (const [, v] of sessions) { if (v.dbPath) s.add(v.dbPath); }
  for (const [, v] of ingests) { if (v.dbPath) s.add(v.dbPath); }
  return s;
}

function listCacheDbs() {
  const dir = dbCacheDir();
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.db')) continue;
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p);
      out.push({ file: f, path: p, size: st.size, mtime: st.mtimeMs });
    } catch {}
  }
  return out;
}

function cacheTotalSize() {
  return listCacheDbs().reduce((s, d) => s + d.size, 0);
}

function cacheSizeLimitBytes() {
  const gb = getSettings().cacheLimitGb;
  if (gb === 0) return Infinity; // unlimited
  return (gb || 20) * 1024 * 1024 * 1024;
}

// Prune: (1) always drop orphaned/stale DBs, (2) enforce the size cap via LRU,
// (3) sweep temp downloads older than 7 days. Never touches in-use DBs.
function pruneCache() {
  const ix = readCacheIndex();
  const used = inUseDbs();
  let freed = 0;
  const remove = (d) => {
    try { fs.unlinkSync(d.path); freed += d.size; } catch {}
    delete ix[d.file];
  };

  const live = [];
  for (const d of listCacheDbs()) {
    if (used.has(d.path)) { live.push(d); continue; }
    const entry = ix[d.file];
    if (entry && entry.source) {
      let orphan = false;
      try {
        fs.statSync(entry.source); // source still exists?
        const expected = path.basename(dbPathFor(entry.source));
        if (expected !== d.file) orphan = true; // source changed -> stale DB
      } catch { orphan = true; } // source deleted/moved
      if (orphan) { remove(d); continue; }
    }
    live.push(d);
  }

  const cap = cacheSizeLimitBytes();
  let total = live.reduce((s, d) => s + d.size, 0);
  if (total > cap) {
    const candidates = live
      .filter((d) => !used.has(d.path))
      .sort((a, b) => {
        const ka = ix[a.file] ? (ix[a.file].lastUsed || 0) : -1; // unknown first
        const kb = ix[b.file] ? (ix[b.file].lastUsed || 0) : -1;
        return ka - kb;
      });
    for (const d of candidates) {
      if (total <= cap) break;
      remove(d);
      total -= d.size;
    }
  }
  writeCacheIndex(ix);

  // Temp downloads older than 7 days (clipboard imports, fetched URLs, reports).
  try {
    const dl = downloadsDir();
    const now = Date.now();
    for (const f of fs.readdirSync(dl)) {
      const p = path.join(dl, f);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs > 7 * 24 * 3600 * 1000) {
          freed += st.size;
          fs.unlinkSync(p);
        }
      } catch {}
    }
  } catch {}
  return freed;
}

// Delete everything except DBs belonging to currently open tabs.
function clearCache() {
  const used = inUseDbs();
  let freed = 0;
  for (const d of listCacheDbs()) {
    if (used.has(d.path)) continue;
    try { fs.unlinkSync(d.path); freed += d.size; } catch {}
  }
  try { fs.unlinkSync(cacheIndexPath()); } catch {}
  try {
    const dl = downloadsDir();
    for (const f of fs.readdirSync(dl)) {
      const p = path.join(dl, f);
      try {
        const st = fs.statSync(p);
        fs.unlinkSync(p);
        freed += st.size;
      } catch {}
    }
  } catch {}
  return freed;
}

// Strip FTS search indexes from every cached DB (engine drops + VACUUMs).
async function deleteSearchIndexes(bw) {
  const win = bw || BrowserWindow.getFocusedWindow();
  const res = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Delete Indexes', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Delete all search indexes?',
    detail:
      'Removes the full-text search index from every cached document and reclaims its disk space. ' +
      'Searches fall back to the (parallel) scan; indexes can be rebuilt any time from the search bar.',
  });
  if (res.response !== 0) return;
  const bin = engineBin();
  if (!bin) return;
  const before = cacheTotalSize();
  for (const d of listCacheDbs()) {
    await new Promise((resolve) => {
      const proc = spawn(bin, ['deindex', '--db', d.path]);
      const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(); }, 600000);
      proc.on('exit', () => { clearTimeout(timer); resolve(); });
      proc.on('error', () => { clearTimeout(timer); resolve(); });
    });
    setIndexBytes(d.path, 0);
  }
  const freed = Math.max(0, before - cacheTotalSize());
  buildMenu();
  dialog.showMessageBox(win, {
    type: 'info',
    message: 'Search indexes deleted',
    detail: freed > 0 ? 'Freed ' + fmtBytes(freed) + '.' : 'No indexes were present.',
  });
}

async function clearCacheInteractive(bw) {
  const win = bw || BrowserWindow.getFocusedWindow();
  const total = cacheTotalSize();
  const res = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Clear Cache', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Clear the document cache?',
    detail:
      'Current cache size: ' + fmtBytes(total) +
      '.\nDatabases for currently open tabs are kept. Cleared files simply re-ingest the next time you open them.',
  });
  if (res.response !== 0) return;
  const freed = clearCache();
  buildMenu();
  dialog.showMessageBox(win, {
    type: 'info',
    message: 'Cache cleared',
    detail: 'Freed ' + fmtBytes(freed) + '.',
  });
}

// ---------------- settings & theme ----------------
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function getSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; }
}
function saveSetting(key, value) {
  const s = getSettings();
  s[key] = value;
  try { fs.writeFileSync(settingsPath(), JSON.stringify(s)); } catch {}
}
function effectiveTheme() {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}
function broadcastTheme() {
  const eff = effectiveTheme();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('theme', eff);
  }
}
function setThemePref(v) {
  saveSetting('theme', v);
  nativeTheme.themeSource = v; // 'system' | 'light' | 'dark'
  broadcastTheme();
  buildMenu();
}

// ---------------- files-served stats ----------------
function statsPath() {
  return path.join(app.getPath('userData'), 'stats.json');
}
function getStats() {
  try { return JSON.parse(fs.readFileSync(statsPath(), 'utf8')); } catch { return {}; }
}
function bumpStat(format) {
  const key = String(format || 'json').toUpperCase();
  if (['XLSX', 'XLS', 'XLSM', 'XLTX', 'XLSB'].includes(key)) return; // Excel unsupported
  const s = getStats();
  s[key] = (s[key] || 0) + 1;
  try { fs.writeFileSync(statsPath(), JSON.stringify(s)); } catch {}
}

// ---------------- per-tab process management ----------------
function killSession(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);
  try { s.proc.kill(); } catch {}
  for (const [, p] of s.pending) p.reject(new Error('engine stopped'));
  s.pending.clear();
}

function killIngest(tabId, deleteDb) {
  const g = ingests.get(tabId);
  if (!g) return;
  ingests.delete(tabId);
  try { g.proc.kill('SIGKILL'); } catch {}
  if (deleteDb && g.dbPath) {
    const p = g.dbPath;
    setTimeout(() => { try { fs.unlinkSync(p); } catch {} }, 300);
  }
}

// Hybrid engine decision ("like the previous app"): files that comfortably
// fit in RAM open with the mmap-based in-memory engine (no ingest at all);
// bigger ones stream into SQLite.
const MEM_MAX_BYTES = 64 * 1024 * 1024 * 1024; // absolute safety ceiling (raised for testing)
const MEM_FREE_FRACTION = 2.5;                 // up to 2.5× available RAM (mmap pages on demand; testing)

// The Rust engine now only handles hierarchical formats (JSON/NDJSON/XML/YAML);
// all delimited/tabular files are routed to the DuckDB engine by the renderer.
async function decideMode(filePath) {
  const pref = getSettings().engineMode || 'auto'; // auto | db | memory
  if (pref === 'db') return 'db';
  if (pref === 'memory') return 'memory';
  try {
    const size = fs.statSync(filePath).size;
    const avail = await availableMemBytes();
    if (size > MEM_MAX_BYTES) return 'db';
    if (size <= avail * MEM_FREE_FRACTION) return 'memory';
  } catch {}
  return 'db';
}

function startServe(tabId, dbPath, wc, file, mode, format) {
  return new Promise((resolve, reject) => {
    killSession(tabId);
    const bin = engineBin();
    if (!bin) return reject(new Error('Engine binary not found. Run: npm run build:engine'));
    const args = mode === 'memory'
      ? ['serve-mem', '--file', file, ...(format ? ['--format', format] : [])]
      : ['serve', '--db', dbPath];
    const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const s = { proc, pending: new Map(), file, dbPath, wc, mode: mode || 'db' };
    sessions.set(tabId, s);
    lastDb.set(tabId, { dbPath, file, wc, mode: mode || 'db' });
    const rl = readline.createInterface({ input: proc.stdout });
    let ready = false;
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.event === 'ready') { ready = true; resolve(); return; }
      if (msg.id != null && s.pending.has(msg.id)) {
        const p = s.pending.get(msg.id);
        s.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(msg.error || 'query failed'));
      }
    });
    let stderrTail = '';
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + String(d)).slice(-2000);
    });
    proc.on('error', (e) => { if (!ready) reject(e); });
    proc.on('exit', (code, signal) => {
      const wasCurrent = sessions.get(tabId) === s;
      if (wasCurrent) sessions.delete(tabId);
      // Reject in-flight queries immediately so callers can retry (the next
      // query auto-revives the engine) instead of hanging until timeout.
      for (const [, p] of s.pending) p.reject(new Error('engine stopped'));
      s.pending.clear();
      if (wasCurrent && (code !== 0 || signal)) {
        engineLog(
          'serve exited unexpectedly: code=' + code + ' signal=' + signal +
          ' file=' + (file || '?') + (stderrTail ? ' stderr: ' + stderrTail.replace(/\n/g, ' | ') : '')
        );
      }
      if (!ready) reject(new Error('engine exited during startup'));
    });
    // Memory mode parses the whole file before 'ready' — allow generous time.
    setTimeout(() => { if (!ready) reject(new Error('engine start timeout')); }, mode === 'memory' ? 300000 : 20000);
  });
}

// If the tab's engine died (crash, teardown race), transparently restart it
// from the cached database before running the query. Revival is serialized
// per tab: concurrent queries share one restart instead of racing (a second
// startServe would kill the first and reject its in-flight requests).
async function query(tabId, payload) {
  if (!sessions.get(tabId)) {
    const info = lastDb.get(tabId);
    const source = info && (info.mode === 'memory' ? info.file : info.dbPath);
    if (info && source && fs.existsSync(source) && !info.wc.isDestroyed()) {
      if (!reviving.has(tabId)) {
        const p = startServe(tabId, info.dbPath, info.wc, info.file, info.mode)
          .finally(() => reviving.delete(tabId));
        reviving.set(tabId, p);
      }
      await reviving.get(tabId);
    }
  }
  return queryRaw(tabId, payload);
}

function queryRaw(tabId, payload) {
  return new Promise((resolve, reject) => {
    const s = sessions.get(tabId);
    if (!s) return reject(new Error('no document loaded'));
    const id = ++reqSeq;
    s.pending.set(id, { resolve, reject });
    s.proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    setTimeout(() => {
      if (s.pending.has(id)) {
        s.pending.delete(id);
        reject(new Error('query timeout'));
      }
    }, 120000);
  });
}

async function loadFile(wc, tabId, filePath, force, fileFormat) {
  const t0 = Date.now();
  const bin = engineBin();
  if (!bin) throw new Error('Engine binary not found. Run: npm run build:engine');
  if (!fs.existsSync(filePath)) throw new Error('File not found: ' + filePath);
  killIngest(tabId, true);
  killSession(tabId);
  addRecent(filePath, fileFormat);

  // For YAML, the engine reads a converted temp JSON; the tab keeps filePath.
  const enginePath = isYamlFile(filePath) ? yamlToTempJson(filePath) : filePath;


  // ---- memory mode: no ingest, no DB — mmap + parse in the engine ----
  if ((await decideMode(enginePath)) === 'memory') {
    try {
      let size = 0;
      try { size = fs.statSync(enginePath).size; } catch {}
      if (!wc.isDestroyed()) {
        wc.send('ingest-progress', { tabId, event: 'start', total_bytes: size, format: 'memory' });
        wc.send('ingest-progress', { tabId, event: 'phase', phase: 'indexing' });
      }
      await startServe(tabId, null, wc, enginePath, 'memory', fileFormat);
      const meta = await query(tabId, { op: 'meta' });
      bumpStat(meta.format);
      if (!wc.isDestroyed()) wc.send('doc-ready', { tabId, meta, cached: false, file: filePath, loadMs: Date.now() - t0 });
      return;
    } catch (memErr) {
      // Parse/memory failure: fall through to the robust DB path.
      engineLog('serve-mem failed, falling back to DB: ' + String((memErr && memErr.message) || memErr));
      killSession(tabId);
    }
  }

  const dbPath = dbPathFor(enginePath);
  if (force) { try { fs.unlinkSync(dbPath); } catch {} }

  if (fs.existsSync(dbPath)) {
    try {
      indexTouch(dbPath, filePath); // refresh LRU timestamp
      await startServe(tabId, dbPath, wc, filePath, 'db');
      const meta = await query(tabId, { op: 'meta' });
      bumpStat(meta.format);
      if (!wc.isDestroyed()) wc.send('doc-ready', { tabId, meta, cached: true, file: filePath, loadMs: Date.now() - t0 });
      return;
    } catch (cacheErr) {
      // Cached DB is corrupt or partial (e.g. an interrupted earlier ingest) —
      // discard it and re-ingest from scratch below.
      engineLog('cached db unusable, re-ingesting: ' + String((cacheErr && cacheErr.message) || cacheErr));
      killSession(tabId);
      try { fs.unlinkSync(dbPath); } catch {}
    }
  }

  const ingestArgs = ['ingest', enginePath, '--db', dbPath];
  if (fileFormat) ingestArgs.push('--format', fileFormat);
  const proc = spawn(bin, ingestArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const g = { proc, dbPath, wc, file: filePath };
  ingests.set(tabId, g);
  const rl = readline.createInterface({ input: proc.stdout });
  let errMsg = null;
  let done = false;
  rl.on('line', async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.event === 'start' || msg.event === 'progress' || msg.event === 'phase') {
      if (!wc.isDestroyed()) wc.send('ingest-progress', { tabId, ...msg });
    } else if (msg.event === 'error') {
      errMsg = msg.message;
    } else if (msg.event === 'done') {
      done = true;
      if (ingests.get(tabId) === g) ingests.delete(tabId);
      indexTouch(dbPath, filePath);
      setTimeout(() => { try { pruneCache(); buildMenu(); } catch {} }, 500); // enforce cap after new data lands
      try {
        await startServe(tabId, dbPath, wc, filePath, 'db');
        const meta = await query(tabId, { op: 'meta' });
        bumpStat(meta.format);
        if (!wc.isDestroyed()) {
          wc.send('doc-ready', { tabId, meta, cached: false, file: filePath, nodes: msg.nodes, elapsed_ms: msg.elapsed_ms, loadMs: Date.now() - t0 });
        }
      } catch (e) {
        if (!wc.isDestroyed()) wc.send('ingest-error', { tabId, message: String((e && e.message) || e) });
      }
    }
  });
  let stderrBuf = '';
  proc.stderr.on('data', (d) => { stderrBuf += String(d); });
  proc.on('exit', (code) => {
    if (ingests.get(tabId) === g) ingests.delete(tabId);
    // code === null means we killed it (cancel/close) — not an error.
    if (!done && code !== 0 && code !== null) {
      try { fs.unlinkSync(dbPath); } catch {}
      if (!wc.isDestroyed()) {
        wc.send('ingest-error', {
          tabId,
          message: errMsg || stderrBuf.slice(0, 500) || 'engine exited with code ' + code,
        });
      }
    }
  });
}

// ---------------- Open URL / Open Clipboard ----------------
function sniffExt(text) {
  const c = String(text).replace(/^﻿/, '').trimStart()[0];
  if (c === '{' || c === '[') return '.json';
  if (c === '<') return '.xml';
  const firstLine = String(text).slice(0, 2000).split('\n')[0] || '';
  if ((firstLine.match(/\t/g) || []).length >= 1) return '.tsv';
  if ((firstLine.match(/,/g) || []).length >= 1) return '.csv';
  return '.json';
}

// First value of an Electron net response header (values arrive as arrays).
function hdr1(headers, name) {
  const v = headers && headers[name];
  return Array.isArray(v) ? (v[0] || '') : String(v || '');
}
// Choose a file extension from content-type, else sniff the first bytes.
function extForResponse(ct, tmp, fallback) {
  if (ct.includes('json')) return '.json';
  if (ct.includes('xml')) return '.xml';
  if (ct.includes('csv')) return '.csv';
  try {
    const fd = fs.openSync(tmp, 'r');
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    return sniffExt(buf.slice(0, n).toString('utf8'));
  } catch { return fallback; }
}

// Both network helpers use Electron's net (Chromium) rather than Node http/https
// so TLS validates against the OS trust store and the system proxy is honoured —
// corporate TLS-inspecting proxies otherwise fail with "unable to get local
// issuer certificate". net follows redirects and decompresses gzip/deflate/br.
function downloadUrl(url, headers) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(downloadsDir(), 'url_' + Date.now());
    const out = fs.createWriteStream(tmp);
    let req;
    try { req = net.request({ method: 'GET', url, redirect: 'follow' }); }
    catch (e) { return reject(e); }
    for (const [k, v] of Object.entries(headers || {})) { try { req.setHeader(k, v); } catch {} }
    let settled = false;
    const fail = (e) => { if (settled) return; settled = true; clearTimeout(timer); try { out.destroy(); } catch {} try { fs.unlinkSync(tmp); } catch {} reject(e); };
    const timer = setTimeout(() => { try { req.abort(); } catch {} fail(new Error('request timed out')); }, 60000);
    req.on('response', (res) => {
      if (res.statusCode !== 200) { res.on('data', () => {}); res.on('end', () => {}); fail(new Error('HTTP ' + res.statusCode + ' from server')); return; }
      res.on('data', (d) => out.write(d));
      res.on('error', fail);
      res.on('end', () => out.end(() => {
        if (settled) return; settled = true; clearTimeout(timer);
        const ext = extForResponse(hdr1(res.headers, 'content-type'), tmp, '.json');
        const final = tmp + ext;
        try { fs.renameSync(tmp, final); } catch {}
        resolve(final);
      }));
    });
    req.on('error', fail);
    req.end();
  });
}

// A full HTTP request (any method/body/headers). Unlike downloadUrl it does not
// reject on non-2xx — the builder shows the status and the response body.
function httpRequest({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const meth = String(method || 'GET').toUpperCase();
    const started = Date.now();
    const tmp = path.join(downloadsDir(), 'url_' + Date.now());
    const out = fs.createWriteStream(tmp);
    let req;
    try { req = net.request({ method: meth, url, redirect: 'follow' }); }
    catch (e) { return reject(e); }
    for (const [k, v] of Object.entries(headers || {})) { try { req.setHeader(k, v); } catch {} }
    let settled = false;
    const fail = (e) => { if (settled) return; settled = true; clearTimeout(timer); try { out.destroy(); } catch {} try { fs.unlinkSync(tmp); } catch {} reject(e); };
    const timer = setTimeout(() => { try { req.abort(); } catch {} fail(new Error('request timed out')); }, 60000);
    req.on('response', (res) => {
      res.on('data', (d) => out.write(d));
      res.on('error', fail);
      res.on('end', () => out.end(() => {
        if (settled) return; settled = true; clearTimeout(timer);
        const ext = extForResponse(hdr1(res.headers, 'content-type'), tmp, '.txt');
        const final = tmp + ext;
        try { fs.renameSync(tmp, final); } catch {}
        let size = 0;
        try { size = fs.statSync(final).size; } catch {}
        resolve({ file: final, status: res.statusCode, statusText: res.statusMessage || '', timeMs: Date.now() - started, headers: res.headers, size });
      }));
    });
    req.on('error', fail);
    if (body != null && body !== '' && meth !== 'GET' && meth !== 'HEAD') req.write(body);
    req.end();
  });
}

// ---------------- licensing ----------------
// Public config. The /verify endpoint is stateless: POST {email, licenseKey}
// -> {valid, tier, email, status, expires_at, reason}. Override with env if the
// deployed endpoint differs.
const LICENSE_API_BASE = process.env.NARIK_API_BASE || 'https://checkapi.openxmljson.com';
const LICENSE_STORE_URL = process.env.NARIK_STORE_URL || 'https://openxmljson.com';
// The shared backend serves several products off one signing secret, so every
// request MUST scope itself to "narik", and only these tiers unlock this app.
const NARIK_PRODUCT = 'narik';
const NARIK_TIERS = ['Narik', 'Unbxd'];

// Keys are XXXX-XXXX-XXXX-XXXX-XXXX-XXXX. The server is lenient, but normalise to
// canonical form (uppercase, dashed, no spaces) before sending.
function normalizeKey(k) {
  const clean = String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.replace(/(.{4})(?=.)/g, '$1-');
}

// Human plan label from the term. `refMs` should be the moment the key was first
// seen (≈ purchase), so the span reflects the plan length rather than time left.
function planLabel(tier, expiresAt, refMs) {
  if (tier === 'Unbxd' || !expiresAt) return 'Lifetime';
  const exp = Date.parse(expiresAt);
  if (!Number.isFinite(exp)) return 'Lifetime';
  const days = Math.round((exp - (refMs || Date.now())) / 86400000);
  if (days >= 300) return 'Annual';
  if (days >= 25 && days <= 45) return '30-day Trial';
  if (days > 0 && days <= 20) return days + '-day Trial';
  return Math.max(days, 0) + ' days';
}

function licensePath() { return path.join(app.getPath('userData'), 'license.json'); }
function readLicense() { try { return JSON.parse(fs.readFileSync(licensePath(), 'utf8')); } catch { return null; } }
function writeLicense(o) { try { fs.writeFileSync(licensePath(), JSON.stringify(o)); } catch {} }
function clearLicense() { try { fs.unlinkSync(licensePath()); } catch {} }

// Current entitlement from the local cache (no network). Expired keys and any
// tier that isn't ours don't count (local backstop against a stale entitlement).
function licenseStatus() {
  const l = readLicense();
  if (!l || !l.valid) return { licensed: false };
  if (!NARIK_TIERS.includes(l.tier)) return { licensed: false };
  if (l.expires_at) {
    const exp = Date.parse(l.expires_at);
    if (Number.isFinite(exp) && Date.now() > exp) return { licensed: false, expired: true, email: l.email };
  }
  return {
    licensed: true, email: l.email, tier: l.tier || null, expires_at: l.expires_at || null,
    plan: l.plan || planLabel(l.tier, l.expires_at, l.cachedAt),
  };
}

// Resolves { status, data } — never rejects on a non-2xx; only on transport error.
// Uses Electron's net module (Chromium network stack) rather than Node's https so
// TLS validates against the OS trust store and honours system proxy settings. On
// corporate networks with a TLS-inspecting proxy, Node's bundled CA list rejects
// the proxy's root ("unable to get local issuer certificate"); the OS store trusts it.
function httpsPostJson(url, body) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = net.request({ method: 'POST', url, useSessionCookies: false }); }
    catch { return reject(new Error('bad license URL')); }
    req.setHeader('Content-Type', 'application/json');
    req.setHeader('User-Agent', 'NARIKJSON');
    let settled = false;
    const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => { try { req.abort(); } catch {} finish(reject, new Error('license server timed out')); }, 15000);
    req.on('response', (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(data || '{}'); } catch { json = {}; }
        finish(resolve, { status: res.statusCode || 0, data: json });
      });
    });
    req.on('error', (e) => finish(reject, e));
    req.write(body);
    req.end();
  });
}

async function activateLicense(email, key) {
  const cleanEmail = String(email || '').trim();
  const cleanKey = normalizeKey(key);
  const { status, data } = await httpsPostJson(
    LICENSE_API_BASE + '/verify',
    JSON.stringify({ email: cleanEmail, licenseKey: cleanKey, product: NARIK_PRODUCT }),
  );
  // Any non-200 (429 rate limit, 4xx/5xx) is a transient failure — surface it,
  // don't touch the cached state.
  if (status !== 200) {
    return { valid: false, reason: (data && data.message) || 'Could not reach the license server. Please try again.' };
  }
  // Valid AND one of our tiers → license. (Backstop: a valid OPENXMLJSON key must
  // still be refused here, using the server's own reason.)
  if (data && data.valid && NARIK_TIERS.includes(data.tier)) {
    const now = Date.now();
    writeLicense({
      valid: true, key: cleanKey, email: data.email || cleanEmail, tier: data.tier,
      status: data.status || null, expires_at: data.expires_at || null,
      plan: planLabel(data.tier, data.expires_at, now),
      cachedAt: now, lastVerified: now,
    });
    return data;
  }
  if (data && data.valid) {
    return { valid: false, reason: data.reason || 'This license key is not valid for NARIK.' };
  }
  return data || { valid: false, reason: 'No response from the license server.' };
}

// Re-verify the cached key at most once every 24 h while active. Lifetime keys
// (no expires_at) are cached permanently and never re-verified. Success refreshes
// the cache; only an explicit 200 + invalid drops the entitlement; a network
// failure or any non-200 is tolerated (offline grace) and retried later.
const REVERIFY_MS = 24 * 3600 * 1000;
function broadcastLicenseRevoked() {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('license-revoked');
}
async function reverifyIfDue() {
  const l = readLicense();
  if (!l || !l.valid) return;
  if (!l.expires_at) return;                              // lifetime → never re-verify
  const last = l.lastVerified || l.cachedAt || 0;
  if (Date.now() - last < REVERIFY_MS) return;            // not due yet (24 h)
  let resp;
  try {
    resp = await httpsPostJson(
      LICENSE_API_BASE + '/verify',
      JSON.stringify({ email: l.email, licenseKey: l.key, product: NARIK_PRODUCT }),
    );
  } catch {
    return; // offline / transport error — keep the cached entitlement, retry later
  }
  if (resp.status !== 200) return; // 429 / 4xx / 5xx — transient, keep cache
  const data = resp.data || {};
  if (data.valid && NARIK_TIERS.includes(data.tier)) {
    const renewed = data.expires_at && data.expires_at !== l.expires_at; // term extended?
    const nextExpiry = data.expires_at !== undefined ? data.expires_at : l.expires_at;
    writeLicense({ ...l, valid: true, tier: data.tier, status: data.status || l.status,
      expires_at: nextExpiry, lastVerified: Date.now(),
      plan: renewed ? planLabel(data.tier, nextExpiry, Date.now()) : (l.plan || planLabel(data.tier, nextExpiry, l.cachedAt)) });
  } else {
    clearLicense(); // server explicitly says the key is no longer valid → drop it
    broadcastLicenseRevoked();
  }
}

function authHeaders(auth) {
  const h = { 'User-Agent': 'NARIKJSON/0.1' };
  if (!auth || auth.type === 'none') return h;
  if (auth.type === 'basic') h['Authorization'] = 'Basic ' + Buffer.from(`${auth.user || ''}:${auth.pass || ''}`).toString('base64');
  else if (auth.type === 'bearer') h['Authorization'] = 'Bearer ' + (auth.token || '');
  else if (auth.type === 'apikey') h[auth.header || 'X-API-Key'] = auth.token || '';
  return h;
}

// ---------------- windows & menu ----------------
function createWindow() {
  const win = new BrowserWindow({
    minWidth: 880,
    minHeight: 560,
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: effectiveTheme() === 'light' ? '#f5f6f8' : '#14161c',
    title: '{N}ARIKJSON',
    show: false,
    fullscreen: false,
    // Disables macOS's auto-injected "Toggle Full Screen" menu item (the green
    // traffic-light button now maximizes instead of entering native fullscreen).
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.maximize();
  win.show();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    // Reap engine processes belonging to this window.
    for (const [tabId, s] of [...sessions]) {
      if (s.wc.isDestroyed()) killSession(tabId);
    }
    for (const [tabId, g] of [...ingests]) {
      if (g.wc.isDestroyed()) killIngest(tabId, true);
    }
  });
  return win;
}

// "verylongfilename…part_1.json" — keeps the extension visible.
function middleTruncate(s, max) {
  if (s.length <= max) return s;
  const tail = Math.min(16, Math.floor(max / 3));
  return s.slice(0, max - tail - 1) + '…' + s.slice(-tail);
}

function sendMenu(bw, action, arg) {
  const w = bw || BrowserWindow.getFocusedWindow();
  if (w && !w.isDestroyed()) w.webContents.send('menu', { action, arg });
}

function buildMenu() {
  const recents = getRecents();
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      // Custom app menu so the About / Hide / Quit item labels read the branded
      // "{N}ARIKJSON". (The bold menubar title comes from the app name and stays
      // "NARIKJSON".) Mirrors Electron's default appMenu roles otherwise.
      label: app.getName(),
      submenu: [
        { label: 'About {N}ARIKJSON', role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { label: 'Hide {N}ARIKJSON', role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit {N}ARIKJSON', role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'Shift+CmdOrCtrl+N', click: () => createWindow() },
        { type: 'separator' },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: (mi, bw) => sendMenu(bw, 'open') },
        { label: 'Open URL…', accelerator: 'Alt+Shift+O', click: (mi, bw) => sendMenu(bw, 'open-url') },
        { label: 'Open Clipboard', accelerator: 'Shift+CmdOrCtrl+V', click: (mi, bw) => sendMenu(bw, 'open-clipboard') },
        {
          label: 'Open Recent',
          submenu: [
            ...recents.map((r) => ({
              label: middleTruncate(path.basename(r.path), 56),
              toolTip: r.path,
              click: (mi, bw) => sendMenu(bw, 'open-path', r.format ? { path: r.path, format: r.format } : r.path),
            })),
            { type: 'separator' },
            { label: 'Clear Menu', enabled: recents.length > 0, click: () => clearRecents() },
          ],
        },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'F5', click: (mi, bw) => sendMenu(bw, 'reload-tab') },
        { type: 'separator' },
        { label: 'Duplicate Tab', accelerator: 'Shift+CmdOrCtrl+D', click: (mi, bw) => sendMenu(bw, 'duplicate-tab') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: (mi, bw) => sendMenu(bw, 'close-tab') },
        { label: 'Close All Tabs', accelerator: 'Alt+CmdOrCtrl+W', click: (mi, bw) => sendMenu(bw, 'close-all-tabs') },
        { label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W', click: (mi, bw) => { if (bw) bw.close(); } },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      // Basic Edit menu — the standard roles carry the native clipboard/undo
      // accelerators (Cmd+Z/X/C/V/A) so text fields and the Source editor work.
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Search',
      submenu: [
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: (mi, bw) => sendMenu(bw, 'find') },
        // F3 / Shift+F3 are handled by a renderer keydown listener (which also
        // does Cmd+G); registerAccelerator:false keeps them as visible hints
        // here without double-firing the step.
        { label: 'Find Next', accelerator: 'F3', registerAccelerator: false, click: (mi, bw) => sendMenu(bw, 'find-next') },
        { label: 'Find Previous', accelerator: 'Shift+F3', registerAccelerator: false, click: (mi, bw) => sendMenu(bw, 'find-prev') },
        { type: 'separator' },
        { label: 'Jump to Path…', accelerator: 'CmdOrCtrl+L', click: (mi, bw) => sendMenu(bw, 'jump-to-path') },
        { type: 'separator' },
        // Cmd+C belongs to Edit ▸ Copy, so Copy Row uses Cmd+Shift+C.
        { label: 'Copy Row', accelerator: 'CmdOrCtrl+Shift+C', click: (mi, bw) => sendMenu(bw, 'copy-row') },
        { label: 'Copy as cURL', click: (mi, bw) => sendMenu(bw, 'copy-curl') },
      ],
    },
    {
      label: 'Export',
      submenu: [
        // Whole-document exports (enabled only when a structured doc is open).
        { id: 'exp-raw', label: 'Raw Copy…', enabled: menuState.hasDoc, click: (mi, bw) => sendMenu(bw, 'export-doc', 'rawjson') },
        { id: 'exp-pretty', label: 'Pretty JSON…', enabled: menuState.hasDoc, click: (mi, bw) => sendMenu(bw, 'export-doc', 'json') },
        { id: 'exp-xml', label: 'XML…', enabled: menuState.hasDoc, click: (mi, bw) => sendMenu(bw, 'export-doc', 'xml') },
        { id: 'exp-csv', label: 'CSV…', enabled: menuState.hasDoc, click: (mi, bw) => sendMenu(bw, 'export-doc', 'csv') },
        { id: 'exp-yaml', label: 'YAML…', enabled: menuState.hasDoc, click: (mi, bw) => sendMenu(bw, 'export-doc', 'yaml') },
        { type: 'separator' },
        { id: 'exp-sel-json', label: 'Selection as JSON…', enabled: menuState.hasDoc, click: (mi, bw) => sendMenu(bw, 'export-selection', 'json') },
        { id: 'exp-sel-text', label: 'Selection as Text…', enabled: menuState.hasDoc, click: (mi, bw) => sendMenu(bw, 'export-selection', 'text') },
        { type: 'separator' },
        // Enabled only while a search has matches.
        { id: 'exp-match-json', label: 'Search Matches as JSON…', enabled: menuState.hasMatches, click: (mi, bw) => sendMenu(bw, 'export-matches', 'json') },
        { id: 'exp-match-csv', label: 'Search Matches as CSV…', enabled: menuState.hasMatches, click: (mi, bw) => sendMenu(bw, 'export-matches', 'csv') },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        { id: 'tool-gen-schema', label: 'Generate JSON Schema', enabled: menuState.hasDoc, click: (mi, bw) => sendMenu(bw, 'gen-schema') },
        { id: 'tool-validate-schema', label: 'Validate Against JSON Schema…', enabled: menuState.hasDoc, click: (mi, bw) => sendMenu(bw, 'validate-schema') },
        { type: 'separator' },
        { id: 'tool-deepdive', label: 'JSON DeepDive → New Tab…', enabled: menuState.hasDoc, click: (mi, bw) => sendMenu(bw, 'deepdive') },
        { type: 'separator' },
        { id: 'tool-compare', label: 'Compare With Open Tab…', enabled: menuState.hasTwoDocs, click: (mi, bw) => sendMenu(bw, 'compare-tabs') },
        { type: 'separator' },
        { label: 'Bookmarks Manager…', accelerator: 'Shift+CmdOrCtrl+B', click: (mi, bw) => sendMenu(bw, 'bookmarks') },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Appearance',
          submenu: ['system', 'light', 'dark'].map((v) => ({
            label: v[0].toUpperCase() + v.slice(1),
            type: 'radio',
            checked: (getSettings().theme || 'system') === v,
            click: () => setThemePref(v),
          })),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    {
      label: 'Cache Manager',
      submenu: [
        { label: 'Cache Size: ' + fmtBytes(cacheTotalSize()), enabled: false },
        { type: 'separator' },
        { label: 'Clear Cache…', click: (mi, bw) => clearCacheInteractive(bw) },
        {
          label: 'Prune Now',
          click: async (mi, bw) => {
            const freed = pruneCache();
            buildMenu();
            const win = bw || BrowserWindow.getFocusedWindow();
            dialog.showMessageBox(win, {
              type: 'info',
              message: 'Cache pruned',
              detail: freed > 0 ? 'Freed ' + fmtBytes(freed) + '.' : 'Nothing to prune — cache is healthy.',
            });
          },
        },
        { label: 'Delete Search Indexes…', click: (mi, bw) => deleteSearchIndexes(bw) },
        { type: 'separator' },
        {
          label: 'Size Limit',
          submenu: [
            { gb: 5, label: '5 GB' },
            { gb: 10, label: '10 GB' },
            { gb: 20, label: '20 GB' },
            { gb: 50, label: '50 GB' },
            { gb: 0, label: 'Unlimited' },
          ].map((o) => ({
            label: o.label,
            type: 'radio',
            checked: (getSettings().cacheLimitGb ?? 20) === o.gb,
            click: () => {
              saveSetting('cacheLimitGb', o.gb);
              pruneCache();
              buildMenu();
            },
          })),
        },
        { type: 'separator' },
        {
          label: 'Engine Mode',
          submenu: [
            { label: 'For JSON, XML & YAML files only', enabled: false },
            { type: 'separator' },
            ...[
              { v: 'auto', label: 'Auto (RAM under 10 GB, DB above)' },
              { v: 'memory', label: 'Always Memory' },
              { v: 'db', label: 'Always Database' },
            ].map((o) => ({
              label: o.label,
              type: 'radio',
              checked: (getSettings().engineMode || 'auto') === o.v,
              click: () => { saveSetting('engineMode', o.v); buildMenu(); },
            })),
            { type: 'separator' },
            { label: 'Table files (CSV, TSV, Parquet…) always use the table engine', enabled: false },
          ],
        },
        { type: 'separator' },
        { label: 'Open Cache Folder', click: () => shell.openPath(dbCacheDir()) },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Activate License…', click: (mi, bw) => sendMenu(bw, 'activate') },
        { label: 'Check for Updates…', click: (mi, bw) => checkForUpdates(bw) },
        { type: 'separator' },
        {
          label: 'About {N}ARIKJSON',
          click: (mi, bw) => {
            const win = bw || BrowserWindow.getFocusedWindow();
            dialog.showMessageBox(win, {
              type: 'info',
              message: '{N}ARIKJSON',
              detail: 'Version ' + app.getVersion() + '\nA rapid JSON·XML·CSV loading engine, built for gigabytes.',
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------- IPC ----------------
const ok = (data) => ({ ok: true, data });
const fail = (e) => ({ ok: false, error: String((e && e.message) || e) });

app.whenReady().then(() => {
  ipcMain.handle('pick-file', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('load-file', async (e, { tabId, path: p, force, format }) => {
    try { await loadFile(e.sender, tabId, p, !!force, format || null); return ok(true); }
    catch (err) { return fail(err); }
  });

  ipcMain.handle('query', async (_e, { tabId, payload }) => {
    try { return ok(await query(tabId, payload)); }
    catch (err) { return fail(err); }
  });

  ipcMain.handle('close-tab', async (_e, tabId) => {
    killIngest(tabId, true);
    killSession(tabId);
    lastDb.delete(tabId); // closed for real — don't auto-revive
    return ok(true);
  });

  ipcMain.handle('cancel-ingest', async (_e, tabId) => {
    killIngest(tabId, true);
    return ok(true);
  });

  ipcMain.handle('download-url', async (_e, { url, auth }) => {
    try {
      if (!/^https?:\/\//i.test(String(url))) throw new Error('URL must start with http:// or https://');
      const file = await downloadUrl(String(url), authHeaders(auth));
      return ok(file);
    } catch (err) { return fail(err); }
  });

  // Full request builder: method + headers + body; returns response metadata.
  ipcMain.handle('http-request', async (_e, req) => {
    try {
      if (!/^https?:\/\//i.test(String(req.url))) throw new Error('URL must start with http:// or https://');
      const headers = { ...authHeaders(req.auth) };
      for (const h of (req.headers || [])) if (h && h.key) headers[h.key] = h.value != null ? h.value : '';
      const hasBody = req.body != null && req.body !== '' && !['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase());
      if (hasBody && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
      const res = await httpRequest({ method: req.method, url: String(req.url), headers, body: req.body });
      return ok(res);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('clipboard-to-file', async () => {
    try {
      const text = clipboard.readText();
      if (!text || !text.trim()) throw new Error('Clipboard is empty');
      const file = path.join(downloadsDir(), 'clipboard_' + Date.now() + sniffExt(text));
      fs.writeFileSync(file, text);
      return ok(file);
    } catch (err) { return fail(err); }
  });

  // Plain-text tabs (txt/js/html…): read directly, no engine involved.
  const PLAIN_MAX = 25 * 1024 * 1024;
  // "Full file" read-only tabs. V8 caps a single string at ~512 MB and Monaco
  // holds the doc as one string, so 450 MB is the safe hard ceiling.
  const PLAIN_MAX_FULL = 450 * 1024 * 1024;
  ipcMain.handle('load-text', async (_e, arg) => {
    try {
      const p = typeof arg === 'string' ? arg : arg.path;
      const limit = (typeof arg === 'object' && arg.full) ? PLAIN_MAX_FULL : PLAIN_MAX;
      if (!fs.existsSync(p)) throw new Error('File not found: ' + p);
      const st = fs.statSync(p);
      const readLen = Math.min(st.size, limit);
      const buf = Buffer.alloc(readLen);
      const fd = fs.openSync(p, 'r');
      fs.readSync(fd, buf, 0, readLen, 0);
      fs.closeSync(fd);
      let ext = path.extname(p).slice(1).toLowerCase();
      if (ext === 'mjs') ext = 'js';
      if (ext === 'htm') ext = 'html';
      if (ext === 'log') ext = 'txt';
      if (ext === 'yml') ext = 'yaml';
      addRecent(p);
      bumpStat(ext || 'txt');
      return ok({ text: buf.toString('utf8'), size: st.size, truncated: st.size > limit, limit });
    } catch (err) { return fail(err); }
  });

  // Save arbitrary text via a save dialog (context-menu exports).
  ipcMain.handle('save-text', async (e, { defaultName, text }) => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender);
      const res = await dialog.showSaveDialog(win, { defaultPath: defaultName });
      if (res.canceled || !res.filePath) return ok(null);
      fs.writeFileSync(res.filePath, text);
      return ok(res.filePath);
    } catch (err) { return fail(err); }
  });

  // Write text to a temp file (Copy to New Tab).
  ipcMain.handle('text-to-file', async (_e, { name, ext, text }) => {
    try {
      const safe = String(name || 'fragment').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'fragment';
      const file = path.join(downloadsDir(), safe + '_' + Date.now() + '.' + (ext || 'json'));
      fs.writeFileSync(file, text);
      return ok(file);
    } catch (err) { return fail(err); }
  });

  // Read a small text file quietly (schema files) — no recents/stats side effects.
  ipcMain.handle('read-file-text', async (_e, p) => {
    try {
      const st = fs.statSync(p);
      if (st.size > 10 * 1024 * 1024) throw new Error('file too large (max 10 MB)');
      return ok(fs.readFileSync(p, 'utf8'));
    } catch (err) { return fail(err); }
  });

  // Structural diff between two loaded tabs (Compare With Open Tab).
  ipcMain.handle('diff-tabs', async (_e, { tabA, tabB }) => {
    try {
      const sa = sessions.get(tabA);
      const sb = sessions.get(tabB);
      if (!sa || !sb) throw new Error('both tabs must have loaded documents');
      if (sa.mode === 'memory' || sb.mode === 'memory') {
        throw new Error('Compare needs database mode — set Cache → Engine Mode → Always Database and reload both tabs');
      }
      const bin = engineBin();
      const out = await new Promise((resolve, reject) => {
        const proc = spawn(bin, ['diff', '--a', sa.dbPath, '--b', sb.dbPath, '--limit', '5000']);
        let buf = '';
        let errBuf = '';
        proc.stdout.on('data', (d) => { buf += d; });
        proc.stderr.on('data', (d) => { errBuf += d; });
        proc.on('error', reject);
        const timer = setTimeout(() => { try { proc.kill(); } catch {} reject(new Error('diff timed out')); }, 180000);
        proc.on('exit', (code) => {
          clearTimeout(timer);
          try {
            const lines = buf.trim().split('\n');
            const last = JSON.parse(lines[lines.length - 1] || '{}');
            if (last.event === 'diff') resolve(last);
            else if (last.event === 'error') reject(new Error(last.message));
            else reject(new Error(errBuf.slice(0, 300) || 'diff exited with code ' + code));
          } catch {
            reject(new Error('diff failed — the engine may need a rebuild (npm run build:engine)'));
          }
        });
      });
      return ok(out);
    } catch (err) { return fail(err); }
  });

  // Build the FTS5 search index for a tab's database (separate process,
  // progress streamed to the renderer). The serve process keeps running;
  // both sides use busy_timeout so reads and index writes interleave safely.
  ipcMain.handle('build-index', async (e, tabId) => {
    try {
      const info = sessions.get(tabId) || lastDb.get(tabId);
      if (!info) throw new Error('no document loaded');
      if (!info.dbPath) throw new Error('memory-mode documents need no search index — search is already parallel');
      const bin = engineBin();
      if (!bin) throw new Error('engine binary not found');
      const wc = e.sender;
      let sizeBefore = 0;
      try { sizeBefore = fs.statSync(info.dbPath).size; } catch {}
      await new Promise((resolve, reject) => {
        const proc = spawn(bin, ['index', '--db', info.dbPath]);
        const rl = readline.createInterface({ input: proc.stdout });
        let errMsg = null;
        let doneSeen = false;
        let stderrBuf = '';
        rl.on('line', (line) => {
          let msg;
          try { msg = JSON.parse(line); } catch { return; }
          if (msg.event === 'error') errMsg = msg.message;
          if (!wc.isDestroyed()) wc.send('index-progress', { tabId, ...msg });
          if (msg.event === 'done') { doneSeen = true; resolve(); }
        });
        proc.stderr.on('data', (d) => { stderrBuf += d; });
        proc.on('error', reject);
        proc.on('exit', (code) => {
          if (!doneSeen) {
            reject(new Error(errMsg || stderrBuf.slice(0, 300) || 'indexer exited with code ' + code));
          }
        });
      });
      try { setIndexBytes(info.dbPath, fs.statSync(info.dbPath).size - sizeBefore); } catch {}
      buildMenu(); // refresh cache size display
      return ok(true);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('cache-info', async () => {
    const dbs = listCacheDbs();
    let tempBytes = 0;
    let tempCount = 0;
    try {
      const dl = downloadsDir();
      for (const f of fs.readdirSync(dl)) {
        try {
          const st = fs.statSync(path.join(dl, f));
          tempBytes += st.size;
          tempCount++;
        } catch {}
      }
    } catch {}
    const ix = readCacheIndex();
    let indexBytes = 0;
    let indexCount = 0;
    for (const d of dbs) {
      const entry = ix[d.file];
      if (entry && entry.indexBytes > 0) {
        indexBytes += entry.indexBytes;
        indexCount++;
      }
    }
    return {
      totalBytes: dbs.reduce((s, d) => s + d.size, 0),
      count: dbs.length,
      limitGb: getSettings().cacheLimitGb ?? 20,
      tempBytes,
      tempCount,
      indexBytes,
      indexCount,
      ramFree: await availableMemBytes(),
      ramTotal: os.totalmem(),
      memModeLimit: Math.min(MEM_MAX_BYTES, (await availableMemBytes()) * MEM_FREE_FRACTION),
      engineMode: getSettings().engineMode || 'auto',
    };
  });

  ipcMain.handle('clear-cache', async () => {
    const freed = clearCache();
    buildMenu();
    return ok(freed);
  });

  ipcMain.handle('engine-mode', async () => {
    const avail = await availableMemBytes();
    return {
      mode: getSettings().engineMode || 'auto',
      ramFree: avail,
      ramTotal: os.totalmem(),
      memModeLimit: Math.min(MEM_MAX_BYTES, avail * MEM_FREE_FRACTION),
    };
  });
  ipcMain.handle('set-engine-mode', async (_e, mode) => {
    if (!['auto', 'memory', 'db'].includes(mode)) return fail(new Error('invalid mode'));
    saveSetting('engineMode', mode);
    buildMenu(); // keep the native Engine Mode menu radio in sync
    return ok(mode);
  });

  // ---- jq filter (system jq binary) ----
  // Generic bridge to the DuckDB engine. The renderer/adapter calls named
  // engine methods (detect, openDataset, buildView, getPage, getRowJson,
  // profileColumn/All, runSql, exportView, diffDatasets, cacheInfo, cancel…).
  ipcMain.handle('duck-invoke', async (_e, { method, params }) => {
    try { return ok(await duckEngine().invoke(String(method), params)); }
    catch (err) { return fail(new Error((err && err.message) || 'DuckDB engine error')); }
  });

  ipcMain.handle('jq-available', async () => new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const p = spawn('jq', ['--version']);
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', () => finish({ available: false }));
      p.on('close', (code) => finish({ available: code === 0, version: out.trim() }));
    } catch { finish({ available: false }); }
  }));

  ipcMain.handle('jq-run', async (_e, { tabId, filter, flags }) => {
    const info = sessions.get(tabId) || lastDb.get(tabId);
    const file = info && info.file;
    if (!file) return fail(new Error('No source file for this tab.'));
    if (!filter || !String(filter).trim()) return fail(new Error('Enter a jq filter.'));
    const args = [];
    if (flags) {
      if (flags.raw) args.push('-r');
      if (flags.compact) args.push('-c');
      if (flags.slurp) args.push('-s');
      if (flags.sortKeys) args.push('-S');
    }
    args.push(String(filter), file);
    return new Promise((resolve) => {
      let out = '', err = '', tooBig = false;
      const CAP = 256 * 1024 * 1024; // guard against a runaway result in memory
      let p;
      try { p = spawn('jq', args); }
      catch { return resolve(fail(new Error('jq is not installed.'))); }
      p.on('error', (e) => resolve(fail(new Error(e && e.code === 'ENOENT' ? 'jq is not installed.' : (e && e.message) || 'jq failed to start.'))));
      p.stdout.on('data', (d) => {
        out += d;
        if (out.length > CAP && !tooBig) { tooBig = true; try { p.kill(); } catch {} }
      });
      p.stderr.on('data', (d) => { if (err.length < 8192) err += d; });
      p.on('close', (code) => {
        if (tooBig) return resolve(fail(new Error('Result exceeds 256 MB — narrow the filter.')));
        if (code === 0) return resolve(ok({ text: out }));
        resolve(fail(new Error(err.trim() || ('jq exited with code ' + code))));
      });
    });
  });

  ipcMain.handle('stats', async () => getStats());
  ipcMain.handle('recents', async () => getRecents());
  ipcMain.handle('clear-recents', async () => { clearRecents(); return true; });
  ipcMain.handle('remove-recent', async (_e, p) => { if (typeof p === 'string') removeRecent(p); return true; });

  // ---- bookmarks (saved URL requests) ----
  ipcMain.handle('bookmarks-list', async () => getBookmarks());
  ipcMain.handle('bookmark-save', async (_e, bm) => saveBookmark(bm || {}));
  ipcMain.handle('bookmark-update', async (_e, { id, patch }) => { if (id) updateBookmarkMeta(id, patch || {}); return true; });
  ipcMain.handle('bookmark-remove', async (_e, id) => { if (id) removeBookmark(id); return true; });
  ipcMain.handle('bookmarks-clear', async () => { clearBookmarks(); return true; });

  // DuckDB opens happen renderer-side (not via loadFile), so recents are noted here.
  ipcMain.handle('note-recent', async (_e, { path: p, format }) => { if (typeof p === 'string' && !isTempPath(p)) addRecent(p, format || null); return true; });
  // Save-path picker (the DuckDB engine writes the file itself via COPY TO).
  ipcMain.handle('pick-save-path', async (e, { defaultName, filters }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showSaveDialog(win, {
      defaultPath: defaultName || undefined,
      filters: filters && filters.length ? filters : [{ name: 'All files', extensions: ['*'] }],
    });
    return res.canceled || !res.filePath ? null : res.filePath;
  });

  ipcMain.handle('license-status', async () => licenseStatus());
  ipcMain.handle('license-activate', async (_e, { email, key }) => {
    try { return ok(await activateLicense(String(email || '').trim(), String(key || '').trim())); }
    catch (err) { return fail(err); }
  });
  ipcMain.handle('license-clear', async () => { clearLicense(); return true; });
  ipcMain.handle('open-store', async () => { try { shell.openExternal(LICENSE_STORE_URL); } catch {} return true; });
  ipcMain.handle('file-stat', async (_e, p) => {
    try { const st = fs.statSync(p); return { exists: true, size: st.size }; } catch { return { exists: false, size: 0 }; }
  });
  ipcMain.handle('reveal-item', async (_e, p) => {
    try { if (typeof p === 'string' && p) { shell.showItemInFolder(p); return true; } } catch {}
    return false;
  });

  // Dock icon in dev (`npm start`); packaged builds use build/icon.icns.
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, 'build', 'icon.png')); } catch {}
  }

  try { pruneCache(); } catch {} // startup pruning: orphans + size cap
  try { pruneRecent(); } catch {} // drop recents whose file no longer exists
  // Re-verify the license shortly after launch, then every 12h (fires only when
  // the 20-day window has elapsed).
  setTimeout(() => { reverifyIfDue().catch(() => {}); }, 4000);
  setInterval(() => { reverifyIfDue().catch(() => {}); }, 12 * 3600 * 1000);

  // Renderer reports whether a doc is open / a search has matches, so the
  // Export menu items enable/disable accordingly.
  ipcMain.on('menu-state', (_e, s) => {
    menuState = { hasDoc: !!(s && s.hasDoc), hasMatches: !!(s && s.hasMatches), hasTwoDocs: !!(s && s.hasTwoDocs) };
    const menu = Menu.getApplicationMenu();
    if (!menu) return;
    const set = (id, on) => { const mi = menu.getMenuItemById(id); if (mi) mi.enabled = on; };
    for (const id of ['exp-raw', 'exp-pretty', 'exp-xml', 'exp-csv', 'exp-yaml', 'exp-sel-json', 'exp-sel-text', 'tool-gen-schema', 'tool-validate-schema', 'tool-deepdive']) set(id, menuState.hasDoc);
    set('exp-match-json', menuState.hasMatches);
    set('exp-match-csv', menuState.hasMatches);
    set('tool-compare', menuState.hasTwoDocs);
  });

  // JSON DeepDive: project selected fields out of the source file (streaming,
  // in Rust) into a temp file, reporting progress and supporting cancellation.
  ipcMain.handle('project', async (e, { file, format, paths }) => {
    const stamp = Date.now();
    const pathsFile = path.join(os.tmpdir(), 'narik_paths_' + stamp + '.json');
    const outFile = path.join(os.tmpdir(), 'narik_projection_' + stamp + (format === 'ndjson' ? '.ndjson' : '.json'));
    try {
      if (!file || !fs.existsSync(file)) throw new Error('source file not found — it may have moved since it was opened');
      fs.writeFileSync(pathsFile, JSON.stringify(paths || []));
      const wc = e.sender;
      const result = await new Promise((resolve, reject) => {
        const proc = spawn(engineBin(), ['project', '--file', file, '--format', format || 'auto', '--paths', pathsFile, '--out', outFile]);
        projProc = proc;
        let errBuf = '';
        let last = null;
        const rl = readline.createInterface({ input: proc.stdout });
        rl.on('line', (line) => {
          line = line.trim();
          if (!line) return;
          try {
            const m = JSON.parse(line);
            if (m.event === 'start' || m.event === 'progress') { if (!wc.isDestroyed()) wc.send('project-progress', m); }
            else if (m.event === 'done') last = m;
            else if (m.event === 'error') errBuf = m.message || errBuf;
          } catch { /* non-JSON line */ }
        });
        proc.stderr.on('data', (d) => { errBuf += d; });
        proc.on('error', reject);
        proc.on('exit', (code) => {
          projProc = null;
          try { fs.unlinkSync(pathsFile); } catch {}
          if (code === 0 && last) { resolve({ out: outFile, kept: last.kept, records: last.records }); return; }
          try { fs.unlinkSync(outFile); } catch {} // remove any partial output
          const lc = (errBuf || '').toLowerCase();
          if (code === 2 || lc.includes('usage') || lc.includes('unknown')) reject(new Error('project unsupported — rebuild the engine (npm run build:engine)'));
          else reject(new Error((errBuf || '').slice(0, 300) || 'projection failed (code ' + code + ')'));
        });
      });
      return ok(result);
    } catch (err) {
      try { fs.unlinkSync(pathsFile); } catch {}
      return fail(err);
    }
  });

  ipcMain.on('cancel-project', () => {
    if (projProc) { try { projProc.kill('SIGTERM'); } catch {} }
  });

  // Write an HTML report to a temp file and open it in the default browser.
  ipcMain.handle('open-html', async (_e, html) => {
    try {
      const file = path.join(os.tmpdir(), 'narikjson_diff_' + Date.now() + '.html');
      fs.writeFileSync(file, String(html == null ? '' : html));
      await shell.openPath(file);
      return ok(file);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('get-theme', async () => effectiveTheme());

  nativeTheme.themeSource = getSettings().theme || 'system';
  nativeTheme.on('updated', () => broadcastTheme());

  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function killAll() {
  for (const tabId of [...ingests.keys()]) killIngest(tabId, true);
  for (const tabId of [...sessions.keys()]) killSession(tabId);
  if (duck) { duck.stop(); duck = null; }
}

app.on('window-all-closed', () => {
  killAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => killAll());
