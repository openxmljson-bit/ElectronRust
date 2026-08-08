/* NARIKJSON — renderer. Tabbed UI (max 12) over per-tab engine sessions. */
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
    colWidths: null,   // per original column index
    colOrder: null,    // original indices in display order
    colHidden: null,   // Set of hidden original indices
    colPinned: null,   // Set of pinned (frozen-left) original indices
    tableSel: null,    // { aRow, aVis, fRow, fVis } rectangular selection
    tableSort: null,   // { col, dir } server-side sort
    tableFilters: [],  // [{ col, op, value }] server-side filters
    tableViewTotal: null, // filtered row count (null = full tableTotal)
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
const FULL_FILE_MAX = 450 * 1024 * 1024; // read cap for the Full File tab (V8 string limit)

// Pretty-print JSON, tolerating a leading UTF-8 BOM (common in exported
// Arabic/Windows feeds) which would otherwise make JSON.parse throw. Unicode
// (Arabic, etc.) is preserved as-is by JSON.stringify.
function prettyJsonText(src) {
  const s = src.replace(/^\uFEFF/, '');
  try {
    // A single JSON value (object/array) \u2014 pretty-print the whole thing.
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch { /* not one value \u2014 try NDJSON (one object per line) */ }
  const out = [];
  let count = 0;
  for (const ln of s.split(/\r?\n/)) {
    const t = ln.trim();
    if (!t) continue;
    out.push(JSON.stringify(JSON.parse(t), null, 2)); // throws on a bad line \u2192 caller keeps raw
    count++;
  }
  if (!count) throw new Error('nothing to format');
  return out.join('\n');
}

// A doc is "not fully pretty-printed" (worth reformatting) when its average
// line is long — true for single-line minified JSON and for line-delimited
// (one object per line) files alike. Genuinely 2-space-indented JSON has short
// lines (avg ~15-40), so it's left alone.
function looksMinified(text) {
  const sample = text.length > 262144 ? text.slice(0, 262144) : text;
  let lines = 1;
  for (let i = 0; i < sample.length; i++) if (sample.charCodeAt(i) === 10) lines++;
  return sample.length / lines > 120;
}

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
  if (isDuck(t) && t.duck) { try { window.oxj.duckInvoke('closeDataset', { datasetId: t.duck.datasetId }); } catch {} }
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

// Close every tab except `keep`.
async function closeOtherTabs(keep) {
  const others = tabs.filter((t) => t !== keep);
  tabs = tabs.filter((t) => t === keep);
  for (const t of others) {
    if (t.plainModel) { try { t.plainModel.dispose(); } catch {} t.plainModel = null; }
    try { await window.oxj.closeTab(t.id); } catch {}
  }
  setCurrent(keep);
}

// Close tabs on one side of `anchor` ('left' or 'right').
async function closeTabsToSide(anchor, side) {
  const at = tabs.indexOf(anchor);
  if (at < 0) return;
  const doomed = side === 'left' ? tabs.slice(0, at) : tabs.slice(at + 1);
  if (!doomed.length) return;
  tabs = tabs.filter((t) => !doomed.includes(t));
  for (const t of doomed) {
    if (t.plainModel) { try { t.plainModel.dispose(); } catch {} t.plainModel = null; }
    try { await window.oxj.closeTab(t.id); } catch {}
  }
  if (!tabs.includes(cur)) setCurrent(anchor);
  else renderTabs();
}

// Right-click menu on a tab (reuses the shared context-menu widget).
function showTabMenu(x, y, t) {
  const at = tabs.indexOf(t);
  showContextMenu(x, y, [
    {
      label: 'Duplicate Tab',
      disabled: !t.file,
      action: () => { const nt = newTab(true); if (nt && t.file) openPath(t.file, nt); },
    },
    { sep: true },
    { label: 'Close Tab', action: () => closeTab(t) },
    { label: 'Close Other Tabs', disabled: tabs.length <= 1, action: () => closeOtherTabs(t) },
    { label: 'Close Tabs to the Left', disabled: at <= 0, action: () => closeTabsToSide(t, 'left') },
    { label: 'Close Tabs to the Right', disabled: at >= tabs.length - 1, action: () => closeTabsToSide(t, 'right') },
  ]);
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
    el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); showTabMenu(ev.clientX, ev.clientY, t); });
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
  // "+" — open another file in a new tab.
  const add = document.createElement('button');
  add.className = 'tab-add';
  add.textContent = '+';
  add.title = 'Open a file in a new tab';
  add.addEventListener('click', async () => {
    const p = await window.oxj.pickFile();
    if (p) openFileWithPrompt(p); // targetTabForOpen() makes a new tab when the current one is busy
  });
  host.appendChild(add);
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
    applyRecentPanel(); // keep the dock's open/closed + width (remembered)
    $('btn-source').classList.toggle('hidden', plain);
    // Raw File opens the file in a read-only tab, size-gated at 450 MB (V8
    // string limit). Hidden for plain tabs, oversized files, and CSV/TSV.
    const srcBytes = Number((t.meta && t.meta.source_bytes) || 0);
    const isCsvDoc = t.docFormat === 'csv' || t.docFormat === 'tsv';
    const duck = isDuck(t);
    // DuckDB tables: table-only (no tree/flow/raw-file/tools yet).
    $('btn-full-file').classList.toggle('hidden', plain || isCsvDoc || srcBytes > FULL_FILE_MAX);
    $('btn-flow').classList.toggle('hidden', plain || duck || t.docFormat === 'xml');
    $('btn-edit-url').classList.toggle('hidden', !t.origin); // shown for URL-loaded docs
    const memMode = t.meta && t.meta.mode === 'memory';
    $('btn-tools').classList.toggle('hidden',
      plain || (t.docFormat !== 'json' && t.docFormat !== 'ndjson'));
    $('search-scope').classList.toggle('hidden', plain || duck);   // JSON scopes only
    $('search-mode').classList.toggle('hidden', plain || !duck);   // duck: contains/exact/regex
    $('search-box').classList.toggle('hidden', plain);             // duck: search every column
    $('btn-find').classList.toggle('hidden', plain);
    $('match-prev').classList.toggle('hidden', plain || duck);     // asFilter search: no stepping
    $('match-next').classList.toggle('hidden', plain || duck);
    $('text-wrap').classList.toggle('hidden', !plain);
    if (plain) {
      $('view-toggle').classList.add('hidden');
      $('tree-wrap').classList.add('hidden');
      $('table-wrap').classList.add('hidden');
      // Table-only tools never apply to plain-text docs (md/html/txt/js…).
      $('btn-cols').classList.add('hidden');
      $('table-tools').classList.add('hidden');
      $('cols-panel').classList.remove('open');
      $('btn-cols').classList.remove('active-tool');
      closeSource();
      closeSearch();
      $('btn-top').classList.add('hidden');
      showPlain(t);
      $('status-doc').textContent =
        t.plain.label + ' · ' + fmtBytes(t.plain.size) + (t.plain.truncated ? ' · showing first ' + fmtBytes(t.plain.limit) : '');
      $('status-load').textContent = t.loadMs != null ? fmtInt(t.loadMs) + ' ms' : '';
      $('status-type').textContent = 'Read-only · ⌘F to find';
      $('status-path').textContent = '';
      return;
    }
    const isCsv = t.docFormat === 'csv' || t.docFormat === 'tsv';
    if (duck) {
      // DuckDB: table view only, no tree.
      $('view-toggle').classList.add('hidden');
      $('tree-wrap').classList.add('hidden');
      t.view = 'table';
      $('search-box').placeholder = 'Search all columns';
      $('search-box').value = t.duck.searchQuery || '';
      $('search-mode').classList.remove('hidden');
      $('search-mode').value = t.duck.searchMode || 'contains';
      setView('table');
      buildTableHead(t);
      $('status-doc').textContent =
        t.tableFormatLabel + ' · ' + fmtInt(t.duck.rowCount) + ' rows · ' + fmtBytes(srcBytes);
      $('status-load').textContent = t.duck.strategy === 'cache-hit'
        ? 'from cache'
        : (t.loadMs != null ? fmtInt(t.loadMs) + ' ms' : '');
      updateTopBtn();
      $('status-type').textContent = '';
      $('status-path').textContent = baseName(t.file || '');
      if (sourceOpen) scheduleSourceUpdate();
      syncMenuState();
      return;
    }
    $('view-toggle').classList.toggle('hidden', !isCsv);
    setView(t.view);
    $('status-doc').textContent =
      t.docFormat.toUpperCase() + ' · ' + fmtInt(t.meta.total_nodes || 0) + ' nodes · ' + fmtBytes(t.meta.source_bytes) + (memMode ? ' · RAM' : '');
    if (isCsv) buildTableHead(t);
    $('status-load').textContent = t.loadMs != null ? fmtInt(t.loadMs) + ' ms' : '';
    renderTree();
    treeScroll.scrollTop = t.treeScrollTop || 0;
    renderTree();
    updateTopBtn();
    updateStatusForSelection();
    if (sourceOpen) scheduleSourceUpdate();
  }
  syncMenuState();
}

// ---------- plain-text tabs (txt/js/html) ----------
let textEditor = null;
let prettyCtxKey = null; // enables the Pretty Print menu item only for minified JSON

// Is the current model minified JSON that would benefit from Pretty Print?
function canPrettyPrint(t) {
  if (!t || !t.plain || t.plain.language !== 'json') return false;
  const text = t.plainText || '';
  return text.length > 0 && text.length < 150 * 1024 * 1024 && looksMinified(text);
}

// Custom Monaco themes whose editor chrome matches the app palette (the stock
// vs-dark background #1e1e1e reads greyer than our --bg2 panels).
let monacoThemesDefined = false;
function defineMonacoThemes() {
  if (monacoThemesDefined || !window.monaco) return;
  window.monaco.editor.defineTheme('narik-dark', {
    base: 'vs-dark', inherit: true, rules: [],
    colors: {
      'editor.background': '#1b1e27',
      'editorGutter.background': '#1b1e27',
      'minimap.background': '#1b1e27',
      'editorLineNumber.foreground': '#5b6270',
      'editorLineNumber.activeForeground': '#d7dae2',
      'editor.lineHighlightBackground': '#232734',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#2d3446',
      'editorIndentGuide.background': '#232734',
      'editorIndentGuide.background1': '#232734',
      'editorWidget.background': '#1b1e27',
      'scrollbarSlider.background': '#2d344680',
    },
  });
  window.monaco.editor.defineTheme('narik-light', {
    base: 'vs', inherit: true, rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editorGutter.background': '#ffffff',
      'minimap.background': '#ffffff',
    },
  });
  monacoThemesDefined = true;
}
function monacoThemeName(eff) {
  defineMonacoThemes();
  return eff === 'light' ? 'narik-light' : 'narik-dark';
}

function showPlain(t) {
  if (monacoReady && window.monaco) {
    $('text-fallback').classList.add('hidden');
    $('text-host').classList.remove('hidden');
    if (!textEditor) {
      textEditor = window.monaco.editor.create($('text-host'), {
        value: '',
        theme: monacoThemeName(uiTheme),
        readOnly: true,
        automaticLayout: true,
        minimap: { enabled: true },
        lineNumbers: 'on',
        fontSize: 12.5,
        scrollBeyondLastLine: false,
        largeFileOptimizations: true,
        maxTokenizationLineLength: 200000, // color longer lines (default 20k)
      });
      // Right-click → Pretty Print, shown only for minified JSON (context key).
      prettyCtxKey = textEditor.createContextKey('narikCanPretty', false);
      textEditor.addAction({
        id: 'narik-pretty-print',
        label: 'Pretty Print',
        contextMenuGroupId: 'modification',
        contextMenuOrder: 1,
        precondition: 'narikCanPretty',
        run: (ed) => {
          const m = ed.getModel();
          if (!m) return;
          const src = m.getValue();
          if (src.length > 150 * 1024 * 1024) { toast('Too large to pretty-print (over 150 MB)'); return; }
          try {
            m.setValue(prettyJsonText(src));
            if (prettyCtxKey) prettyCtxKey.set(false); // now formatted — disable
          } catch {
            toast('Not valid JSON — cannot pretty-print');
          }
        },
      });
    }
    if (!t.plainModel) {
      t.plainModel = window.monaco.editor.createModel(t.plainText || '', t.plain.language);
    }
    textEditor.setModel(t.plainModel);
    textEditor.updateOptions({
      wordWrap: t.plain.language === 'plaintext' || t.plain.language === 'markdown' ? 'on' : 'off',
    });
    if (prettyCtxKey) prettyCtxKey.set(canPrettyPrint(t));
  } else {
    $('text-host').classList.add('hidden');
    const fb = $('text-fallback');
    fb.classList.remove('hidden');
    fb.textContent = t.plainText || '';
  }
}

async function openPlainPath(p, tab, lang, full) {
  const t = tab || targetTabForOpen();
  if (!t) return;
  if (t.plainModel) { try { t.plainModel.dispose(); } catch {} t.plainModel = null; }
  t.file = p;
  t.title = baseName(p);
  t.phase = 'loading';
  t.progress = { startedMsg: 'Reading file…', plain: true };
  if (t !== cur) setCurrent(t);
  else { renderTabs(); renderScreen(); }
  const t0 = performance.now();
  try {
    const res = await window.oxj.loadText(p, full);
    if (!tabAlive(t)) return;
    t.loadMs = Math.round(performance.now() - t0);
    let text = res.text;
    // Pretty-print minified JSON so it's readable and Monaco can syntax-color
    // it (long single lines are left uncolored by the tokenizer). Bounded to a
    // safe size — parse+stringify of very large text would exceed V8 limits.
    const PRETTY_MAX = 150 * 1024 * 1024; // parse+stringify stays under V8's ~512MB string cap
    if (lang === 'json' && !res.truncated && text.length < PRETTY_MAX && looksMinified(text)) {
      try { text = prettyJsonText(text); } catch {}
    }
    t.plain = {
      language: lang,
      label: String(p).split('.').pop().toUpperCase(),
      size: res.size,
      truncated: res.truncated,
      limit: res.limit || 25 * 1024 * 1024,
    };
    t.plainText = text;
    t.phase = 'ready';
    renderTabs();
    if (t === cur) renderScreen();
    if (res.truncated) toast('Large file: showing the first ' + fmtBytes(res.limit || 25 * 1024 * 1024), true);
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
function toast(msg, info, ms) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('info', !!info);
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms || (info ? 3500 : 6000));
}
// Styled, roomy replacement for window.confirm(). Returns a Promise<boolean>.
function confirmDialog(opts) {
  const { title = 'Are you sure?', body = '', okLabel = 'OK', cancelLabel = 'Cancel' } = opts || {};
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'modal confirm-modal';
    const h = document.createElement('div'); h.className = 'confirm-title'; h.textContent = title;
    box.appendChild(h);
    if (body) { const p = document.createElement('div'); p.className = 'confirm-body'; p.textContent = body; box.appendChild(p); }
    const actions = document.createElement('div'); actions.className = 'modal-actions';
    const cancel = document.createElement('button'); cancel.className = 'btn-secondary'; cancel.textContent = cancelLabel;
    const ok = document.createElement('button'); ok.className = 'btn-primary'; ok.textContent = okLabel;
    actions.append(cancel, ok);
    box.appendChild(actions);
    back.appendChild(box);
    document.body.appendChild(back);
    const close = (val) => { document.removeEventListener('keydown', onKey); back.remove(); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') close(false); else if (e.key === 'Enter') close(true); };
    cancel.addEventListener('click', () => close(false));
    ok.addEventListener('click', () => close(true));
    back.addEventListener('click', (e) => { if (e.target === back) close(false); });
    document.addEventListener('keydown', onKey);
    ok.focus();
  });
}
// Single-line text prompt styled like confirmDialog. Resolves to the trimmed
// string, or null if cancelled / left empty.
function promptDialog(opts) {
  const { title = '', body = '', value = '', placeholder = '', okLabel = 'Save' } = opts || {};
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'modal confirm-modal';
    const h = document.createElement('div'); h.className = 'confirm-title'; h.textContent = title; box.appendChild(h);
    if (body) { const p = document.createElement('div'); p.className = 'confirm-body'; p.textContent = body; box.appendChild(p); }
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = value; inp.placeholder = placeholder; inp.style.width = '100%';
    box.appendChild(inp);
    const actions = document.createElement('div'); actions.className = 'modal-actions';
    const cancel = document.createElement('button'); cancel.className = 'btn-secondary'; cancel.textContent = 'Cancel';
    const ok = document.createElement('button'); ok.className = 'btn-primary'; ok.textContent = okLabel;
    actions.append(cancel, ok); box.appendChild(actions);
    back.appendChild(box); document.body.appendChild(back);
    const close = (v) => { document.removeEventListener('keydown', onKey); back.remove(); resolve(v); };
    const submit = () => { const v = inp.value.trim(); if (v) close(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); else if (e.key === 'Enter') { e.preventDefault(); submit(); } };
    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click', submit);
    back.addEventListener('click', (e) => { if (e.target === back) close(null); });
    document.addEventListener('keydown', onKey);
    setTimeout(() => { inp.focus(); inp.select(); }, 20);
  });
}
function baseName(p) { return String(p).split(/[\\/]/).pop(); }
// Middle-ellipsis so the extension always stays visible.
function middleTruncate(s, max) {
  if (s.length <= max) return s;
  const tail = Math.min(16, Math.floor(max / 3));
  return s.slice(0, max - tail - 1) + '…' + s.slice(-tail);
}

// Shorten a filename with a middle ellipsis, keeping the start and the full
// extension: very_long_export_name.json -> very_long_e…rt_name.json
function middleEllipsis(name, limit) {
  if (!name || name.length <= limit) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const base = dot > 0 ? name.slice(0, dot) : name;
  const keep = limit - ext.length - 1; // room for the …
  if (keep < 4) return name.slice(0, Math.max(1, limit - 1)) + '…';
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return base.slice(0, head) + '…' + base.slice(base.length - tail) + ext;
}

// Approximate, human-readable size with a leading ~ (shown orange in the UI).
function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1073741824) return '~' + (n / 1073741824).toFixed(1) + ' GB';
  if (n >= 1048576) return '~' + (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return '~' + Math.round(n / 1024) + ' KB';
  return '~' + n + ' B';
}

// Group a recents entry by file type (extension) for the side panel sections.
const FILE_GROUPS = [
  ['JSON', ['json', 'ndjson', 'jsonl']],
  ['XML', ['xml']],
  ['CSV', ['csv', 'tsv', 'tab']],
  ['YAML', ['yaml', 'yml']],
  ['Logs', ['log']],
  ['Code', ['js', 'mjs', 'ts', 'py', 'html', 'htm', 'css', 'rs', 'go', 'java', 'c', 'cpp', 'sh']],
  ['Text', ['txt', 'md']],
];
function fileGroup(pathStr) {
  const ext = String(pathStr).split('.').pop().toLowerCase();
  for (const [name, exts] of FILE_GROUPS) if (exts.includes(ext)) return name;
  return 'Other';
}
function groupRecentsByType(list) {
  const out = new Map();
  for (const [name] of FILE_GROUPS) out.set(name, []);
  out.set('Other', []);
  for (const r of list) out.get(fileGroup(r.path)).push(r);
  // Only non-empty groups, in the fixed order.
  const res = [];
  for (const [name] of [...FILE_GROUPS, ['Other']]) {
    const items = out.get(name);
    if (items && items.length) res.push([name, items]);
  }
  return res;
}
function cleanErr(err) {
  return String((err && err.message) || err).replace(/^.*Error:\s*/, '');
}

// ---------- welcome / recents ----------
async function refreshRecents() {
  const list = (await window.oxj.recents()).slice(0, 15);
  const wrap = $('recents-wrap');
  const el = $('recents-list');
  el.textContent = '';
  if (!list.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  $('recents-head-label').textContent = 'Recent (' + list.length + ')';
  for (const r of list) {
    const item = document.createElement('div');
    item.className = 'recent-item';
    item.title = r.path; // full path on hover
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = middleEllipsis(baseName(r.path), 40);
    const size = document.createElement('span');
    size.className = 'recent-size';
    size.textContent = humanSize(r.size);
    item.append(name, size);
    item.addEventListener('click', () => openRecent(r));
    el.appendChild(item);
  }
}

// Open a recent (entry or path), focusing an already-open tab instead of a
// duplicate. Honors a remembered format (e.g. a .txt opened as a delimited table).
function openRecent(r) {
  const p = typeof r === 'string' ? r : r.path;
  const fmt = typeof r === 'object' ? r.format : null;
  const existing = tabs.find((x) => x.file === p && x.phase !== 'empty');
  if (existing) { setCurrent(existing); return; }
  if (fmt === 'csv' || fmt === 'tsv') openAsCsv(p);
  else openPath(p);
}

// ---------- Recent Files side panel (dock) ----------
let recentPanelOpen = false;
let recentWidth = Math.max(180, parseInt(localStorage.getItem('oxj-recent-width'), 10) || 260);
const recentCollapsed = new Set();
const FOLDER_SVG = '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M1.5 3.75A1.25 1.25 0 0 1 2.75 2.5h2.9c.33 0 .64.13.88.37L7.7 4H13.25A1.25 1.25 0 0 1 14.5 5.25v6A1.25 1.25 0 0 1 13.25 12.5H2.75A1.25 1.25 0 0 1 1.5 11.25v-7.5Z"/></svg>';

// Apply the open/closed state to the DOM (width is inline so the drag handle
// can resize it while the toggle still fully collapses it).
function applyRecentPanel() {
  $('recent-panel').style.width = recentPanelOpen ? recentWidth + 'px' : '0';
  $('recent-panel').classList.toggle('open', recentPanelOpen);
  $('btn-recent').classList.toggle('active-tool', recentPanelOpen);
}
function closeRecentPanel() { recentPanelOpen = false; applyRecentPanel(); }
function toggleRecentPanel() {
  recentPanelOpen = !recentPanelOpen;
  applyRecentPanel();
  if (recentPanelOpen) renderRecentDock();
}

// Drag the left edge of the dock to resize it.
(function initRecentResizer() {
  const panel = $('recent-panel');
  const grip = $('recent-resizer');
  if (!grip) return;
  let startX = 0, startW = 0;
  const onMove = (ev) => {
    recentWidth = Math.max(180, Math.min(window.innerWidth * 0.6, startW + (startX - ev.clientX)));
    panel.style.width = recentWidth + 'px';
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('resizing');
    grip.classList.remove('dragging');
    localStorage.setItem('oxj-recent-width', String(recentWidth | 0));
  };
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

let dockTab = 'recent'; // 'recent' | 'bookmarks'
function setDockTab(which) {
  dockTab = which;
  document.querySelectorAll('.dock-tab').forEach((b) => b.classList.toggle('active', b.dataset.dock === which));
  renderRecentDock();
}
document.querySelectorAll('.dock-tab').forEach((b) => b.addEventListener('click', () => setDockTab(b.dataset.dock)));

async function renderRecentDock() {
  if (!recentPanelOpen) return;
  if (dockTab === 'bookmarks') return renderDockBookmarks();
  const list = await window.oxj.recents();
  const el = $('recent-dock-list');
  el.textContent = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'recent-dock-empty';
    empty.textContent = 'No recent files';
    el.appendChild(empty);
    return;
  }
  for (const [group, items] of groupRecentsByType(list)) {
    const sec = document.createElement('div');
    sec.className = 'recent-sec';
    const collapsed = recentCollapsed.has(group);
    const head = document.createElement('div');
    head.className = 'recent-sec-head';
    head.innerHTML = '<span class="recent-sec-caret">' + (collapsed ? '▸' : '▾') + '</span>' +
      '<span class="recent-sec-name">' + htmlEsc(group) + '</span><span class="recent-sec-count">' + items.length + '</span>';
    head.addEventListener('click', () => { if (recentCollapsed.has(group)) recentCollapsed.delete(group); else recentCollapsed.add(group); renderRecentDock(); });
    sec.appendChild(head);
    if (!collapsed) {
      for (const r of items) {
        const row = document.createElement('div');
        row.className = 'recent-file';
        row.title = r.path;
        const name = document.createElement('span');
        name.className = 'recent-file-name';
        name.textContent = middleEllipsis(baseName(r.path), 28);
        const size = document.createElement('span');
        size.className = 'recent-size';
        size.textContent = humanSize(r.size);
        const rev = document.createElement('button');
        rev.className = 'recent-reveal';
        rev.title = 'Reveal in folder';
        rev.innerHTML = FOLDER_SVG;
        rev.addEventListener('click', (e) => { e.stopPropagation(); window.oxj.revealItem(r.path); });
        const rm = document.createElement('button');
        rm.className = 'recent-remove';
        rm.title = 'Remove from recents';
        rm.textContent = '✕';
        rm.addEventListener('click', (e) => { e.stopPropagation(); window.oxj.removeRecent(r.path); });
        row.append(name, size, rev, rm);
        row.addEventListener('click', () => openRecent(r));
        sec.appendChild(row);
      }
    }
    el.appendChild(sec);
  }
}

// Bookmarks tab of the dock: pinned first, then most-recently used. Clicking a
// row opens (sends) the saved request; ★ pins, ✕ deletes.
async function renderDockBookmarks() {
  if (!recentPanelOpen) return;
  const list = await window.oxj.bookmarks.list();
  const el = $('recent-dock-list');
  el.textContent = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'recent-dock-empty';
    empty.textContent = 'No bookmarks yet. Save one from Open URL (☆).';
    el.appendChild(empty);
    return;
  }
  list.sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    return (b.lastUsedAt || b.updatedAt || 0) - (a.lastUsedAt || a.updatedAt || 0);
  });
  for (const b of list) {
    const row = document.createElement('div');
    row.className = 'dock-bm';
    row.title = (b.request && b.request.url) || b.name;
    const star = document.createElement('button');
    star.className = 'dock-bm-star' + (b.pinned ? ' on' : '');
    star.textContent = b.pinned ? '★' : '☆';
    star.title = b.pinned ? 'Unpin' : 'Pin to top';
    star.addEventListener('click', async (e) => { e.stopPropagation(); await window.oxj.bookmarks.update(b.id, { pinned: !b.pinned }); renderDockBookmarks(); });
    const main = document.createElement('div'); main.className = 'dock-bm-main';
    const nameRow = document.createElement('div'); nameRow.className = 'dock-bm-name';
    const m = (b.request && b.request.method) || 'GET';
    const chip = document.createElement('span'); chip.className = 'dock-bm-chip'; chip.textContent = m;
    const col = METHOD_COLOR[m] || 'var(--fg-dim)';
    chip.style.color = col; chip.style.border = '1px solid ' + col;
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = b.name;
    nameRow.append(chip, nm);
    const url = document.createElement('div'); url.className = 'dock-bm-url'; url.textContent = (b.request && b.request.url) || '';
    main.append(nameRow, url);
    const rm = document.createElement('button'); rm.className = 'dock-bm-rm'; rm.textContent = '✕'; rm.title = 'Delete bookmark';
    rm.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!await confirmDialog({ title: 'Delete bookmark?', body: '“' + b.name + '” will be removed.', okLabel: 'Delete' })) return;
      await window.oxj.bookmarks.remove(b.id); renderDockBookmarks();
    });
    row.append(star, main, rm);
    row.addEventListener('click', () => openBookmark(b));
    el.appendChild(row);
  }
}

$('btn-recent').addEventListener('click', toggleRecentPanel);
window.oxj.onRecentsChanged(() => { refreshRecents(); renderRecentDock(); });

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
      : '~' + fmtBytes(info.memModeLimit));
  }
  if (info.tempCount) addRow('Temp files', fmtInt(info.tempCount) + ' · ' + fmtBytes(info.tempBytes));
}

// Cache Manager has two tabs: JSON (SQLite) and CSV (DuckDB Parquet).
let cacheTab = 'db';
function setCacheTab(which) {
  cacheTab = which;
  document.querySelectorAll('#cache-seg .engine-opt').forEach((b) => b.classList.toggle('active', b.dataset.cache === which));
  $('cache-list').classList.toggle('hidden', which !== 'db');
  $('duck-cache-list').classList.toggle('hidden', which !== 'duck');
  if (which === 'duck') refreshDuckCache(); // lazily boots the DuckDB engine
}
document.querySelectorAll('#cache-seg .engine-opt').forEach((b) => b.addEventListener('click', () => setCacheTab(b.dataset.cache)));

async function refreshDuckCache() {
  const list = $('duck-cache-list');
  const addRow = (k, v) => {
    const row = document.createElement('div'); row.className = 'stat-kv';
    const kk = document.createElement('span'); kk.className = 'k'; kk.textContent = k;
    const vv = document.createElement('span'); vv.textContent = v;
    row.append(kk, vv); list.appendChild(row);
  };
  list.textContent = ''; addRow('Loading…', '');
  try {
    const info = await window.oxj.duckInvoke('cacheInfo');
    list.textContent = '';
    addRow('Cached files', fmtInt((info.entries || []).length));
    addRow('Cache size', fmtBytes(info.totalBytes || 0));
    addRow('Size limit', info.limitBytes ? fmtBytes(info.limitBytes) : 'Unlimited');
  } catch (e) {
    list.textContent = ''; addRow('Cache', 'unavailable');
  }
}

$('btn-clear-cache').addEventListener('click', async () => {
  if (cacheTab === 'duck') {
    if (!await confirmDialog({
      title: 'Clear the table cache?',
      body: 'Your table files will load fresh the next time you open them.',
      okLabel: 'Clear cache',
    })) return;
    try {
      const r = await window.oxj.duckInvoke('clearCache');
      toast('CSV cache cleared' + (r && r.bytes ? ' — freed ' + fmtBytes(r.bytes) : ''), true);
    } catch (e) { toast('Clear failed: ' + cleanErr(e)); }
    refreshDuckCache();
    return;
  }
  if (!await confirmDialog({
    title: 'Clear the document cache?',
    body: 'Your files will load fresh the next time you open them.',
    okLabel: 'Clear cache',
  })) return;
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

// ---------- DuckDB engine (delimited/tabular files) ----------
// Extensions routed straight to DuckDB; .txt/.dat/.tab arrive via format:'csv'.
const DUCK_EXTS = ['csv', 'tsv', 'psv', 'parquet'];
const EMPTY_VIEW = { filters: [], combine: 'and', search: null, sort: [], select: null };
const DUCK_FORMAT_LABEL = { csv: 'CSV', tsv: 'TSV', psv: 'Pipe-delimited', delimited: 'Delimited', parquet: 'Parquet' };
let duckJobSeq = 1;
const duckJob = () => 'job-' + (duckJobSeq++);

// Open a delimited/tabular file through DuckDB and set the tab up as a table.
async function openDuck(t, path) {
  const openJobId = duckJob();
  t.duckOpenJobId = openJobId; // so progress events can find this tab
  const man = await window.oxj.duckInvoke('openDataset', { path, options: {}, jobId: openJobId });
  if (!tabAlive(t)) return;
  const datasetId = man.id; // manifest keys the dataset by `id`
  const view = { ...EMPTY_VIEW };
  const vi = await window.oxj.duckInvoke('buildView', { datasetId, view, jobId: duckJob() });
  if (!tabAlive(t)) return;
  t.engine = 'duck';
  t.duck = { datasetId, view, columns: man.columns || [], rowCount: vi.rowCount, manifest: man, strategy: man.strategy };
  t.docFormat = man.format === 'tsv' ? 'tsv' : 'csv'; // table logic keys off csv/tsv
  t.tableFormatLabel = DUCK_FORMAT_LABEL[man.format] || (man.format || 'CSV').toUpperCase();
  t.tableHeaders = (man.columns || []).map((c) => c.name);
  t.tableTotal = vi.rowCount;
  t.tableViewTotal = vi.rowCount;
  t.meta = { format: t.docFormat, total_nodes: vi.rowCount, source_bytes: man.sourceSize || 0, mode: 'duck' };
  t.rootId = 1;
  t.tablePages = new Map();
  t.tableInflight = new Set();
  t.colWidths = null; t.colOrder = null; t.colHidden = null; t.colPinned = null;
  t.tableSel = null; t.tableSort = null; t.tableFilters = [];
  t.view = 'table';
  t.loadMs = man.ingestMs != null ? man.ingestMs : (vi.buildMs != null ? vi.buildMs : null);
  t.phase = 'ready';
  try { window.oxj.noteRecent(path, 'csv'); } catch {}
  renderTabs();
  if (t === cur) { renderScreen(); if (recentPanelOpen) renderRecentDock(); }
  toast('Loaded ' + fmtInt(vi.rowCount) + ' rows · ' + t.tableFormatLabel, true);
}
function isDuck(t) { return t && t.engine === 'duck'; }

async function openPath(p, tab, force, opts) {
  const fmt = opts && opts.format; // e.g. 'csv' to open a delimited .txt as a table
  const ext = String(p).split('.').pop().toLowerCase();
  if (BLOCKED_EXTS.includes(ext)) {
    toast('Excel files are not supported — export to CSV or JSON first');
    return;
  }
  // YAML loads as a structured tree (converted to JSON by the engine); other
  // plain-text languages open read-only. A forced format (fmt) skips that so a
  // .txt can load as a table. (Raw File still opens the original read-only.)
  const isYaml = ext === 'yaml' || ext === 'yml';
  const lang = plainLangFor(p);
  if (lang && !isYaml && !fmt) return openPlainPath(p, tab, lang);
  const t = tab || targetTabForOpen();
  if (!t) return; // tab limit reached
  if (t.plainModel) { try { t.plainModel.dispose(); } catch {} t.plainModel = null; }
  t.plain = null;
  t.plainText = null;
  t.file = p;
  t.forcedFormat = fmt || null; // remembered so reload keeps the table view
  t.title = baseName(p);
  t.phase = 'loading';
  t.progress = { startedAt: Date.now(), lastBytes: 0, lastTime: Date.now(), speed: 0, total: 0, bytes: 0, nodes: 0, indexing: false };
  t.engine = null; t.duck = null;
  if (t !== cur) setCurrent(t);
  else { renderTabs(); renderScreen(); }
  // Delimited/tabular files go to the DuckDB engine; everything else to Rust.
  const wantDuck = fmt === 'csv' || DUCK_EXTS.includes(ext);
  if (wantDuck) { t.progress.duck = true; if (t === cur) renderScreen(); }
  try {
    if (wantDuck) await openDuck(t, p);
    else await window.oxj.loadFile(t.id, p, !!force, fmt || undefined);
  } catch (e) {
    if (!tabAlive(t)) return;
    t.phase = 'empty';
    t.title = 'New Tab';
    if (t === cur) { renderTabs(); renderScreen(); }
    toast('Load failed: ' + cleanErr(e));
  }
  return t;
}

// Open any file forcing the CSV table view (engine sniffs comma/;/tab/pipe).
function openAsCsv(p) { return openPath(p, null, false, { format: 'csv' }); }

$('btn-open').addEventListener('click', async () => {
  const p = await window.oxj.pickFile();
  if (p) openFileWithPrompt(p);
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
$('btn-clear-recents').addEventListener('click', async () => {
  await window.oxj.clearRecents();
  refreshRecents();
});
$('btn-cancel').addEventListener('click', async () => {
  const t = cur;
  if (t.phase !== 'loading') return;
  if (t.progress && t.progress.duck && t.duckOpenJobId) {
    try { await window.oxj.duckInvoke('cancel', { jobId: t.duckOpenJobId }); } catch {}
  } else {
    try { await window.oxj.cancelIngest(t.id); } catch {}
  }
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
// Extensions that could be either a delimited table or plain text.
const MAYBE_DELIM_EXTS = ['txt', 'dat', 'psv', 'tab'];
function isMaybeDelim(p) {
  const name = String(p).split(/[\\/]/).pop();
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return ext === '' || MAYBE_DELIM_EXTS.includes(ext);
}

// Ask how to open an ambiguous dropped file. Resolves 'table' | 'text' | null.
function askOpenAs(name) {
  return new Promise((resolve) => {
    const { back, box } = simpleModal('Open "' + name + '"');
    const msg = document.createElement('div');
    msg.className = 'ask-open-msg';
    msg.textContent = 'This looks like a delimited text file. Open it as a table or as plain text?';
    box.appendChild(msg);
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button'); cancel.className = 'btn-secondary'; cancel.textContent = 'Cancel';
    const asText = document.createElement('button'); asText.className = 'btn-secondary'; asText.textContent = 'Open as Text';
    const asTable = document.createElement('button'); asTable.className = 'btn-primary'; asTable.textContent = 'Open as Table';
    cancel.onclick = () => { back.remove(); resolve(null); };
    asText.onclick = () => { back.remove(); resolve('text'); };
    asTable.onclick = () => { back.remove(); resolve('table'); };
    back.addEventListener('mousedown', (e) => { if (e.target === back) { back.remove(); resolve(null); } });
    actions.append(cancel, asText, asTable);
    box.appendChild(actions);
  });
}

// User-initiated open of a real file: prompt Table/Text for ambiguous delimited
// files, otherwise open normally. Used by Open File and drag-and-drop.
async function openFileWithPrompt(p) {
  const name = String(p).split(/[\\/]/).pop();
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  // PSV / .tab are unambiguously delimited → open straight into the table.
  if (ext === 'psv' || ext === 'tab') { openAsCsv(p); return; }
  if (isMaybeDelim(p)) {
    const choice = await askOpenAs(baseName(p)); // Table / Text / Cancel
    if (choice === 'table') openAsCsv(p);
    else if (choice === 'text') openPlainPath(p, null, plainLangFor(p) || 'plaintext');
  } else {
    openPath(p);
  }
}

window.addEventListener('drop', async (e) => {
  e.preventDefault();
  $('drop-overlay').classList.add('hidden');
  const files = (e.dataTransfer && e.dataTransfer.files) || [];
  if (!files.length) return;
  let paths = [];
  try { paths = [...files].slice(0, MAX_TABS).map((f) => window.oxj.pathForFile(f)).filter(Boolean); }
  catch { toast('Could not resolve dropped file path'); return; }
  for (const p of paths) await openFileWithPrompt(p);
});

// ---------- ingest progress ----------
function updateProgressDom(t) {
  const pr = t.progress || {};
  // Plain-text / Full File loads are a single file read — no DB, no engine.
  if (pr.plain) {
    $('prog-title').textContent = 'Opening file';
    $('prog-file').textContent = t.file || '';
    $('bar-inner').classList.add('indeterminate');
    $('prog-pct').textContent = '';
    $('prog-bytes').textContent = '';
    $('prog-speed').textContent = '';
    $('prog-eta').textContent = '';
    $('prog-nodes').textContent = pr.startedMsg || 'Reading file…';
    $('prog-phase').classList.add('hidden');
    return;
  }
  if (pr.duck) {
    $('prog-title').textContent = 'Opening ' + baseName(t.file || '');
    $('prog-file').textContent = t.file || '';
    const pct = pr.percent != null ? Math.min(100, pr.percent) : null;
    $('bar-inner').classList.toggle('indeterminate', pct == null);
    if (pct != null) $('bar-inner').style.width = pct.toFixed(2) + '%';
    $('prog-pct').textContent = pct != null ? pct.toFixed(1) + '%' : '';
    $('prog-bytes').textContent = pr.bytesDone ? fmtBytes(pr.bytesDone) + (pr.bytesTotal ? ' / ' + fmtBytes(pr.bytesTotal) : '') : '';
    $('prog-speed').textContent = '';
    $('prog-eta').textContent = pr.etaMs ? 'ETA ' + fmtDur(pr.etaMs / 1000) : '';
    $('prog-nodes').textContent = pr.rowsDone ? fmtInt(pr.rowsDone) + ' rows read' : (pr.phase || 'Loading into the query engine…');
    $('prog-phase').classList.add('hidden');
    return;
  }
  // pr.mem is undefined until the engine's first 'start' event reports the mode.
  // Show a neutral title until then, so it doesn't flash "database" → "memory".
  const modeKnown = pr.mem !== undefined;
  $('prog-title').textContent = !modeKnown
    ? 'Opening ' + baseName(t.file || '')
    : (pr.mem ? 'Loading into memory' : 'Loading into database');
  $('prog-phase').textContent = !modeKnown
    ? ''
    : (pr.mem
        ? 'Indexing in memory — no database needed, this is quick…'
        : 'Building index… this can take a while on large files');
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

// DuckDB ingest progress → drive the loading screen for the matching tab.
window.oxj.onDuckEvent((ev) => {
  if (!ev) return;
  if (ev.type === 'job' && ev.progress) {
    const jp = ev.progress;
    const t = tabs.find((x) => x.duckOpenJobId === jp.jobId && x.phase === 'loading');
    if (!t) return;
    const pr = t.progress;
    pr.duck = true;
    pr.percent = jp.percent;
    pr.phase = jp.phase || jp.label || '';
    pr.bytesDone = jp.bytesDone;
    pr.bytesTotal = jp.bytesTotal;
    pr.rowsDone = jp.rowsDone;
    pr.etaMs = jp.etaMs;
    if (t === cur) updateProgressDom(t);
  }
});

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

window.oxj.onIngestError(async (m) => {
  const t = tabById(m.tabId);
  if (!t) return;
  const file = t.file;
  if (file) {
    const ext = String(file).split('.').pop().toLowerCase();
    const lang = DATA_FALLBACK_LANGS[ext] || plainLangFor(file) || 'plaintext';
    // Load the text FIRST, then show the notice — otherwise the plain loader's
    // own toasts ("Reading file…" / "Large file…") override it and it just blinks.
    await openPlainPath(file, t, lang);
    toast('Could not parse ' + baseName(file) + ' (' + m.message + ') — opened as read-only text', false, 9000);
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
  t.loadMs = m.loadMs != null ? m.loadMs : m.elapsed_ms;
  t.meta = m.meta || {};
  t.docFormat = t.meta.format || 'json';
  t.rootId = parseInt(t.meta.root_id || '1', 10);
  t.tableHeaders = [];
  try { t.tableHeaders = JSON.parse(t.meta.csv_headers || '[]'); } catch {}
  t.tablePages = new Map();
  t.tableInflight = new Set();
  t.colWidths = null;
  t.colOrder = null;
  t.colHidden = null;
  t.colPinned = null;
  t.tableSel = null;
  t.tableSort = null;
  t.tableFilters = [];
  t.tableViewTotal = null;
  // CSV/TSV (and PSV / delimited TXT opened as CSV) default to the Table view.
  t.view = (t.docFormat === 'csv' || t.docFormat === 'tsv') ? 'table' : 'tree';
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
  if (t === cur) {
    renderScreen(); // Source panel stays closed until a tree node is clicked
    if (recentPanelOpen) renderRecentDock(); // reopen the dock if the user had it on
  }
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
      !await confirmDialog({
        title: 'Load all remaining rows?',
        body: 'This will load ' + fmtInt(remaining) + ' more rows into the tree and may take a while.',
        okLabel: 'Load all',
      })) {
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
// Nearest preceding row shallower than idx = its parent in the flat tree list.
function parentIndex(t, idx) {
  const d = t.visible[idx].depth;
  for (let i = idx - 1; i >= 0; i--) if (t.visible[i].depth < d) return i;
  return -1;
}
async function copySelValue(t, e) {
  try {
    const text = isScalarKind(e.kind) ? await getScalarValue(t, e) : (await getSubtree(t, e)).text;
    await copyText(text, 'value');
  } catch (err) { toast(cleanErr(err)); }
}
async function copySelPath(t, e) {
  try { const r = await window.oxj.query(t.id, { op: 'path', node: e.id }); await copyText(r.path, 'path'); }
  catch (err) { toast(cleanErr(err)); }
}

// Pending prefix for multi-key shortcuts (y… yank, g… go). ~1.2s window.
let treePrefix = null;
let treePrefixAt = 0;

// Keyboard navigation + Vim-style shortcuts for the tree.
document.addEventListener('keydown', async (ev) => {
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) return;
  if (t.view === 'table' || flowOpen) return; // tree view only
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA')) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (!t.visible.length || t.selectedIdx < 0) return;
  const idx = t.selectedIdx;
  const e = t.visible[idx];
  const k = ev.key;

  const prefix = (treePrefix && Date.now() - treePrefixAt < 1200) ? treePrefix : null;
  treePrefix = null;

  // Yank (copy) — y then v/k/p/n (yy = value).
  if (prefix === 'y') {
    ev.preventDefault();
    if (!e || e.pseudo) return;
    if (k === 'v' || k === 'y') copySelValue(t, e);
    else if (k === 'k') { if (e.name != null) copyText(e.name, 'key'); else toast('This node has no key'); }
    else if (k === 'p') copySelPath(t, e);
    else if (k === 'n') copyNodeAs(t, e, 'json');
    return;
  }
  // Go — gg to root.
  if (prefix === 'g') {
    ev.preventDefault();
    if (k === 'g') { selectAt(t, 0); scrollToIdx(0); renderTree(); }
    return;
  }
  if (k === 'y') { treePrefix = 'y'; treePrefixAt = Date.now(); ev.preventDefault(); return; }
  if (k === 'g') { treePrefix = 'g'; treePrefixAt = Date.now(); ev.preventDefault(); return; }

  const moveTo = (i) => { selectAt(t, i); scrollToIdx(t.selectedIdx); renderTree(); };

  if (k === 'ArrowDown' || k === 'j') {
    ev.preventDefault(); if (idx < t.visible.length - 1) moveTo(idx + 1);
  } else if (k === 'ArrowUp' || k === 'k') {
    ev.preventDefault(); if (idx > 0) moveTo(idx - 1);
  } else if (k === 'ArrowRight' || k === 'l') {
    ev.preventDefault();
    if (e && !e.pseudo && !e.expanded && isContainer(e.kind, e.n)) { await toggleAt(t, idx); renderTree(); }
    else if (idx < t.visible.length - 1) moveTo(idx + 1); // already open → into first child
  } else if (k === 'ArrowLeft' || k === 'h') {
    ev.preventDefault();
    if (e && !e.pseudo && e.expanded) { collapseAt(t, idx); renderTree(); }
    else { const p = parentIndex(t, idx); if (p >= 0) moveTo(p); }
  } else if (k === 'p') {
    ev.preventDefault(); const p = parentIndex(t, idx); if (p >= 0) moveTo(p);
  } else if (k === 'Enter' || k === ' ') {
    ev.preventDefault(); if (e && !e.pseudo) { await toggleAt(t, idx); renderTree(); }
  } else if (k === 'Home') {
    ev.preventDefault(); moveTo(0);
  } else if (k === 'End') {
    ev.preventDefault(); moveTo(t.visible.length - 1);
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

// DuckDB tables: search filters the view to rows matching in ANY column.
function duckSearch(t, q) {
  t.duck.searchQuery = q || '';
  t.duck.searchMode = $('search-mode').value || 'contains';
  applyTableView(t); // rebuilds the view (search folded into duckViewSpec)
}
// Re-run the search when the mode changes (if there's an active query).
$('search-mode').addEventListener('change', () => {
  if (isDuck(cur) && cur.duck.searchQuery) duckSearch(cur, $('search-box').value.trim());
});
$('search-box').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    if (isDuck(cur)) { duckSearch(cur, ev.target.value.trim()); return; }
    if (currentQueryMatchesNav() && matchNav.ids.length) gotoMatch(matchNav.cur + 1);
    else startSearch();
  }
  if (ev.key === 'Escape') { ev.target.value = ''; if (isDuck(cur)) duckSearch(cur, ''); else closeSearch(); }
});
$('btn-find').addEventListener('click', () => {
  if (isDuck(cur)) { duckSearch(cur, $('search-box').value.trim()); return; }
  if (currentQueryMatchesNav() && matchNav.ids.length) gotoMatch(matchNav.cur + 1);
  else startSearch();
});
// Fires when the X inside the field is clicked (or the field is emptied).
$('search-box').addEventListener('search', (ev) => {
  if (isDuck(cur)) { if (!ev.target.value) duckSearch(cur, ''); return; }
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
  syncMenuState();
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
      syncMenuState();
      return;
    }
    gotoMatch(0);
    syncMenuState();
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
  $('btn-flow').textContent = 'Flow';
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
  const tooBigMsg = 'This node is too large to diagram. Expand it and pick a smaller item (an array element or object) first.';
  try {
    const res = await window.oxj.query(t.id, { op: 'subtree', node: nodeId, budget: 20000 });
    if (t !== cur) return;
    // Oversized nodes come back as a truncated preview, not valid JSON.
    if (res.truncated) { toast(tooBigMsg); return; }
    let data;
    try { data = JSON.parse(res.text); }
    catch { toast(tooBigMsg); return; }
    flowOpen = true;
    closeSource();
    $('tree-wrap').classList.add('hidden');
    $('table-wrap').classList.add('hidden');
    $('flow-wrap').classList.remove('hidden');
    $('btn-flow').classList.add('active-tool');
    $('btn-flow').textContent = 'Tree'; // click again to return to the tree
    window.OXJGraph.render($('flow-wrap'), data);
  } catch (err) {
    const msg = cleanErr(err);
    toast(/too large|too big|truncat/i.test(msg) ? tooBigMsg : 'Flow diagram unavailable: ' + msg);
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
  if (table) { closeSource(); buildTableHead(t); renderTable(); renderColumnsPanel(t); }
  else { $('cols-panel').classList.remove('open'); $('btn-cols').classList.remove('active-tool'); }
  updateTableToolbar(t);
  updateTopBtn();
}
$('btn-view-tree').addEventListener('click', () => setView('tree'));
$('btn-view-table').addEventListener('click', () => setView('table'));

const TABLE_COL_DEFAULT = 180;
const TABLE_COL_MIN = 50;
const IDX_W = 70; // fallback row-number gutter width
function colWidth(t, c) {
  return (t.colWidths && t.colWidths[c]) || TABLE_COL_DEFAULT;
}

// Gutter wide enough for the largest (comma-formatted) row number.
function idxWidth(t) {
  const n = Math.max(0, tableRows(t) - 1);
  const digits = fmtInt(n).length; // includes thousands separators
  return Math.max(IDX_W, 16 + digits * 8);
}

// Lazily initialise the column order/visibility/pin state for a tab.
function ensureColState(t) {
  const n = t.tableHeaders.length;
  if (!t.colWidths || t.colWidths.length !== n) t.colWidths = new Array(n).fill(TABLE_COL_DEFAULT);
  if (!t.colOrder || t.colOrder.length !== n) t.colOrder = t.tableHeaders.map((_, i) => i);
  if (!t.colHidden) t.colHidden = new Set();
  if (!t.colPinned) t.colPinned = new Set();
}

// Original column indices in display order: pinned first (frozen), then the
// rest, hidden ones removed.
function visCols(t) {
  ensureColState(t);
  const shown = t.colOrder.filter((c) => !t.colHidden.has(c));
  return shown.filter((c) => t.colPinned.has(c)).concat(shown.filter((c) => !t.colPinned.has(c)));
}

function buildTableHead(t) {
  ensureColState(t);
  const head = $('table-head');
  head.textContent = '';
  const iw = idxWidth(t);
  const idx = document.createElement('div');
  idx.className = 'th idx';
  idx.textContent = '#';
  idx.style.width = iw + 'px';
  head.appendChild(idx);
  const cols = visCols(t);
  let pinnedLeft = iw;
  cols.forEach((c) => {
    const th = document.createElement('div');
    th.className = 'th';
    th.textContent = t.tableHeaders[c];
    th.title = t.tableHeaders[c] + ' — click to sort';
    th.style.width = colWidth(t, c) + 'px';
    th.dataset.col = String(c);
    if (t.tableSort && t.tableSort.col === c) {
      th.classList.add('sorted');
      const ar = document.createElement('span');
      ar.className = 'sort-arrow';
      ar.textContent = t.tableSort.dir === 'asc' ? ' ▲' : ' ▼';
      th.appendChild(ar);
    }
    // Click the header to cycle sort: asc → desc → none.
    th.addEventListener('click', (ev) => { if (!ev.target.classList.contains('col-resizer')) cycleSort(t, c); });
    if (t.colPinned.has(c)) {
      th.classList.add('pinned');
      th.style.left = pinnedLeft + 'px';
      pinnedLeft += colWidth(t, c);
    }
    // Resize handle (right edge).
    const grip = document.createElement('div');
    grip.className = 'col-resizer';
    grip.addEventListener('mousedown', (ev) => startColResize(ev, t, c, th));
    grip.addEventListener('click', (ev) => ev.stopPropagation());
    grip.addEventListener('dblclick', (ev) => { ev.stopPropagation(); autoFitColumn(t, c); });
    th.appendChild(grip);
    // Drag to reorder.
    th.draggable = true;
    th.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/col', String(c)); e.dataTransfer.effectAllowed = 'move'; });
    th.addEventListener('dragover', (e) => { e.preventDefault(); th.classList.add('drop-target'); });
    th.addEventListener('dragleave', () => th.classList.remove('drop-target'));
    th.addEventListener('drop', (e) => { e.preventDefault(); th.classList.remove('drop-target'); reorderCol(t, parseInt(e.dataTransfer.getData('text/col'), 10), c); });
    // Header context menu.
    th.addEventListener('contextmenu', (e) => { e.preventDefault(); showHeaderMenu(e, t, c); });
    head.appendChild(th);
  });
}

// Click a header to cycle its sort: unsorted → ascending → descending → none.
function cycleSort(t, c) {
  const s = t.tableSort;
  if (!s || s.col !== c) t.tableSort = { col: c, dir: 'asc' };
  else if (s.dir === 'asc') t.tableSort = { col: c, dir: 'desc' };
  else t.tableSort = null;
  applyTableView(t);
}

// Move column `from` to just before column `to` in the display order.
function reorderCol(t, from, to) {
  if (from === to || Number.isNaN(from)) return;
  ensureColState(t);
  const order = t.colOrder.slice();
  const fi = order.indexOf(from);
  const ti = order.indexOf(to);
  if (fi < 0 || ti < 0) return;
  order.splice(fi, 1);
  order.splice(order.indexOf(to) + (fi < ti ? 0 : 0), 0, from);
  t.colOrder = order;
  buildTableHead(t);
  renderTable();
}

// Measure text width in the grid's monospace font (cached canvas context).
let _measureCtx = null;
function measureCellText(s) {
  if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
  _measureCtx.font = '12px "SF Mono", Menlo, Consolas, "Courier New", monospace';
  return _measureCtx.measureText(s).width;
}

// Double-click the resize grip → size the column to fit its header + loaded cells.
function autoFitColumn(t, c) {
  ensureColState(t);
  let max = measureCellText(t.tableHeaders[c] || '');
  for (const page of t.tablePages.values()) {
    if (!page) continue;
    for (const rd of page) {
      const cell = rd && rd.cells ? rd.cells[c] : null;
      if (!cell || cell.value == null) continue;
      const v = String(cell.value);
      const w = measureCellText(v.length > 200 ? v.slice(0, 200) : v);
      if (w > max) max = w;
    }
  }
  t.colWidths[c] = Math.max(TABLE_COL_MIN, Math.min(600, Math.ceil(max) + 24)); // + cell padding/buffer
  buildTableHead(t);
  renderTable();
}

function startColResize(ev, t, c, th) {
  ev.preventDefault();
  ev.stopPropagation();
  const startX = ev.clientX;
  const startW = colWidth(t, c);
  document.body.classList.add('resizing');
  const onMove = (e) => {
    const w = Math.max(TABLE_COL_MIN, startW + (e.clientX - startX));
    t.colWidths[c] = w;
    th.style.width = w + 'px';
    renderTable(); // re-apply to the visible rows
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('resizing');
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

async function fetchTablePage(t, page) {
  if (t.tablePages.has(page) || t.tableInflight.has(page)) return;
  t.tableInflight.add(page);
  try {
    if (isDuck(t)) {
      const res = await window.oxj.duckInvoke('getPage', {
        datasetId: t.duck.datasetId, view: t.duck.view, offset: page * 100, limit: 100, maxCellChars: 2000,
      });
      if (!tabAlive(t)) return;
      const cols = t.duck.columns;
      const rows = (res.rows || []).map((r, i) => ({
        id: page * 100 + i, ord: page * 100 + i,
        cells: cols.map((c, ci) => ({ name: c.name, value: r[ci] })),
      }));
      t.tablePages.set(page, rows);
      if (t === cur && t.view === 'table') renderTable();
      return;
    }
    const q = { op: 'table', node: 1, offset: page * 100, limit: 100 };
    if (t.tableSort) q.sort = t.tableSort;
    if (t.tableFilters && t.tableFilters.length) q.filters = t.tableFilters;
    const res = await window.oxj.query(t.id, q);
    if (!tabAlive(t)) return;
    t.tablePages.set(page, res.rows);
    // Filtered/full row count from the engine drives the virtual scroll height.
    if (res.total != null && res.total !== t.tableViewTotal) {
      t.tableViewTotal = res.total;
      if (t === cur && t.view === 'table') { renderTable(); return; }
    }
    if (t === cur && t.view === 'table') renderTable();
  } catch {} finally {
    t.tableInflight.delete(page);
  }
}

function tableRows(t) {
  return t.tableViewTotal != null ? t.tableViewTotal : t.tableTotal;
}

// Re-apply the current sort/filter view: drop cached windows, reset scroll,
// refetch. Guarded to database mode (the memory engine can't sort/filter).
// Translate the tab's sort/filter state (Rust op shape) into a DuckDB ViewSpec.
const DUCK_FILTER_OP = {
  contains: 'contains', equals: 'eq', 'starts-with': 'startswith',
  'not-equals': 'ne', gt: 'gt', lt: 'lt', between: 'between',
};
function duckViewSpec(t) {
  const filters = (t.tableFilters || []).map((f, i) => {
    let value = String(f.value == null ? '' : f.value), value2 = '';
    if (f.op === 'between') { const p = value.split(','); value = (p[0] || '').trim(); value2 = (p[1] || '').trim(); }
    return { id: 'f' + i, column: t.tableHeaders[f.col], op: DUCK_FILTER_OP[f.op] || 'contains', value, value2, caseSensitive: false, enabled: true };
  });
  const sort = t.tableSort ? [{ column: t.tableHeaders[t.tableSort.col], dir: t.tableSort.dir }] : [];
  const q = t.duck && t.duck.searchQuery;
  const search = q ? { query: q, mode: (t.duck.searchMode || 'contains'), columns: null, caseSensitive: false, includeNested: false, asFilter: true } : null;
  return { filters, combine: 'and', search, sort, select: null };
}

async function applyTableViewDuck(t) {
  t.duck.view = duckViewSpec(t);
  t.tablePages = new Map();
  t.tableInflight = new Set();
  t.tableSel = null;
  tableScroll.scrollTop = 0;
  try {
    const vi = await window.oxj.duckInvoke('buildView', { datasetId: t.duck.datasetId, view: t.duck.view, jobId: duckJob() });
    if (!tabAlive(t)) return;
    t.duck.rowCount = vi.rowCount;
    t.tableViewTotal = vi.rowCount;
    buildTableHead(t);
    renderTable();
    updateTableToolbar(t);
  } catch (e) { toast('View failed: ' + cleanErr(e)); }
}

function applyTableView(t) {
  if (isDuck(t)) return applyTableViewDuck(t);
  t.tablePages = new Map();
  t.tableInflight = new Set();
  t.tableViewTotal = null;
  t.tableSel = null;
  tableScroll.scrollTop = 0;
  buildTableHead(t);
  renderTable();
  updateTableToolbar(t);
}

// Selection bounds as inclusive [row0,row1] x [vis0,vis1], or null.
function selRect(t) {
  const s = t.tableSel;
  if (!s) return null;
  return {
    r0: Math.min(s.aRow, s.fRow), r1: Math.max(s.aRow, s.fRow),
    v0: Math.min(s.aVis, s.fVis), v1: Math.max(s.aVis, s.fVis),
  };
}

function renderTable() {
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) return;
  ensureColState(t);
  const cols = visCols(t);
  const total = tableRows(t);
  tableSpacer.style.height = total * ROW_H + 'px';
  const scrollTop = tableScroll.scrollTop;
  const h = tableScroll.clientHeight;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const last = Math.min(total, Math.ceil((scrollTop + h) / ROW_H) + 5);
  tableRowsEl.textContent = '';
  const frag = document.createDocumentFragment();
  const needed = new Set();
  for (let i = first; i < last; i++) needed.add(Math.floor(i / 100));
  for (const p of needed) fetchTablePage(t, p);
  const sel = selRect(t);
  const iw = idxWidth(t);
  // Precompute left offset of each pinned column for sticky positioning.
  const pinnedLeft = [];
  let pl = iw;
  cols.forEach((c, vi) => { if (t.colPinned.has(c)) { pinnedLeft[vi] = pl; pl += colWidth(t, c); } });
  for (let i = first; i < last; i++) {
    const page = t.tablePages.get(Math.floor(i / 100));
    const rowData = page ? page[i % 100] : null;
    const row = document.createElement('div');
    row.className = 'table-row' + (i % 2 ? ' zebra' : '');
    row.style.top = i * ROW_H + 'px';
    const idxCell = document.createElement('div');
    idxCell.className = 'td idx';
    idxCell.style.width = iw + 'px';
    idxCell.textContent = fmtInt(i);
    row.appendChild(idxCell);
    const cells = rowData ? rowData.cells : [];
    cols.forEach((c, vi) => {
      const td = document.createElement('div');
      td.className = 'td';
      td.style.width = colWidth(t, c) + 'px';
      if (t.colPinned.has(c)) { td.classList.add('pinned'); td.style.left = pinnedLeft[vi] + 'px'; }
      if (sel && i >= sel.r0 && i <= sel.r1 && vi >= sel.v0 && vi <= sel.v1) td.classList.add('cell-sel');
      const cell = cells[c];
      td.textContent = cell && cell.value != null ? cell.value : '';
      if (cell && cell.value) td.title = cell.value;
      td.addEventListener('mousedown', (e) => startCellSelect(e, t, i, vi));
      td.addEventListener('mouseenter', (e) => extendCellSelect(e, t, i, vi));
      row.appendChild(td);
    });
    frag.appendChild(row);
  }
  tableRowsEl.appendChild(frag);
}
tableScroll.addEventListener('scroll', () => { renderTable(); updateTopBtn(); });

// ---------- cell selection + copy block ----------
let cellDragging = false;
function startCellSelect(e, t, row, vis) {
  if (e.button !== 0) return;
  e.preventDefault();
  cellDragging = true;
  if (e.shiftKey && t.tableSel) { t.tableSel.fRow = row; t.tableSel.fVis = vis; }
  else t.tableSel = { aRow: row, aVis: vis, fRow: row, fVis: vis };
  renderTable();
  if (sourceOpen) scheduleSourceUpdate(); // Source pane follows the selected row
}
function extendCellSelect(e, t, row, vis) {
  if (!cellDragging || !t.tableSel) return;
  t.tableSel.fRow = row;
  t.tableSel.fVis = vis;
  renderTable();
}
document.addEventListener('mouseup', () => { cellDragging = false; });

// Keyboard nav within the grid (arrows move the focus cell; shift extends).
document.addEventListener('keydown', (e) => {
  const t = cur;
  if (!t || t.view !== 'table' || t.plain) return;
  if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  const cols = visCols(t);
  if (!cols.length) return;
  if (!t.tableSel && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    t.tableSel = { aRow: 0, aVis: 0, fRow: 0, fVis: 0 };
  }
  const s = t.tableSel;
  if (!s) return;
  let dr = 0, dv = 0;
  if (e.key === 'ArrowDown') dr = 1;
  else if (e.key === 'ArrowUp') dr = -1;
  else if (e.key === 'ArrowLeft') dv = -1;
  else if (e.key === 'ArrowRight') dv = 1;
  else return;
  e.preventDefault();
  const nr = Math.max(0, Math.min(tableRows(t) - 1, s.fRow + dr));
  const nv = Math.max(0, Math.min(cols.length - 1, s.fVis + dv));
  s.fRow = nr; s.fVis = nv;
  if (!e.shiftKey) { s.aRow = nr; s.aVis = nv; }
  const y = nr * ROW_H;
  if (y < tableScroll.scrollTop) tableScroll.scrollTop = y;
  else if (y > tableScroll.scrollTop + tableScroll.clientHeight - ROW_H) tableScroll.scrollTop = y - tableScroll.clientHeight + ROW_H;
  renderTable();
});

// Copy the selected block as tab/newline-separated text (fetch any rows not
// yet loaded from the engine).
async function copyTableSelection(t) {
  const sel = selRect(t);
  if (!sel) return false;
  const cols = visCols(t);
  const originCols = [];
  for (let v = sel.v0; v <= sel.v1; v++) originCols.push(cols[v]);
  const rows = [];
  for (let r = sel.r0; r <= sel.r1; r++) {
    let page = t.tablePages.get(Math.floor(r / 100));
    if (!page) { await fetchTablePage(t, Math.floor(r / 100)); page = t.tablePages.get(Math.floor(r / 100)); }
    const rd = page ? page[r % 100] : null;
    const cells = rd ? rd.cells : [];
    rows.push(originCols.map((c) => { const cell = cells[c]; return cell && cell.value != null ? String(cell.value) : ''; }).join('\t'));
  }
  await copyText(rows.join('\n'), 'selection');
  return true;
}

// Cmd/Ctrl-C in the grid copies the selected block. Handle the copy event so
// the native Edit ▸ Copy accelerator drives it; fast path writes synchronously
// from loaded pages, otherwise fall back to the async clipboard write.
document.addEventListener('copy', (e) => {
  const t = cur;
  if (!t || t.view !== 'table' || t.plain || !t.tableSel) return;
  const sel = selRect(t);
  if (!sel) return;
  e.preventDefault();
  let allLoaded = true;
  for (let r = sel.r0; r <= sel.r1; r++) if (!t.tablePages.get(Math.floor(r / 100))) { allLoaded = false; break; }
  if (!allLoaded) { copyTableSelection(t); return; }
  const cols = visCols(t);
  const oc = [];
  for (let v = sel.v0; v <= sel.v1; v++) oc.push(cols[v]);
  const lines = [];
  for (let r = sel.r0; r <= sel.r1; r++) {
    const page = t.tablePages.get(Math.floor(r / 100));
    const rd = page ? page[r % 100] : null;
    const cells = rd ? rd.cells : [];
    lines.push(oc.map((c) => { const cell = cells[c]; return cell && cell.value != null ? String(cell.value) : ''; }).join('\t'));
  }
  e.clipboardData.setData('text/plain', lines.join('\n'));
});

// ---------- header context menu ----------
function showHeaderMenu(e, t, c) {
  const hasFilter = t.tableFilters && t.tableFilters.some((f) => f.col === c);
  const items = [
    { label: 'Filter "' + t.tableHeaders[c] + '"…', action: () => openFilterDialog(t, c) },
  ];
  if (hasFilter) items.push({ label: 'Clear this filter', action: () => { t.tableFilters = t.tableFilters.filter((f) => f.col !== c); applyTableView(t); } });
  items.push(
    { sep: true },
    { label: 'Column coverage "' + t.tableHeaders[c] + '"…', action: () => openCoverageDialog(t, c) },
    { sep: true },
    { label: t.colPinned.has(c) ? 'Unpin Column' : 'Pin to Left', action: () => { if (t.colPinned.has(c)) t.colPinned.delete(c); else t.colPinned.add(c); buildTableHead(t); renderTable(); } },
    { label: 'Hide Column', action: () => { t.colHidden.add(c); afterColChange(t); } },
    { sep: true },
    { label: 'Show All Columns', action: () => { t.colHidden.clear(); afterColChange(t); } },
  );
  showContextMenu(e.clientX, e.clientY, items);
}

// Rebuild header + grid and re-evaluate export enablement after a column change.
function afterColChange(t) {
  // Keep any selection within bounds of the new visible-column count.
  const n = visCols(t).length;
  if (t.tableSel) {
    t.tableSel.aVis = Math.min(t.tableSel.aVis, Math.max(0, n - 1));
    t.tableSel.fVis = Math.min(t.tableSel.fVis, Math.max(0, n - 1));
  }
  buildTableHead(t);
  renderTable();
  renderColumnsPanel(t);
  updateTableToolbar(t);
}

// ---------- Columns panel (collapsible drawer) ----------
function toggleColumnsPanel() {
  const panel = $('cols-panel');
  const open = panel.classList.toggle('open');
  $('btn-cols').classList.toggle('active-tool', open);
  if (open && cur) renderColumnsPanel(cur);
}

function renderColumnsPanel(t) {
  const panel = $('cols-panel');
  if (!panel.classList.contains('open')) return;
  ensureColState(t);
  const q = ($('cols-search').value || '').trim().toLowerCase();
  const list = $('cols-list');
  list.textContent = '';
  t.colOrder.forEach((c) => {
    const name = t.tableHeaders[c];
    if (q && !String(name).toLowerCase().includes(q)) return;
    const row = document.createElement('label');
    row.className = 'cols-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !t.colHidden.has(c);
    cb.addEventListener('change', () => { if (cb.checked) t.colHidden.delete(c); else t.colHidden.add(c); afterColChange(t); });
    const span = document.createElement('span');
    span.textContent = name;
    span.title = name;
    row.append(cb, span);
    list.appendChild(row);
  });
}

// ---------- toolbar enablement ----------
// Pure rule (unit-tested): export is allowed only when the view differs from the
// original (a column hidden OR a filter active), there are rows, and at least
// one visible column remains.
function tableExportEnabled(view) {
  const differs = view.hiddenCount > 0 || view.filterActive;
  return differs && view.rowCount > 0 && view.visibleCount > 0;
}

function updateTableToolbar(t) {
  const on = t && (t.docFormat === 'csv' || t.docFormat === 'tsv') && t.view === 'table';
  $('btn-cols').classList.toggle('hidden', !on);
  $('table-tools').classList.toggle('hidden', !on);
  if (!on) return;
  ensureColState(t);
  const view = {
    hiddenCount: t.colHidden.size,
    filterActive: !!(t.tableFilters && t.tableFilters.length),
    rowCount: tableRows(t),
    visibleCount: visCols(t).length,
  };
  const enabled = isDuck(t) ? (view.rowCount > 0 && view.visibleCount > 0) : tableExportEnabled(view);
  $('btn-tbl-export').disabled = !enabled;
  const info = $('table-viewinfo');
  const narrowed = t.tableViewTotal != null && t.tableTotal != null && t.tableViewTotal !== t.tableTotal;
  if ((view.filterActive || (isDuck(t) && t.duck.searchQuery) || narrowed) && t.tableViewTotal != null) {
    info.textContent = fmtInt(t.tableViewTotal) + ' of ' + fmtInt(t.tableTotal) + ' rows';
  } else info.textContent = '';
}

// ---------- sort / filter dialogs ----------
const FILTER_OPS = [
  ['contains', 'contains'], ['equals', 'equals'], ['starts-with', 'starts with'],
  ['not-equals', 'not equals'], ['gt', '> (numeric)'], ['lt', '< (numeric)'], ['between', 'between (a,b)'],
];

function colSelect(t, selected) {
  const sel = document.createElement('select');
  visCols(t).forEach((c) => {
    const o = document.createElement('option');
    o.value = String(c);
    o.textContent = t.tableHeaders[c];
    if (selected === c) o.selected = true;
    sel.appendChild(o);
  });
  return sel;
}

function openSortDialog(t) {
  const { back, box } = simpleModal('Sort rows');
  const row = document.createElement('div');
  row.className = 'modal-row';
  const l1 = document.createElement('label'); l1.textContent = 'Column';
  const sel = colSelect(t, t.tableSort ? t.tableSort.col : undefined);
  const l2 = document.createElement('label'); l2.textContent = 'Order';
  const dir = document.createElement('select');
  [['asc', 'Ascending'], ['desc', 'Descending']].forEach(([v, lab]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = lab;
    if (t.tableSort && t.tableSort.dir === v) o.selected = true;
    dir.appendChild(o);
  });
  row.append(l1, sel, l2, dir);
  box.appendChild(row);
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const clr = document.createElement('button'); clr.className = 'btn-secondary'; clr.textContent = 'Clear Sort';
  clr.onclick = () => { t.tableSort = null; back.remove(); applyTableView(t); };
  const cancel = document.createElement('button'); cancel.className = 'btn-secondary'; cancel.textContent = 'Cancel'; cancel.onclick = () => back.remove();
  const ok = document.createElement('button'); ok.className = 'btn-primary'; ok.textContent = 'Apply';
  ok.onclick = () => { t.tableSort = { col: parseInt(sel.value, 10), dir: dir.value }; back.remove(); applyTableView(t); };
  actions.append(clr, cancel, ok);
  box.appendChild(actions);
}

function openFilterDialog(t, presetCol) {
  const { back, box } = simpleModal('Filter rows');
  const working = (t.tableFilters || []).map((f) => ({ ...f }));
  if (presetCol != null && !working.some((f) => f.col === presetCol)) working.push({ col: presetCol, op: 'contains', value: '' });
  if (!working.length) working.push({ col: visCols(t)[0], op: 'contains', value: '' });
  const list = document.createElement('div');
  list.className = 'filter-list';
  const render = () => {
    list.textContent = '';
    working.forEach((f, i) => {
      const r = document.createElement('div');
      r.className = 'filter-row';
      const cs = colSelect(t, f.col); cs.onchange = () => { f.col = parseInt(cs.value, 10); };
      const os = document.createElement('select');
      FILTER_OPS.forEach(([v, lab]) => { const o = document.createElement('option'); o.value = v; o.textContent = lab; if (f.op === v) o.selected = true; os.appendChild(o); });
      os.onchange = () => { f.op = os.value; };
      const vi = document.createElement('input'); vi.type = 'text'; vi.value = f.value || ''; vi.placeholder = 'value'; vi.oninput = () => { f.value = vi.value; };
      const rm = document.createElement('button'); rm.className = 'link-btn'; rm.textContent = '✕'; rm.onclick = () => { working.splice(i, 1); render(); };
      r.append(cs, os, vi, rm);
      list.appendChild(r);
    });
  };
  render();
  box.appendChild(list);
  const add = document.createElement('button'); add.className = 'link-btn'; add.textContent = '+ Add filter';
  add.onclick = () => { working.push({ col: visCols(t)[0], op: 'contains', value: '' }); render(); };
  box.appendChild(add);
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button'); cancel.className = 'btn-secondary'; cancel.textContent = 'Cancel'; cancel.onclick = () => back.remove();
  const ok = document.createElement('button'); ok.className = 'btn-primary'; ok.textContent = 'Apply';
  ok.onclick = () => {
    t.tableFilters = working.filter((f) => f.value !== '' || f.op === 'not-equals').map((f) => ({ col: f.col, op: f.op, value: String(f.value) }));
    back.remove();
    applyTableView(t);
  };
  actions.append(cancel, ok);
  box.appendChild(actions);
}

// Table "Actions ▾" dropdown: filter, sort, clear filters, profile, SQL.
$('btn-tbl-actions').addEventListener('click', (ev) => {
  const t = cur; if (!t) return;
  ev.stopPropagation();
  const r = ev.currentTarget.getBoundingClientRect();
  const filterActive = !!(t.tableFilters && t.tableFilters.length);
  const items = [
    { label: 'Filter…', action: () => openFilterDialog(t) },
    { label: 'Sort…', action: () => openSortDialog(t) },
    { label: 'Clear Filters', disabled: !filterActive, action: () => { t.tableFilters = []; applyTableView(t); } },
    { label: 'Clear Sort', disabled: !t.tableSort, action: () => { t.tableSort = null; applyTableView(t); } },
    { sep: true },
    { label: 'Profile', action: () => runProfile(t) },
  ];
  if (isDuck(t)) {
    items.push({ label: 'SQL Console…', action: () => openSqlConsole(t) });
    items.push({ label: 'Compare with…', disabled: !otherDuckTabs(t).length, action: () => openDiffPicker(t) });
  }
  showContextMenu(r.left, r.bottom + 4, items);
});
// Table "Export ▾" dropdown: CSV / JSON.
$('btn-tbl-export').addEventListener('click', (ev) => {
  const t = cur; if (!t) return;
  ev.stopPropagation();
  const r = ev.currentTarget.getBoundingClientRect();
  showContextMenu(r.left, r.bottom + 4, [
    { label: 'Export CSV…', action: () => runTableExport(t, 'csv') },
    { label: 'Export JSON…', action: () => runTableExport(t, 'json') },
  ]);
});

// ---------- DuckDB dataset diff (compare two delimited tables) ----------
function otherDuckTabs(t) {
  return tabs.filter((x) => x !== t && isDuck(x) && x.phase === 'ready' && x.duck);
}

function openDiffPicker(t) {
  const others = otherDuckTabs(t);
  if (!others.length) { toast('Open another delimited file in a tab to compare.'); return; }
  const { back, box } = simpleModal('Compare table');
  const r1 = document.createElement('div'); r1.className = 'modal-row';
  const l1 = document.createElement('label'); l1.textContent = 'Against';
  const sel = document.createElement('select');
  others.forEach((o, i) => { const op = document.createElement('option'); op.value = String(tabs.indexOf(o)); op.textContent = baseName(o.file || o.title); if (i === 0) op.selected = true; sel.appendChild(op); });
  r1.append(l1, sel);
  const r2 = document.createElement('div'); r2.className = 'modal-row';
  const l2 = document.createElement('label'); l2.textContent = 'Match by';
  const keySel = document.createElement('select');
  const pos = document.createElement('option'); pos.value = ''; pos.textContent = '(row position)'; keySel.appendChild(pos);
  (t.duck.columns || []).forEach((c) => { const op = document.createElement('option'); op.value = c.name; op.textContent = c.name; keySel.appendChild(op); });
  r2.append(l2, keySel);
  box.append(r1, r2);
  const actions = document.createElement('div'); actions.className = 'modal-actions';
  const cancel = document.createElement('button'); cancel.className = 'btn-secondary'; cancel.textContent = 'Cancel'; cancel.onclick = () => back.remove();
  const ok = document.createElement('button'); ok.className = 'btn-primary'; ok.textContent = 'Compare';
  ok.onclick = () => { const other = tabs[parseInt(sel.value, 10)]; const key = keySel.value; back.remove(); runDatasetDiff(t, other, key); };
  actions.append(cancel, ok); box.append(actions);
}

async function runDatasetDiff(t, other, keyCol) {
  if (!tabAlive(other) || !isDuck(other)) { toast('The other table is no longer open.'); return; }
  try {
    toast('Comparing…', true);
    const res = await window.oxj.duckInvoke('diffDatasets', {
      leftId: t.duck.datasetId, rightId: other.duck.datasetId,
      keyColumns: keyCol ? [keyCol] : [], compareColumns: null, maxExamples: 200, jobId: duckJob(),
    });
    showDatasetDiffReport(t, other, res);
  } catch (err) { toast('Compare failed: ' + cleanErr(err)); }
}

function showDatasetDiffReport(t, other, res) {
  const sub = '<span>' + htmlEsc(baseName(t.file || t.title)) + ' ↔ ' + htmlEsc(baseName(other.file || other.title)) + '</span>'
    + '<span>' + fmtInt(res.leftRows) + ' vs ' + fmtInt(res.rightRows) + ' rows · ' + res.elapsedMs + ' ms</span>';
  const { page } = reportOverlay('Dataset Diff', sub);
  const bar = document.createElement('div'); bar.className = 'diff-bar';
  const close = document.createElement('button'); close.className = 'btn-tool'; close.textContent = 'Close'; close.onclick = () => page.parentElement.remove();
  bar.append(close); page.appendChild(bar);
  const cards = document.createElement('div'); cards.className = 'diff-cards';
  const card = (n, l, cls) => '<div class="diff-card ' + cls + '"><div class="diff-card-n">' + fmtInt(n) + '</div><div class="diff-card-l">' + l + '</div></div>';
  cards.innerHTML = card(res.onlyLeft, 'Only left', 'c-rem') + card(res.onlyRight, 'Only right', 'c-add') + card(res.changed, 'Changed', 'c-chg') + card(res.identical, 'Identical', '');
  page.appendChild(cards);
  if ((res.columnsOnlyLeft || []).length || (res.columnsOnlyRight || []).length) {
    const note = document.createElement('div'); note.className = 'diff-files'; note.style.padding = '0 22px 8px';
    note.innerHTML = (res.columnsOnlyLeft.length ? '<span>Columns only left: ' + res.columnsOnlyLeft.map(htmlEsc).join(', ') + '</span>' : '')
      + (res.columnsOnlyRight.length ? '<span>Columns only right: ' + res.columnsOnlyRight.map(htmlEsc).join(', ') + '</span>' : '');
    page.appendChild(note);
  }
  const wrap = document.createElement('div'); wrap.className = 'diff-tablewrap';
  let html = '<div class="cov-table"><div class="cov-tr cov-th"><div class="cov-td c-num" style="flex:0 0 96px">Change</div><div class="cov-td c-val">Key</div><div class="cov-td c-val">Changed columns</div></div>';
  for (const ex of (res.examples || [])) {
    const label = ex.kind === 'only-left' ? 'Only left' : ex.kind === 'only-right' ? 'Only right' : 'Changed';
    const cls = ex.kind === 'only-left' ? 'r-rem' : ex.kind === 'only-right' ? 'r-add' : 'r-chg';
    html += '<div class="cov-tr ' + cls + '"><div class="cov-td c-num" style="flex:0 0 96px">' + label + '</div>'
      + '<div class="cov-td c-val">' + htmlEsc(ex.key || '') + '</div>'
      + '<div class="cov-td c-val">' + htmlEsc((ex.changedColumns || []).join(', ')) + '</div></div>';
  }
  wrap.innerHTML = html + '</div>';
  page.appendChild(wrap);
}

// ---------- DuckDB SQL console (query the file as the table `data`) ----------
function renderSqlResult(wrap, res) {
  wrap.textContent = '';
  const grid = document.createElement('div');
  grid.className = 'sql-grid';
  let html = '<div class="sql-row sql-head">';
  for (const c of res.columns) html += '<div class="sql-cell" title="' + htmlEsc(c.type || '') + '">' + htmlEsc(c.name) + '</div>';
  html += '</div>';
  for (const r of res.rows) {
    html += '<div class="sql-row">';
    for (const v of r) html += '<div class="sql-cell">' + htmlEsc(v == null ? '' : String(v)) + '</div>';
    html += '</div>';
  }
  grid.innerHTML = html;
  wrap.appendChild(grid);
}

function openSqlConsole(t) {
  const { back, box } = simpleModal('SQL Console');
  box.classList.add('sql-modal');
  const hint = document.createElement('div');
  hint.className = 'jq-hint';
  hint.textContent = "Query this file as the table “data” (read-only SELECT). ⌘/Ctrl+Enter to run.";
  const ta = document.createElement('textarea');
  ta.className = 'jq-filter sql-input'; ta.spellcheck = false;
  ta.value = t.sqlLast || 'SELECT * FROM data LIMIT 100';
  const actions = document.createElement('div'); actions.className = 'modal-actions';
  const status = document.createElement('span'); status.className = 'sql-status';
  const openTable = document.createElement('button'); openTable.className = 'btn-secondary'; openTable.textContent = 'Open as table'; openTable.disabled = true;
  const openTab = document.createElement('button'); openTab.className = 'btn-secondary'; openTab.textContent = 'Open as JSON'; openTab.disabled = true;
  const cancel = document.createElement('button'); cancel.className = 'btn-secondary'; cancel.textContent = 'Close'; cancel.onclick = () => back.remove();
  const run = document.createElement('button'); run.className = 'btn-primary'; run.textContent = 'Run';
  actions.append(status, openTable, openTab, cancel, run);
  const result = document.createElement('div'); result.className = 'sql-result';
  // Clickable example queries (like GigaTables).
  const firstCol = (t.duck.columns[0] && t.duck.columns[0].name) || 'column_name';
  const secondCol = (t.duck.columns[1] && t.duck.columns[1].name) || firstCol;
  const examples = [
    'SELECT * FROM data LIMIT 100',
    'SELECT count(*) FROM data',
    'SELECT * FROM data ORDER BY 1 DESC LIMIT 50',
    'SELECT "' + firstCol + '", count(*) AS c FROM data GROUP BY 1 ORDER BY c DESC LIMIT 50',
    'SELECT "' + firstCol + '", count(*) AS rows, avg(TRY_CAST("' + secondCol + '" AS DOUBLE)) AS avg_' + secondCol.replace(/[^A-Za-z0-9_]/g, '_') + ' FROM data GROUP BY 1 ORDER BY rows DESC LIMIT 50',
    'SELECT "' + firstCol + '", count(*) AS c FROM data GROUP BY 1 HAVING count(*) > 1 ORDER BY c DESC',
  ];
  const exWrap = document.createElement('div'); exWrap.className = 'sql-examples';
  const exLbl = document.createElement('span'); exLbl.className = 'sql-ex-label'; exLbl.textContent = 'Examples';
  exWrap.appendChild(exLbl);
  examples.forEach((ex) => {
    const b = document.createElement('button'); b.className = 'sql-ex'; b.textContent = ex; b.title = ex;
    b.onclick = () => { ta.value = ex; ta.focus(); };
    exWrap.appendChild(b);
  });
  box.append(hint, ta, exWrap, actions, result);
  let last = null;
  const doRun = async () => {
    const sql = ta.value.trim();
    if (!sql) { ta.focus(); return; }
    t.sqlLast = sql;
    run.disabled = true; run.textContent = 'Running…'; status.textContent = '';
    try {
      const res = await window.oxj.duckInvoke('runSql', { datasetId: t.duck.datasetId, sql, limit: 2000, jobId: duckJob() });
      last = res; openTab.disabled = false; openTable.disabled = false;
      renderSqlResult(result, res);
      status.textContent = fmtInt(res.rowCount) + ' rows · ' + res.elapsedMs + ' ms' + (res.truncatedAt ? ' · capped at ' + fmtInt(res.truncatedAt) : '');
    } catch (e) {
      result.textContent = '';
      const err = document.createElement('div'); err.className = 'sql-error'; err.textContent = cleanErr(e);
      result.appendChild(err); status.textContent = '';
    }
    run.disabled = false; run.textContent = 'Run';
  };
  run.onclick = doRun;
  openTab.onclick = () => {
    if (!last) return;
    const out = last.rows.map((r) => { const o = {}; last.columns.forEach((c, i) => { o[c.name] = r[i]; }); return o; });
    back.remove();
    openTextAsTab('sql_result', 'json', JSON.stringify(out, null, 2));
  };
  // Materialize the result to a CSV and reopen it as a full DuckDB table.
  openTable.onclick = async () => {
    if (!last) return;
    let full = last;
    if (last.truncatedAt) { // fetch more rows than the preview cap
      try { full = await window.oxj.duckInvoke('runSql', { datasetId: t.duck.datasetId, sql: t.sqlLast, limit: 1000000, jobId: duckJob() }); } catch {}
    }
    const names = full.columns.map((c) => c.name);
    const lines = [names.map((n) => csvCell(n, ',')).join(',')];
    for (const r of full.rows) lines.push(r.map((v) => csvCell(v == null ? '' : String(v), ',')).join(','));
    const file = await window.oxj.textToFile('sql_result', 'csv', lines.join('\n'));
    back.remove();
    const nt = newTab(true);
    if (nt) openPath(file, nt, false, { format: 'csv' });
  };
  ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); doRun(); } });
  setTimeout(() => ta.focus(), 30);
}

// ---------- coverage / profile reports (light overlay, like the diff report) ----------
function reportOverlay(titleText, subtitleHtml) {
  const overlay = document.createElement('div');
  overlay.className = 'diff-overlay';
  const page = document.createElement('div');
  page.className = 'diff-report';
  overlay.appendChild(page);
  const head = document.createElement('div');
  head.className = 'diff-head';
  head.innerHTML = '<button class="diff-x" title="Close">✕</button><div class="diff-title">' + htmlEsc(titleText) + '</div>' +
    (subtitleHtml ? '<div class="diff-files">' + subtitleHtml + '</div>' : '');
  head.querySelector('.diff-x').addEventListener('click', () => overlay.remove());
  page.appendChild(head);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  const onEsc = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEsc); } };
  document.addEventListener('keydown', onEsc);
  document.body.appendChild(overlay);
  return { overlay, page };
}

function openCoverageDialog(t, col) {
  const { back, box } = simpleModal('Column coverage — ' + t.tableHeaders[col]);
  const opt = (id, label, checked) => {
    const l = document.createElement('label'); l.className = 'cov-opt';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = id; cb.checked = checked;
    const s = document.createElement('span'); s.textContent = label;
    l.append(cb, s); return l;
  };
  const ci = opt('cov-ci', 'Case-insensitive', false);
  const trim = opt('cov-trim', 'Trim whitespace', false);
  const row = document.createElement('div'); row.className = 'modal-row';
  const tl = document.createElement('label'); tl.textContent = 'Top N';
  const topIn = document.createElement('input'); topIn.type = 'text'; topIn.value = '1000'; topIn.style.width = '80px';
  row.append(tl, topIn);
  box.append(ci, trim, row);
  const actions = document.createElement('div'); actions.className = 'modal-actions';
  const cancel = document.createElement('button'); cancel.className = 'btn-secondary'; cancel.textContent = 'Cancel'; cancel.onclick = () => back.remove();
  const ok = document.createElement('button'); ok.className = 'btn-primary'; ok.textContent = 'Compute';
  ok.onclick = () => {
    back.remove();
    runCoverage(t, col, {
      ci: ci.querySelector('input').checked,
      trim: trim.querySelector('input').checked,
      top: Math.max(1, parseInt(topIn.value, 10) || 1000),
    });
  };
  actions.append(cancel, ok); box.appendChild(actions);
}

async function runCoverage(t, col, opts) {
  if (isDuck(t)) return runCoverageDuck(t, col, opts);
  try {
    toast('Computing coverage…', true);
    const res = await window.oxj.query(t.id, {
      op: 'distinct', node: 1, col, top: opts.top, ci: opts.ci, trim: opts.trim,
      filters: (t.tableFilters && t.tableFilters.length) ? t.tableFilters : undefined,
    });
    showCoverageReport(t, col, res);
  } catch (err) {
    const msg = cleanErr(err);
    if (msg.includes('unknown op')) toast('Coverage needs an engine rebuild (npm run build:engine), then restart');
    else toast('Coverage failed: ' + msg);
  }
}

function showCoverageReport(t, col, res) {
  const total = Number(res.total_rows) || 0;
  const uniq = total ? (100 * Number(res.distinct) / total).toFixed(1) : '0';
  let sub = '<span>' + htmlEsc(t.tableHeaders[col]) + '</span><span>' + fmtInt(res.distinct) + ' distinct of ' + fmtInt(total) + ' rows (' + uniq + '% unique)</span>';
  if (res.numeric) sub += '<span>min ' + res.numeric.min + ' · max ' + res.numeric.max + ' · mean ' + Number(res.numeric.mean).toFixed(2) + '</span>';
  const { page } = reportOverlay('Column Coverage', sub);
  const bar = document.createElement('div'); bar.className = 'diff-bar';
  const save = document.createElement('button'); save.className = 'btn-tool'; save.textContent = 'Save As CSV';
  save.onclick = async () => {
    const lines = ['value,count,cumulative_%'];
    let cum = 0;
    for (const it of res.items) { cum += it.count; lines.push([csvCell(it.value == null ? '' : String(it.value), ','), it.count, total ? (100 * cum / total).toFixed(2) : '0'].join(',')); }
    const saved = await window.oxj.saveText(stampName('coverage_' + t.tableHeaders[col], 'csv'), lines.join('\n'));
    if (saved) toast('Saved ' + baseName(saved), true);
  };
  const close = document.createElement('button'); close.className = 'btn-tool'; close.textContent = 'Close'; close.onclick = () => page.parentElement.remove();
  bar.append(save, close); page.appendChild(bar);

  const wrap = document.createElement('div'); wrap.className = 'diff-tablewrap';
  const max = res.items.reduce((m, it) => Math.max(m, it.count), 1);
  let cum = 0;
  let html = '<div class="cov-table"><div class="cov-tr cov-th"><div class="cov-td c-val">Value</div><div class="cov-td c-num">Count</div><div class="cov-td c-num">Cum %</div><div class="cov-td c-bar">Share</div></div>';
  for (const it of res.items) {
    cum += it.count;
    const pct = total ? (100 * cum / total).toFixed(1) : '0';
    const w = (100 * it.count / max).toFixed(1);
    html += '<div class="cov-tr"><div class="cov-td c-val">' + htmlEsc(it.value == null ? '(empty)' : it.value) + '</div>' +
      '<div class="cov-td c-num">' + fmtInt(it.count) + '</div><div class="cov-td c-num">' + pct + '%</div>' +
      '<div class="cov-td c-bar"><div class="cov-bar" style="width:' + w + '%"></div></div></div>';
  }
  wrap.innerHTML = html + '</div>';
  page.appendChild(wrap);
}

// ---------- DuckDB profile / coverage (profileAll / profileColumn) ----------
async function runProfileDuck(t) {
  try {
    toast('Profiling columns…', true);
    const cols = await window.oxj.duckInvoke('profileAll', { datasetId: t.duck.datasetId, view: t.duck.view, jobId: duckJob() });
    const total = t.duck.rowCount || 0;
    const { page } = reportOverlay('Column Profile', '<span>' + htmlEsc(baseName(t.file || t.title)) + '</span><span>' + fmtInt(total) + ' rows · ' + cols.length + ' columns</span>');
    const bar = document.createElement('div'); bar.className = 'diff-bar';
    const close = document.createElement('button'); close.className = 'btn-tool'; close.textContent = 'Close'; close.onclick = () => page.parentElement.remove();
    bar.append(close); page.appendChild(bar);
    const wrap = document.createElement('div'); wrap.className = 'diff-tablewrap';
    let html = '<div class="cov-table"><div class="cov-tr cov-th">'
      + '<div class="cov-td c-val">Column</div><div class="cov-td c-val">Type</div>'
      + '<div class="cov-td c-num">Non-null</div><div class="cov-td c-num">Nulls</div>'
      + '<div class="cov-td c-num">Distinct ~</div><div class="cov-td c-val">Min</div>'
      + '<div class="cov-td c-val">Max</div><div class="cov-td c-val">Top value</div></div>';
    for (const c of cols) {
      const tv = (c.topValues && c.topValues[0]) ? (c.topValues[0].value == null ? '(null)' : c.topValues[0].value) : '';
      html += '<div class="cov-tr"><div class="cov-td c-val">' + htmlEsc(c.column) + '</div>'
        + '<div class="cov-td c-val">' + htmlEsc(c.type || '') + '</div>'
        + '<div class="cov-td c-num">' + fmtInt(c.nonNull) + '</div>'
        + '<div class="cov-td c-num">' + fmtInt(c.nulls) + '</div>'
        + '<div class="cov-td c-num">' + fmtInt(c.distinctApprox) + '</div>'
        + '<div class="cov-td c-val">' + htmlEsc(c.min == null ? '' : c.min) + '</div>'
        + '<div class="cov-td c-val">' + htmlEsc(c.max == null ? '' : c.max) + '</div>'
        + '<div class="cov-td c-val">' + htmlEsc(tv) + '</div></div>';
    }
    wrap.innerHTML = html + '</div>';
    page.appendChild(wrap);
  } catch (err) { toast('Profile failed: ' + cleanErr(err)); }
}

async function runCoverageDuck(t, col, opts) {
  try {
    toast('Computing coverage…', true);
    const colName = t.tableHeaders[col];
    const prof = await window.oxj.duckInvoke('profileColumn', { datasetId: t.duck.datasetId, view: t.duck.view, column: colName, topN: opts.top || 1000, jobId: duckJob() });
    const total = prof.rows || t.duck.rowCount || 0;
    const uniq = total ? (100 * Number(prof.distinctApprox) / total).toFixed(1) : '0';
    let sub = '<span>' + htmlEsc(colName) + '</span><span>~' + fmtInt(prof.distinctApprox) + ' distinct of ' + fmtInt(total) + ' rows (' + uniq + '% unique)</span>';
    if (prof.min != null || prof.max != null) sub += '<span>min ' + htmlEsc(prof.min || '') + ' · max ' + htmlEsc(prof.max || '') + (prof.avg != null ? ' · avg ' + htmlEsc(prof.avg) : '') + '</span>';
    const { page } = reportOverlay('Column Coverage', sub);
    const bar = document.createElement('div'); bar.className = 'diff-bar';
    const close = document.createElement('button'); close.className = 'btn-tool'; close.textContent = 'Close'; close.onclick = () => page.parentElement.remove();
    bar.append(close); page.appendChild(bar);
    const wrap = document.createElement('div'); wrap.className = 'diff-tablewrap';
    const items = prof.topValues || [];
    const max = items.reduce((m, it) => Math.max(m, it.count), 1);
    let html = '<div class="cov-table"><div class="cov-tr cov-th"><div class="cov-td c-val">Value</div><div class="cov-td c-num">Count</div><div class="cov-td c-num">Share</div><div class="cov-td c-bar"></div></div>';
    for (const it of items) {
      const pct = total ? (100 * it.count / total).toFixed(1) : '0';
      const w = (100 * it.count / max).toFixed(1);
      html += '<div class="cov-tr"><div class="cov-td c-val">' + htmlEsc(it.value == null ? '(null)' : it.value) + '</div>' +
        '<div class="cov-td c-num">' + fmtInt(it.count) + '</div><div class="cov-td c-num">' + pct + '%</div>' +
        '<div class="cov-td c-bar"><div class="cov-bar" style="width:' + w + '%"></div></div></div>';
    }
    wrap.innerHTML = html + '</div>';
    page.appendChild(wrap);
  } catch (err) { toast('Coverage failed: ' + cleanErr(err)); }
}

async function runProfile(t) {
  if (isDuck(t)) return runProfileDuck(t);
  try {
    toast('Profiling columns…', true);
    const res = await window.oxj.query(t.id, { op: 'profile', node: 1 });
    showProfileReport(t, res);
  } catch (err) {
    const msg = cleanErr(err);
    if (msg.includes('unknown op')) toast('Profile needs an engine rebuild (npm run build:engine), then restart');
    else toast('Profile failed: ' + msg);
  }
}

function showProfileReport(t, res) {
  const total = Number(res.total_rows) || 0;
  const { page } = reportOverlay('Column Profile', '<span>' + htmlEsc(baseName(t.file || t.title)) + '</span><span>' + fmtInt(total) + ' rows · ' + res.columns.length + ' columns</span>');
  const bar = document.createElement('div'); bar.className = 'diff-bar';
  const save = document.createElement('button'); save.className = 'btn-tool'; save.textContent = 'Save As CSV';
  save.onclick = async () => {
    const lines = ['column,distinct,non_empty,empty,fill_%,top_value,top_%'];
    for (const c of res.columns) {
      const fill = total ? (100 * c.non_empty / total).toFixed(1) : '0';
      const topPct = total ? (100 * c.top_count / total).toFixed(1) : '0';
      lines.push([csvCell(c.column, ','), c.distinct, c.non_empty, c.empty, fill, csvCell(c.top_value == null ? '' : String(c.top_value), ','), topPct].join(','));
    }
    const saved = await window.oxj.saveText(stampName('profile_' + baseName(t.file || 'table'), 'csv'), lines.join('\n'));
    if (saved) toast('Saved ' + baseName(saved), true);
  };
  const close = document.createElement('button'); close.className = 'btn-tool'; close.textContent = 'Close'; close.onclick = () => page.parentElement.remove();
  bar.append(save, close); page.appendChild(bar);

  const wrap = document.createElement('div'); wrap.className = 'diff-tablewrap';
  let html = '<div class="cov-table"><div class="cov-tr cov-th"><div class="cov-td c-val">Column</div><div class="cov-td c-num">Distinct</div><div class="cov-td c-num">Non-empty</div><div class="cov-td c-num">Empty</div><div class="cov-td c-num">Fill %</div><div class="cov-td c-val">Top value</div><div class="cov-td c-num">Top %</div></div>';
  for (const c of res.columns) {
    const fill = total ? (100 * c.non_empty / total).toFixed(1) : '0';
    const topPct = total ? (100 * c.top_count / total).toFixed(1) : '0';
    html += '<div class="cov-tr"><div class="cov-td c-val">' + htmlEsc(c.column) + '</div>' +
      '<div class="cov-td c-num">' + fmtInt(c.distinct) + '</div><div class="cov-td c-num">' + fmtInt(c.non_empty) + '</div>' +
      '<div class="cov-td c-num">' + fmtInt(c.empty) + '</div><div class="cov-td c-num">' + fill + '%</div>' +
      '<div class="cov-td c-val">' + htmlEsc(c.top_value == null ? '' : c.top_value) + '</div><div class="cov-td c-num">' + topPct + '%</div></div>';
  }
  wrap.innerHTML = html + '</div>';
  page.appendChild(wrap);
}

$('btn-cols').addEventListener('click', toggleColumnsPanel);
$('btn-cols-close').addEventListener('click', toggleColumnsPanel);
$('cols-search').addEventListener('input', () => { if (cur) renderColumnsPanel(cur); });
$('btn-cols-all').addEventListener('click', () => { if (cur) { cur.colHidden.clear(); afterColChange(cur); } });
$('btn-cols-none').addEventListener('click', () => {
  const t = cur; if (!t) return;
  ensureColState(t);
  // Keep at least one column visible.
  t.colHidden = new Set(t.colOrder.slice(1));
  afterColChange(t);
});
// DuckDB export: CSV via the engine (COPY TO), JSON assembled from pages.
async function runTableExportDuck(t, fmt) {
  const visIdx = visCols(t);
  const names = visIdx.map((c) => t.tableHeaders[c]);
  try {
    if (fmt === 'csv') {
      const target = await window.oxj.pickSavePath(stampName('export_' + baseName(t.file || 'table'), 'csv'), [{ name: 'CSV', extensions: ['csv'] }]);
      if (!target) return;
      toast('Exporting…', true);
      const view = { ...t.duck.view, select: names };
      const res = await window.oxj.duckInvoke('exportView', { datasetId: t.duck.datasetId, view, targetPath: target, format: 'csv', limit: null, includeHeader: true });
      toast('Exported ' + fmtInt(res.rowsWritten) + ' rows → ' + baseName(res.targetPath), true);
    } else {
      toast('Exporting JSON…', true);
      const CAP = 200000;
      const total = Math.min(CAP, t.duck.rowCount || 0);
      const out = [];
      for (let off = 0; off < total; off += 1000) {
        const res = await window.oxj.duckInvoke('getPage', { datasetId: t.duck.datasetId, view: t.duck.view, offset: off, limit: 1000, maxCellChars: 1000000 });
        for (const r of (res.rows || [])) { const o = {}; visIdx.forEach((c, k) => { o[names[k]] = r[c]; }); out.push(o); }
        if (!tabAlive(t)) return;
      }
      const saved = await window.oxj.saveText(stampName('export_' + baseName(t.file || 'table'), 'json'), JSON.stringify(out, null, 2));
      if (saved) toast('Exported ' + fmtInt(out.length) + (total < (t.duck.rowCount || 0) ? ' (capped at ' + fmtInt(CAP) + ')' : '') + ' rows → ' + baseName(saved), true);
    }
  } catch (err) { toast('Export failed: ' + cleanErr(err)); }
}

// Export the visible columns + filtered/sorted rows via the engine, into a new tab.
async function runTableExport(t, fmt) {
  if (isDuck(t)) return runTableExportDuck(t, fmt);
  try {
    toast('Exporting…', true);
    const cols = visCols(t).map((c) => ({ ord: c, name: t.tableHeaders[c] }));
    const res = await window.oxj.query(t.id, {
      op: 'export', node: 1, format: fmt, cols,
      filters: (t.tableFilters && t.tableFilters.length) ? t.tableFilters : undefined,
      sort: t.tableSort || undefined,
    });
    const file = await window.oxj.textToFile('oxj_export', fmt, res.text);
    const nt = newTab(true);
    if (nt) openPath(file, nt);
    toast('Exported ' + fmtInt(res.rows) + ' row(s)' + (res.truncated ? ' (capped at 2M)' : ''), true);
  } catch (err) {
    const msg = cleanErr(err);
    if (msg.includes('unknown op')) toast('Export needs an engine rebuild (npm run build:engine), then restart');
    else toast('Export failed: ' + msg);
  }
}

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
        theme: monacoThemeName(uiTheme),
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

// DuckDB table: Source shows the selected row as JSON (getRowJson).
async function updateSourceDuck(t) {
  const rowIdx = t.tableSel ? t.tableSel.fRow : 0;
  $('source-title').textContent = 'Source — loading…';
  try {
    const res = await window.oxj.duckInvoke('getRowJson', { datasetId: t.duck.datasetId, view: t.duck.view, viewRow: rowIdx });
    if (t !== cur) return;
    let text = res && res.json != null ? res.json : '';
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {}
    $('source-title').textContent = 'Source — Row ' + (rowIdx + 1) + ' (JSON)';
    if (monacoReady && monacoEditor) {
      $('source-fallback').classList.add('hidden');
      $('monaco-host').classList.remove('hidden');
      const model = window.monaco.editor.createModel(text, 'json');
      const old = monacoEditor.getModel();
      monacoEditor.setModel(model);
      if (old) old.dispose();
    } else {
      $('monaco-host').classList.add('hidden');
      const fb = $('source-fallback'); fb.classList.remove('hidden'); fb.textContent = text;
    }
    updateSource._text = text;
  } catch (err) {
    $('source-title').textContent = 'Source — unavailable';
    const msg = cleanErr(err);
    if (monacoReady && monacoEditor) monacoEditor.setValue('// ' + msg);
    else { $('source-fallback').classList.remove('hidden'); $('source-fallback').textContent = msg; }
  }
}

async function updateSource() {
  const t = cur;
  if (!t || t.phase !== 'ready' || !sourceOpen) return;
  if (isDuck(t)) return updateSourceDuck(t);
  const e = t.visible[t.selectedIdx];
  if (!e || e.pseudo) return;
  $('source-title').textContent = 'Source — loading…';
  try {
    const res = await window.oxj.query(t.id, { op: 'subtree', node: e.id, budget: 50000 });
    if (t !== cur) return;
    // Always pretty-print JSON in the Source pane — minified sources (e.g. API
    // responses) are sliced raw by the engine, so reformat here.
    let text = res.text;
    if (res.language === 'json' && !res.truncated) {
      try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {}
    }
    $('source-title').textContent = 'Source — ' + (e.label || '') + ' (' + res.language.toUpperCase() + ')';
    if (monacoReady && monacoEditor) {
      $('source-fallback').classList.add('hidden');
      $('monaco-host').classList.remove('hidden');
      const model = window.monaco.editor.createModel(text, res.language);
      const old = monacoEditor.getModel();
      monacoEditor.setModel(model);
      if (old) old.dispose();
    } else {
      $('monaco-host').classList.add('hidden');
      const fb = $('source-fallback');
      fb.classList.remove('hidden');
      fb.textContent = text;
    }
    updateSource._text = text;
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

// Full File ↗ — open the complete original file in a new read-only tab.
function fullFileLang(p) {
  const ext = String(p).split('.').pop().toLowerCase();
  if (['json', 'ndjson', 'jsonl'].includes(ext)) return 'json';
  if (ext === 'xml') return 'xml';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  return plainLangFor(p) || 'plaintext'; // md/py/etc.; csv/tsv fall back to raw text
}
$('btn-full-file').addEventListener('click', () => {
  const t = cur;
  if (!t || t.phase !== 'ready' || !t.file) return;
  const nt = newTab(true);
  if (nt) openPlainPath(t.file, nt, fullFileLang(t.file), true);
});
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
// ---------- Smart URL / request builder (Postman-style) ----------
let builderParams = [];
let builderHeaders = [];
let urlSyncing = false; // guard against URL<->params feedback loops
let builderEditTab = null; // when editing an open URL doc, reuse its tab

function showUrlModal(prefill, editTab) {
  builderEditTab = editTab || null;
  const r = prefill || {};
  $('req-method').value = r.method || 'GET';
  $('url-input').value = r.url || '';
  $('req-body').value = r.body || '';
  const a = r.auth || { type: 'none' };
  $('url-auth').value = a.type || 'none';
  $('url-user').value = a.user || '';
  $('url-pass').value = a.pass || '';
  $('url-token').value = a.token || '';
  $('url-apikey-key').value = a.header || '';
  $('url-apikey-val').value = a.value || a.token || '';
  $('url-apikey-in').value = a.addTo || 'header';
  updateAuthPanes();
  builderParams = (r.params && r.params.length)
    ? r.params.map((p) => ({ on: p.on !== false, key: p.key, val: p.val }))
    : parseParams(r.url || '');
  builderHeaders = (r.headers || []).map((h) => ({ on: h.on !== false, key: h.key, val: h.val }));
  renderKv('params-table', builderParams, onParamsChange);
  renderKv('headers-table', builderHeaders, () => {});
  showReqTab('params');
  $('req-bookmark').classList.remove('saved');
  if (!prefill) bmEditingId = null;
  $('url-modal').classList.remove('hidden');
  setUModalTab('request');
  setTimeout(() => $('url-input').focus(), 20);
}
function hideUrlModal() { $('url-modal').classList.add('hidden'); }

// ---------- Open URL modal outer tabs: Request | Bookmarks | Recents ----------
function setUModalTab(which) {
  document.querySelectorAll('.umodal-tab').forEach((b) => b.classList.toggle('active', b.dataset.utab === which));
  document.querySelectorAll('.umodal-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.upane !== which));
  if (which === 'bookmarks') renderBookmarks();
  else if (which === 'recents') renderRecentsTab();
  else setTimeout(() => $('url-input').focus(), 10);
}
// Open the modal directly on a given tab (used by the Bookmarks Manager menu).
function openUModalTab(which) {
  if ($('url-modal').classList.contains('hidden')) showUrlModal();
  setUModalTab(which);
}

function relTime(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return Math.floor(m) + 'm ago';
  const h = m / 60; if (h < 24) return Math.floor(h) + 'h ago';
  const d = h / 24; if (d < 30) return Math.floor(d) + 'd ago';
  const mo = d / 30; if (mo < 12) return Math.floor(mo) + 'mo ago';
  return Math.floor(mo / 12) + 'y ago';
}
const METHOD_COLOR = { GET: '#1d9e75', POST: '#ba7517', PUT: '#378add', DELETE: '#e24b4a', PATCH: '#7f77dd' };
function defaultBookmarkName(url) {
  try { const u = new URL(url); return (u.host + u.pathname).replace(/\/$/, '') || url; } catch { return url; }
}
// A bookmark "carries a credential" (stored encrypted at rest) if its auth
// type has a non-empty secret field.
function bmHasSecret(b) {
  const a = b.request && b.request.auth; if (!a) return false;
  if (a.type === 'bearer') return !!a.token;
  if (a.type === 'basic') return !!a.pass;
  if (a.type === 'apikey') return !!(a.value || a.token);
  return false;
}

// ---------- Bookmarks tab ----------
let bmCache = [];
let bmSort = 'recent';

async function renderBookmarks() {
  bmCache = await window.oxj.bookmarks.list();
  drawBookmarks();
}
function drawBookmarks() {
  const q = $('bm-search').value.trim().toLowerCase();
  let list = bmCache.slice();
  if (q) list = list.filter((b) => (b.name || '').toLowerCase().includes(q) || ((b.request && b.request.url) || '').toLowerCase().includes(q));
  list.sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    switch (bmSort) {
      case 'used': return (b.useCount || 0) - (a.useCount || 0);
      case 'name': return (a.name || '').localeCompare(b.name || '');
      case 'added': return (b.createdAt || 0) - (a.createdAt || 0);
      default: return (b.lastUsedAt || b.updatedAt || 0) - (a.lastUsedAt || a.updatedAt || 0);
    }
  });
  const wrap = $('bm-list');
  wrap.textContent = '';
  if (!list.length) {
    const e = document.createElement('div'); e.className = 'umodal-empty';
    e.textContent = bmCache.length ? 'No bookmarks match your search.' : 'No bookmarks yet. Build a request, then click ☆ to save it.';
    wrap.appendChild(e); return;
  }
  for (const b of list) wrap.appendChild(bmRow(b));
}
function bmRow(b) {
  const row = document.createElement('div'); row.className = 'bm-row';
  const star = document.createElement('button');
  star.className = 'bm-star' + (b.pinned ? ' on' : ''); star.textContent = b.pinned ? '★' : '☆';
  star.title = b.pinned ? 'Unpin' : 'Pin to top';
  star.addEventListener('click', async (e) => { e.stopPropagation(); await window.oxj.bookmarks.update(b.id, { pinned: !b.pinned }); renderBookmarks(); });

  const main = document.createElement('div'); main.className = 'bm-main';
  const l1 = document.createElement('div'); l1.className = 'bm-line1';
  const name = document.createElement('span'); name.className = 'bm-name'; name.textContent = b.name;
  const m = (b.request && b.request.method) || 'GET';
  const chip = document.createElement('span'); chip.className = 'bm-chip'; chip.textContent = m;
  const col = METHOD_COLOR[m] || 'var(--fg-dim)';
  chip.style.color = col; chip.style.border = '1px solid ' + col;
  l1.append(name, chip);
  const url = document.createElement('div'); url.className = 'bm-url'; url.textContent = (b.request && b.request.url) || '';
  const meta = document.createElement('div'); meta.className = 'bm-meta';
  let metaText = b.lastUsedAt ? ('used ' + relTime(b.lastUsedAt) + ' · ' + (b.useCount || 0) + '×') : ('added ' + relTime(b.createdAt));
  if (bmHasSecret(b)) metaText += ' · secured';
  meta.textContent = metaText;
  main.append(l1, url, meta);

  const acts = document.createElement('div'); acts.className = 'bm-actions';
  const open = document.createElement('button'); open.className = 'link-btn bm-open'; open.textContent = 'Open';
  open.addEventListener('click', (e) => { e.stopPropagation(); openBookmark(b); });
  const edit = document.createElement('button'); edit.className = 'link-btn'; edit.textContent = 'Edit';
  edit.addEventListener('click', (e) => { e.stopPropagation(); editBookmark(b); });
  const del = document.createElement('button'); del.className = 'link-btn'; del.textContent = 'Delete';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!await confirmDialog({ title: 'Delete bookmark?', body: '“' + b.name + '” will be removed.', okLabel: 'Delete' })) return;
    await window.oxj.bookmarks.remove(b.id); renderBookmarks();
  });
  acts.append(open, edit, del);

  row.append(star, main, acts);
  row.addEventListener('dblclick', () => openBookmark(b));
  return row;
}
async function openBookmark(b) {
  await window.oxj.bookmarks.update(b.id, { touch: true });
  await performRequest(b.request, undefined);
}
// Load a bookmark into the Request builder for editing; remembers its id so a
// re-save (☆) updates it in place rather than duplicating.
function editBookmark(b) {
  showUrlModal(b.request);
  bmEditingId = b.id;
}
async function saveCurrentAsBookmark() {
  const reqState = currentRequestState();
  if (!reqState.url) { toast('Enter a URL first'); return; }
  bmCache = await window.oxj.bookmarks.list();
  const existing = bmEditingId
    ? bmCache.find((b) => b.id === bmEditingId)
    : bmCache.find((b) => b.request && b.request.url === reqState.url);
  const name = await promptDialog({
    title: existing ? 'Update bookmark' : 'Save bookmark',
    body: existing ? 'Save your changes to this bookmark.' : '',
    value: existing ? existing.name : defaultBookmarkName(reqState.url),
    placeholder: 'Bookmark name',
    okLabel: existing ? 'Update' : 'Save',
  });
  if (!name) return;
  await window.oxj.bookmarks.save({ id: existing ? existing.id : undefined, name, request: reqState, pinned: existing ? existing.pinned : false });
  bmEditingId = null;
  toast('Bookmark saved', true);
  $('req-bookmark').classList.add('saved');
}
let bmEditingId = null;

// ---------- Recents tab ----------
let rcCache = [];
async function renderRecentsTab() {
  rcCache = await window.oxj.recents();
  drawRecents();
}
const rcCollapsed = new Set(); // collapsed file-type groups in the modal Recents tab
function drawRecents() {
  const q = $('rc-search').value.trim().toLowerCase();
  let list = rcCache.slice();
  if (q) list = list.filter((r) => baseName(r.path).toLowerCase().includes(q) || String(r.path).toLowerCase().includes(q));
  const wrap = $('rc-list'); wrap.textContent = '';
  if (!list.length) {
    const e = document.createElement('div'); e.className = 'umodal-empty';
    e.textContent = rcCache.length ? 'No recent files match your search.' : 'No recent files yet.';
    wrap.appendChild(e); return;
  }
  // Group by file type (JSON / CSV / XML / …), same buckets as the side dock.
  for (const [group, items] of groupRecentsByType(list)) {
    const collapsed = rcCollapsed.has(group);
    const head = document.createElement('div');
    head.className = 'rc-group-head';
    head.innerHTML = '<span class="rc-group-caret">' + (collapsed ? '▸' : '▾') + '</span>'
      + '<span class="rc-group-name">' + htmlEsc(group) + '</span>'
      + '<span class="rc-group-count">' + items.length + '</span>';
    head.addEventListener('click', () => {
      if (rcCollapsed.has(group)) rcCollapsed.delete(group); else rcCollapsed.add(group);
      drawRecents();
    });
    wrap.appendChild(head);
    if (!collapsed) for (const r of items) wrap.appendChild(rcRow(r));
  }
}
function rcRow(r) {
  const row = document.createElement('div'); row.className = 'bm-row';
  const main = document.createElement('div'); main.className = 'bm-main';
  const n = document.createElement('div'); n.className = 'bm-name'; n.textContent = baseName(r.path);
  const u = document.createElement('div'); u.className = 'bm-url'; u.textContent = r.path;
  const meta = document.createElement('div'); meta.className = 'bm-meta';
  meta.textContent = humanSize(r.size || 0) + (r.at ? ' · ' + relTime(r.at) : '');
  main.append(n, u, meta);
  const acts = document.createElement('div'); acts.className = 'bm-actions';
  const open = document.createElement('button'); open.className = 'link-btn bm-open'; open.textContent = 'Open';
  open.addEventListener('click', (e) => { e.stopPropagation(); hideUrlModal(); openRecent(r); });
  const del = document.createElement('button'); del.className = 'link-btn'; del.textContent = '✕'; del.title = 'Remove from recents';
  del.addEventListener('click', async (e) => { e.stopPropagation(); await window.oxj.removeRecent(r.path); renderRecentsTab(); });
  acts.append(open, del);
  row.append(main, acts);
  row.addEventListener('dblclick', () => { hideUrlModal(); openRecent(r); });
  return row;
}

// Modal tab + bookmarks/recents wiring.
document.querySelectorAll('.umodal-tab').forEach((b) => b.addEventListener('click', () => setUModalTab(b.dataset.utab)));
$('req-bookmark').addEventListener('click', saveCurrentAsBookmark);
$('bm-search').addEventListener('input', drawBookmarks);
$('bm-sort').addEventListener('change', () => { bmSort = $('bm-sort').value; drawBookmarks(); });
$('rc-search').addEventListener('input', drawRecents);
window.oxj.bookmarks.onChanged(() => {
  if (!$('url-modal').classList.contains('hidden')) {
    const onBm = document.querySelector('.umodal-tab[data-utab="bookmarks"]').classList.contains('active');
    if (onBm) renderBookmarks();
  }
  if (recentPanelOpen && dockTab === 'bookmarks') renderDockBookmarks();
});

// URL <-> Params
// Form-decode a query token: '+' means space, then percent-decode. Rebuilding
// with encodeURIComponent turns spaces back into %20 (which servers read as a
// space), so a pasted '+' isn't mangled into a literal '%2B'.
function decParam(s) {
  try { return decodeURIComponent(String(s).replace(/\+/g, '%20')); }
  catch { return String(s); }
}
function parseParams(url) {
  const qi = String(url).indexOf('?');
  if (qi < 0) return [];
  const out = [];
  for (const pair of url.slice(qi + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? '' : pair.slice(eq + 1);
    out.push({ on: true, key: decParam(k), val: decParam(v) });
  }
  return out;
}
function baseOf(url) { const qi = url.indexOf('?'); return qi < 0 ? url : url.slice(0, qi); }
function buildUrl() {
  const base = baseOf($('url-input').value.trim());
  const on = builderParams.filter((p) => p.on !== false && (p.key || p.val));
  if (!on.length) return base;
  return base + '?' + on.map((p) => encodeURIComponent(p.key) + '=' + encodeURIComponent(p.val)).join('&');
}
function onParamsChange() {
  if (urlSyncing) return;
  urlSyncing = true;
  $('url-input').value = buildUrl();
  urlSyncing = false;
}

// key-value table (append-on-type so focus is preserved)
function makeKvRow(el, rows, row, onChange) {
  const r = document.createElement('div');
  r.className = 'kv-row' + (row.on === false ? ' kv-off' : '');
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = row.on !== false;
  const key = document.createElement('input'); key.className = 'kv-key'; key.placeholder = 'key'; key.value = row.key || '';
  const val = document.createElement('input'); val.className = 'kv-val'; val.placeholder = 'value'; val.value = row.val || '';
  const del = document.createElement('button'); del.className = 'kv-del'; del.textContent = '×';
  cb.onchange = () => { row.on = cb.checked; r.classList.toggle('kv-off', !row.on); onChange(); };
  const upd = () => {
    row.key = key.value; row.val = val.value; onChange();
    if (rows[rows.length - 1] === row && (row.key || row.val)) {
      const blank = { on: true, key: '', val: '' };
      rows.push(blank);
      el.appendChild(makeKvRow(el, rows, blank, onChange));
    }
  };
  key.oninput = upd; val.oninput = upd;
  const onEnter = (e) => { if (e.key === 'Enter') { e.preventDefault(); sendRequest(); } };
  key.addEventListener('keydown', onEnter);
  val.addEventListener('keydown', onEnter);
  del.onclick = () => { const i = rows.indexOf(row); if (i >= 0) rows.splice(i, 1); r.remove(); onChange(); };
  r.append(cb, key, val, del);
  return r;
}
function renderKv(tableId, rows, onChange) {
  const el = $(tableId);
  el.textContent = '';
  if (!rows.length || rows[rows.length - 1].key || rows[rows.length - 1].val) rows.push({ on: true, key: '', val: '' });
  for (const row of rows) el.appendChild(makeKvRow(el, rows, row, onChange));
}

function updateAuthPanes() {
  const v = $('url-auth').value;
  $('url-auth-basic').classList.toggle('hidden', v !== 'basic');
  $('url-auth-bearer').classList.toggle('hidden', v !== 'bearer');
  $('url-auth-apikey').classList.toggle('hidden', v !== 'apikey');
}
function gatherAuth() {
  const type = $('url-auth').value;
  if (type === 'basic') return { type, user: $('url-user').value, pass: $('url-pass').value };
  if (type === 'bearer') return { type, token: $('url-token').value };
  if (type === 'apikey') return { type, header: $('url-apikey-key').value, value: $('url-apikey-val').value, token: $('url-apikey-val').value, addTo: $('url-apikey-in').value };
  return { type: 'none' };
}
function showReqTab(name) {
  document.querySelectorAll('.req-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.req-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
}

// Snapshot the builder as a request object (the shape stored in bookmarks and
// on t.origin): method, url, params, auth, headers, body.
function currentRequestState() {
  return {
    method: $('req-method').value,
    url: buildUrl(),
    params: builderParams.filter((p) => p.key || p.val),
    auth: gatherAuth(),
    headers: builderHeaders.filter((h) => h.key),
    body: $('req-body').value,
  };
}

// Send a stored/snapshotted request (shared by Send and by opening a bookmark).
async function performRequest(reqState, target) {
  const canonUrl = reqState.url;
  if (!canonUrl) { toast('Enter a URL'); return; }
  const method = reqState.method || 'GET';
  const auth = reqState.auth || { type: 'none' };
  const body = reqState.body || '';
  let sendUrl = canonUrl;
  let sendAuth = auth;
  if (auth.type === 'apikey' && auth.addTo === 'query' && auth.header) {
    sendUrl += (sendUrl.includes('?') ? '&' : '?') + encodeURIComponent(auth.header) + '=' + encodeURIComponent(auth.value || '');
    sendAuth = { type: 'none' };
  } else if (auth.type === 'apikey') {
    sendAuth = { type: 'apikey', header: auth.header, token: auth.value };
  }
  const sendHeaders = (reqState.headers || []).filter((h) => h.on !== false && h.key).map((h) => ({ key: h.key, value: h.val }));
  hideUrlModal();
  toast(method + ' ' + canonUrl + ' …', true);
  try {
    const res = await window.oxj.httpRequest({ method, url: sendUrl, auth: sendAuth, headers: sendHeaders, body });
    const t = await openPath(res.file, target);
    if (t) t.origin = reqState; // full request → Edit URL + Copy as cURL
    toast(res.status + ' ' + (res.statusText || '').trim() + ' · ' + res.timeMs + ' ms · ' + humanSize(res.size), res.status >= 200 && res.status < 300);
  } catch (e) {
    toast('Request failed: ' + cleanErr(e));
  }
}

async function sendRequest() {
  const reqState = currentRequestState();
  if (!reqState.url) { toast('Enter a URL'); return; }
  // When editing an existing URL doc, reload into its tab; otherwise a new tab.
  const target = (builderEditTab && tabAlive(builderEditTab)) ? builderEditTab : undefined;
  builderEditTab = null;
  await performRequest(reqState, target);
}

// One-time wiring
$('url-auth').addEventListener('change', updateAuthPanes);
document.querySelectorAll('.req-tab').forEach((b) => b.addEventListener('click', () => showReqTab(b.dataset.tab)));
$('params-add').addEventListener('click', () => { const b = { on: true, key: '', val: '' }; builderParams.push(b); $('params-table').appendChild(makeKvRow($('params-table'), builderParams, b, onParamsChange)); });
$('headers-add').addEventListener('click', () => { const b = { on: true, key: '', val: '' }; builderHeaders.push(b); $('headers-table').appendChild(makeKvRow($('headers-table'), builderHeaders, b, () => {})); });
$('url-input').addEventListener('input', () => {
  if (urlSyncing) return;
  urlSyncing = true;
  builderParams = parseParams($('url-input').value);
  renderKv('params-table', builderParams, onParamsChange);
  urlSyncing = false;
});
$('url-input').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); sendRequest(); } });
$('req-send').addEventListener('click', sendRequest);
$('url-cancel').addEventListener('click', hideUrlModal);
$('url-modal').addEventListener('click', (ev) => { if (ev.target === $('url-modal')) hideUrlModal(); });
$('btn-edit-url').addEventListener('click', () => { if (cur && cur.origin) showUrlModal(cur.origin, cur); });

// ---------- native menu actions ----------
window.oxj.onMenu(async ({ action, arg }) => {
  switch (action) {
    case 'open': {
      const p = await window.oxj.pickFile();
      if (p) openFileWithPrompt(p);
      break;
    }
    case 'open-path':
      if (arg) { if (typeof arg === 'object') openRecent(arg); else openPath(arg); }
      break;
    case 'open-url':
      showUrlModal();
      break;
    case 'bookmarks':
      openUModalTab('bookmarks');
      break;
    case 'activate':
      openLicenseLock(licensed);
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
      if (cur && cur.file) openPath(cur.file, cur, true, cur.forcedFormat ? { format: cur.forcedFormat } : undefined);
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
    case 'find': {
      if (!cur || cur.plain || cur.phase !== 'ready') { toast('Search is not available here'); break; }
      const box = $('search-box');
      box.classList.remove('hidden');
      box.focus();
      box.select();
      break;
    }
    case 'find-next':
      if (matchNav && matchNav.ids.length) gotoMatch(matchNav.cur + 1);
      else if (cur && !cur.plain && cur.phase === 'ready') { $('search-box').focus(); }
      break;
    case 'find-prev':
      if (matchNav && matchNav.ids.length) gotoMatch(matchNav.cur - 1);
      break;
    case 'jump-to-path':
      jumpToPath();
      break;
    case 'copy-row':
      copyRowOrText();
      break;
    case 'copy-curl':
      copyAsCurl();
      break;
    case 'export-doc':
      exportDocAs(cur, arg);
      break;
    case 'export-selection':
      exportSelection(cur, arg);
      break;
    case 'export-matches':
      exportMatches(cur, arg);
      break;
    case 'gen-schema':
      generateSchema();
      break;
    case 'validate-schema':
      validateAgainstSchema();
      break;
    case 'compare-tabs':
      compareTabsFlow();
      break;
    case 'deepdive':
      jsonDeepDive();
      break;
  }
});

// ---------- Search-menu helpers: jump-to-path, copy row, copy as cURL ----------

// Small modal prompt (Electron disables window.prompt). Resolves to the trimmed
// string, or null if cancelled.
function askText(title, placeholder) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'modal';
    const h = document.createElement('div');
    h.className = 'modal-title';
    h.textContent = title;
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = placeholder || '';
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn-secondary';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.className = 'btn-primary';
    ok.textContent = 'Go';
    actions.append(cancel, ok);
    modal.append(h, input, actions);
    back.append(modal);
    document.body.append(back);
    const done = (v) => { back.remove(); resolve(v); };
    ok.onclick = () => done(input.value.trim() || null);
    cancel.onclick = () => done(null);
    back.addEventListener('mousedown', (e) => { if (e.target === back) done(null); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim() || null); }
      else if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    setTimeout(() => input.focus(), 20);
  });
}

// Parse a JSON path like $.a.b[0]["c d"] into segments ({key} | {index}).
function parseJsonPath(p) {
  let s = p.trim();
  if (s[0] === '$') s = s.slice(1);
  const segs = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '.') { i++; continue; }
    if (c === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) return null;
      let inner = s.slice(i + 1, end).trim();
      if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
        const body = inner.slice(1, -1);
        try { segs.push({ key: JSON.parse('"' + body.replace(/"/g, '\\"') + '"') }); }
        catch { segs.push({ key: body }); }
      } else if (/^\d+$/.test(inner)) {
        segs.push({ index: parseInt(inner, 10) });
      } else {
        segs.push({ key: inner });
      }
      i = end + 1;
    } else {
      let j = i;
      while (j < s.length && s[j] !== '.' && s[j] !== '[') j++;
      const name = s.slice(i, j);
      if (name) segs.push({ key: name });
      i = j;
    }
  }
  return segs;
}

// Parse an XML path like /root/item[2]/@id or /root/text().
function parseXmlPath(p) {
  return p.split('/').map((s) => s.trim()).filter(Boolean).map((tok) => {
    if (tok.startsWith('@')) return { attr: tok.slice(1) };
    if (tok === 'text()') return { text: true };
    const m = tok.match(/^(.+?)\[(\d+)\]$/);
    if (m) return { key: m[1], nth: parseInt(m[2], 10) };
    return { key: tok };
  });
}

// Walk from the root to the node identified by one path segment.
async function childMatching(t, parentId, seg, isXml) {
  if (!isXml && 'index' in seg) {
    const res = await window.oxj.query(t.id, { op: 'children', node: parentId, offset: seg.index, limit: 1 });
    return res.items && res.items.length ? res.items[0].id : null;
  }
  const PAGE = 500;
  const nth = seg.nth ? seg.nth - 1 : 0;
  let off = 0, seen = 0;
  for (;;) {
    const res = await window.oxj.query(t.id, { op: 'children', node: parentId, offset: off, limit: PAGE });
    const items = res.items || [];
    for (const c of items) {
      let match;
      if (isXml && seg.attr != null) match = c.kind === 7 && c.name === seg.attr;
      else if (isXml && seg.text) match = c.kind === 8;
      else match = c.name === seg.key;
      if (match) {
        if (seen === nth) return c.id;
        seen++;
      }
    }
    if (items.length < PAGE) break;
    off += PAGE;
  }
  return null;
}

async function resolvePath(t, p, isXml) {
  try {
    const segs = isXml ? parseXmlPath(p) : parseJsonPath(p);
    if (!segs) return null;
    if (!segs.length) return t.rootId; // "$" or "/" -> root
    let curId = t.rootId;
    for (const seg of segs) {
      curId = await childMatching(t, curId, seg, isXml);
      if (curId == null) return null;
    }
    return curId;
  } catch { return null; }
}

async function jumpToPath() {
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) { toast('Open a document first'); return; }
  const isXml = t.docFormat === 'xml';
  const p = await askText('Jump to Path', isXml ? '/root/item/@id' : '$.users[0].name');
  if (!p) return;
  const id = await resolvePath(t, p, isXml);
  if (id == null) { toast('No node found at that path'); return; }
  await revealNode(t, id);
}

// True when a text field / the Source editor is focused, so Cmd+C should do a
// normal text copy rather than "Copy Row".
function isEditableFocus() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return !!(el.closest && el.closest('.monaco-editor'));
}

async function copyRowOrText() {
  if (isEditableFocus()) { try { document.execCommand('copy'); } catch {} return; }
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) return;
  const e = t.visible && t.selectedIdx >= 0 ? t.visible[t.selectedIdx] : null;
  if (!e || e.pseudo) { toast('Select a row first'); return; }
  if (t.docFormat === 'csv' || t.docFormat === 'tsv') await copyCsvRow(t, e);
  else await copyNodeAs(t, e, 'json');
}

async function copyAsCurl() {
  const t = cur;
  if (!t || !t.origin || !t.origin.url) {
    toast('Copy as cURL only works for documents opened from a URL');
    return;
  }
  const { url, auth } = t.origin;
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  let cmd = 'curl ' + q(url);
  if (auth && auth.type === 'basic' && (auth.user || auth.pass)) {
    cmd += ' -u ' + q((auth.user || '') + ':' + (auth.pass || ''));
  } else if (auth && auth.type === 'bearer' && auth.token) {
    cmd += ' -H ' + q('Authorization: Bearer ' + auth.token);
  } else if (auth && auth.type === 'apikey' && auth.token) {
    cmd += ' -H ' + q((auth.header || 'X-API-Key') + ': ' + auth.token);
  }
  await copyText(cmd, 'cURL command');
}

// ---------- Export menu ----------
const EXPORT_BUDGET = 5000000; // node budget for whole-document reconstruction

function exportDocName(t, ext) {
  const b = String(baseName(t.file || 'document')).replace(/\.[^.]+$/, '') || 'document';
  return stampName(b, ext);
}

// Whole document, converted to the requested format.
async function exportDocAs(t, fmt) {
  if (!t || t.phase !== 'ready' || t.plain) { toast('Open a document first'); return; }
  const root = t.visible && t.visible[0];
  if (!root) { toast('Nothing to export'); return; }
  try {
    const text = await convertNode(t, root, fmt, EXPORT_BUDGET);
    const ext = fmt === 'rawjson' ? 'json' : fmt;
    const saved = await window.oxj.saveText(exportDocName(t, ext), text);
    if (saved) toast('Saved ' + baseName(saved), true);
  } catch (err) {
    toast('Export failed: ' + cleanErr(err).replace(/\s*\(raise the budget[^)]*\)/, ' (document too large to export whole)'));
  }
}

// Currently selected node — as pretty JSON, or as its raw text/source.
async function exportSelection(t, kind) {
  if (!t || t.phase !== 'ready' || t.plain) { toast('Open a document first'); return; }
  const e = t.visible && t.selectedIdx >= 0 ? t.visible[t.selectedIdx] : null;
  if (!e || e.pseudo) { toast('Select a node first'); return; }
  try {
    if (kind === 'json') { await exportNodeAs(t, e, 'json'); return; }
    let text;
    if (isScalarKind(e.kind)) text = String(await getScalarValue(t, e));
    else text = (await getSubtree(t, e, EXPORT_BUDGET)).text;
    const saved = await window.oxj.saveText(defaultExportName(e, 'txt'), text);
    if (saved) toast('Saved ' + baseName(saved), true);
  } catch (err) {
    toast('Export failed: ' + cleanErr(err));
  }
}

// Loaded search matches -> JSON array or CSV of {path, name, value}.
async function exportMatches(t, fmt) {
  if (!t || !matchNav || matchNav.tabId !== t.id || !matchNav.ids.length) {
    toast('No search matches to export');
    return;
  }
  const ids = matchNav.ids.slice(0, 5000);
  toast('Collecting ' + ids.length + ' matches…', true);
  const rows = [];
  for (const id of ids) {
    try {
      const [node, pth] = await Promise.all([
        window.oxj.query(t.id, { op: 'node', node: id }),
        window.oxj.query(t.id, { op: 'path', node: id }),
      ]);
      rows.push({ path: pth.path, name: node.name != null ? node.name : null, value: node.value != null ? node.value : null });
    } catch { /* skip a match that can't be read */ }
  }
  let text, ext;
  if (fmt === 'json') {
    text = JSON.stringify(rows, null, 2);
    ext = 'json';
  } else {
    const cell = (v) => csvCell(v == null ? '' : String(v), ',');
    text = ['path,name,value', ...rows.map((r) => [cell(r.path), cell(r.name), cell(r.value)].join(','))].join('\n');
    ext = 'csv';
  }
  const stem = 'matches_' + String(matchNav.q || 'search').replace(/[^\w]+/g, '_').slice(0, 30);
  const saved = await window.oxj.saveText(stampName(stem, ext), text);
  if (saved) {
    toast('Saved ' + baseName(saved) + (matchNav.hasMore ? ' (loaded matches only)' : ''), true);
  }
}

// Tell the main process what the Export menu items should enable against.
function syncMenuState() {
  try {
    const hasDoc = !!(cur && cur.phase === 'ready' && !cur.plain);
    const hasMatches = !!(matchNav && cur && matchNav.tabId === cur.id && matchNav.ids.length);
    const hasTwoDocs = tabs.filter((x) => x.phase === 'ready' && !x.plain).length >= 2;
    window.oxj.setMenuState({ hasDoc, hasMatches, hasTwoDocs });
  } catch { /* ignore */ }
}

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

async function getNodeObj(t, e, budget) {
  if (isScalarKind(e.kind)) {
    const v = await getScalarValue(t, e);
    if (e.kind === K.NUM) { const n = Number(v); return Number.isFinite(n) ? n : v; }
    if (e.kind === K.BOOL) return v === 'true';
    if (e.kind === K.NULL) return null;
    return v;
  }
  const r = await getSubtree(t, e, budget);
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

async function convertNode(t, e, fmt, budget) {
  const obj = await getNodeObj(t, e, budget);
  if (fmt === 'json') return JSON.stringify(obj, null, 2);
  if (fmt === 'rawjson') return JSON.stringify(obj);
  if (fmt === 'yaml') return toYaml(obj);
  if (fmt === 'xml') return exportXml(obj);
  if (fmt === 'csv') return toCsvStr(obj);
  throw new Error('unknown format');
}

// Compact local timestamp (YYYYMMDD_HHMMSS) suffixed to all export filenames.
function timeStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
function stampName(base, ext) {
  const b = String(base).replace(/[^\w.-]+/g, '_').slice(0, 60).replace(/^_+|_+$/g, '') || 'file';
  return b + '_' + timeStamp() + '.' + ext;
}

function defaultExportName(e, ext) {
  return stampName(e.label || 'value', ext);
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

// ============================================================
// JSON DeepDive — pick fields from the schema, project into a new tab
// ============================================================

// Path-segment helpers (array-transparent grammar: items[].price).
function fieldIsIdent(k) { return /^[A-Za-z_$][\w$]*$/.test(k); }
function fieldAppend(prefix, key) {
  if (!prefix) return fieldIsIdent(key) ? key : '[' + JSON.stringify(key) + ']';
  return fieldIsIdent(key) ? prefix + '.' + key : prefix + '[' + JSON.stringify(key) + ']';
}

// Build an array-transparent field tree from a JSON Schema. A root array is the
// record boundary (each element is a record), so paths are relative to a record;
// nested arrays are transparent ("[]"). Returns top-level nodes:
//   { name, path, selectPath, isLeaf, children }
function schemaToFieldTree(schema) {
  let rec = schema;
  while (rec && rec.type === 'array' && rec.items) rec = rec.items; // unwrap root array(s)
  if (!rec || rec.type !== 'object' || !rec.properties) return [];
  const nodeFor = (key, sch, prefix) => {
    const path = fieldAppend(prefix, key);
    let s = sch, p = path;
    while (s && s.type === 'array' && s.items) { p += '[]'; s = s.items; } // nested arrays transparent
    const node = { name: key, path, selectPath: p, children: [] };
    if (s && s.type === 'object' && s.properties) {
      node.children = Object.keys(s.properties).map((k) => nodeFor(k, s.properties[k], p));
      node.isLeaf = false;
    } else {
      node.isLeaf = true;
    }
    return node;
  };
  return Object.keys(rec.properties).map((k) => nodeFor(k, rec.properties[k], ''));
}

// Reference projection (JS) — kept for tests and parity with the Rust core.
// Given a value and selected leaf paths, keep only the selected fields.
function parseFieldPath(p) {
  const segs = [];
  let i = 0;
  while (i < p.length) {
    if (p[i] === '.') { i++; continue; }
    if (p.startsWith('[]', i)) { segs.push({ arr: true }); i += 2; continue; }
    if (p[i] === '[') {
      const end = p.indexOf(']', i);
      let inner = p.slice(i + 1, end);
      try { inner = JSON.parse(inner); } catch { /* leave as-is */ }
      segs.push({ key: String(inner) }); i = end + 1; continue;
    }
    let j = i;
    while (j < p.length && p[j] !== '.' && p[j] !== '[') j++;
    segs.push({ key: p.slice(i, j) }); i = j;
  }
  return segs;
}
function projectValue(value, paths) {
  const specs = paths.map(parseFieldPath);
  const build = (val, segLists) => {
    // segLists: array of remaining-segment arrays that reached this value
    if (segLists.some((s) => s.length === 0)) return val; // a leaf selected here → keep whole
    if (Array.isArray(val)) {
      // consume one array-transparent segment
      const next = segLists.filter((s) => s[0] && s[0].arr).map((s) => s.slice(1));
      if (!next.length) return undefined;
      return val.map((el) => build(el, next)).filter((x) => x !== undefined);
    }
    if (val && typeof val === 'object') {
      const out = {};
      for (const k of Object.keys(val)) {
        const forK = segLists.filter((s) => s[0] && s[0].key === k).map((s) => s.slice(1));
        if (forK.length) {
          const r = build(val[k], forK);
          if (r !== undefined) out[k] = r;
        }
      }
      return out;
    }
    return undefined; // scalar with remaining segments → nothing to keep
  };
  return build(value, specs);
}

async function jsonDeepDive() {
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) { toast('Open a document first'); return; }
  if (t.docFormat !== 'json' && t.docFormat !== 'ndjson') {
    toast('JSON DeepDive supports JSON and NDJSON documents'); return;
  }
  let schemaRes;
  try { toast('Scanning fields…', true); schemaRes = await getDocSchema(t); }
  catch (err) { toast('Could not read fields: ' + cleanErr(err)); return; }
  const tree = schemaToFieldTree(schemaRes.schema);
  if (!tree.length) { toast('No object fields found to extract'); return; }
  const paths = await showFieldPicker(tree, schemaRes.sampled);
  if (!paths || !paths.length) return;
  await runProjection(t, paths);
}

// Checkbox tree picker. Returns selected leaf selectPaths, or null if cancelled.
function showFieldPicker(tree, sampled) {
  return new Promise((resolve) => {
    const nodes = [];
    (function flat(list, depth, parent) {
      for (const n of list) {
        const id = nodes.length;
        nodes.push({ name: n.name, selectPath: n.selectPath, isLeaf: !!n.isLeaf, depth, parent, childIds: [] });
        if (parent >= 0) nodes[parent].childIds.push(id);
        if (n.children && n.children.length) flat(n.children, depth + 1, id);
      }
    })(tree, 0, -1);

    const checked = new Set();
    const expanded = new Set(nodes.map((_, i) => i));
    const setSub = (id, val) => { if (val) checked.add(id); else checked.delete(id); nodes[id].childIds.forEach((c) => setSub(c, val)); };
    const recompute = (id) => { const k = nodes[id].childIds; if (k.length && k.every((c) => checked.has(c))) checked.add(id); else checked.delete(id); };
    const toggle = (id, val) => { setSub(id, val); let p = nodes[id].parent; while (p >= 0) { recompute(p); p = nodes[p].parent; } };
    const someDesc = (id) => nodes[id].childIds.some((c) => checked.has(c) || someDesc(c));
    const leaves = () => { const s = new Set(); nodes.forEach((n, i) => { if (n.isLeaf && checked.has(i)) s.add(n.selectPath); }); return [...s]; };

    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'modal fp-modal';
    box.innerHTML =
      '<div class="modal-title">JSON DeepDive — pick fields</div>' +
      (sampled ? '<div class="fp-note">Fields inferred from a sample of a very large document — rare fields may be missing.</div>' : '') +
      '<input type="search" class="fp-filter" placeholder="Filter fields…" spellcheck="false" />' +
      '<div class="fp-toolbar"><button class="link-btn fp-all">Select all</button>' +
      '<button class="link-btn fp-none">Select none</button><span class="fp-count"></span></div>' +
      '<div class="fp-list"></div>' +
      '<div class="modal-actions"><button class="btn-secondary fp-cancel">Cancel</button>' +
      '<button class="btn-primary fp-ok">Extract to New Tab</button></div>';
    back.appendChild(box);
    document.body.appendChild(back);
    const filter = box.querySelector('.fp-filter');
    const listEl = box.querySelector('.fp-list');
    const countEl = box.querySelector('.fp-count');
    const done = (v) => { back.remove(); resolve(v); };

    const render = () => {
      const q = filter.value.trim().toLowerCase();
      const matches = new Set();
      if (q) nodes.forEach((n, i) => {
        if ((n.name + ' ' + n.selectPath).toLowerCase().includes(q)) { let c = i; while (c >= 0) { matches.add(c); c = nodes[c].parent; } }
      });
      const visible = (i) => {
        if (q) return matches.has(i);
        let p = nodes[i].parent;
        while (p >= 0) { if (!expanded.has(p)) return false; p = nodes[p].parent; }
        return true;
      };
      listEl.innerHTML = '';
      nodes.forEach((n, i) => {
        if (!visible(i)) return;
        const row = document.createElement('div');
        row.className = 'fp-row';
        row.style.paddingLeft = (6 + n.depth * 18) + 'px';
        const tog = document.createElement('span');
        tog.className = 'fp-tog';
        if (n.childIds.length && !q) {
          tog.textContent = expanded.has(i) ? '▾' : '▸';
          tog.onclick = (e) => { e.stopPropagation(); if (expanded.has(i)) expanded.delete(i); else expanded.add(i); render(); };
        }
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked.has(i);
        cb.indeterminate = !checked.has(i) && someDesc(i);
        cb.onclick = (e) => { e.stopPropagation(); toggle(i, cb.checked); render(); };
        const lbl = document.createElement('span');
        lbl.className = 'fp-label' + (n.isLeaf ? ' leaf' : '');
        lbl.textContent = n.name;
        lbl.title = n.selectPath;
        row.append(tog, cb, lbl);
        row.onclick = () => { toggle(i, !checked.has(i)); render(); };
        listEl.appendChild(row);
      });
      countEl.textContent = leaves().length + ' field(s) selected';
    };

    filter.addEventListener('input', render);
    box.querySelector('.fp-all').onclick = () => { nodes.forEach((_, i) => checked.add(i)); render(); };
    box.querySelector('.fp-none').onclick = () => { checked.clear(); render(); };
    box.querySelector('.fp-cancel').onclick = () => done(null);
    box.querySelector('.fp-ok').onclick = () => { const p = leaves(); if (!p.length) { toast('Select at least one field'); return; } done(p); };
    back.addEventListener('mousedown', (e) => { if (e.target === back) done(null); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { done(null); document.removeEventListener('keydown', esc); } });
    render();
    setTimeout(() => filter.focus(), 20);
  });
}

function showProjectionProgress() {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  const box = document.createElement('div');
  box.className = 'modal';
  box.innerHTML =
    '<div class="modal-title">Building projection…</div>' +
    '<div class="bar-outer"><div class="bar-inner pp-bar" style="width:0%"></div></div>' +
    '<div class="pp-stat"></div>' +
    '<div class="modal-actions"><button class="btn-secondary pp-cancel">Cancel</button></div>';
  back.appendChild(box);
  document.body.appendChild(back);
  const bar = box.querySelector('.pp-bar');
  const stat = box.querySelector('.pp-stat');
  return {
    update(done, total) {
      if (total) { bar.style.width = Math.min(100, 100 * done / total) + '%'; stat.textContent = fmtInt(done) + ' / ' + fmtInt(total) + ' records'; }
      else { bar.classList.add('indeterminate'); stat.textContent = fmtInt(done) + ' records'; }
    },
    onCancel(cb) { box.querySelector('.pp-cancel').onclick = cb; },
    close() { back.remove(); },
  };
}

async function runProjection(t, paths) {
  const prog = showProjectionProgress();
  let cancelled = false;
  prog.onCancel(() => { cancelled = true; window.oxj.cancelProject(); prog.close(); });
  const off = window.oxj.onProjectProgress((m) => {
    if (m && (m.event === 'progress' || m.event === 'start')) prog.update(m.done || 0, m.total);
  });
  try {
    const res = await window.oxj.project({ file: t.file, format: t.docFormat, paths });
    off(); prog.close();
    if (cancelled) return;
    const nt = newTab(true);
    if (nt) openPath(res.out, nt);
    toast('Kept ' + (res.kept != null ? res.kept : paths.length) + ' field(s)', true);
  } catch (err) {
    off(); prog.close();
    if (cancelled) return;
    const msg = cleanErr(err);
    if (msg.includes('rebuild') || msg.includes('unsupported')) toast('JSON DeepDive needs an engine rebuild (npm run build:engine), then restart');
    else toast('DeepDive failed: ' + msg);
  }
}

// ============================================================
// Compare two open documents — structural diff + styled report
// ============================================================
function htmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function compareTabsFlow() {
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) { toast('Open a document first'); return; }
  const others = tabs.filter((x) => x !== t && x.phase === 'ready' && !x.plain);
  if (!others.length) { toast('Open another document in a second tab to compare'); return; }
  const { box, back } = simpleModal('Compare "' + t.title + '" with…');
  const counts = {};
  others.forEach((o) => { counts[o.title] = (counts[o.title] || 0) + 1; });

  // A filter box appears when there are many tabs, so a long list stays usable.
  let filter = null;
  if (others.length > 6) {
    filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'picker-filter';
    filter.placeholder = 'Filter tabs…';
    filter.spellcheck = false;
    box.appendChild(filter);
  }

  // The list itself scrolls once it exceeds its max height.
  const list = document.createElement('div');
  list.className = 'picker-list';
  const rowEls = [];
  for (const o of others) {
    const row = document.createElement('div');
    row.className = 'recent-item';
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = o.title;
    // Disambiguate duplicate tab names by showing the path.
    if (counts[o.title] > 1 && o.file) {
      const sub = document.createElement('span');
      sub.className = 'recent-path';
      sub.textContent = o.file;
      name.appendChild(sub);
    }
    name.title = o.file || '';
    row.appendChild(name);
    row.addEventListener('click', async () => { back.remove(); await runCompare(t, o); });
    row._hay = (o.title + ' ' + (o.file || '')).toLowerCase();
    rowEls.push(row);
    list.appendChild(row);
  }
  box.appendChild(list);

  if (filter) {
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      for (const r of rowEls) r.style.display = (!q || r._hay.includes(q)) ? '' : 'none';
    });
    // Enter selects the only visible match, for quick keyboard use.
    filter.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      const shown = rowEls.filter((r) => r.style.display !== 'none');
      if (shown.length === 1) shown[0].click();
    });
    setTimeout(() => filter.focus(), 20);
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

async function runCompare(a, b) {
  try {
    toast('Comparing…', true);
    let res;
    try {
      res = await window.oxj.diffTabs(a.id, b.id); // Rust core (database mode)
    } catch (err) {
      if (!isMemoryModeErr(cleanErr(err))) throw err;
      // Memory mode: reconstruct both documents and diff in the renderer.
      const [av, bv] = await Promise.all([reconstructDoc(a), reconstructDoc(b)]);
      res = jsDiff(av, bv);
    }
    const model = buildDiffModel(a, b, res);
    if (!model.summary.total) { toast('Documents are structurally identical ✓', true); return; }
    showDiffReport(model);
  } catch (err) {
    const msg = cleanErr(err);
    if (msg.includes('doc-too-large-for-memory-tool')) toast('A document is too large to compare in memory mode; reopen via Engine Mode → Always Database');
    else toast('Compare failed: ' + msg);
  }
}

// Structural diff in JS (memory-mode fallback), mirroring the Rust core:
// arrays position-based (element i vs i; tail added/removed), objects key-based,
// a JSON-type change counts as Changed. Paths use the $.a[0].b grammar.
function jsDiff(a, b, limit) {
  limit = limit || 5000;
  const entries = [];
  let added = 0, removed = 0, changed = 0, truncated = false;
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const show = (v) => (v === undefined ? '' : (v !== null && typeof v === 'object') ? JSON.stringify(v).slice(0, 400) : String(v));
  const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? '.' + k : '[' + JSON.stringify(k) + ']');
  const push = (op, path, av, bv) => {
    if (entries.length >= limit) { truncated = true; return; }
    entries.push({ op, path, a: show(av), b: show(bv) });
  };
  const walk = (x, y, path) => {
    if (truncated) return;
    const tx = typeOf(x), ty = typeOf(y);
    if (tx !== ty) { changed++; push('changed', path, x, y); return; }
    if (tx === 'object') {
      for (const k of Object.keys(x)) {
        const cp = path + key(k);
        if (Object.prototype.hasOwnProperty.call(y, k)) walk(x[k], y[k], cp);
        else { removed++; push('removed', cp, x[k], undefined); }
      }
      for (const k of Object.keys(y)) {
        if (!Object.prototype.hasOwnProperty.call(x, k)) { added++; push('added', path + key(k), undefined, y[k]); }
      }
    } else if (tx === 'array') {
      const n = Math.min(x.length, y.length);
      for (let i = 0; i < n; i++) walk(x[i], y[i], path + '[' + i + ']');
      for (let i = n; i < x.length; i++) { removed++; push('removed', path + '[' + i + ']', x[i], undefined); }
      for (let i = n; i < y.length; i++) { added++; push('added', path + '[' + i + ']', undefined, y[i]); }
    } else if (x !== y) {
      changed++; push('changed', path, x, y);
    }
  };
  walk(a, b, '$');
  return { added, removed, changed, truncated, entries };
}

function buildDiffModel(a, b, res) {
  const rows = (res.entries || []).map((e) => ({
    kind: e.op === 'added' ? 'Added' : e.op === 'removed' ? 'Removed' : 'Changed',
    path: e.path,
    left: e.a == null ? '' : String(e.a),
    right: e.b == null ? '' : String(e.b),
  }));
  const added = Number(res.added) || 0;
  const removed = Number(res.removed) || 0;
  const changed = Number(res.changed) || 0;
  return {
    aName: baseName(a.file || a.title),
    bName: baseName(b.file || b.title),
    aPath: a.file || a.title,
    bPath: b.file || b.title,
    ts: new Date().toISOString().replace('T', ' ').slice(0, 19),
    summary: { added, removed, changed, total: added + removed + changed, truncated: !!res.truncated },
    rows,
  };
}

const DIFF_KIND_CLS = { Added: 'r-add', Removed: 'r-rem', Changed: 'r-chg' };

function showDiffReport(model) {
  const overlay = document.createElement('div');
  overlay.className = 'diff-overlay';
  const page = document.createElement('div');
  page.className = 'diff-report';
  overlay.appendChild(page);

  const head = document.createElement('div');
  head.className = 'diff-head';
  head.innerHTML =
    '<button class="diff-x" title="Close">✕</button>' +
    '<div class="diff-title">Structural Document Comparison</div>' +
    '<div class="diff-files"><span title="' + htmlEsc(model.aPath) + '">A: ' + htmlEsc(model.aName) + '</span>' +
    '<span title="' + htmlEsc(model.bPath) + '">B: ' + htmlEsc(model.bName) + '</span></div>' +
    '<div class="diff-ts">Generated ' + htmlEsc(model.ts) +
    (model.summary.truncated ? ' · truncated at 5000 changes' : '') + '</div>';
  head.querySelector('.diff-x').addEventListener('click', () => overlay.remove());
  page.appendChild(head);

  const bar = document.createElement('div');
  bar.className = 'diff-bar';
  const saveWrap = document.createElement('div');
  saveWrap.className = 'diff-saveas';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-tool';
  saveBtn.textContent = 'Save As ▾';
  const saveMenu = document.createElement('div');
  saveMenu.className = 'diff-saveas-menu hidden';
  [['HTML', 'html'], ['Text', 'txt'], ['JSON', 'json'], ['CSV', 'csv']].forEach(([label, fmt]) => {
    const it = document.createElement('button');
    it.className = 'diff-saveas-item';
    it.textContent = label;
    it.addEventListener('click', async () => { saveMenu.classList.add('hidden'); await saveDiff(model, fmt); });
    saveMenu.appendChild(it);
  });
  saveBtn.addEventListener('click', (e) => { e.stopPropagation(); saveMenu.classList.toggle('hidden'); });
  saveWrap.append(saveBtn, saveMenu);
  const openBtn = document.createElement('button');
  openBtn.className = 'btn-tool';
  openBtn.textContent = 'Open in Browser';
  openBtn.addEventListener('click', async () => {
    try { await window.oxj.openHtmlInBrowser(diffToHtml(model)); }
    catch (err) { toast(cleanErr(err)); }
  });
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-tool';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => overlay.remove());
  bar.append(saveWrap, openBtn, closeBtn);
  page.appendChild(bar);

  const cards = document.createElement('div');
  cards.className = 'diff-cards';
  const card = (label, val, cls) =>
    '<div class="diff-card ' + (cls || '') + '"><div class="diff-card-n">' + fmtInt(val) +
    '</div><div class="diff-card-l">' + label + '</div></div>';
  cards.innerHTML = card('Total', model.summary.total) + card('Added', model.summary.added, 'c-add') +
    card('Removed', model.summary.removed, 'c-rem') + card('Changed', model.summary.changed, 'c-chg');
  page.appendChild(cards);

  // "By type" breakdown: a proportional bar.
  const tot = model.summary.total || 1;
  const bd = document.createElement('div');
  bd.className = 'diff-breakdown';
  bd.innerHTML =
    '<div class="seg s-add" style="width:' + (100 * model.summary.added / tot) + '%"></div>' +
    '<div class="seg s-rem" style="width:' + (100 * model.summary.removed / tot) + '%"></div>' +
    '<div class="seg s-chg" style="width:' + (100 * model.summary.changed / tot) + '%"></div>';
  page.appendChild(bd);

  const tableWrap = document.createElement('div');
  tableWrap.className = 'diff-tablewrap';
  page.appendChild(tableWrap);
  renderDiffTable(tableWrap, model.rows);

  overlay.addEventListener('click', (e) => {
    saveMenu.classList.add('hidden');
    if (e.target === overlay) overlay.remove();
  });
  const onEsc = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEsc); } };
  document.addEventListener('keydown', onEsc);
  document.body.appendChild(overlay);
}

// Header + rows. Small diffs render fully (cells wrap); large diffs virtualize
// with a fixed row height (cells clip, full value on hover).
function renderDiffTable(wrap, rows) {
  const header =
    '<div class="diff-tr diff-th"><div class="diff-td c-kind">Change</div>' +
    '<div class="diff-td c-path">Path</div><div class="diff-td c-val">Left (A)</div>' +
    '<div class="diff-td c-val">Right (B)</div></div>';
  if (rows.length <= 600) {
    let html = '<div class="diff-table">' + header;
    for (const r of rows) {
      html += '<div class="diff-tr ' + DIFF_KIND_CLS[r.kind] + '"><div class="diff-td c-kind">' + r.kind +
        '</div><div class="diff-td c-path">' + htmlEsc(r.path) + '</div><div class="diff-td c-val">' +
        htmlEsc(r.left) + '</div><div class="diff-td c-val">' + htmlEsc(r.right) + '</div></div>';
    }
    wrap.innerHTML = html + '</div>';
    return;
  }
  const ROW = 30;
  wrap.innerHTML = '<div class="diff-table virt">' + header +
    '<div class="diff-vport"><div class="diff-spacer"></div><div class="diff-rows"></div></div></div>';
  const vport = wrap.querySelector('.diff-vport');
  wrap.querySelector('.diff-spacer').style.height = (rows.length * ROW) + 'px';
  const rowsEl = wrap.querySelector('.diff-rows');
  const draw = () => {
    const top = vport.scrollTop;
    const h = vport.clientHeight || 420;
    const start = Math.max(0, Math.floor(top / ROW) - 6);
    const end = Math.min(rows.length, Math.ceil((top + h) / ROW) + 6);
    let html = '';
    for (let i = start; i < end; i++) {
      const r = rows[i];
      html += '<div class="diff-tr virt-row ' + DIFF_KIND_CLS[r.kind] + '" style="top:' + (i * ROW) +
        'px;height:' + ROW + 'px"><div class="diff-td c-kind">' + r.kind +
        '</div><div class="diff-td c-path" title="' + htmlEsc(r.path) + '">' + htmlEsc(r.path) +
        '</div><div class="diff-td c-val" title="' + htmlEsc(r.left) + '">' + htmlEsc(r.left) +
        '</div><div class="diff-td c-val" title="' + htmlEsc(r.right) + '">' + htmlEsc(r.right) + '</div></div>';
    }
    rowsEl.innerHTML = html;
  };
  vport.addEventListener('scroll', draw);
  setTimeout(draw, 0);
}

async function saveDiff(model, fmt) {
  const map = { html: diffToHtml, txt: diffToTxt, json: diffToJson, csv: diffToCsv };
  try {
    const text = map[fmt](model);
    const saved = await window.oxj.saveText(stampName('diff_report', fmt), text);
    if (saved) toast('Saved ' + baseName(saved), true);
  } catch (err) { toast('Export failed: ' + cleanErr(err)); }
}

// ---- Pure diff serializers (self-contained, HTML-escaped) ----
function diffToTxt(m) {
  const L = ['NARIKJSON — Structural Document Comparison', 'A: ' + m.aName, 'B: ' + m.bName, 'Generated: ' + m.ts, '',
    'Total: ' + m.summary.total + '  Added: ' + m.summary.added + '  Removed: ' + m.summary.removed +
    '  Changed: ' + m.summary.changed + (m.summary.truncated ? '  (truncated)' : ''), ''];
  for (const r of m.rows) {
    if (r.kind === 'Changed') L.push('[changed] ' + r.path + ': ' + r.left + ' -> ' + r.right);
    else if (r.kind === 'Added') L.push('[added]   ' + r.path + ' = ' + r.right);
    else L.push('[removed] ' + r.path + ' (was ' + r.left + ')');
  }
  return L.join('\n');
}

function diffToJson(m) {
  return JSON.stringify({
    a: m.aName, b: m.bName, generated: m.ts, summary: m.summary,
    changes: m.rows.map((r) => ({ kind: r.kind, path: r.path, left: r.left, right: r.right })),
  }, null, 2);
}

function diffToCsv(m) {
  const cell = (v) => csvCell(v == null ? '' : String(v), ',');
  const lines = ['kind,path,left,right'];
  for (const r of m.rows) lines.push([cell(r.kind), cell(r.path), cell(r.left), cell(r.right)].join(','));
  return lines.join('\n');
}

function diffToHtml(m) {
  const e = htmlEsc;
  const cls = { Added: 'add', Removed: 'rem', Changed: 'chg' };
  const rows = m.rows.map((r) =>
    '<tr class="' + cls[r.kind] + '"><td>' + r.kind + '</td><td class="p">' + e(r.path) +
    '</td><td>' + e(r.left) + '</td><td>' + e(r.right) + '</td></tr>').join('');
  return '<!doctype html><html><head><meta charset="utf-8"><title>NARIKJSON — Structural Document Comparison</title><style>' +
    'body{font:14px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1a1a1a;background:#fff;margin:0;padding:24px}' +
    'h1{font-size:18px;margin:0 0 4px}.files{color:#555;font-size:13px}.files span{margin-right:18px}' +
    '.ts{color:#888;font-size:12px;margin:2px 0 16px}' +
    '.cards{display:flex;gap:12px;margin-bottom:18px}.card{flex:1;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px}' +
    '.card .n{font-size:22px;font-weight:600}.card .l{color:#666;font-size:11px;text-transform:uppercase;letter-spacing:.04em}' +
    '.card.add{background:#f0fdf4}.card.rem{background:#fff1f2}.card.chg{background:#eff6ff}' +
    'table{width:100%;border-collapse:collapse;font-size:13px}' +
    'th{position:sticky;top:0;background:#f8fafc;text-align:left;padding:8px;border-bottom:2px solid #e5e7eb}' +
    'td{padding:6px 8px;border-bottom:1px solid #f0f0f0;vertical-align:top;word-break:break-word}' +
    'td.p{font-family:ui-monospace,Menlo,monospace;white-space:nowrap}' +
    'tr.add{background:#f0fdf4}tr.rem{background:#fff1f2}tr.chg{background:#eff6ff}' +
    '</style></head><body>' +
    '<h1>Structural Document Comparison</h1>' +
    '<div class="files"><span>A: ' + e(m.aName) + '</span><span>B: ' + e(m.bName) + '</span></div>' +
    '<div class="ts">Generated ' + e(m.ts) + (m.summary.truncated ? ' · truncated at 5000 changes' : '') + '</div>' +
    '<div class="cards"><div class="card"><div class="n">' + m.summary.total + '</div><div class="l">Total</div></div>' +
    '<div class="card add"><div class="n">' + m.summary.added + '</div><div class="l">Added</div></div>' +
    '<div class="card rem"><div class="n">' + m.summary.removed + '</div><div class="l">Removed</div></div>' +
    '<div class="card chg"><div class="n">' + m.summary.changed + '</div><div class="l">Changed</div></div></div>' +
    '<table><thead><tr><th>Change</th><th>Path</th><th>Left (A)</th><th>Right (B)</th></tr></thead><tbody>' +
    rows + '</tbody></table></body></html>';
}

// The in-memory engine doesn't implement schema/validate, so it returns this.
function isMemoryModeErr(m) { return String(m || '').includes('database mode'); }

// Reconstruct the whole document into a JS value (used by the validate
// fallback). The in-memory subtree op clamps its budget and returns a
// truncated preview past that, so detect truncation and fail cleanly rather
// than trying to JSON.parse an ellipsis marker.
async function reconstructDoc(t) {
  const root = t.visible[0];
  if (isScalarKind(root.kind)) return getNodeObj(t, root);
  const r = await getSubtree(t, root, 300000);
  if (r.truncated) throw new Error('doc-too-large-for-memory-tool');
  return r.language === 'json' ? JSON.parse(r.text) : xmlTextToObj(r.text);
}

// Get the document's JSON Schema: engine op in database mode, or a structural
// tree-walk in memory mode. Returns { schema, sampled }. Shared by Generate
// Schema and JSON DeepDive.
async function getDocSchema(t) {
  try {
    const res = await window.oxj.query(t.id, { op: 'schema', node: t.rootId });
    return { schema: res.schema, sampled: !!res.sampled };
  } catch (err) {
    if (!isMemoryModeErr(cleanErr(err))) throw err;
    const root = t.visible[0];
    const budget = { n: 200000 };
    const inferred = await inferSchemaFromTree(t, { id: root.id, kind: root.kind, n: root.n, value: root.value }, budget);
    return { schema: { '$schema': 'http://json-schema.org/draft-07/schema#', ...inferred }, sampled: budget.n <= 0 };
  }
}

async function generateSchema() {
  const t = cur;
  if (!t || t.phase !== 'ready' || t.plain) return;
  if (t.docFormat === 'xml') { toast('JSON Schema generation supports JSON, NDJSON and CSV documents'); return; }
  try {
    toast('Generating schema…', true);
    const { schema, sampled } = await getDocSchema(t);
    const text = JSON.stringify(schema, null, 2);
    await openTextAsTab(baseName(t.file).replace(/\.[^.]+$/, '') + '_schema', 'json', text);
    if (sampled) toast('Schema inferred from a sample of a very large document', true);
  } catch (err) {
    const msg = cleanErr(err);
    if (msg.includes('unknown op')) toast('This tool needs an engine rebuild: npm run build:engine, then restart');
    else if (isMemoryModeErr(msg)) toast('Document too large to build a schema in memory mode; reopen via Engine Mode → Always Database');
    else toast('Schema generation failed: ' + msg);
  }
}

// Infer a draft-07 schema by walking the node tree (no full reconstruction, so
// no truncation). Arrays are sampled; `budget.n` caps total nodes visited and,
// when exhausted, marks the result as sampled.
async function inferSchemaFromTree(t, node, budget) {
  const k = node.kind;
  if (k === K.STR || k === K.ATTR || k === K.TEXT) return { type: 'string' };
  if (k === K.BOOL) return { type: 'boolean' };
  if (k === K.NULL) return { type: 'null' };
  if (k === K.NUM) {
    const s = String(node.value == null ? '' : node.value);
    return { type: /^[+-]?\d+$/.test(s) ? 'integer' : 'number' };
  }
  if (k === K.ARR) {
    if (!node.n || budget.n <= 0) return { type: 'array' };
    const SAMPLE = 500;
    const res = await window.oxj.query(t.id, { op: 'children', node: node.id, offset: 0, limit: Math.min(SAMPLE, Number(node.n)) });
    const subs = [];
    for (const c of (res.items || [])) {
      if (budget.n <= 0) break;
      budget.n -= 1;
      subs.push(await inferSchemaFromTree(t, c, budget));
    }
    return subs.length ? { type: 'array', items: mergeSchemas(subs) } : { type: 'array' };
  }
  if (k === K.OBJ || k === K.ELEM) {
    const properties = {};
    const required = [];
    let off = 0;
    const PAGE = 500;
    for (;;) {
      if (budget.n <= 0) break;
      const res = await window.oxj.query(t.id, { op: 'children', node: node.id, offset: off, limit: PAGE });
      const items = res.items || [];
      for (const c of items) {
        if (budget.n <= 0) break;
        budget.n -= 1;
        if (c.name == null) continue;
        properties[c.name] = await inferSchemaFromTree(t, c, budget);
        required.push(c.name);
      }
      if (items.length < PAGE) break;
      off += PAGE;
    }
    const s = { type: 'object', properties };
    if (required.length) s.required = required;
    return s;
  }
  return {};
}

// ---- JSON Schema inference (draft-07), renderer fallback for memory mode ----
function inferJsonSchema(v) {
  if (v === null) return { type: 'null' };
  if (Array.isArray(v)) {
    if (!v.length) return { type: 'array' };
    return { type: 'array', items: mergeSchemas(v.map(inferJsonSchema)) };
  }
  const t = typeof v;
  if (t === 'string') return { type: 'string' };
  if (t === 'number') return { type: Number.isInteger(v) ? 'integer' : 'number' };
  if (t === 'boolean') return { type: 'boolean' };
  if (t === 'object') {
    const properties = {};
    const required = [];
    for (const k of Object.keys(v)) { properties[k] = inferJsonSchema(v[k]); required.push(k); }
    const s = { type: 'object', properties };
    if (required.length) s.required = required;
    return s;
  }
  return {};
}

function mergeSchemas(list) {
  if (list.length === 1) return list[0];
  const types = new Set(list.map((s) => s.type));
  if (types.size === 1 && list[0].type === 'object') {
    const keys = new Set();
    list.forEach((s) => Object.keys(s.properties || {}).forEach((k) => keys.add(k)));
    const properties = {};
    const required = [];
    for (const k of keys) {
      const subs = list.filter((s) => s.properties && s.properties[k]).map((s) => s.properties[k]);
      properties[k] = mergeSchemas(subs);
      if (list.every((s) => s.properties && s.properties[k])) required.push(k);
    }
    const s = { type: 'object', properties };
    if (required.length) s.required = required;
    return s;
  }
  if (types.size === 1 && list[0].type === 'array') {
    const items = list.map((s) => s.items).filter(Boolean);
    return items.length ? { type: 'array', items: mergeSchemas(items) } : { type: 'array' };
  }
  if (types.size === 1) return { type: list[0].type };
  // integer is a refinement of number
  if (types.size === 2 && types.has('integer') && types.has('number')) return { type: 'number' };
  return { type: Array.from(types) };
}

// ---- Minimal draft-07 validator, renderer fallback for memory mode ----
function jsValidate(value, schema) {
  const errors = [];
  const MAX = 1000;
  const typeOf = (v) => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    const t = typeof v;
    if (t === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    return t;
  };
  const check = (v, sch, path) => {
    if (errors.length >= MAX || !sch || typeof sch !== 'object') return;
    if (sch.type) {
      const types = Array.isArray(sch.type) ? sch.type : [sch.type];
      const vt = typeOf(v);
      const ok = types.some((tt) => tt === vt || (tt === 'number' && vt === 'integer'));
      if (!ok) { errors.push({ path, message: 'expected type ' + types.join('|') + ', got ' + vt }); return; }
    }
    if (sch.enum && !sch.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) {
      errors.push({ path, message: 'value not in enum' });
    }
    if (typeof v === 'number') {
      if (sch.minimum != null && v < sch.minimum) errors.push({ path, message: 'below minimum ' + sch.minimum });
      if (sch.maximum != null && v > sch.maximum) errors.push({ path, message: 'above maximum ' + sch.maximum });
      if (sch.exclusiveMinimum != null && v <= sch.exclusiveMinimum) errors.push({ path, message: 'not above exclusiveMinimum ' + sch.exclusiveMinimum });
      if (sch.exclusiveMaximum != null && v >= sch.exclusiveMaximum) errors.push({ path, message: 'not below exclusiveMaximum ' + sch.exclusiveMaximum });
      if (sch.multipleOf && v % sch.multipleOf !== 0) errors.push({ path, message: 'not a multiple of ' + sch.multipleOf });
    }
    if (typeof v === 'string') {
      if (sch.minLength != null && v.length < sch.minLength) errors.push({ path, message: 'shorter than minLength ' + sch.minLength });
      if (sch.maxLength != null && v.length > sch.maxLength) errors.push({ path, message: 'longer than maxLength ' + sch.maxLength });
      if (sch.pattern) { try { if (!new RegExp(sch.pattern).test(v)) errors.push({ path, message: 'does not match pattern' }); } catch { /* bad regex */ } }
    }
    if (Array.isArray(v)) {
      if (sch.minItems != null && v.length < sch.minItems) errors.push({ path, message: 'fewer than minItems ' + sch.minItems });
      if (sch.maxItems != null && v.length > sch.maxItems) errors.push({ path, message: 'more than maxItems ' + sch.maxItems });
      if (sch.items) {
        if (Array.isArray(sch.items)) sch.items.forEach((it, i) => { if (v[i] !== undefined) check(v[i], it, path + '[' + i + ']'); });
        else v.forEach((el, i) => check(el, sch.items, path + '[' + i + ']'));
      }
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (Array.isArray(sch.required)) for (const r of sch.required) if (!(r in v)) errors.push({ path: path + '.' + r, message: 'missing required property' });
      if (sch.properties) for (const k of Object.keys(sch.properties)) if (k in v) check(v[k], sch.properties[k], path + '.' + k);
      if (sch.additionalProperties === false && sch.properties) {
        for (const k of Object.keys(v)) if (!(k in sch.properties)) errors.push({ path: path + '.' + k, message: 'additional property not allowed' });
      }
    }
  };
  check(value, schema, '$');
  return { count: errors.length, truncated: errors.length >= MAX, errors };
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
    let res;
    try {
      res = await window.oxj.query(t.id, { op: 'validate', schema, node: t.rootId });
    } catch (err) {
      if (!isMemoryModeErr(cleanErr(err))) throw err;
      res = jsValidate(await reconstructDoc(t), schema); // memory-mode fallback
    }
    if (!res.count) {
      toast('Valid — no schema violations found ✓', true);
      return;
    }
    showValidationReport(t, p, res);
  } catch (err) {
    const msg = cleanErr(err);
    if (msg.includes('unknown op')) toast('This tool needs an engine rebuild: npm run build:engine, then restart');
    else if (isMemoryModeErr(msg) || msg.includes('doc-too-large-for-memory-tool')) toast('This document is too large to validate in memory mode; reopen via Engine Mode → Always Database');
    else toast('Validation failed: ' + msg);
  }
}

function showValidationReport(t, p, res) {
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
      'NARIKJSON schema validation report\nDocument: ' + t.file + '\nSchema: ' + p +
      '\nErrors: ' + res.count + (res.truncated ? '+ (truncated)' : '') + '\n\n' +
      res.errors.map((e) => e.path + '\t' + e.message).join('\n');
    const saved = await window.oxj.saveText(stampName('validation_report', 'txt'), report);
    if (saved) toast('Saved ' + baseName(saved), true);
  });
  const close = document.createElement('button');
  close.className = 'btn-secondary';
  close.textContent = 'Close';
  close.addEventListener('click', () => back.remove());
  actions.append(save, close);
  box.appendChild(actions);
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
          'NARIKJSON comparison report',
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
  // jq runs on the source file, so it works in any engine mode. The schema /
  // compare tools use the database engine and aren't available in RAM mode.
  const memMode = t.meta && t.meta.mode === 'memory';
  const items = [{ label: 'jq Filter…', action: () => openJqModal(cur) }];
  if (!memMode) {
    items.push(
      { sep: true },
      { label: 'Generate JSON Schema', action: generateSchema },
      { label: 'Validate Against JSON Schema…', action: validateAgainstSchema },
      { sep: true },
      { label: 'Compare With Open Tab…', action: compareWithTab },
    );
  }
  showContextMenu(r.left, r.bottom + 4, items);
});

// ---------- jq filter (system jq, result in a new tab) ----------
async function openJqModal(t) {
  if (!t || t.phase !== 'ready' || !t.file) { toast('Open a JSON file first.'); return; }
  const { back, box } = simpleModal('jq Filter');
  box.classList.add('jq-modal');

  const banner = document.createElement('div');
  banner.className = 'jq-banner hidden';
  box.appendChild(banner);

  const lbl = document.createElement('div'); lbl.className = 'jq-lbl'; lbl.textContent = 'Filter';
  const ta = document.createElement('textarea');
  ta.className = 'jq-filter'; ta.spellcheck = false;
  ta.placeholder = 'e.g.  .items[] | {name, price}';
  ta.value = t.jqLast || '.';
  box.append(lbl, ta);

  const opts = document.createElement('div'); opts.className = 'jq-opts';
  const mkOpt = (key, label, title) => {
    const l = document.createElement('label'); l.className = 'jq-opt'; l.title = title || '';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.dataset.k = key;
    const s = document.createElement('span'); s.textContent = label;
    l.append(cb, s); opts.appendChild(l); return cb;
  };
  const rawCb = mkOpt('raw', 'Raw output (-r)', 'Emit raw strings instead of JSON-quoted values');
  const compactCb = mkOpt('compact', 'Compact (-c)', 'One compact JSON value per line');
  const slurpCb = mkOpt('slurp', 'Slurp (-s)', 'Read the entire input into a single array');
  const sortCb = mkOpt('sortKeys', 'Sort keys (-S)', 'Sort object keys in the output');
  box.appendChild(opts);

  const hint = document.createElement('div'); hint.className = 'jq-hint';
  hint.textContent = 'Runs jq on this file; the result opens in a new tab. jq reads the whole file into memory, so very large files may be slow.';
  box.appendChild(hint);

  const actions = document.createElement('div'); actions.className = 'modal-actions';
  const cancel = document.createElement('button'); cancel.className = 'btn-secondary'; cancel.textContent = 'Cancel'; cancel.onclick = () => back.remove();
  const run = document.createElement('button'); run.className = 'btn-primary'; run.textContent = 'Run';
  actions.append(cancel, run); box.appendChild(actions);

  let avail = { available: false };
  try { avail = await window.oxj.jqAvailable(); } catch {}
  if (!avail.available) {
    banner.classList.remove('hidden');
    banner.innerHTML = 'jq is not installed. Install it with <code>brew install jq</code> (macOS), then reopen this dialog.';
    run.disabled = true; ta.disabled = true;
  }

  const doRun = async () => {
    const filter = ta.value.trim();
    if (!filter) { ta.focus(); return; }
    t.jqLast = filter;
    banner.classList.remove('jq-error');
    run.disabled = true; run.textContent = 'Running…';
    const flags = { raw: rawCb.checked, compact: compactCb.checked, slurp: slurpCb.checked, sortKeys: sortCb.checked };
    try {
      const res = await window.oxj.jqRun(t.id, filter, flags);
      const text = res && res.text != null ? res.text : '';
      if (!text.trim()) { toast('jq produced no output.'); run.disabled = false; run.textContent = 'Run'; return; }
      back.remove();
      openTextAsTab('jq_result', flags.raw ? 'txt' : 'json', text);
    } catch (e) {
      banner.classList.remove('hidden'); banner.classList.add('jq-error');
      banner.textContent = 'jq error: ' + cleanErr(e);
      run.disabled = false; run.textContent = 'Run';
    }
  };
  run.onclick = doRun;
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); doRun(); }
  });
  setTimeout(() => ta.focus(), 30);
}

// ---------- theme ----------
function applyTheme(eff) {
  uiTheme = eff;
  document.body.classList.toggle('light', eff === 'light');
  if (monacoReady && window.monaco) {
    window.monaco.editor.setTheme(monacoThemeName(eff));
  }
}
window.oxj.onTheme((eff) => applyTheme(eff));

// ---------- licensing / activation ----------
let licensed = false;
const EXPIRY_NUDGE_DAYS = 14;
function setLicError(msg) { $('lic-error').textContent = msg || ''; }
function editionValidity(expiresAt) { return expiresAt ? 'until ' + String(expiresAt).slice(0, 10) : 'Lifetime'; }
function daysUntil(expiresAt) {
  if (!expiresAt) return Infinity; // lifetime
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) ? Math.ceil((t - Date.now()) / 86400000) : Infinity;
}
function showEdition(on) {
  licensed = !!on;
  refreshMembership(); // the Membership card is now the sole license display
  refreshEngineMode(); // Engine Mode card lives in the same left column
  const fw = $('formats-wrap'); // Supported Files card, same left column
  if (fw) fw.classList.toggle('hidden', !on);
}

// Engine Mode card — shows the active engine and lets the user switch it.
const ENGINE_DESC = {
  auto: 'Picks the in-RAM engine for files that fit in memory, and the database engine for anything larger.',
  memory: 'Always loads into the in-RAM engine — fastest, but bounded by available memory.',
  db: 'Always uses the on-disk database engine — handles files of any size.',
};
async function refreshEngineMode() {
  const wrap = $('engine-wrap');
  if (!wrap) return;
  if (!licensed) { wrap.classList.add('hidden'); return; }
  let info = { mode: 'auto' };
  try { info = await window.oxj.engineMode(); } catch {}
  if (!licensed) { wrap.classList.add('hidden'); return; }
  const mode = info.mode || 'auto';
  document.querySelectorAll('#engine-seg .engine-opt').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  $('engine-desc').textContent = ENGINE_DESC[mode] || '';
  const list = $('engine-list');
  list.textContent = '';
  const addRow = (k, v) => {
    const row = document.createElement('div');
    row.className = 'stat-kv';
    const kk = document.createElement('span'); kk.className = 'k'; kk.textContent = k;
    const vv = document.createElement('span'); vv.textContent = v;
    row.append(kk, vv);
    list.appendChild(row);
  };
  addRow('Active engine', mode === 'db' ? 'Database' : mode === 'memory' ? 'In-RAM' : 'Auto');
  if (info.ramFree != null) addRow('Available RAM', fmtBytes(info.ramFree));
  if (mode !== 'db' && info.memModeLimit != null) addRow('In-RAM limit', '~' + fmtBytes(info.memModeLimit));
  wrap.classList.remove('hidden');
}
document.getElementById('engine-seg').addEventListener('click', async (e) => {
  const btn = e.target.closest('.engine-opt');
  if (!btn) return;
  try {
    await window.oxj.setEngineMode(btn.dataset.mode);
    toast('Engine mode: ' + btn.textContent + ' — applies to files opened from now on', true);
  } catch (err) { toast('Could not change engine mode: ' + cleanErr(err)); }
  refreshEngineMode();
});

// Membership card on the welcome screen — visible only when a license is active.
async function refreshMembership() {
  const wrap = $('membership-wrap');
  if (!wrap) return;
  if (!licensed) { wrap.classList.add('hidden'); return; }
  let s = {};
  try { s = await window.oxj.license.status(); } catch {}
  if (!licensed) { wrap.classList.add('hidden'); return; } // may have changed while awaiting
  const list = $('membership-list');
  list.textContent = '';
  const addRow = (k, v, cls) => {
    const row = document.createElement('div');
    row.className = 'stat-kv';
    const kk = document.createElement('span'); kk.className = 'k'; kk.textContent = k;
    const vv = document.createElement('span'); vv.className = 'v'; vv.textContent = v;
    if (cls) vv.classList.add(cls);
    row.append(kk, vv);
    list.appendChild(row);
  };
  const exp = s.expires_at;
  const d = daysUntil(exp);
  let valid = 'Lifetime', validCls = '';
  if (exp) {
    if (d <= 0) { valid = 'Expired'; validCls = 'expiring'; }
    else if (d <= EXPIRY_NUDGE_DAYS) { valid = 'Expires in ' + d + ' day' + (d === 1 ? '' : 's'); validCls = 'expiring'; }
    else valid = 'Until ' + String(exp).slice(0, 10);
  }
  addRow('Status', 'Active');
  addRow('Plan', s.plan || 'NARIK Edition');
  addRow('Account', s.email || '');
  addRow('Valid', valid, validCls);
  wrap.classList.remove('hidden');
}
function openLicenseLock(canClose) {
  $('lic-close').classList.toggle('hidden', !canClose);
  $('lic-heading').textContent = licensed ? 'License active — enter a new key to re-activate' : 'Activate to unlock';
  setLicError('');
  $('license-lock').classList.remove('hidden');
  setTimeout(() => ($('lic-email').value ? $('lic-key') : $('lic-email')).focus(), 30);
}
function hideLicenseLock() { $('license-lock').classList.add('hidden'); }

async function initLicense() {
  let s = { licensed: false };
  try { s = await window.oxj.license.status(); } catch {}
  if (s && s.email) $('lic-email').value = s.email;
  if (s && s.licensed) {
    showEdition(true, s.expires_at);
    const d = daysUntil(s.expires_at);
    if (Number.isFinite(d) && d > 0 && d <= EXPIRY_NUDGE_DAYS) {
      toast('Your NARIK EDITION license expires in ' + d + ' day' + (d === 1 ? '' : 's') + ' — renew to avoid interruption.', true);
    }
  } else {
    showEdition(false);
    openLicenseLock(false); // hard lock: app is unusable until activated
    if (s && s.expired) setLicError('Your license has expired — re-activate to continue.');
  }
}

// The server rejected the cached key during a periodic re-check → re-lock.
window.oxj.license.onRevoked(() => {
  showEdition(false);
  openLicenseLock(false);
  setLicError('Your license is no longer valid — please re-activate.');
});

$('lic-activate').addEventListener('click', async () => {
  const email = $('lic-email').value.trim();
  const key = $('lic-key').value.trim();
  if (!email || !key) { setLicError('Enter your email and license key.'); return; }
  $('lic-activate').disabled = true;
  setLicError('Verifying…');
  try {
    const r = await window.oxj.license.activate(email, key);
    if (r && r.valid) {
      showEdition(true, r.expires_at);
      hideLicenseLock();
      toast('Activated — NARIK EDITION (' + editionValidity(r.expires_at) + ')', true);
    } else {
      setLicError(r && r.reason ? 'Not activated: ' + r.reason : 'Invalid email or license key.');
    }
  } catch (e) {
    setLicError('Could not reach the license server: ' + cleanErr(e));
  }
  $('lic-activate').disabled = false;
});
$('lic-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lic-key').focus(); });
$('lic-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lic-activate').click(); });
$('lic-close').addEventListener('click', hideLicenseLock);
$('lic-buy').addEventListener('click', () => window.oxj.license.store());
$('welcome-manage').addEventListener('click', () => openLicenseLock(true)); // renew / change key

// ---------- init ----------
initMonaco();
window.oxj.getTheme().then((eff) => applyTheme(eff)).catch(() => {});
newTab(true);
initLicense();
