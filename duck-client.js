'use strict';
/**
 * DuckDB engine client (main process).
 *
 * Owns the vendored GigaTables engine as a separate OS process
 * (Electron utilityProcess running dist/engine/engine.cjs). Talks RPC to it,
 * forwards engine events to the renderer, and restarts it if it dies. The
 * engine handles all delimited/tabular files; the Rust engine still handles
 * the hierarchical formats.
 *
 * Ported to CommonJS from GigaTables' EngineClient.
 */
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { app, utilityProcess } = require('electron');

const RESTART_BACKOFF_MS = [250, 1000, 3000, 8000];
// Long-running methods run without a timeout; everything else gets 60 s.
const UNBOUNDED = new Set([
  'openDataset', 'buildView', 'getPage', 'exportView', 'diffDatasets',
  'profileColumn', 'profileAll', 'runSql', 'clearCache', 'cacheInfo', 'previewRows',
]);

class DuckClient extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.readyWaiters = [];
    this.restarts = 0;
    this.stopping = false;
  }

  options() {
    const cacheLimitBytes = 64 * 1024 * 1024 * 1024;
    return {
      cacheRoot: path.join(app.getPath('userData'), 'duck-cache'),
      cacheLimitBytes,
      memoryLimitMb: 4096,
      threads: null,
      maxTempBytes: Math.max(cacheLimitBytes, 64 * 1024 * 1024 * 1024),
    };
  }

  entryPath() {
    const candidates = [
      path.join(app.getAppPath(), 'dist', 'engine', 'engine.cjs'),
      path.join(process.cwd(), 'dist', 'engine', 'engine.cjs'),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return candidates[0];
  }

  async start() {
    if (this.child) return;
    this.stopping = false;
    const entry = this.entryPath();
    if (!fs.existsSync(entry)) {
      const detail = `Engine bundle missing at ${entry}. Run "npm run build:duck".`;
      this.emitEvent({ type: 'engine-state', state: 'crashed', detail });
      throw new Error(detail);
    }
    const child = utilityProcess.fork(entry, [], {
      serviceName: 'NARIKJSON DuckDB Engine',
      stdio: 'inherit',
      env: { ...process.env, NARIK_ENGINE: '1' },
    });
    this.child = child;
    child.on('message', (m) => this.onMessage(m));
    child.on('exit', (code) => this.onExit(code));
    await this.init();
  }

  async init() {
    try {
      await this.rawInvoke('init', this.options(), 120000);
      this.ready = true;
      this.restarts = 0;
      for (const w of this.readyWaiters.splice(0)) w();
    } catch (err) {
      this.emitEvent({ type: 'engine-state', state: 'crashed', detail: `Engine failed to start: ${(err && err.message) || String(err)}` });
      throw err;
    }
  }

  onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if ('event' in message) { this.emitEvent(message.event); return; }
    if (typeof message.id !== 'number') return;
    const p = this.pending.get(message.id);
    if (!p) return;
    this.pending.delete(message.id);
    if (message.ok) p.resolve(message.result);
    else p.reject(message.error);
  }

  onExit(code) {
    const wasReady = this.ready;
    this.ready = false;
    this.child = null;
    const err = { code: 'engine-down', message: 'The DuckDB engine stopped unexpectedly.', detail: `exit code ${code}` };
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    if (this.stopping) return;
    this.emitEvent({ type: 'engine-state', state: 'crashed', detail: wasReady ? `Engine exited with code ${code}.` : 'Engine failed during startup.' });
    const delay = RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)];
    this.restarts++;
    if (this.restarts > 6) {
      this.emitEvent({ type: 'engine-state', state: 'crashed', detail: 'The DuckDB engine keeps failing. Restart the application.' });
      return;
    }
    setTimeout(() => {
      if (this.stopping) return;
      this.emitEvent({ type: 'engine-state', state: 'restarting' });
      this.start().catch(() => {});
    }, delay);
  }

  emitEvent(event) { this.emit('engine-event', event); }

  rawInvoke(method, params, timeoutMs) {
    const child = this.child;
    if (!child) return Promise.reject({ code: 'engine-down', message: 'The DuckDB engine is not running.' });
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, startedAt: Date.now() });
      if (timeoutMs > 0) {
        const t = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          reject({ code: 'internal', message: `The engine did not answer "${method}" in time.` });
        }, timeoutMs);
        if (typeof t.unref === 'function') t.unref();
      }
      try { child.postMessage({ id, method, params }); }
      catch (e) { this.pending.delete(id); reject({ code: 'engine-down', message: e.message }); }
    });
  }

  waitReady(ms = 30000) {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject({ code: 'engine-down', message: 'The DuckDB engine is not ready.' }), ms);
      this.readyWaiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  // Lazily boot the engine on first use, then invoke a method.
  async invoke(method, params) {
    if (!this.child) await this.start();
    if (method !== 'cancel' && method !== 'ping') await this.waitReady();
    return this.rawInvoke(method, params, UNBOUNDED.has(method) ? 0 : 60000);
  }

  stop() {
    this.stopping = true;
    if (this.child) { try { this.child.kill(); } catch {} this.child = null; }
  }
}

module.exports = { DuckClient };
