/* OPENJSONXML — renderer. Tabbed UI (max 12) over per-tab engine sessions. */
'use strict';

const PAGE = 200;
const ROW_H = 26;
const MAX_TABS = 12;
const K = { OBJ: 0, ARR: 1, STR: 2, NUM: 3, BOOL: 4, NULL: 5, ELEM: 6, ATTR: 7, TEXT: 8 };

const $ = (id) => document.getElementById(id);

// ---------- tab state ----------
let tabs = [];
let cur = null;
let tabSeq = 0;

let monacoEditor = null;
let monacoReady = false;
let uiTheme = 'dark';
let sourceOpen = false;

function makeTab() {
  return {
    id: 't' + Date.now().toString(36) + '_' + (++tabSeq) + '_' + Math.random().toString(36).slice(2, 6),
    title: 'New Tab',
    file: null,
    phase: 'empty', // empty | loading | ready
    meta: null,
    docFormat: 'json',
    rootId: 1,
    visible: [],
    selectedIdx: -1,
    treeScrollTop: 0,
    view: 'tree',
    tableHeaders: [],
    tableTotal: 0,
    tablePages: new Map(),
    tableInflight: new Set(),
    progress: null,
    plain: null,      // { language, label, size, truncated } for txt/js/html tabs
    plainText: null,
    plainModel: null,
  };
}

const PLAIN_LANGS = {
  txt: 'plaintext', log: 'plaintext', md: 'markdown',
  js: 'javascript', mjs: 'javascript', html: 'html', htm: 'html',
  py: 'python', yaml: 'yaml', yml: 'yaml',
};
function plainLangFor(p) {
  const ext = String(p).split('.').pop().toLowerCase();
  return PLAIN_LANGS[ext] || null;
}

function tabById(id) { return tabs.find((t) => t.id === id) || null; }
function tabAlive(t) { return t && tabs.includes(t); }

function newTab(activate = true) {
  if (tabs.length >= MAX_TABS) {
    toast('Maximum of ' + MAX_TABS + ' tabs reached');
    return null;
  }
  const t = makeTab();
  tabs.push(t);
  if (activate) setCurrent(t);
  else renderTabs();
  return t;
}

async function closeTab(t) {
  if (!tabAlive(t)) return;
  const idx = tabs.indexOf(t);
  tabs.splice(idx, 1);
  if (t.plainModel) { try { t.plainModel.dispose(); } catch {} t.plainModel = null; }
  try { await window.oxj.closeTab(t.id); } catch {}
  if (!tabs.length) {
    newTab(true);
    return;
  }
  if (cur === t) setCurrent(tabs[Math.min(idx, tabs.length - 1)]);
  else renderTabs();
}

async function closeAllTabs() {
  const old = tabs.slice();
  tabs = [];
  for (const t of old) { try { await window.oxj.closeTab(t.id); } catch {} }
  newTab(true);
}

function setCurrent(t) {
  if (cur && cur.phase === 'ready') cur.treeScrollTop = treeScroll.scrollTop;
  cur = t;
  closeSearch();
  renderTabs();
  renderScreen();
}

function renderTabs() {
  // A single empty tab (the welcome screen) needs no tab strip.
  const showBar = tabs.length > 1 || tabs.some((t) => t.phase !== 'empty');
  $('tabbar').classList.toggle('hidden', !showBar);
  const host = $('tabs');
  host.textContent = '';
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t === cur ? ' active' : '') + (t.phase === 'loading' ? ' loading' : '');
    el.draggable = true;
    el.dataset.tabId = t.id;
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = t.phase === 'loading' ? '⏳ ' + t.title : t.title;
    title.title = t.file || t.title;
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '✕';
    close.title = 'Close tab';
    close.addEventListener('click', (ev) => { ev.stopPropagation(); closeTab(t); });
    el.append(title, close);
    el.addEventListener('click', () => { if (t !== cur) setCurrent(t); });
    el.addEventListener('auxclick', (ev) => { if (ev.button === 1) closeTab(t); });
    // drag to reorder
    el.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/tab-id', t.id);
      ev.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragover', (ev) => {
      if (ev.dataTransfer.types.includes('text/tab-id')) {
        ev.preventDefault();
        el.classList.add('drag-over');
      }
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (ev) => {
      el.classList.remove('drag-over');
      const srcId = ev.dataTransfer.getData('text/tab-id');
      if (!srcId || srcId === t.id) return;
      ev.preventDefault();
      ev.stopPropagation();
      const src = tabById(srcId);
      if (!src) return;
      tabs.splice(tabs.indexOf(src), 1);
      tabs.splice(tabs.indexOf(t), 0, src);
      renderTabs();
    });
    host.appendChild(el);
  }
}

// ---------- screen switching ----------
function renderScreen() {
  const t = cur;
  $('screen-welcome').classList.toggle('hidden', t.phase !== 'empty');
  $('screen-progress').classList.toggle('hidden', t.phase !== 'loading');
  $('screen-viewer').classList.toggle('hidden', t.phase !== 'ready');
  if (t.phase === 'empty') { refreshRecents(); refreshStats(); refreshCacheInfo(); }
  else if (t.phase === 'loading') updateProgressDom(t);
  else if (t.phase === 'ready') {
    const plain = !!t.plain;
    killFlow();
    $('btn-source').classList.toggle('hidden', plain);
    $('btn-flow').classList.toggle('hidden', plain || t.docFormat === 'xml');
    const memMode = t.meta && t.meta.mode === 'memory';
    $('btn-tools').classList.toggle('hidden',
      plain || memMode || (t.docFormat !== 'json' && t.docFormat !== 'ndjson'));
    $('btn-jq').classList.toggle('hidden', !jqApplicable(t));
    if (!jqApplicable(t)) $('jq-bar').classList.add('hidden');
    $('search-scope').classList.toggle('hidden', plain);
    $('search-box').classList.toggle('hidden', plain);
    $('btn-find').classList.toggle('hidden', plain);
    $('match-prev').classList.toggle('hidden', plain);
    $('match-next').classList.toggle('hidden', plain);
    $('text-wrap').classList.toggle('hidden', !plain);
    if (plain) {
      $('view-toggle').classList.add('hidden');
      $('tree-wrap').classList.add('hidden');
      $('table-wrap').classList.add('hidden');
      closeSource();
      closeSearch();
      $('btn-top').classList.add('hidden');
      showPlain(t);
      $('status-doc').textContent =
        baseName(t.file) + ' · ' + t.plain.label + ' · ' + fmtBytes(t.plain.size) + (t.plain.truncated ? ' · showing first 25 MB' : '');
      $('status-type').textContent = 'Read-only · ⌘F to find';
      $('status-path').textContent = '';
      return;
    }
    const isCsv = t.docFormat === 'csv' || t.docFormat === 'tsv';
    $('view-toggle').classList.toggle('hidden', !isCsv);
    setView(t.view);
    $('status-doc').textContent =
      baseName(t.file) + ' · ' + t.docFormat.toUpperCase() + ' · ' + fmtInt(t.meta.total_nodes || 0) + ' nodes · ' + fmtBytes(t.meta.source_bytes) + (memMode ? ' · RAM' : '');
    if (isCsv) buildTableHead(t);
    renderTree();
    treeScroll.scrollTop = t.treeScrollTop || 0;
    renderTree();
    updateTopBtn();
    updateStatusForSelection();
    if (sourceOpen) scheduleSourceUpdate();
  }
}

// ---------- plain-text tabs (txt/js/html) ----------
let textEditor = null;
function showPlain(t) {
  if (monacoReady && window.monaco) {
    $('text-fallback').classList.add('hidden');
    $('text-host').classList.remove('hidden');
    if (!textEditor) {
      textEditor = window.monaco.editor.create($('text-host'), {
        value: '',
        theme: uiTheme === 'light' ? 'vs' : 'vs-dark',
        readOnly: true,
        automaticLayout: true,
        minimap: { enabled: true },
        lineNumbers: 'on',
        fontSize: 12.5,
        scrollBeyondLastLine: false,
        largeFileOptimizations: true,
      });
    }
    if (!t.plainModel) {
      t.plainModel = window.monaco.editor.createModel(t.plainText || '', t.plain.language);
    }
    textEditor.setModel(t.plainModel);
    textEditor.updateOptions({
      wordWrap: t.plain.language === 'plaintext' || t.plain.language === 'markdown' ? 'on' : 'off',
    });
  } else {
    $('text-host').classList.add('hidden');
    const fb = $('text-fallback');
    fb.classList.remove('hidden');
    fb.textContent = t.plainText || '';
  }
}

async function openPlainPath(p, tab, lang) {
  const t = tab || targetTabForOpen();
  if (!t) return;
  if (t.plainModel) { try { t.plainModel.dispose(); } catch {} t.plainModel = null; }
  t.file = p;
  t.title = baseName(p);
  t.phase = 'loading';
  t.progress = { startedMsg: 'Reading file…' };
  if (t !== cur) setCurrent(t);
  else { renderTabs(); renderScreen(); }
  try {
    const res = await window.oxj.loadText(p);
    if (!tabAlive(t)) return;
    t.plain = {
      language: lang,
      label: String(p).split('.').pop().toUpperCase(),
      size: res.size,
      truncated: res.truncated,
    };
    t.plainText = res.text;
    t.phase = 'ready';
    renderTabs();
    if (t === cur) renderScreen();
    if (res.truncated) toast('Large file: showing the first 25 MB', true);
  } catch (e) {
    if (!tabAlive(t)) return;
    t.phase = 'empty';
    t.title = 'New Tab';
    t.file = null;
    if (t === cur) { renderTabs(); renderScreen(); }
    toast('Load failed: ' + cleanErr(e));
  }
}

// ---------- helpers ----------
function fmtBytes(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
}
function fmtInt(n) { return Number(n).toLocaleString(); }
function fmtDur(sec) {
  if (!isFinite(sec) || sec < 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
function toast(msg, info) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('info', !!info);
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), info ? 3500 : 6000);
}
function baseName(p) { return String(p).split(/[\\/]/).pop(); }
// Middle-ellipsis so the extension always stays visible.
function middleTruncate(s, max) {
  if (s.length <= max) return s;
  const tail = Math.min(16, Math.floor(max / 3));
  return s.slice(0, max - tail - 1) + '…' + s.slice(-tail);
}
function cleanErr(err) {
  return String((err && err.message) || err).replace(/^.*Error:\s*/, '');
}

// ---------- welcome / recents ----------
async function refreshRecents() {
  const list = (await window.oxj.recents()).slice(0, 10); // last 10 files
  const wrap = $('recents-wrap');
  const el = $('recents-list');
  el.textContent = '';
  if (!list.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  for (const r of list) {
    const item = document.createElement('div');
    item.className = 'recent-item';
    item.title = r.path; // full path on hover
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = middleTruncate(baseName(r.path), 42);
    const size = document.createElement('span');
    size.className = 'recent-size';
    size.textContent = fmtBytes(r.size);
    item.append(name, size);
    item.addEventListener('click', () => openPath(r.path));
    el.appendChild(item);
  }
}

// ---------- file activity donut chart ----------
const STAT_PALETTE = ['#4da3ff', '#e0764a', '#7ee0a3', '#c586c0', '#e2b93b', '#8b91a3', '#66c2cd', '#d16d6d', '#9a86e8'];

async function refreshStats() {
  let s = {};
  try { s = await window.oxj.stats(); } catch {}
  const hidden = ['XLSX', 'XLS', 'XLSM', 'XLTX', 'XLSB'];
  const entries = Object.entries(s)
    .filter(([k]) => !hidden.includes(k.toUpperCase()))
    .sort((a, b) => b[1] - a[1]);
  const wrap = $('stats-wrap');
  const list = $('stats-list');
  list.textContent = '';
  if (!entries.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  const total = entries.reduce((sum, [, v]) => sum + v, 0) || 1;

  const chart = document.createElement('div');
  chart.className = 'stats-chart';

  // Donut via conic-gradient — compact, fixed height.
  const donut = document.createElement('div');
  donut.className = 'donut';
  let acc = 0;
  const stops = entries.map(([, v], i) => {
    const from = (acc / total) * 360;
    acc += v;
    const to = (acc / total) * 360;
    return STAT_PALETTE[i % STAT_PALETTE.length] + ' ' + from.toFixed(2) + 'deg ' + to.toFixed(2) + 'deg';
  }).join(', ');
  donut.style.background = 'conic-gradient(' + stops + ')';
  const center = document.createElement('div');
  center.className = 'donut-center';
  center.innerHTML = '<b>' + fmtInt(total) + '</b><span>files</span>';
  donut.appendChild(center);

  const legend = document.createElement('div');
  legend.className = 'stat-legend';
  entries.forEach(([fmt, count], i) => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const dot = document.createElement('span');
    dot.className = 'legend-dot';
    dot.style.background = STAT_PALETTE[i % STAT_PALETTE.length];
    const name = document.createElement('span');
    name.className = 'legend-name';
    name.textContent = fmt;
    const num = document.createElement('span');
    num.className = 'legend-count';
    num.textContent = fmtInt(count);
    item.append(dot, name, num);
    legend.appendChild(item);
  });

  chart.append(donut, legend);
  list.appendChild(chart);
}

// ---------- cache info box ----------
async function refreshCacheInfo() {
  let info = null;
  try { info = await window.oxj.cacheInfo(); } catch {}
  const wrap = $('cache-wrap');
  const list = $('cache-list');
  if (!info) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  list.textContent = '';
  const addRow = (k, v) => {
    const row = document.createElement('div');
    row.className = 'stat-kv';
    const kk = document.createElement('span'); kk.className = 'k'; kk.textContent = k;
    const vv = document.createElement('span'); vv.textContent = v;
    row.append(kk, vv);
    list.appendChild(row);
  };
  addRow('Cached documents', fmtInt(info.count));
  addRow('Cache size', fmtBytes(info.totalBytes));
  addRow('Search indexes', info.indexCount ? fmtInt(info.indexCount) + ' · ' + fmtBytes(info.indexBytes) : 'None');
  addRow('Size limit', info.limitGb === 0 ? 'Unlimited' : info.limitGb + ' GB');
  if (info.ramTotal) {
    addRow('Available RAM', fmtBytes(info.ramFree));
    const mode = info.engineMode || 'auto';
    addRow('RAM mode',
      mode === 'db' ? 'Off (always database)'
      : mode === 'memory' ? 'Always on'
      : 'Files up to ' + fmtBytes(info.memModeLimit));
  }
  if (info.tempCount) addRow('Temp files', fmtInt(info.tempCount) + ' · ' + fmtBytes(info.tempBytes));
}

$('btn-clear-cache').addEventListener('click', async () => {
  if (!window.confirm('Clear the document cache? Files re-ingest the next time you open them.')) return;
  try {
    const freed = await window.oxj.clearCache();
    toast('Cache cleared — freed ' + fmtBytes(freed), true);
  } catch (e) {
    toast('Clear failed: ' + cleanErr(e));
  }
  refreshCacheInfo();
});

// ---------- opening files ----------
function targetTabForOpen() {
  if (cur && cur.phase === 'empty') return cur;
  return newTab(true);
}

const BLOCKED_EXTS = ['xlsx', 'xls', 'xlsm', 'xltx', 'xlsb'];

async function openPath(p, tab, force) {
  const ext = String(p).split('.').pop().toLowerCase();
  if (BLOCKED_EXTS.includes(ext)) {
    toast('Excel files are not supported — export to CSV or JSON first');
    return;
  }
  const lang = plainLangFor(p);
  if (lang) return openPlainPath(p, tab, lang);
  const t = tab || targetTabForOpen();
  if (!t) return; // tab limit reached
  if (t.plainModel) { try { t.plainModel.dispose(); } catch {} t.plainModel = null; }
  t.plain = null;
  t.plainText = null;
  t.file = p;
  t.title = baseName(p);
  t.phase = 'loading';
  t.progress = { startedAt: Date.now(), lastBytes: 0, lastTime: Date.now(), speed: 0, total: 0, bytes: 0, nodes: 0, indexing: false };
  if (t !== cur) setCurrent(t);
  else { renderTabs(); renderScreen(); }
  try {
    await window.oxj.loadFile(t.id, p, !!force);
  } catch (e) {
    if (!tabAlive(t)) return;
    t.phase = 'empty';
    t.title = 'New Tab';
    if (t === cur) { renderTabs(); renderScreen(); }
    toast('Load failed: ' + cleanErr(e));
  }
}

$('btn-open').addEventListener('click', async () => {
  const p = await window.oxj.pickFile();
  if (p) openPath(p);
});
$('btn-open-url').addEventListener('click', () => showUrlModal());
$('btn-open-clip').addEventListener('click', async () => {
  try {
    const file = await window.oxj.clipboardToFile();
    openPath(file);
  } catch (e) {
    toast(cleanErr(e));
  }
});
$('btn-open2').addEventListener('click', async () => {
  const p = await window.oxj.pickFile();
  if (p) openPath(p);
});
$('btn-clear-recents').addEventListener('click', async () => {
  await window.oxj.clearRecents();
  refreshRecents();
});
$('btn-cancel').addEventListener('click', async () => {
  const t = cur;
  if (t.phase !== 'loading') return;
  try { await window.oxj.cancelIngest(t.id); } catch {}
  t.phase = 'empty';
  t.title = 'New Tab';
  t.file = null;
  renderTabs();
  renderScreen();
});

// Drag & drop files
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
    $('drop-overlay').classList.remove('hidden');
  }
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) $('drop-overlay').classList.add('hidden');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  $('drop-overlay').classList.add('hidden');
  const files = (e.dataTransfer && e.dataTransfer.files) || [];
  if (!files.length) return;
  try {
    for (const f of [...files].slice(0, MAX_TABS)) {
      const p = window.oxj.pathForFile(f);
      if (p) openPath(p);
    }
  } catch {
    toast('Could not resolve dropped file path');
  }
});

// ---------- ingest progress ----------
function updateProgressDom(t) {
  const pr = t.progress || {};
  $('prog-title').textContent = pr.mem ? 'Loading into memory' : 'Loading into database';
  $('prog-phase').textContent = pr.mem
    ? 'Indexing in memory — no database needed, this is quick…'
    : 'Building index… this can take a while on large files';
  $('prog-file').textContent = t.file || '';
  const total = pr.total || 1;
  const pct = Math.min(100, ((pr.bytes || 0) / total) * 100);
  $('bar-inner').classList.toggle('indeterminate', !!pr.indexing);
  if (!pr.indexing) $('bar-inner').style.width = pct.toFixed(2) + '%';
  $('prog-pct').textContent = pr.indexing ? '' : pct.toFixed(1) + '%';
  $('prog-bytes').textContent = pr.bytes ? fmtBytes(pr.bytes) + ' / ' + fmtBytes(total) : '';
  $('prog-speed').textContent = pr.speed > 0 ? fmtBytes(pr.speed) + '/s' : '';
  $('prog-eta').textContent = !pr.indexing && pr.speed > 0 ? 'ETA ' + fmtDur((total - pr.bytes) / pr.speed) : '';
  $('prog-nodes').textContent = pr.nodes ? fmtInt(pr.nodes) + ' nodes parsed' : (pr.startedMsg || 'Starting engine…');
  $('prog-phase').classList.toggle('hidden', !pr.indexing);
}

window.oxj.onProgress((msg) => {
  const t = tabById(msg.tabId);
  if (!t || t.phase !== 'loading') return;
  const pr = t.progress;
  if (msg.event === 'start') {
    pr.total = msg.total_bytes;
    pr.mem = msg.format === 'memory';
    pr.startedMsg = pr.mem ? 'Reading file into memory…' : 'Parsing (' + (msg.format || '') + ')…';
  } else if (msg.event === 'phase') {
    pr.indexing = true;
  } else if (msg.event === 'progress') {
    pr.bytes = msg.bytes;
    pr.total = msg.total_bytes || pr.total;
    pr.nodes = msg.nodes;
    const now = Date.now();
    const dt = (now - pr.lastTime) / 1000;
    if (dt > 0.15) {
      const inst = (msg.bytes - pr.lastBytes) / dt;
      pr.speed = pr.speed ? pr.speed * 0.7 + inst * 0.3 : inst;
      pr.lastBytes = msg.bytes;
      pr.lastTime = now;
    }
  }
  if (t === cur) updateProgressDom(t);
});

// When a data file fails to parse, fall back to a read-only Monaco text tab
// (with JSON/XML syntax highlighting) instead of failing outright.
const DATA_FALLBACK_LANGS = {
  json: 'json', ndjson: 'json', jsonl: 'json',
  xml: 'xml', csv: 'plaintext', tsv: 'plaintext', tab: 'plaintext',
};

window.oxj.onIngestError((m) => {
  const t = tabById(m.tabId);
  if (!t) return;
  const file = t.file;
  if (file) {
    const ext = String(file).split('.').pop().toLowerCase();
    const lang = DATA_FALLBACK_LANGS[ext] || plainLangFor(file) || 'plaintext';
    toast('Could not parse ' + baseName(file) + ' (' + m.message + ') — opened as read-only text');
    openPlainPath(file, t, lang);
    return;
  }
  t.phase = 'empty';
  t.title = 'New Tab';
  t.file = null;
  if (t === cur) { renderTabs(); renderScreen(); }
  toast('Load failed: ' + m.message);
});

window.oxj.onDocReady(async (m) => {
  const t = tabById(m.tabId);
  if (!t) return;
  t.meta = m.meta || {};
  t.docFormat = t.meta.format || 'json';
  t.rootId = parseInt(t.meta.root_id || '1', 10);
  t.tableHeaders = [];
  try { t.tableHeaders = JSON.parse(t.meta.csv_headers || '[]'); } catch {}
  t.tablePages = new Map();
  t.tableInflight = new Set();
  t.view = 'tree';
  try {
    await buildViewer(t);
  } catch (e) {
    t.phase = 'empty';
    if (t === cur) { renderTabs(); renderScreen(); }
    toast('Load failed: ' + cleanErr(e));
    return;
  }
  if (!tabAlive(t)) return;
  t.phase = 'ready';
  renderTabs();
  if (t === cur) renderScreen();
  if (m.cached) toast('Reopened instantly from cached database', true);
  else toast('Loaded ' + fmtInt(m.nodes || t.meta.total_nodes || 0) + ' nodes', true);
});

// ---------- viewer construction ----------
const isContainer = (kind, n) => kind === K.OBJ || kind === K.ARR || (kind === K.ELEM && n > 0);

async function buildViewer(t) {
  const root = await window.oxj.query(t.id, { op: 'node', node: t.rootId });
  const isCsv = t.docFormat === 'csv' || t.docFormat === 'tsv';
  t.visible = [{
    id: root.id, kind: root.kind, name: root.name, value: root.value, vlen: root.vlen,
    n: root.n, ord: root.ord, depth: 0, expanded: false, win: null,
    label: root.name || (isCsv ? baseName(t.file) : '$'),
  }];
  t.selectedIdx = 0;
  t.treeScrollTop = 0;
  t.tableTotal = Number(root.n || 0);
  if (isContainer(root.kind, root.n)) await expandAt(t, 0, 0);
}

function childLabel(t, parent, item) {
  if (item.name != null) return item.name;
  if (item.kind === K.TEXT) return '#text';
  if (parent.kind === K.ARR) {
    if (t.docFormat === 'csv' || t.docFormat === 'tsv') return 'Row ' + item.ord;
    return '[' + item.ord + ']';
  }
  return '[' + item.ord + ']';
}

function makeEntry(t, parent, item) {
  return {
    id: item.id, kind: item.kind, name: item.name, value: item.value, vlen: item.vlen,
    n: item.n, ord: item.ord, depth: parent.depth + 1, expanded: false, win: null,
    label: childLabel(t, parent, item),
  };
}

function subtreeEnd(t, idx) {
  const d = t.visible[idx].depth;
  let j = idx + 1;
  while (j < t.visible.length && t.visible[j].depth > d) j++;
  return j;
}

function collapseAt(t, idx) {
  const e = t.visible[idx];
  const end = subtreeEnd(t, idx);
  t.visible.splice(idx + 1, end - idx - 1);
  e.expanded = false;
  e.win = null;
}

async function expandAt(t, idx, start) {
  const e = t.visible[idx];
  const res = await window.oxj.query(t.id, { op: 'children', node: e.id, offset: start, limit: PAGE });
  if (!tabAlive(t)) return;
  const items = res.items.map((it) => makeEntry(t, e, it));
  const rows = [];
  if (start > 0) rows.push({ pseudo: 'before', parentId: e.id, depth: e.depth + 1, count: start });
  rows.push(...items);
  const end = start + items.length;
  if (end < e.n) rows.push({ pseudo: 'more', parentId: e.id, depth: e.depth + 1, count: e.n - end });
  t.visible.splice(idx + 1, 0, ...rows);
  e.expanded = true;
  e.win = { start, end };
}

function findParentIdx(t, pseudoIdx) {
  const pid = t.visible[pseudoIdx].parentId;
  const d = t.visible[pseudoIdx].depth;
  for (let j = pseudoIdx - 1; j >= 0; j--) {
    if (t.visible[j].depth === d - 1 && t.visible[j].id === pid) return j;
  }
  return -1;
}

async function loadMore(t, pseudoIdx) {
  const pIdx = findParentIdx(t, pseudoIdx);
  if (pIdx < 0) return;
  const e = t.visible[pIdx];
  const res = await window.oxj.query(t.id, { op: 'children', node: e.id, offset: e.win.end, limit: PAGE });
  if (!tabAlive(t)) return;
  const items = res.items.map((it) => makeEntry(t, e, it));
  e.win.end += items.length;
  if (e.win.end >= e.n || items.length === 0) {
    t.visible.splice(pseudoIdx, 1, ...items);
  } else {
    t.visible[pseudoIdx].count = e.n - e.win.end;
    t.visible.splice(pseudoIdx, 0, ...items);
  }
  if (t === cur) renderTree();
}

async function loadBefore(t, pseudoIdx) {
  const pIdx = findParentIdx(t, pseudoIdx);
  if (pIdx < 0) return;
  const e = t.visible[pIdx];
  const newStart = Math.max(0, e.win.start - PAGE);
  const count = e.win.start - newStart;
  const res = await window.oxj.query(t.id, { op: 'children', node: e.id, offset: newStart, limit: count });
  if (!tabAlive(t)) return;
  const items = res.items.map((it) => makeEntry(t, e, it));
  e.win.start = newStart;
  if (newStart === 0) {
    t.visible.splice(pseudoIdx, 1, ...items);
  } else {
    t.visible[pseudoIdx].count = newStart;
    t.visible.splice(pseudoIdx + 1, 0, ...items);
  }
  if (t === cur) renderTree();
}

async function loadAll(t, pseudoIdx) {
  const pIdx = findParentIdx(t, pseudoIdx);
  if (pIdx < 0) return;
  const e = t.visible[pIdx];
  const pseudo = t.visible[pseudoIdx];
  const remaining = Number(e.n) - e.win.end;
  if (remaining > 300000 &&
      !window.confirm('Load all ' + fmtInt(remaining) + ' remaining rows into the tree? This may take a while.')) {
    return;
  }
  pseudo.loading = true;
  pseudo.loadingText = 'loading 0 / ' + fmtInt(remaining) + '…';
  renderTree();
  const items = [];
  let offset = e.win.end;
  let sinceRender = 0;
  try {
    while (offset < e.n) {
      const res = await window.oxj.query(t.id, { op: 'children', node: e.id, offset, limit: 1000 });
      if (!tabAlive(t)) return;
      if (!res.items.length) break;
      items.push(...res.items.map((it) => makeEntry(t, e, it)));
      offset += res.items.length;
      sinceRender += res.items.length;
      if (sinceRender >= 20000) {
        sinceRender = 0;
        pseudo.loadingText = 'loading ' + fmtInt(items.length) + ' / ' + fmtInt(remaining) + '…';
        if (t === cur) renderTree();
      }
    }
    const at = t.visible.indexOf(pseudo); // re-locate: tree may have changed
    if (at >= 0) {
      // concat, not splice(...items): spread arguments overflow the call
      // stack beyond ~100k items.
      t.visible = t.visible.slice(0, at).concat(items, t.visible.slice(at + 1));
      e.win.end = offset; // only commit the window once rows are actually in
    }
    if (t === cur) {
      renderTree();
      toast('Loaded ' + fmtInt(items.length) + ' rows', true);
    }
  } catch (err) {
    pseudo.loading = false;
    pseudo.loadingText = null;
    if (t === cur) renderTree();
    toast('Load all failed: ' + cleanErr(err));
  }
}

async function toggleAt(t, idx) {
  const e = t.visible[idx];
  if (!e || e.pseudo) return;
  if (!isContainer(e.kind, e.n) || e.n === 0) return;
  if (e.expanded) collapseAt(t, idx);
  else await expandAt(t, idx, 0);
  if (t === cur) renderTree();
}

// ---------- tree rendering (virtualized, current tab only) ----------
const treeScroll = $('tree-scroll');
const treeSpacer = $('tree-spacer');
const treeRows = $('tree-rows');

function kindBadge(e) {
  if (e.kind === K.OBJ) return '{' + fmtInt(e.n) + (Number(e.n) === 1 ? ' key}' : ' keys}');
  if (e.kind === K.ARR) return '[' + fmtInt(e.n) + (Number(e.n) === 1 ? ' item]' : ' items]');
  if (e.kind === K.ELEM) return '(' + fmtInt(e.n) + ')';
  return '';
}

// Append text with occurrences of `q` wrapped in .hl spans (case-insensitive).
function appendHighlighted(el, text, q) {
  if (!q) { el.textContent = text; return; }
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let from = 0;
  let i;
  let guard = 0;
  while (guard < 50 && (i = lower.indexOf(ql, from)) !== -1) {
    if (i > from) el.appendChild(document.createTextNode(text.slice(from, i)));
    const m = document.createElement('span');
    m.className = 'hl';
    m.textContent = text.slice(i, i + q.length);
    el.appendChild(m);
    from = i + q.length;
    guard++;
  }
  el.appendChild(document.createTextNode(text.slice(from)));
}

function buildRow(t, e, idx) {
  const row = document.createElement('div');
  row.className = 'trow' + (idx % 2 ? ' zebra' : '') + (idx === t.selectedIdx ? ' selected' : '') +
    (!e.pseudo && t.matchSet && t.matchSet.has(e.id) ? ' match' : '');
  row.style.top = idx * ROW_H + 'px';
  row.dataset.idx = idx;

  const indent = document.createElement('span');
  indent.style.display = 'inline-block';
  indent.style.width = 6 + e.depth * 18 + 'px';
  indent.style.flexShrink = '0';
  row.appendChild(indent);

  if (e.pseudo) {
    const more = document.createElement('span');
    more.className = 'tmore';
    if (e.loading) {
      more.textContent = '… ' + (e.loadingText || 'loading…');
      row.appendChild(more);
      return row;
    }
    more.textContent = e.pseudo === 'more'
      ? '… load more (' + fmtInt(e.count) + ' remaining)'
      : '… show previous (' + fmtInt(e.count) + ' earlier)';
    more.dataset.act = 'page';
    row.appendChild(more);
    if (e.pseudo === 'more') {
      const all = document.createElement('span');
      all.className = 'tmore tmore-all';
      all.textContent = 'Load all';
      all.dataset.act = 'all';
      row.appendChild(all);
    }
    return row;
  }

  const tw = document.createElement('span');
  tw.className = 'twisty' + (isContainer(e.kind, e.n) && e.n > 0 ? '' : ' leaf');
  tw.textContent = e.expanded ? '▼' : '▶';
  row.appendChild(tw);

  const nav = matchNav && matchNav.tabId === t.id ? matchNav : null;
  const isMatch = nav && t.matchSet && t.matchSet.has(e.id);

  const key = document.createElement('span');
  key.className = 'tkey' + (e.kind === K.ELEM ? ' xml' : '') + (e.kind === K.ATTR ? ' attr' : '');
  const keyText = e.kind === K.ELEM ? '<' + e.label + '>' : e.kind === K.ATTR ? '@' + e.label : e.label;
  if (isMatch && nav.scope !== 'values') appendHighlighted(key, keyText, nav.q);
  else key.textContent = keyText;
  row.appendChild(key);

  if (e.kind === K.OBJ || e.kind === K.ARR || (e.kind === K.ELEM && e.n > 0)) {
    const badge = document.createElement('span');
    badge.className = 'tbadge';
    badge.textContent = ' ' + kindBadge(e);
    row.appendChild(badge);
  } else {
    const sep = document.createElement('span');
    sep.className = 'tsep';
    sep.textContent = ':';
    row.appendChild(sep);
    const val = document.createElement('span');
    let cls = 'tval';
    let text = e.value == null ? '' : String(e.value);
    if (e.kind === K.STR) {
      cls += ' str';
      if (t.docFormat === 'json' || t.docFormat === 'ndjson') text = JSON.stringify(text);
    } else if (e.kind === K.NUM) cls += ' num';
    else if (e.kind === K.BOOL) cls += ' bool';
    else if (e.kind === K.NULL) { cls += ' null'; text = 'null'; }
    else if (e.kind === K.TEXT || e.kind === K.ATTR) cls += ' str';
    if (text.length > 500) text = text.slice(0, 500) + '…';
    val.className = cls;
    if (isMatch && nav.scope !== 'keys') appendHighlighted(val, text, nav.q);
    else val.textContent = text;
    row.appendChild(val);
    if (e.vlen > 4096) {
      const note = document.createElement('span');
      note.className = 'vlen-note';
      note.textContent = '(' + fmtInt(e.vlen) + ' chars)';
      row.appendChild(note);
    }
  }
  return row;
}

function renderTree() {
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) return;
  treeSpacer.style.height = t.visible.length * ROW_H + 'px';
  const scrollTop = treeScroll.scrollTop;
  const h = treeScroll.clientHeight;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
  const last = Math.min(t.visible.length, Math.ceil((scrollTop + h) / ROW_H) + 8);
  treeRows.textContent = '';
  const frag = document.createDocumentFragment();
  for (let i = first; i < last; i++) frag.appendChild(buildRow(t, t.visible[i], i));
  treeRows.appendChild(frag);
}

// Back-to-top button: appears after scrolling down in tree or table view.
function activeScroller() {
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) return null;
  return t.view === 'table' ? tableScroll : treeScroll;
}
function updateTopBtn() {
  const sc = activeScroller();
  const btn = $('btn-top');
  btn.classList.toggle('hidden', !sc || sc.scrollTop < 600);
  // Anchor inside whichever view is active, so it hugs the tree/table edge
  // rather than floating over the Source panel.
  const wrap = cur && cur.view === 'table' ? $('table-wrap') : $('tree-wrap');
  if (btn.parentElement !== wrap) wrap.appendChild(btn);
}
$('btn-top').addEventListener('click', () => {
  const sc = activeScroller();
  if (sc) sc.scrollTo({ top: 0, behavior: 'smooth' });
});

treeScroll.addEventListener('scroll', () => { renderTree(); updateTopBtn(); });
window.addEventListener('resize', () => renderTree());

treeRows.addEventListener('click', async (ev) => {
  const t = cur;
  const rowEl = ev.target.closest('.trow');
  if (!rowEl || !t) return;
  const idx = parseInt(rowEl.dataset.idx, 10);
  const e = t.visible[idx];
  if (!e) return;
  if (e.pseudo) {
    if (e.loading) return;
    if (e.pseudo === 'more' && ev.target.dataset.act === 'all') await loadAll(t, idx);
    else if (e.pseudo === 'more') await loadMore(t, idx);
    else await loadBefore(t, idx);
    return;
  }
  selectAt(t, idx);
  if (ev.target.classList.contains('twisty')) await toggleAt(t, idx);
  renderTree();
});

treeRows.addEventListener('dblclick', async (ev) => {
  const t = cur;
  const rowEl = ev.target.closest('.trow');
  if (!rowEl || !t) return;
  const idx = parseInt(rowEl.dataset.idx, 10);
  if (t.visible[idx] && !t.visible[idx].pseudo) {
    await toggleAt(t, idx);
    renderTree();
  }
});

function selectAt(t, idx, autoSource = true) {
  t.selectedIdx = idx;
  if (t !== cur) return;
  updateStatusForSelection();
  if (sourceOpen) scheduleSourceUpdate();
  else if (autoSource) openSource(); // auto-show source for the selected node
}

function scrollToIdx(idx) {
  const y = idx * ROW_H;
  if (y < treeScroll.scrollTop || y > treeScroll.scrollTop + treeScroll.clientHeight - ROW_H) {
    treeScroll.scrollTop = Math.max(0, y - treeScroll.clientHeight / 2);
  }
}

// Keyboard navigation
document.addEventListener('keydown', async (ev) => {
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA')) return;
  if (!t.visible.length || t.selectedIdx < 0) return;
  const e = t.visible[t.selectedIdx];
  if (ev.key === 'ArrowDown' && t.selectedIdx < t.visible.length - 1) {
    selectAt(t, t.selectedIdx + 1); scrollToIdx(t.selectedIdx); renderTree(); ev.preventDefault();
  } else if (ev.key === 'ArrowUp' && t.selectedIdx > 0) {
    selectAt(t, t.selectedIdx - 1); scrollToIdx(t.selectedIdx); renderTree(); ev.preventDefault();
  } else if (ev.key === 'ArrowRight' && e && !e.pseudo && !e.expanded) {
    await toggleAt(t, t.selectedIdx); renderTree(); ev.preventDefault();
  } else if (ev.key === 'ArrowLeft' && e && !e.pseudo) {
    if (e.expanded) collapseAt(t, t.selectedIdx);
    renderTree(); ev.preventDefault();
  } else if (ev.key === 'Enter' && e && !e.pseudo) {
    await toggleAt(t, t.selectedIdx); renderTree(); ev.preventDefault();
  }
});

async function updateStatusForSelection() {
  const t = cur;
  if (!t || t.phase !== 'ready') return;
  const e = t.visible[t.selectedIdx];
  if (!e || e.pseudo) return;
  const typeNames = ['Object', 'Array', 'String', 'Number', 'Boolean', 'Null', 'Element', 'Attribute', 'Text'];
  let ty = typeNames[e.kind] || '?';
  if (e.kind === K.OBJ) ty += ' · ' + fmtInt(e.n) + ' keys';
  else if (e.kind === K.ARR) ty += ' · ' + fmtInt(e.n) + ' items';
  else if (e.kind === K.ELEM) ty += ' · ' + fmtInt(e.n) + ' children';
  else if (e.vlen) ty += ' · ' + fmtInt(e.vlen) + ' chars';
  $('status-type').textContent = ty;
  try {
    const res = await window.oxj.query(t.id, { op: 'path', node: e.id });
    if (t !== cur) return;
    $('status-path').textContent = res.path;
    $('status-path').title = res.path;
  } catch {}
}

// ---------- search: match stepping with amber highlights ----------
// No results panel: matches are highlighted in the tree; a compact bar shows
// "Match N of M" with prev/next stepping (F3 / Cmd+G).
let matchNav = null; // { tabId, q, scope, exact, ids, total, cur, after, hasMore, fetching }
const MATCH_PAGE = 500;
const INDEX_SUGGEST_NODES = 2000000;

// Enter behaves like the classic find bar: first press runs the search,
// every following press steps to the next match (until the query changes).
function currentQueryMatchesNav() {
  if (!matchNav || !cur || matchNav.tabId !== cur.id) return false;
  let q = $('search-box').value.trim();
  let exact = false;
  if (q.length > 2 && q.startsWith('"') && q.endsWith('"')) {
    exact = true;
    q = q.slice(1, -1);
  }
  return matchNav.q === q && matchNav.exact === exact && matchNav.scope === $('search-scope').value;
}

$('search-box').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    if (currentQueryMatchesNav() && matchNav.ids.length) gotoMatch(matchNav.cur + 1);
    else startSearch();
  }
  if (ev.key === 'Escape') { ev.target.value = ''; closeSearch(); }
});
$('btn-find').addEventListener('click', () => {
  if (currentQueryMatchesNav() && matchNav.ids.length) gotoMatch(matchNav.cur + 1);
  else startSearch();
});
// Fires when the X inside the field is clicked (or the field is emptied).
$('search-box').addEventListener('search', (ev) => {
  if (!ev.target.value) closeSearch();
});
$('match-prev').addEventListener('click', () => matchNav && gotoMatch(matchNav.cur - 1));
$('match-next').addEventListener('click', () => matchNav && gotoMatch(matchNav.cur + 1));

// F3 / Cmd+G step forward, with Shift step back.
document.addEventListener('keydown', (ev) => {
  if (!matchNav || !matchNav.ids.length) return;
  if (ev.key === 'F3' || ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'g')) {
    ev.preventDefault();
    gotoMatch(matchNav.cur + (ev.shiftKey ? -1 : 1));
  }
});

function closeSearch() {
  $('match-count').textContent = '';
  $('index-note').classList.add('hidden');
  $('btn-build-index').classList.add('hidden');
  if (matchNav) {
    const t = tabById(matchNav.tabId);
    if (t) {
      t.matchSet = null;
      if (t === cur) renderTree();
    }
  }
  matchNav = null;
}

function startSearch() {
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) return;
  let q = $('search-box').value.trim();
  if (!q) return;
  // "quoted text" -> exact match (values are stored unescaped, without quotes)
  let exact = false;
  if (q.length > 2 && q.startsWith('"') && q.endsWith('"')) {
    exact = true;
    q = q.slice(1, -1);
  }
  closeSearch();
  matchNav = {
    tabId: t.id, q, scope: $('search-scope').value, exact,
    ids: [], total: null, cur: -1, after: 0, hasMore: false, fetching: false,
  };
  $('match-count').textContent = 'Searching…';
  fetchMatchPage(false).then(() => {
    if (!matchNav || matchNav.tabId !== t.id) return;
    if (!matchNav.ids.length) {
      $('match-count').textContent = 'No matches';
      return;
    }
    gotoMatch(0);
  });
}

async function fetchMatchPage(retried) {
  const nav = matchNav;
  if (!nav || nav.fetching) return;
  const t = tabById(nav.tabId);
  if (!t) return;
  nav.fetching = true;
  try {
    const res = await window.oxj.query(t.id, {
      op: 'search', q: nav.q, scope: nav.scope, exact: !!nav.exact,
      offset: nav.ids.length, after: nav.after, limit: MATCH_PAGE,
      total: nav.total == null,
    });
    if (matchNav !== nav) return;
    for (const it of res.items) nav.ids.push(it.id);
    if (res.items.length) nav.after = res.items[res.items.length - 1].id;
    nav.hasMore = !!res.hasMore;
    if (res.total != null) nav.total = res.total;
    t.matchSet = new Set(nav.ids);
    if (t === cur) renderTree();
    updateIndexUi(t, res);
  } catch (e) {
    const msg = cleanErr(e);
    // The engine auto-revives on the next query - retry once for transient deaths.
    if (!retried && /engine stopped|no document loaded/i.test(msg)) {
      nav.fetching = false;
      return fetchMatchPage(true);
    }
    if (matchNav === nav) $('match-count').textContent = 'Search failed';
    toast(msg);
  } finally {
    nav.fetching = false;
  }
}

async function gotoMatch(i) {
  const nav = matchNav;
  if (!nav || !nav.ids.length) return;
  const t = tabById(nav.tabId);
  if (!t || t !== cur) return;
  if (i >= nav.ids.length && nav.hasMore) {
    await fetchMatchPage(false); // extend the loaded window
    if (matchNav !== nav) return;
  }
  if (i < 0) i = nav.ids.length - 1;
  if (i >= nav.ids.length) i = 0;
  nav.cur = i;
  updateMatchCount();
  await revealNode(t, nav.ids[i]);
}

function updateMatchCount() {
  const nav = matchNav;
  if (!nav) return;
  const totalText = nav.total != null
    ? fmtInt(nav.total)
    : fmtInt(nav.ids.length) + (nav.hasMore ? '+' : '');
  let text = 'Match ' + fmtInt(nav.cur + 1) + ' of ' + totalText;
  if (nav.exact) text += ' (exact)';
  const known = nav.total != null ? nav.total : 0;
  if (known > nav.ids.length) text += ' (first ' + fmtInt(nav.ids.length) + ' loaded)';
  $('match-count').textContent = text;
}

// ---------- search index (FTS) hint in the match bar ----------
function updateIndexUi(t, res) {
  const big = Number((t.meta && t.meta.total_nodes) || 0) > INDEX_SUGGEST_NODES;
  const built = t.meta && t.meta.fts_built === '1';
  const show = big && !built && !t.indexBuilding && !(res && res.indexed);
  $('index-note').classList.toggle('hidden', !show && !t.indexBuilding);
  if (show) $('index-note').textContent = 'Slow? Build a one-time index for instant search.';
  $('btn-build-index').classList.toggle('hidden', !show);
}

$('btn-build-index').addEventListener('click', async () => {
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain || t.indexBuilding) return;
  t.indexBuilding = true;
  $('index-note').classList.remove('hidden');
  $('index-note').textContent = 'Building index… you can keep browsing.';
  $('btn-build-index').classList.add('hidden');
  try {
    await window.oxj.buildIndex(t.id);
    if (!tabAlive(t)) return;
    try { t.meta = await window.oxj.query(t.id, { op: 'meta' }); } catch {}
    toast('Search index built — searches are now instant', true);
    t.indexBuilding = false;
    if (t === cur) {
      $('index-note').classList.add('hidden');
      // Re-run the current search against the index.
      if (matchNav && matchNav.tabId === t.id) startSearch();
    }
  } catch (err) {
    t.indexBuilding = false;
    $('index-note').classList.add('hidden');
    const msg = cleanErr(err);
    if (msg.includes('unknown command')) toast('Indexing needs an engine rebuild: npm run build:engine, then restart');
    else toast('Index build failed: ' + msg);
  }
});

window.oxj.onIndexProgress((m) => {
  const t = tabById(m.tabId);
  if (!t || t !== cur) return;
  if (m.event === 'progress' && m.total > 0) {
    const pct = Math.min(100, (m.done / m.total) * 100).toFixed(0);
    $('index-note').textContent = 'Building index… ' + pct + '%';
  } else if (m.event === 'phase' && m.phase === 'optimize') {
    $('index-note').textContent = 'Finalizing index (optimize)… this can take a few minutes';
  }
});

async function ensureChildAt(t, parentIdx, ord, childId) {
  const e = t.visible[parentIdx];
  const page = Math.floor(ord / PAGE) * PAGE;
  if (!e.expanded) {
    await expandAt(t, parentIdx, page);
  } else if (!e.win || ord < e.win.start || ord >= e.win.end) {
    collapseAt(t, parentIdx);
    await expandAt(t, parentIdx, page);
  }
  const end = subtreeEnd(t, parentIdx);
  for (let j = parentIdx + 1; j < end; j++) {
    if (!t.visible[j].pseudo && t.visible[j].id === childId && t.visible[j].depth === e.depth + 1) return j;
  }
  return -1;
}

async function revealNode(t, id) {
  try {
    if (t !== cur) setCurrent(t);
    if (t.view !== 'tree') { t.view = 'tree'; setView('tree'); }
    const res = await window.oxj.query(t.id, { op: 'path', node: id });
    const chain = res.ancestors || [];
    if (!chain.length) return;
    if (t.visible[0].id !== chain[0].id) return;
    let idx = 0;
    for (let k = 1; k < chain.length; k++) {
      idx = await ensureChildAt(t, idx, chain[k].ord, chain[k].id);
      if (idx < 0) { toast('Could not reveal node'); return; }
    }
    selectAt(t, idx, false); // reveal from search: don't auto-open the Source panel
    renderTree();
    scrollToIdx(idx);
    renderTree();
  } catch (e) {
    toast(cleanErr(e));
  }
}

// ---------- CSV table view ----------
const tableScroll = $('table-scroll');
const tableSpacer = $('table-spacer');
const tableRowsEl = $('table-rows');

// ---------- flow diagram ----------
let flowOpen = false;

function killFlow() {
  if (!flowOpen) return;
  flowOpen = false;
  $('flow-wrap').classList.add('hidden');
  $('btn-flow').classList.remove('active-tool');
  window.OXJGraph.destroy();
}

async function openFlow() {
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) return;
  if (t.docFormat === 'xml') {
    toast('Flow diagram currently supports JSON, NDJSON and CSV documents');
    return;
  }
  const e = t.visible[t.selectedIdx];
  const nodeId = e && !e.pseudo ? e.id : t.rootId;
  try {
    const res = await window.oxj.query(t.id, { op: 'subtree', node: nodeId, budget: 20000 });
    if (t !== cur) return;
    const data = JSON.parse(res.text);
    flowOpen = true;
    closeSource();
    $('tree-wrap').classList.add('hidden');
    $('table-wrap').classList.add('hidden');
    $('flow-wrap').classList.remove('hidden');
    $('btn-flow').classList.add('active-tool');
    window.OXJGraph.render($('flow-wrap'), data);
  } catch (err) {
    const msg = cleanErr(err).replace('render as source', 'diagram');
    toast('Flow diagram unavailable: ' + msg + ' — select a smaller node and try again');
  }
}

function closeFlow() {
  if (!flowOpen) return;
  killFlow();
  if (cur && cur.phase === 'ready' && !cur.plain) {
    setView(cur.view);
    renderTree();
  }
}

$('btn-flow').addEventListener('click', () => (flowOpen ? closeFlow() : openFlow()));
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && flowOpen) closeFlow();
});

function setView(name) {
  const t = cur;
  if (!t || t.plain) return;
  killFlow();
  const isCsv = t.docFormat === 'csv' || t.docFormat === 'tsv';
  const table = name === 'table' && isCsv;
  t.view = table ? 'table' : 'tree';
  $('tree-wrap').classList.toggle('hidden', table);
  $('table-wrap').classList.toggle('hidden', !table);
  $('btn-view-tree').classList.toggle('active', !table);
  $('btn-view-table').classList.toggle('active', table);
  if (table) renderTable();
  updateTopBtn();
}
$('btn-view-tree').addEventListener('click', () => setView('tree'));
$('btn-view-table').addEventListener('click', () => setView('table'));

function buildTableHead(t) {
  const head = $('table-head');
  head.textContent = '';
  const idx = document.createElement('div');
  idx.className = 'th idx';
  idx.textContent = '#';
  head.appendChild(idx);
  for (const h of t.tableHeaders) {
    const th = document.createElement('div');
    th.className = 'th';
    th.textContent = h;
    th.title = h;
    head.appendChild(th);
  }
}

async function fetchTablePage(t, page) {
  if (t.tablePages.has(page) || t.tableInflight.has(page)) return;
  t.tableInflight.add(page);
  try {
    const res = await window.oxj.query(t.id, { op: 'table', node: 1, offset: page * 100, limit: 100 });
    if (!tabAlive(t)) return;
    t.tablePages.set(page, res.rows);
    if (t === cur && t.view === 'table') renderTable();
  } catch {} finally {
    t.tableInflight.delete(page);
  }
}

function renderTable() {
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) return;
  tableSpacer.style.height = t.tableTotal * ROW_H + 'px';
  const scrollTop = tableScroll.scrollTop;
  const h = tableScroll.clientHeight;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const last = Math.min(t.tableTotal, Math.ceil((scrollTop + h) / ROW_H) + 5);
  tableRowsEl.textContent = '';
  const frag = document.createDocumentFragment();
  const needed = new Set();
  for (let i = first; i < last; i++) needed.add(Math.floor(i / 100));
  for (const p of needed) fetchTablePage(t, p);
  for (let i = first; i < last; i++) {
    const page = t.tablePages.get(Math.floor(i / 100));
    const rowData = page ? page[i % 100] : null;
    const row = document.createElement('div');
    row.className = 'table-row' + (i % 2 ? ' zebra' : '');
    row.style.top = i * ROW_H + 'px';
    const idxCell = document.createElement('div');
    idxCell.className = 'td idx';
    idxCell.textContent = fmtInt(i);
    row.appendChild(idxCell);
    const cells = rowData ? rowData.cells : [];
    for (let c = 0; c < t.tableHeaders.length; c++) {
      const td = document.createElement('div');
      td.className = 'td';
      const cell = cells[c];
      td.textContent = cell && cell.value != null ? cell.value : '';
      if (cell && cell.value) td.title = cell.value;
      row.appendChild(td);
    }
    frag.appendChild(row);
  }
  tableRowsEl.appendChild(frag);
}
tableScroll.addEventListener('scroll', () => { renderTable(); updateTopBtn(); });

// ---------- Monaco source panel ----------
function initMonaco() {
  if (typeof window.require !== 'function') return;
  try {
    window.require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
    window.require(['vs/editor/editor.main'], () => {
      monacoReady = true;
      monacoEditor = window.monaco.editor.create($('monaco-host'), {
        value: '',
        language: 'json',
        theme: uiTheme === 'light' ? 'vs' : 'vs-dark',
        readOnly: true,
        automaticLayout: true,
        minimap: { enabled: true },
        wordWrap: 'off',
        largeFileOptimizations: true,
        scrollBeyondLastLine: false,
        fontSize: 12.5,
      });
      if (sourceOpen) scheduleSourceUpdate();
      if (cur && cur.phase === 'ready' && cur.plain) renderScreen();
    });
  } catch {
    monacoReady = false;
  }
}

let sourceTimer = null;
function scheduleSourceUpdate() {
  clearTimeout(sourceTimer);
  sourceTimer = setTimeout(updateSource, 200);
}

async function updateSource() {
  const t = cur;
  if (!t || t.phase !== 'ready' || !sourceOpen) return;
  const e = t.visible[t.selectedIdx];
  if (!e || e.pseudo) return;
  $('source-title').textContent = 'Source — loading…';
  try {
    const res = await window.oxj.query(t.id, { op: 'subtree', node: e.id, budget: 50000 });
    if (t !== cur) return;
    $('source-title').textContent = 'Source — ' + (e.label || '') + ' (' + res.language.toUpperCase() + ')';
    if (monacoReady && monacoEditor) {
      $('source-fallback').classList.add('hidden');
      $('monaco-host').classList.remove('hidden');
      const model = window.monaco.editor.createModel(res.text, res.language);
      const old = monacoEditor.getModel();
      monacoEditor.setModel(model);
      if (old) old.dispose();
    } else {
      $('monaco-host').classList.add('hidden');
      const fb = $('source-fallback');
      fb.classList.remove('hidden');
      fb.textContent = res.text;
    }
    updateSource._text = res.text;
  } catch (err) {
    $('source-title').textContent = 'Source — unavailable';
    const msg = cleanErr(err).replace(/\s*\(raise the budget[^)]*\)/, '');
    if (monacoReady && monacoEditor) monacoEditor.setValue('// ' + msg);
    else { $('source-fallback').classList.remove('hidden'); $('source-fallback').textContent = msg; }
  }
}

// Drag-resize for the source panel
(function initSourceResizer() {
  const panel = $('source-panel');
  const grip = $('source-resizer');
  const saved = localStorage.getItem('oxj-source-width');
  if (saved) panel.style.width = saved + 'px';
  let startX = 0;
  let startW = 0;
  function onMove(ev) {
    const w = Math.max(280, Math.min(window.innerWidth * 0.85, startW + (startX - ev.clientX)));
    panel.style.width = w + 'px';
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('resizing');
    grip.classList.remove('dragging');
    localStorage.setItem('oxj-source-width', String(panel.getBoundingClientRect().width | 0));
    renderTree();
  }
  grip.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    startX = ev.clientX;
    startW = panel.getBoundingClientRect().width;
    document.body.classList.add('resizing');
    grip.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

function openSource() {
  sourceOpen = true;
  $('source-panel').classList.remove('hidden');
  scheduleSourceUpdate();
}
function closeSource() {
  sourceOpen = false;
  $('source-panel').classList.add('hidden');
}
$('btn-source').addEventListener('click', () => (sourceOpen ? closeSource() : openSource()));
$('btn-close-source').addEventListener('click', closeSource);
$('btn-copy-source').addEventListener('click', async () => {
  const text = monacoReady && monacoEditor ? monacoEditor.getValue() : updateSource._text || '';
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard', true);
  } catch {
    toast('Copy failed');
  }
});

// ---------- Open URL modal ----------
function showUrlModal() {
  $('url-modal').classList.remove('hidden');
  $('url-input').focus();
}
function hideUrlModal() {
  $('url-modal').classList.add('hidden');
}
$('url-auth').addEventListener('change', () => {
  const v = $('url-auth').value;
  $('url-auth-basic').classList.toggle('hidden', v !== 'basic');
  $('url-auth-token').classList.toggle('hidden', v !== 'bearer' && v !== 'apikey');
  $('url-header').classList.toggle('hidden', v !== 'apikey');
});
$('url-cancel').addEventListener('click', hideUrlModal);
$('url-modal').addEventListener('click', (ev) => { if (ev.target === $('url-modal')) hideUrlModal(); });
$('url-input').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('url-ok').click(); });
$('url-ok').addEventListener('click', async () => {
  const url = $('url-input').value.trim();
  if (!url) return;
  const type = $('url-auth').value;
  const auth = {
    type,
    user: $('url-user').value,
    pass: $('url-pass').value,
    token: $('url-token').value,
    header: $('url-header').value || 'X-API-Key',
  };
  hideUrlModal();
  toast('Fetching ' + url + '…', true);
  try {
    const file = await window.oxj.downloadUrl(url, auth);
    openPath(file);
  } catch (e) {
    toast('Fetch failed: ' + cleanErr(e));
  }
});

// ---------- native menu actions ----------
window.oxj.onMenu(async ({ action, arg }) => {
  switch (action) {
    case 'open': {
      const p = await window.oxj.pickFile();
      if (p) openPath(p);
      break;
    }
    case 'open-path':
      if (arg) openPath(arg);
      break;
    case 'open-url':
      showUrlModal();
      break;
    case 'open-clipboard':
      try {
        const file = await window.oxj.clipboardToFile();
        openPath(file);
      } catch (e) {
        toast(cleanErr(e));
      }
      break;
    case 'reload-tab':
      if (cur && cur.file) openPath(cur.file, cur, true);
      break;
    case 'duplicate-tab': {
      // Capture the source file BEFORE creating the tab — newTab() switches
      // `cur` to the new (empty) tab.
      const srcFile = cur && cur.file;
      const t = newTab(true);
      if (t && srcFile) openPath(srcFile, t);
      break;
    }
    case 'close-tab':
      if (cur) closeTab(cur);
      break;
    case 'close-all-tabs':
      closeAllTabs();
      break;
  }
});

// ============================================================
// Context menu + cross-format converters (JSON/XML/YAML/CSV)
// ============================================================
let ctxEl = null;
function closeCtxMenu() {
  if (ctxEl) { ctxEl.remove(); ctxEl = null; }
}
document.addEventListener('click', closeCtxMenu);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeCtxMenu(); });

function buildMenuEl(items) {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      menu.appendChild(s);
      continue;
    }
    const item = document.createElement('div');
    item.className = 'ctx-item' + (it.disabled ? ' disabled' : '');
    const lbl = document.createElement('span');
    lbl.textContent = it.label;
    item.appendChild(lbl);
    if (it.submenu) {
      const arrow = document.createElement('span');
      arrow.className = 'ctx-arrow';
      arrow.textContent = '▸';
      item.appendChild(arrow);
      const sub = buildMenuEl(it.submenu);
      sub.classList.add('ctx-sub');
      item.appendChild(sub);
    } else if (it.action && !it.disabled) {
      item.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeCtxMenu();
        it.action();
      });
    }
    menu.appendChild(item);
  }
  return menu;
}

function showContextMenu(x, y, items) {
  closeCtxMenu();
  ctxEl = buildMenuEl(items);
  ctxEl.style.visibility = 'hidden';
  document.body.appendChild(ctxEl);
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
  ctxEl.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  ctxEl.style.visibility = 'visible';
}

// ---------- data helpers ----------
const isScalarKind = (k) =>
  k === K.STR || k === K.NUM || k === K.BOOL || k === K.NULL || k === K.ATTR || k === K.TEXT;

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(String(text));
    toast('Copied ' + what, true);
  } catch {
    toast('Copy failed');
  }
}

async function getScalarValue(t, e) {
  if (e.kind === K.NULL) return 'null';
  if (e.vlen > 4096) {
    const n = await window.oxj.query(t.id, { op: 'node', node: e.id });
    return n.value != null ? n.value : '';
  }
  return e.value != null ? e.value : '';
}

async function getSubtree(t, e, budget) {
  return window.oxj.query(t.id, { op: 'subtree', node: e.id, budget: budget || 100000 });
}

async function getNodeObj(t, e) {
  if (isScalarKind(e.kind)) {
    const v = await getScalarValue(t, e);
    if (e.kind === K.NUM) { const n = Number(v); return Number.isFinite(n) ? n : v; }
    if (e.kind === K.BOOL) return v === 'true';
    if (e.kind === K.NULL) return null;
    return v;
  }
  const r = await getSubtree(t, e);
  if (r.language === 'json') return JSON.parse(r.text);
  return xmlTextToObj(r.text);
}

// ---------- converters ----------
function yamlScalar(v) {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (
    s === '' ||
    /[:#[\]{}&*!|>'"%@`,\n\t]/.test(s) ||
    /^[\s-]|[\s]$/.test(s) ||
    /^(true|false|null|~|yes|no|on|off)$/i.test(s) ||
    /^[+-]?[\d.eE+]+$/.test(s)
  ) return JSON.stringify(s);
  return s;
}

function toYaml(v, indent) {
  indent = indent || 0;
  const pad = '  '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return pad + '[]';
    return v.map((it) => {
      if (it !== null && typeof it === 'object') return pad + '-\n' + toYaml(it, indent + 1);
      return pad + '- ' + yamlScalar(it);
    }).join('\n');
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return pad + '{}';
    return keys.map((k) => {
      const val = v[k];
      const key = /^[\w.-]+$/.test(k) ? k : JSON.stringify(k);
      if (val !== null && typeof val === 'object') {
        const empty = Array.isArray(val) ? !val.length : !Object.keys(val).length;
        if (empty) return pad + key + ': ' + (Array.isArray(val) ? '[]' : '{}');
        return pad + key + ':\n' + toYaml(val, indent + 1);
      }
      return pad + key + ': ' + yamlScalar(val);
    }).join('\n');
  }
  return pad + yamlScalar(v);
}

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function xmlName(k) {
  const n = String(k).replace(/[^\w.-]/g, '_');
  return /^[A-Za-z_]/.test(n) ? n : '_' + n;
}
function toXmlStr(v, name, indent) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(v)) {
    return v.map((it) => toXmlStr(it, name, indent)).join('\n');
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return pad + '<' + xmlName(name) + '/>';
    const inner = keys.map((k) => toXmlStr(v[k], k, indent + 1)).join('\n');
    return pad + '<' + xmlName(name) + '>\n' + inner + '\n' + pad + '</' + xmlName(name) + '>';
  }
  return pad + '<' + xmlName(name) + '>' + xmlEsc(v === null ? '' : v) + '</' + xmlName(name) + '>';
}
function exportXml(obj) {
  if (Array.isArray(obj)) {
    return '<root>\n' + obj.map((it) => toXmlStr(it, 'item', 1)).join('\n') + '\n</root>';
  }
  return toXmlStr(obj, 'root', 0);
}

function csvCell(v, delim) {
  if (v == null) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (s.includes('"') || s.includes(delim) || s.includes('\n') || s.includes('\r')) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
function toCsvStr(v) {
  const delim = ',';
  let arr = v;
  if (!Array.isArray(arr) && arr && typeof arr === 'object') {
    const arrProps = Object.values(arr).filter(Array.isArray);
    if (arrProps.length === 1) arr = arrProps[0];
    else arr = null;
  }
  if (!Array.isArray(arr)) throw new Error('this node is not tabular (need an array)');
  if (arr.every((r) => r === null || typeof r !== 'object')) {
    return 'value\n' + arr.map((r) => csvCell(r, delim)).join('\n');
  }
  const headers = [];
  arr.forEach((r) => {
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      Object.keys(r).forEach((k) => { if (!headers.includes(k)) headers.push(k); });
    }
  });
  if (!headers.length) throw new Error('this node is not tabular');
  const lines = [headers.map((h) => csvCell(h, delim)).join(delim)];
  arr.forEach((r) => {
    lines.push(headers.map((h) => csvCell(r && typeof r === 'object' && !Array.isArray(r) ? r[h] : r, delim)).join(delim));
  });
  return lines.join('\n');
}

function xmlTextToObj(text) {
  const parse = (s) => {
    const doc = new DOMParser().parseFromString(s, 'application/xml');
    return doc.querySelector('parsererror') ? null : doc;
  };
  let doc = parse(text);
  if (!doc) doc = parse('<root>' + text + '</root>');
  if (!doc) throw new Error('could not parse XML fragment');
  function walk(el) {
    const out = {};
    for (const a of el.attributes) out['@' + a.name] = a.value;
    let textContent = '';
    for (const ch of el.childNodes) {
      if (ch.nodeType === 1) {
        const o = walk(ch);
        const n = ch.tagName;
        if (out[n] === undefined) out[n] = o;
        else {
          if (!Array.isArray(out[n])) out[n] = [out[n]];
          out[n].push(o);
        }
      } else if (ch.nodeType === 3 || ch.nodeType === 4) {
        textContent += ch.nodeValue;
      }
    }
    const txt = textContent.trim();
    if (txt) {
      if (!Object.keys(out).length) return txt;
      out['#text'] = txt;
    }
    return Object.keys(out).length ? out : '';
  }
  return { [doc.documentElement.tagName]: walk(doc.documentElement) };
}

async function convertNode(t, e, fmt) {
  const obj = await getNodeObj(t, e);
  if (fmt === 'json') return JSON.stringify(obj, null, 2);
  if (fmt === 'rawjson') return JSON.stringify(obj);
  if (fmt === 'yaml') return toYaml(obj);
  if (fmt === 'xml') return exportXml(obj);
  if (fmt === 'csv') return toCsvStr(obj);
  throw new Error('unknown format');
}

function defaultExportName(e, ext) {
  const base = String(e.label || 'value').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'value';
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return base + '_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.' + ext;
}

async function copyNodeAs(t, e, fmt) {
  try { await copyText(await convertNode(t, e, fmt), fmt === 'rawjson' ? 'raw JSON' : fmt.toUpperCase()); }
  catch (err) { toast('Convert failed: ' + cleanErr(err)); }
}

async function exportNodeAs(t, e, fmt) {
  try {
    const text = await convertNode(t, e, fmt);
    const saved = await window.oxj.saveText(defaultExportName(e, fmt === 'rawjson' ? 'json' : fmt), text);
    if (saved) toast('Saved ' + baseName(saved), true);
  } catch (err) { toast('Export failed: ' + cleanErr(err)); }
}

async function copyCsvRow(t, e) {
  try {
    const res = await window.oxj.query(t.id, { op: 'children', node: e.id, offset: 0, limit: 1000 });
    const delim = t.docFormat === 'tsv' ? '\t' : ',';
    await copyText(res.items.map((c) => csvCell(c.value, delim)).join(delim), 'row');
  } catch (err) { toast(cleanErr(err)); }
}

async function copyToNewTab(t, e) {
  try {
    const r = await getSubtree(t, e);
    const ext = r.language === 'xml' ? 'xml' : 'json';
    const file = await window.oxj.textToFile(e.label || 'fragment', ext, r.text);
    const nt = newTab(true);
    if (nt) openPath(file, nt);
  } catch (err) { toast(cleanErr(err)); }
}

async function showStats(t, e) {
  try {
    const s = await window.oxj.query(t.id, { op: 'stats', node: e.id });
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'modal';
    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = 'Statistics — ' + (e.label || '');
    box.appendChild(title);
    const addRow = (k, v) => {
      const row = document.createElement('div');
      row.className = 'stat-kv';
      const kk = document.createElement('span'); kk.className = 'k'; kk.textContent = k;
      const vv = document.createElement('span'); vv.textContent = v;
      row.append(kk, vv);
      box.appendChild(row);
    };
    addRow('Direct children', fmtInt(s.children));
    for (const [k, v] of Object.entries(s.kinds || {})) addRow('· ' + k, fmtInt(v));
    addRow('Distinct values', fmtInt(s.distinct_values));
    if (s.numeric && s.numeric.count > 0) {
      addRow('Numeric values', fmtInt(s.numeric.count));
      const f = (x) => (x == null ? '—' : Number(x).toLocaleString(undefined, { maximumFractionDigits: 4 }));
      addRow('· min', f(s.numeric.min));
      addRow('· max', f(s.numeric.max));
      addRow('· average', f(s.numeric.avg));
    }
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-secondary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => back.remove());
    actions.appendChild(closeBtn);
    box.appendChild(actions);
    back.appendChild(box);
    back.addEventListener('click', (ev) => { if (ev.target === back) back.remove(); });
    document.body.appendChild(back);
  } catch (err) {
    const msg = cleanErr(err);
    if (msg.includes('unknown op')) toast('Statistics needs an engine rebuild: npm run build:engine, then restart');
    else toast(msg);
  }
}

async function expandAllAt(t, idx, budget) {
  const e = t.visible[idx];
  if (!isContainer(e.kind, e.n) || e.n === 0 || budget.n <= 0) return;
  if (!e.expanded) {
    await expandAt(t, idx, 0);
    budget.n -= Math.min(Number(e.n), PAGE);
  }
  for (let j = idx + 1; j < subtreeEnd(t, idx) && budget.n > 0; j++) {
    const c = t.visible[j];
    if (!c.pseudo && c.depth === e.depth + 1 && isContainer(c.kind, c.n) && c.n > 0 && !c.expanded) {
      await expandAllAt(t, j, budget);
    }
  }
}

function displayText(e) {
  if (e.kind === K.NULL) return 'null';
  if (e.kind === K.OBJ || e.kind === K.ARR || e.kind === K.ELEM) return kindBadge(e);
  return e.value != null ? String(e.value) : '';
}

function treeMenuItems(t, idx, e) {
  const isCsvDoc = t.docFormat === 'csv' || t.docFormat === 'tsv';
  const isCsvRow = isCsvDoc && e.kind === K.OBJ && e.depth === 1;
  const scalar = isScalarKind(e.kind);
  const container = isContainer(e.kind, e.n);
  const items = [];

  if (isCsvRow) {
    items.push({ label: 'Copy Row (CSV)', action: () => copyCsvRow(t, e) });
    items.push({ label: 'Copy Row As JSON', action: () => copyNodeAs(t, e, 'json') });
  } else {
    items.push({
      label: 'Copy Name',
      disabled: e.name == null,
      action: () => copyText(e.name, 'name'),
    });
    items.push({
      label: 'Copy Value',
      action: async () => {
        try {
          const text = scalar ? await getScalarValue(t, e) : (await getSubtree(t, e)).text;
          await copyText(text, 'value');
        } catch (err) { toast(cleanErr(err)); }
      },
    });
  }
  items.push({
    label: 'Copy Value As',
    submenu: [
      { label: 'Pretty JSON', action: () => copyNodeAs(t, e, 'json') },
      { label: 'Raw Token', action: () => copyNodeAs(t, e, 'rawjson') },
      { label: 'YAML', action: () => copyNodeAs(t, e, 'yaml') },
      { label: 'XML', action: () => copyNodeAs(t, e, 'xml') },
      { label: 'CSV', action: () => copyNodeAs(t, e, 'csv') },
      { label: 'Display Text', action: () => copyText(displayText(e), 'text') },
    ],
  });
  items.push({ sep: true });
  items.push({
    label: 'Copy Path',
    action: async () => {
      try {
        const r = await window.oxj.query(t.id, { op: 'path', node: e.id });
        await copyText(r.path, 'path');
      } catch (err) { toast(cleanErr(err)); }
    },
  });
  items.push({ sep: true });
  items.push({ label: 'Copy to New Tab', action: () => copyToNewTab(t, e) });
  items.push({ sep: true });
  items.push({
    label: 'Export Value As',
    submenu: [
      { label: 'JSON', action: () => exportNodeAs(t, e, 'json') },
      { label: 'XML', action: () => exportNodeAs(t, e, 'xml') },
      { label: 'YAML', action: () => exportNodeAs(t, e, 'yaml') },
      { label: 'CSV', action: () => exportNodeAs(t, e, 'csv') },
    ],
  });
  items.push({ sep: true });
  items.push({ label: 'Statistics…', action: () => showStats(t, e) });
  items.push({ sep: true });
  items.push({
    label: 'Expand Children',
    disabled: !container || e.n === 0 || e.expanded,
    action: async () => { await toggleAt(t, idx); },
  });
  items.push({
    label: 'Expand All',
    disabled: !container || e.n === 0,
    action: async () => {
      const b = { n: 2000 };
      await expandAllAt(t, idx, b);
      renderTree();
      if (b.n <= 0) toast('Expanded the first ~2,000 rows (limit reached)', true);
    },
  });
  items.push({
    label: 'Collapse',
    disabled: !e.expanded,
    action: () => { collapseAt(t, idx); renderTree(); },
  });
  return items;
}

treeRows.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) return;
  const rowEl = ev.target.closest('.trow');
  if (!rowEl) return;
  const idx = parseInt(rowEl.dataset.idx, 10);
  const e = t.visible[idx];
  if (!e || e.pseudo) return;
  selectAt(t, idx);
  renderTree();
  showContextMenu(ev.clientX, ev.clientY, treeMenuItems(t, idx, e));
});

// ============================================================
// Tools: Generate Schema / Validate / Compare With Open Tab
// ============================================================
function simpleModal(titleText) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  const box = document.createElement('div');
  box.className = 'modal';
  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = titleText;
  box.appendChild(title);
  back.appendChild(box);
  back.addEventListener('click', (ev) => { if (ev.target === back) back.remove(); });
  document.body.appendChild(back);
  return { back, box };
}

async function openTextAsTab(name, ext, text) {
  const file = await window.oxj.textToFile(name, ext, text);
  const nt = newTab(true);
  if (nt) openPath(file, nt);
}

async function generateSchema() {
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) return;
  try {
    toast('Generating schema…', true);
    const res = await window.oxj.query(t.id, { op: 'schema', node: t.rootId });
    const text = JSON.stringify(res.schema, null, 2);
    await openTextAsTab(baseName(t.file).replace(/\.[^.]+$/, '') + '_schema', 'json', text);
    if (res.sampled) toast('Schema inferred from a sample of a very large document', true);
  } catch (err) {
    const msg = cleanErr(err);
    if (msg.includes('unknown op')) toast('This tool needs an engine rebuild: npm run build:engine, then restart');
    else toast('Schema generation failed: ' + msg);
  }
}

async function validateAgainstSchema() {
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) return;
  const p = await window.oxj.pickFile();
  if (!p) return;
  let schema;
  try {
    schema = JSON.parse(await window.oxj.readFileText(p));
  } catch (err) {
    toast('Could not read schema file: ' + cleanErr(err));
    return;
  }
  try {
    toast('Validating…', true);
    const res = await window.oxj.query(t.id, { op: 'validate', schema, node: t.rootId });
    if (!res.count) {
      toast('Valid — no schema violations found ✓', true);
      return;
    }
    const { box, back } = simpleModal(
      'Validation — ' + fmtInt(res.count) + (res.truncated ? '+' : '') + ' error(s)'
    );
    const list = document.createElement('div');
    list.style.cssText = 'max-height:50vh;overflow-y:auto;';
    for (const e of res.errors.slice(0, 300)) {
      const row = document.createElement('div');
      row.className = 'stat-kv';
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = e.path;
      k.style.cssText = 'overflow:hidden;text-overflow:ellipsis;max-width:45%;';
      const v = document.createElement('span');
      v.textContent = e.message;
      row.append(k, v);
      list.appendChild(row);
    }
    box.appendChild(list);
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const save = document.createElement('button');
    save.className = 'btn-secondary';
    save.textContent = 'Save Report';
    save.addEventListener('click', async () => {
      const report =
        'OPENXMLJSON schema validation report\nDocument: ' + t.file + '\nSchema: ' + p +
        '\nErrors: ' + res.count + (res.truncated ? '+ (truncated)' : '') + '\n\n' +
        res.errors.map((e) => e.path + '\t' + e.message).join('\n');
      const saved = await window.oxj.saveText('validation_report.txt', report);
      if (saved) toast('Saved ' + baseName(saved), true);
    });
    const close = document.createElement('button');
    close.className = 'btn-secondary';
    close.textContent = 'Close';
    close.addEventListener('click', () => back.remove());
    actions.append(save, close);
    box.appendChild(actions);
  } catch (err) {
    const msg = cleanErr(err);
    if (msg.includes('unknown op')) toast('This tool needs an engine rebuild: npm run build:engine, then restart');
    else toast('Validation failed: ' + msg);
  }
}

async function compareWithTab() {
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) return;
  const others = tabs.filter(
    (x) => x !== t && x.phase === 'ready' && !x.plain && !(x.meta && x.meta.mode === 'memory')
  );
  if (!others.length) {
    toast('Open the document to compare with in another tab first (database mode)');
    return;
  }
  const { box, back } = simpleModal('Compare "' + t.title + '" with…');
  for (const o of others) {
    const row = document.createElement('div');
    row.className = 'recent-item';
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = o.title;
    name.title = o.file || '';
    row.appendChild(name);
    row.addEventListener('click', async () => {
      back.remove();
      try {
        toast('Comparing…', true);
        const res = await window.oxj.diffTabs(t.id, o.id);
        const total = Number(res.added) + Number(res.removed) + Number(res.changed);
        if (!total) {
          toast('Documents are structurally identical ✓', true);
          return;
        }
        const lines = [
          'OPENXMLJSON comparison report',
          'A: ' + (t.file || t.title),
          'B: ' + (o.file || o.title),
          '',
          'Added: ' + res.added + '   Removed: ' + res.removed + '   Changed: ' + res.changed +
            (res.truncated ? '   (report truncated)' : ''),
          '',
        ];
        for (const e of res.entries) {
          if (e.op === 'changed') lines.push('[changed] ' + e.path + ': ' + (e.a ?? '') + '  →  ' + (e.b ?? ''));
          else if (e.op === 'added') lines.push('[added]   ' + e.path + ' = ' + (e.b ?? ''));
          else lines.push('[removed] ' + e.path + ' (was ' + (e.a ?? '') + ')');
        }
        await openTextAsTab('compare_report', 'txt', lines.join('\n'));
        toast(fmtInt(total) + ' difference(s): +' + res.added + ' −' + res.removed + ' ~' + res.changed, true);
      } catch (err) {
        toast('Compare failed: ' + cleanErr(err));
      }
    });
    box.appendChild(row);
  }
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const close = document.createElement('button');
  close.className = 'btn-secondary';
  close.textContent = 'Cancel';
  close.addEventListener('click', () => back.remove());
  actions.appendChild(close);
  box.appendChild(actions);
}

$('btn-tools').addEventListener('click', (ev) => {
  ev.stopPropagation();
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) return;
  if (t.docFormat !== 'json' && t.docFormat !== 'ndjson') return; // JSON documents only
  const r = ev.currentTarget.getBoundingClientRect();
  showContextMenu(r.left, r.bottom + 4, [
    { label: 'Generate JSON Schema', action: generateSchema },
    { label: 'Validate Against JSON Schema…', action: validateAgainstSchema },
    { sep: true },
    { label: 'Compare With Open Tab…', action: compareWithTab },
  ]);
});

// ============================================================
// jq filter bar
// ============================================================
let jqBusy = false;

const JQ_MAX_NODES = 300000; // matches the subtree reconstruction budget

function jqApplicable(t) {
  return t && t.phase === 'ready' && !t.plain &&
    (t.docFormat === 'json' || t.docFormat === 'ndjson' || t.docFormat === 'csv' || t.docFormat === 'tsv') &&
    Number((t.meta && t.meta.total_nodes) || 0) <= JQ_MAX_NODES;
}

function toggleJqBar() {
  const bar = $('jq-bar');
  const show = bar.classList.contains('hidden');
  bar.classList.toggle('hidden', !show);
  if (show) $('jq-input').focus();
}

$('btn-jq').addEventListener('click', async () => {
  if (!jqApplicable(cur)) return;
  if (!(await window.oxj.jqAvailable())) {
    toast('jq is not installed — run: brew install jq');
    return;
  }
  toggleJqBar();
});
$('jq-close').addEventListener('click', () => $('jq-bar').classList.add('hidden'));
$('jq-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') runJqProgram();
  if (ev.key === 'Escape') $('jq-bar').classList.add('hidden');
});
$('jq-run').addEventListener('click', () => runJqProgram());

async function runJqProgram() {
  const t = cur;
  if (!jqApplicable(t) || jqBusy) return;
  const program = $('jq-input').value.trim();
  if (!program) return;
  const scope = $('jq-scope').value;
  const e = t.visible[t.selectedIdx];
  const nodeId = scope === 'selected' && e && !e.pseudo ? e.id : t.rootId;
  jqBusy = true;
  $('jq-run').textContent = 'Running…';
  try {
    const sub = await window.oxj.query(t.id, { op: 'subtree', node: nodeId, budget: 300000 });
    const inputFile = await window.oxj.textToFile('jq_input', 'json', sub.text);
    const outFile = await window.oxj.runJq(program, inputFile);
    const nt = newTab(true);
    if (nt) openPath(outFile, nt);
    toast('jq result opened in a new tab', true);
  } catch (err) {
    const msg = cleanErr(err).replace('render as source', 'feed into jq');
    toast('jq: ' + msg);
  } finally {
    jqBusy = false;
    $('jq-run').textContent = 'Run ↵';
  }
}

// ---------- jq help: examples built from THIS document ----------
function jqField(k) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? '.' + k : '.[' + JSON.stringify(k) + ']';
}

// Inspect the document (root, its arrays, and the fields of their first
// object element) and produce concrete, runnable jq examples using the
// real key names and values found in the data.
async function buildJqExamples(t) {
  const q = (payload) => window.oxj.query(t.id, payload);
  const root = await q({ op: 'node', node: t.rootId });
  const ex = [];
  const add = (cmd, desc) => ex.push({ cmd, desc });

  async function fieldsOfFirstObject(arrId) {
    const kids = await q({ op: 'children', node: arrId, offset: 0, limit: 1 });
    if (!kids.items.length || kids.items[0].kind !== K.OBJ) return null;
    const f = await q({ op: 'children', node: kids.items[0].id, offset: 0, limit: 50 });
    return f.items;
  }

  // Locate up to two arrays (root itself, direct children, or one level deeper).
  const arrays = [];
  if (root.kind === K.ARR) {
    arrays.push({ path: '', n: root.n, fields: (await fieldsOfFirstObject(root.id)) || [] });
  } else if (root.kind === K.OBJ) {
    const kids = await q({ op: 'children', node: root.id, offset: 0, limit: 100 });
    const keyNames = kids.items.map((i) => i.name).filter(Boolean);
    add('keys', 'Top-level keys of this document (' + keyNames.slice(0, 4).join(', ') + (keyNames.length > 4 ? ', …' : '') + ')');
    for (const k of kids.items) {
      if (arrays.length >= 2) break;
      if (k.kind === K.ARR && k.n > 0 && k.name) {
        arrays.push({ path: jqField(k.name), n: k.n, fields: (await fieldsOfFirstObject(k.id)) || [] });
      } else if (k.kind === K.OBJ && k.name && !arrays.length) {
        const gk = await q({ op: 'children', node: k.id, offset: 0, limit: 50 });
        for (const g of gk.items) {
          if (g.kind === K.ARR && g.n > 0 && g.name && arrays.length < 2) {
            arrays.push({
              path: jqField(k.name) + jqField(g.name),
              n: g.n,
              fields: (await fieldsOfFirstObject(g.id)) || [],
            });
          }
        }
      }
    }
  }

  for (let ai = 0; ai < arrays.length; ai++) {
    const a = arrays[ai];
    const base = a.path;
    const it = base + '[]';
    const label = base || 'the root array';
    add((base || '.') + ' | length', 'Count elements of ' + label + ' (' + fmtInt(a.n) + ')');
    if (ai > 0) continue; // full example set only for the primary array
    add(base + '[0]', 'First element of ' + label);
    const f = a.fields || [];
    const strF = f.find((x) => x.kind === K.STR && x.name);
    const numF = f.find((x) => x.kind === K.NUM && x.name);
    const boolF = f.find((x) => x.kind === K.BOOL && x.name);
    const identNames = f.filter((x) => x.name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(x.name)).map((x) => x.name);
    if (f.length) add(base + '[0] | keys', 'Field names of one element');
    if (identNames.length >= 2) {
      add(it + ' | {' + identNames.slice(0, 2).join(', ') + '}', 'Project only ' + identNames.slice(0, 2).join(' and '));
    }
    if (strF) {
      add(base + ' | map(' + jqField(strF.name) + ')', 'map: collect every ' + strF.name + ' into one array');
      const sv = String(strF.value != null ? strF.value : '').slice(0, 40);
      if (sv) {
        add(it + ' | select(' + jqField(strF.name) + ' == ' + JSON.stringify(sv) + ')', 'select: elements where ' + strF.name + ' equals this value (from your data)');
        if (/^[\w .-]{3,}$/.test(sv)) {
          add(it + ' | select(' + jqField(strF.name) + ' | test(' + JSON.stringify(sv.slice(0, 3)) + '; "i"))', 'select + regex: ' + strF.name + ' matching a pattern, case-insensitive');
        }
      }
      add('[' + it + ' | ' + jqField(strF.name) + '] | unique', 'Distinct ' + strF.name + ' values');
      add(base + ' | group_by(' + jqField(strF.name) + ') | map({' + (/^[A-Za-z_]\w*$/.test(strF.name) ? strF.name : 'key') + ': .[0]' + jqField(strF.name) + ', count: length})', 'group_by: count elements per ' + strF.name);
    }
    if (boolF) {
      add(it + ' | select(' + jqField(boolF.name) + ')', 'select: only elements where ' + boolF.name + ' is true');
      add(base + ' | map(select(' + jqField(boolF.name) + ' | not)) | length', 'Count elements where ' + boolF.name + ' is false');
    }
    if (numF) {
      const v = Number(numF.value);
      const cmp = Number.isFinite(v) ? v : 0;
      add(it + ' | select(' + jqField(numF.name) + ' > ' + cmp + ')', 'select: filter by ' + numF.name + ' > ' + cmp + ' (a real value from your data)');
      add('[' + it + ' | ' + jqField(numF.name) + '] | add / length', 'Average ' + numF.name);
      add('[' + it + ' | ' + jqField(numF.name) + '] | max', 'Maximum ' + numF.name);
      add(base + ' | sort_by(' + jqField(numF.name) + ') | reverse | .[0:5]', 'Top 5 elements by ' + numF.name);
      add(base + ' | map(select(' + jqField(numF.name) + ' > ' + cmp + ')) | length', 'map + select: count matching elements');
    }
    if (strF && numF) {
      add(it + ' | select(' + jqField(numF.name) + ' > ' + (Number.isFinite(Number(numF.value)) ? Number(numF.value) : 0) + ') | ' + jqField(strF.name), 'Combine: filter on ' + numF.name + ', output ' + strF.name);
    }
  }

  if (!arrays.length && root.kind === K.OBJ) {
    const kids = await q({ op: 'children', node: root.id, offset: 0, limit: 20 });
    const first = kids.items.find((k) => k.name);
    if (first) add(jqField(first.name), 'Access the ' + first.name + ' field');
    add('to_entries | map({key, type: (.value | type)})', 'Inspect the type of every top-level field');
  }
  add('[paths(scalars) | map(tostring) | join(".")] | .[0:20]', 'First 20 leaf paths in this document');
  return ex;
}

async function showJqHelp() {
  const t = cur;
  if (!jqApplicable(t)) return;
  let examples;
  try {
    examples = await buildJqExamples(t);
  } catch (err) {
    toast('Could not analyze document: ' + cleanErr(err));
    return;
  }
  const { box, back } = simpleModal('jq examples for ' + (t.title || 'this document'));
  const hint = document.createElement('div');
  hint.style.cssText = 'color:var(--fg-dim);font-size:12px;';
  hint.textContent = 'Built from the structure and values of this document — click one to insert it.';
  box.appendChild(hint);
  const list = document.createElement('div');
  list.className = 'jq-ex-list';
  for (const e of examples) {
    const row = document.createElement('div');
    row.className = 'jq-ex';
    const cmd = document.createElement('div');
    cmd.className = 'jq-ex-cmd';
    cmd.textContent = e.cmd;
    const desc = document.createElement('div');
    desc.className = 'jq-ex-desc';
    desc.textContent = e.desc;
    row.append(cmd, desc);
    row.addEventListener('click', () => {
      $('jq-input').value = e.cmd;
      back.remove();
      $('jq-input').focus();
    });
    list.appendChild(row);
  }
  box.appendChild(list);
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const close = document.createElement('button');
  close.className = 'btn-secondary';
  close.textContent = 'Close';
  close.addEventListener('click', () => back.remove());
  actions.appendChild(close);
  box.appendChild(actions);
}

$('jq-help').addEventListener('click', () => showJqHelp());

// ---------- theme ----------
function applyTheme(eff) {
  uiTheme = eff;
  document.body.classList.toggle('light', eff === 'light');
  if (monacoReady && window.monaco) {
    window.monaco.editor.setTheme(eff === 'light' ? 'vs' : 'vs-dark');
  }
}
window.oxj.onTheme((eff) => applyTheme(eff));

// ---------- init ----------
initMonaco();
window.oxj.getTheme().then((eff) => applyTheme(eff)).catch(() => {});
newTab(true);
