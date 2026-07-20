/* =====================================================================
   OPENXMLJSON — Flow diagram module (adapted from URL & JSON Studio's
   json-graph.js content script).

   Renders a JS object/array as an interactive node-link graph (JSONCrack
   style): each object/array element becomes a card, nested containers
   branch out with key-labelled edges.

   Self-contained: no external libraries. Pan/zoom, fit-to-center,
   zoom in/out, rotate layout (LR / TB / RL / BT) and export to
   PNG / JPG / PDF / SVG are all hand-rolled.

   Interactions:
     mouse drag           → pan
     ctrl + mouse wheel   → zoom (desktop convention)
     trackpad pinch       → zoom (browser reports it as wheel+ctrlKey)
     trackpad 2-finger    → pan
     toolbar              → fit / zoom presets / +/− / rotate / export

   API: window.OXJGraph.render(container, data)  /  .destroy()
   ===================================================================== */
window.OXJGraph = (function () {
  "use strict";

  const SVGNS = "http://www.w3.org/2000/svg";
  let cleanups = [];

  function destroy() {
    cleanups.forEach((fn) => { try { fn(); } catch {} });
    cleanups = [];
  }

  /* ===================================================================
     1. MODEL — turn JSON into a graph of cards
     =================================================================== */
  let _uid = 0;
  function buildGraph(root) {
    _uid = 0;
    return nodeFor(root);
  }

  function shortType(v) {
    if (Array.isArray(v)) return "[" + v.length + (v.length === 1 ? " item]" : " items]");
    if (v && typeof v === "object") {
      const n = Object.keys(v).length;
      return "{" + n + (n === 1 ? " key}" : " keys}");
    }
    return "";
  }

  function primClass(v) {
    if (v === null) return "g-null";
    const t = typeof v;
    if (t === "number") return "g-number";
    if (t === "boolean") return "g-boolean";
    return "g-string";
  }
  function primText(v) {
    if (v === null) return "null";
    if (typeof v === "string") return v;
    return String(v);
  }

  function colorHex(v) {
    if (typeof v !== "string") return null;
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim()) ? v.trim() : null;
  }

  function isContainer(v) { return v !== null && typeof v === "object"; }

  function nodeFor(value) {
    const node = { id: ++_uid, rows: [], children: [] };

    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (isContainer(item)) node.children.push({ node: titled(nodeFor(item), String(i)) });
        else node.rows.push({ label: String(i), val: primText(item), cls: primClass(item), color: colorHex(item) });
      });
      if (!value.length) node.rows.push({ label: "", val: "empty array", cls: "g-null" });
      return node;
    }

    if (isContainer(value)) {
      for (const k of Object.keys(value)) {
        const v = value[k];
        if (Array.isArray(v)) {
          node.rows.push({ label: k, val: shortType(v), cls: "g-summary" });
          addArrayChildren(node, k, v);
        } else if (isContainer(v)) {
          node.rows.push({ label: k, val: shortType(v), cls: "g-summary" });
          node.children.push({ node: titled(nodeFor(v), k) });
        } else {
          node.rows.push({ label: k, val: primText(v), cls: primClass(v), color: colorHex(v) });
        }
      }
      if (!Object.keys(value).length) node.rows.push({ label: "", val: "empty object", cls: "g-null" });
      return node;
    }

    node.rows.push({ label: "", val: primText(value), cls: primClass(value), color: colorHex(value) });
    return node;
  }

  function titled(node, title) { node.title = title; return node; }

  function addArrayChildren(node, key, arr) {
    const prims = [];
    arr.forEach((item, i) => {
      if (isContainer(item)) node.children.push({ node: titled(nodeFor(item), key) });
      else prims.push({ i, item });
    });
    if (prims.length) {
      const listNode = { id: ++_uid, rows: [], children: [], title: key };
      prims.forEach(({ i, item }) =>
        listNode.rows.push({ label: String(i), val: primText(item), cls: primClass(item), color: colorHex(item) })
      );
      node.children.push({ node: listNode });
    }
  }

  /* ===================================================================
     2. MEASURE
     =================================================================== */
  const CH = 8.0;
  const ROW_H = 30;
  const TITLE_H = 30;
  const PAD_X = 14;
  const PAD_Y = 8;
  const MIN_W = 120;
  const MAX_W = 340;
  const SWATCH = 16;

  function measure(node) {
    let maxChars = 0;
    node.rows.forEach((r) => {
      const label = r.label ? r.label + ": " : "";
      let chars = (label + r.val).length;
      if (r.color) chars += 2;
      maxChars = Math.max(maxChars, chars);
    });
    if (node.title) maxChars = Math.max(maxChars, node.title.length + 1);
    const w = Math.max(MIN_W, Math.min(MAX_W, Math.round(maxChars * CH) + PAD_X * 2));
    const rows = Math.max(1, node.rows.length);
    node.titleH = node.title ? TITLE_H : 0;
    node.w = w;
    node.h = node.titleH + rows * ROW_H + PAD_Y * 2;
    node.rowH = ROW_H;
    node.padY = PAD_Y;
    node.children.forEach((c) => measure(c.node));
  }

  /* ===================================================================
     3. LAYOUT — tidy layered tree, direction-aware (LR/RL/TB/BT)
     =================================================================== */
  const GAP_CROSS = 26;
  const GAP_DEPTH = 90;

  function layout(root, dir) {
    const horizontal = dir === "LR" || dir === "RL";
    const crossSize = (n) => (horizontal ? n.h : n.w);
    const depthSize = (n) => (horizontal ? n.w : n.h);

    function calcSpan(node) {
      if (!node.children.length) { node._span = crossSize(node); return node._span; }
      let sum = 0;
      node.children.forEach((c, i) => {
        sum += calcSpan(c.node);
        if (i) sum += GAP_CROSS;
      });
      node._span = Math.max(crossSize(node), sum);
      return node._span;
    }

    const levelMax = [];
    function scanLevels(node, depth) {
      levelMax[depth] = Math.max(levelMax[depth] || 0, depthSize(node));
      node.children.forEach((c) => scanLevels(c.node, depth + 1));
    }

    function levelOffset(depth) {
      let off = 0;
      for (let d = 0; d < depth; d++) off += (levelMax[d] || 0) + GAP_DEPTH;
      return off;
    }

    function place(node, depth, crossStart) {
      node._depth = depth;
      node._cross = crossStart + node._span / 2;
      const childrenSpan = node.children.reduce(
        (s, c, i) => s + c.node._span + (i ? GAP_CROSS : 0), 0
      );
      let cursor = crossStart + (node._span - childrenSpan) / 2;
      node.children.forEach((c) => {
        place(c.node, depth + 1, cursor);
        cursor += c.node._span + GAP_CROSS;
      });
    }

    calcSpan(root);
    scanLevels(root, 0);
    place(root, 0, 0);

    let depthExtent = 0;
    for (let d = 0; d < levelMax.length; d++) depthExtent += (levelMax[d] || 0) + GAP_DEPTH;

    const nodes = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    function assign(node) {
      const depthPos = levelOffset(node._depth);
      const depthExt = levelMax[node._depth] || depthSize(node);
      let x, y;
      if (horizontal) {
        x = dir === "LR" ? depthPos : depthExtent - depthPos - depthExt;
        y = node._cross - node.h / 2;
      } else {
        y = dir === "TB" ? depthPos : depthExtent - depthPos - depthExt;
        x = node._cross - node.w / 2;
      }
      node.x = x; node.y = y;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + node.w); maxY = Math.max(maxY, y + node.h);
      nodes.push(node);
      node.children.forEach((c) => assign(c.node));
    }
    assign(root);

    nodes.forEach((n) => { n.x -= minX; n.y -= minY; });
    return { nodes, width: maxX - minX, height: maxY - minY, dir };
  }

  /* ===================================================================
     4. RENDER
     =================================================================== */
  function render(container, data) {
    destroy();
    container.textContent = "";

    const root = buildGraph(data);
    measure(root);

    const stage = document.createElement("div");
    stage.className = "g-stage";

    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "g-svg");
    svg.setAttribute("xmlns", SVGNS);

    const defs = document.createElementNS(SVGNS, "defs");
    defs.innerHTML =
      '<marker id="g-arrow" viewBox="0 0 10 10" refX="9" refY="5" ' +
      'markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M0,0 L10,5 L0,10 z" fill="var(--g-edge)"/></marker>';
    svg.appendChild(defs);

    const scene = document.createElementNS(SVGNS, "g");
    scene.setAttribute("class", "g-scene");
    svg.appendChild(scene);

    stage.appendChild(svg);
    container.appendChild(stage);
    cleanups.push(() => { container.textContent = ""; });

    const zoomInfo = document.createElement("div");
    zoomInfo.className = "g-zoominfo";
    stage.appendChild(zoomInfo);

    const state = { dir: "TB", scale: 1, tx: 0, ty: 0, layout: null };

    function draw() {
      const lay = layout(root, state.dir);
      state.layout = lay;
      scene.textContent = "";

      const edgeLayer = document.createElementNS(SVGNS, "g");
      lay.nodes.forEach((n) => {
        n.children.forEach((c) => {
          const pts = edgeAnchors(n, c.node, state.dir);
          const path = document.createElementNS(SVGNS, "path");
          path.setAttribute("class", "g-edge");
          path.setAttribute("d", bezier(pts.x1, pts.y1, pts.x2, pts.y2, state.dir));
          path.setAttribute("marker-end", "url(#g-arrow)");
          edgeLayer.appendChild(path);
        });
      });
      scene.appendChild(edgeLayer);

      lay.nodes.forEach((n) => scene.appendChild(cardEl(n)));

      applyTransform();
      return lay;
    }

    function cardEl(n) {
      const g = document.createElementNS(SVGNS, "g");
      g.setAttribute("class", "g-card");
      g.setAttribute("transform", "translate(" + n.x + "," + n.y + ")");

      const rect = document.createElementNS(SVGNS, "rect");
      rect.setAttribute("width", n.w); rect.setAttribute("height", n.h);
      rect.setAttribute("rx", 8);
      rect.setAttribute("class", "g-cardbg");
      g.appendChild(rect);

      if (n.title) {
        const bar = document.createElementNS(SVGNS, "path");
        bar.setAttribute("class", "g-titlebar");
        bar.setAttribute("d", topRoundedRect(n.w, n.titleH, 8));
        g.appendChild(bar);

        const tt = document.createElementNS(SVGNS, "text");
        tt.setAttribute("x", PAD_X);
        tt.setAttribute("y", n.titleH / 2);
        tt.setAttribute("dy", "0.32em");
        tt.setAttribute("class", "g-title");
        tt.textContent = clampVal(n.title);
        g.appendChild(tt);
        const sep2 = document.createElementNS(SVGNS, "line");
        sep2.setAttribute("x1", 0); sep2.setAttribute("x2", n.w);
        sep2.setAttribute("y1", n.titleH); sep2.setAttribute("y2", n.titleH);
        sep2.setAttribute("class", "g-titlesep");
        g.appendChild(sep2);
      }

      n.rows.forEach((r, i) => {
        const ry = n.titleH + n.padY + i * n.rowH;
        if (i > 0) {
          const line = document.createElementNS(SVGNS, "line");
          line.setAttribute("x1", 0); line.setAttribute("x2", n.w);
          line.setAttribute("y1", ry); line.setAttribute("y2", ry);
          line.setAttribute("class", "g-rowsep");
          g.appendChild(line);
        }
        const text = document.createElementNS(SVGNS, "text");
        text.setAttribute("x", PAD_X);
        text.setAttribute("y", ry + n.rowH / 2);
        text.setAttribute("dy", "0.32em");
        text.setAttribute("class", "g-row");

        if (r.label) {
          const ts = document.createElementNS(SVGNS, "tspan");
          ts.setAttribute("class", "g-key");
          ts.textContent = r.label + ": ";
          text.appendChild(ts);
        }
        if (r.color) {
          const approxKeyW = r.label ? (r.label.length + 2) * CH : 0;
          const sw = document.createElementNS(SVGNS, "rect");
          sw.setAttribute("x", PAD_X + approxKeyW);
          sw.setAttribute("y", ry + n.rowH / 2 - SWATCH / 2);
          sw.setAttribute("width", SWATCH); sw.setAttribute("height", SWATCH);
          sw.setAttribute("rx", 3);
          sw.setAttribute("class", "g-swatch");
          sw.setAttribute("fill", r.color);
          g.appendChild(sw);
          const ts = document.createElementNS(SVGNS, "tspan");
          ts.setAttribute("class", r.cls);
          ts.setAttribute("dx", SWATCH + 6);
          ts.textContent = clampVal(r.val);
          text.appendChild(ts);
        } else {
          const ts = document.createElementNS(SVGNS, "tspan");
          ts.setAttribute("class", r.cls);
          ts.textContent = clampVal(r.val);
          text.appendChild(ts);
        }
        g.appendChild(text);
      });
      return g;
    }

    function clampVal(v) {
      const s = String(v);
      const max = Math.floor((MAX_W - PAD_X * 2) / CH);
      return s.length > max ? s.slice(0, max - 1) + "…" : s;
    }

    /* ---- pan / zoom ---- */
    function applyTransform() {
      scene.setAttribute(
        "transform",
        "translate(" + state.tx + "," + state.ty + ") scale(" + state.scale + ")"
      );
      zoomInfo.textContent = Math.round(state.scale * 100) + "%";
    }

    function fit() {
      const lay = state.layout || draw();
      const vw = stage.clientWidth, vh = stage.clientHeight;
      const pad = 60;
      const s = Math.min((vw - pad * 2) / lay.width, (vh - pad * 2) / lay.height, 1.5);
      state.scale = isFinite(s) && s > 0 ? s : 1;
      state.tx = (vw - lay.width * state.scale) / 2;
      state.ty = (vh - lay.height * state.scale) / 2;
      applyTransform();
    }

    function zoomTo(scale) {
      const lay = state.layout || draw();
      const vw = stage.clientWidth;
      const rootNode = lay.nodes[0];
      const topPad = 50;
      state.scale = scale;
      state.tx = vw / 2 - (rootNode.x + rootNode.w / 2) * scale;
      state.ty = topPad - rootNode.y * scale;
      applyTransform();
    }

    function zoomBy(factor, cx, cy) {
      const vw = stage.clientWidth, vh = stage.clientHeight;
      cx = cx == null ? vw / 2 : cx;
      cy = cy == null ? vh / 2 : cy;
      const ns = Math.max(0.05, Math.min(4, state.scale * factor));
      state.tx = cx - (cx - state.tx) * (ns / state.scale);
      state.ty = cy - (cy - state.ty) * (ns / state.scale);
      state.scale = ns;
      applyTransform();
    }

    // drag to pan (mouse)
    let dragging = false, sx = 0, sy = 0, otx = 0, oty = 0;
    stage.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      dragging = true; sx = e.clientX; sy = e.clientY; otx = state.tx; oty = state.ty;
      stage.classList.add("g-dragging");
    });
    const onMove = (e) => {
      if (!dragging) return;
      state.tx = otx + (e.clientX - sx);
      state.ty = oty + (e.clientY - sy);
      applyTransform();
    };
    const onUp = () => { dragging = false; stage.classList.remove("g-dragging"); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    cleanups.push(() => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    });

    // trackpad gestures:
    //   pinch  → wheel event with ctrlKey → zoom
    //   2-finger swipe → wheel deltas → pan
    //   ctrl + mouse wheel also zooms (desktop convention)
    stage.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
      } else {
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1;
        state.tx -= e.deltaX * unit;
        state.ty -= e.deltaY * unit;
        applyTransform();
      }
    }, { passive: false });

    /* ---- controls toolbar ---- */
    buildToolbar(stage, {
      fit,
      zoomTo: (scale) => zoomTo(scale),
      zoomIn: () => zoomBy(1.2),
      zoomOut: () => zoomBy(1 / 1.2),
      rotate: () => {
        const order = ["LR", "TB", "RL", "BT"];
        state.dir = order[(order.indexOf(state.dir) + 1) % order.length];
        draw(); fit();
      },
      exportAs: (fmt) => exportGraph(fmt, svg, state),
    });

    draw();
    requestAnimationFrame(fit);

    const onResize = () => applyTransform();
    window.addEventListener("resize", onResize);
    cleanups.push(() => window.removeEventListener("resize", onResize));
  }

  function topRoundedRect(w, h, r) {
    return "M0," + h + " V" + r + " A" + r + "," + r + " 0 0 1 " + r + ",0 " +
      "H" + (w - r) + " A" + r + "," + r + " 0 0 1 " + w + "," + r + " V" + h + " Z";
  }

  /* ---- edge geometry ---- */
  function edgeAnchors(parent, child, dir) {
    let x1, y1, x2, y2;
    if (dir === "LR") {
      x1 = parent.x + parent.w; y1 = parent.y + parent.h / 2;
      x2 = child.x;             y2 = child.y + child.h / 2;
    } else if (dir === "RL") {
      x1 = parent.x;            y1 = parent.y + parent.h / 2;
      x2 = child.x + child.w;   y2 = child.y + child.h / 2;
    } else if (dir === "TB") {
      x1 = parent.x + parent.w / 2; y1 = parent.y + parent.h;
      x2 = child.x + child.w / 2;   y2 = child.y;
    } else {
      x1 = parent.x + parent.w / 2; y1 = parent.y;
      x2 = child.x + child.w / 2;   y2 = child.y + child.h;
    }
    return { x1, y1, x2, y2 };
  }

  function bezier(x1, y1, x2, y2, dir) {
    if (dir === "LR" || dir === "RL") {
      const mx = (x1 + x2) / 2;
      return "M" + x1 + "," + y1 + " C" + mx + "," + y1 + " " + mx + "," + y2 + " " + x2 + "," + y2;
    }
    const my = (y1 + y2) / 2;
    return "M" + x1 + "," + y1 + " C" + x1 + "," + my + " " + x2 + "," + my + " " + x2 + "," + y2;
  }

  /* ===================================================================
     5. TOOLBAR
     =================================================================== */
  function buildToolbar(stage, actions) {
    const bar = document.createElement("div");
    bar.className = "g-toolbar";

    const mk = (label, title, fn) => {
      const b = document.createElement("button");
      b.className = "g-tbtn";
      b.innerHTML = label;
      b.title = title;
      b.type = "button";
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      return b;
    };

    bar.appendChild(mk(ICON.fit, "Fit to center", actions.fit));

    const zoomWrap = document.createElement("div");
    zoomWrap.className = "g-expwrap";
    const zoomBtn = document.createElement("button");
    zoomBtn.className = "g-tbtn";
    zoomBtn.type = "button";
    zoomBtn.title = "Zoom level";
    zoomBtn.innerHTML = ICON.zoom + '<span class="g-caret">▾</span>';
    const zoomMenu = document.createElement("div");
    zoomMenu.className = "g-expmenu";
    [100, 150, 200].forEach((pct) => {
      const item = document.createElement("button");
      item.className = "g-expitem";
      item.type = "button";
      item.textContent = pct + "%";
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        zoomMenu.classList.remove("open");
        actions.zoomTo(pct / 100);
      });
      zoomMenu.appendChild(item);
    });
    zoomBtn.addEventListener("click", (e) => { e.stopPropagation(); zoomMenu.classList.toggle("open"); });
    zoomWrap.appendChild(zoomBtn);
    zoomWrap.appendChild(zoomMenu);
    bar.appendChild(zoomWrap);

    bar.appendChild(sep());
    bar.appendChild(mk(ICON.minus, "Zoom out", actions.zoomOut));
    bar.appendChild(mk(ICON.plus, "Zoom in", actions.zoomIn));
    bar.appendChild(sep());
    bar.appendChild(mk(ICON.rotate, "Rotate layout (LR → TB → RL → BT)", actions.rotate));
    bar.appendChild(sep());

    const expWrap = document.createElement("div");
    expWrap.className = "g-expwrap";
    const menu = document.createElement("div");
    menu.className = "g-expmenu";
    const expBtn = mk(ICON.export + " <span class='g-caret'>▾</span>", "Export", () => {
      menu.classList.toggle("open");
    });
    [["PNG", "png"], ["JPG", "jpg"], ["PDF", "pdf"], ["SVG", "svg"]].forEach(([label, fmt]) => {
      const item = document.createElement("button");
      item.className = "g-expitem";
      item.type = "button";
      item.textContent = label;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        menu.classList.remove("open");
        actions.exportAs(fmt);
      });
      menu.appendChild(item);
    });
    expWrap.appendChild(expBtn);
    expWrap.appendChild(menu);
    bar.appendChild(expWrap);

    const closeMenus = () => { menu.classList.remove("open"); zoomMenu.classList.remove("open"); };
    document.addEventListener("click", closeMenus);
    cleanups.push(() => document.removeEventListener("click", closeMenus));

    stage.appendChild(bar);
    return bar;
  }

  function sep() {
    const s = document.createElement("span");
    s.className = "g-tsep";
    return s;
  }

  const ICON = {
    fit: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>',
    minus: '<svg viewBox="0 0 24 24" width="16" height="16"><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M5 12h14"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="16" height="16"><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>',
    rotate: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 12a8 8 0 0 1 13.6-5.7L20 8M20 4v4h-4"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M20 12a8 8 0 0 1-13.6 5.7L4 16M4 20v-4h4"/></svg>',
    export: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 15V3M8 7l4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>',
    zoom: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M15.5 15.5 L21 21"/></svg>',
  };

  /* ===================================================================
     6. EXPORT — SVG / PNG / JPG / PDF (self-contained)
     =================================================================== */
  function exportGraph(fmt, svg, state) {
    const lay = state.layout;
    if (!lay) return;
    const pad = 40;
    const W = Math.ceil(lay.width + pad * 2);
    const H = Math.ceil(lay.height + pad * 2);
    const bg = getComputedStyle(document.body).getPropertyValue("--g-bg").trim() || "#0e0f12";

    const svgStr = serializeSvg(svg, W, H, pad, bg);

    if (fmt === "svg") {
      download(new Blob([svgStr], { type: "image/svg+xml" }), exportName("svg"));
      return;
    }

    const scale = 2;
    const img = new Image();
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = W * scale; canvas.height = H * scale;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      if (fmt === "png") {
        canvas.toBlob((b) => download(b, exportName("png")), "image/png");
      } else if (fmt === "jpg") {
        canvas.toBlob((b) => download(b, exportName("jpg")), "image/jpeg", 0.92);
      } else if (fmt === "pdf") {
        canvas.toBlob(async (b) => {
          const bytes = new Uint8Array(await b.arrayBuffer());
          const pdf = jpegToPdf(bytes, canvas.width, canvas.height);
          download(new Blob([pdf], { type: "application/pdf" }), exportName("pdf"));
        }, "image/jpeg", 0.92);
      }
    };
    img.onerror = () => alert("Export failed while rasterising the graph.");
    img.src = url;
  }

  function serializeSvg(svg, W, H, pad, bg) {
    const scene = svg.querySelector(".g-scene").cloneNode(true);
    scene.setAttribute("transform", "translate(" + pad + "," + pad + ")");
    const defs = svg.querySelector("defs").cloneNode(true);
    const css = graphExportCss();
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" ' +
      'viewBox="0 0 ' + W + " " + H + '">' +
      "<style>" + css + "</style>" +
      '<rect width="' + W + '" height="' + H + '" fill="' + bg + '"/>' +
      new XMLSerializer().serializeToString(defs) +
      new XMLSerializer().serializeToString(scene) +
      "</svg>"
    );
  }

  // Resolve CSS variables (from <body>, so light/dark themes both work)
  // into concrete values so the exported SVG renders identically anywhere.
  function graphExportCss() {
    const cs = getComputedStyle(document.body);
    const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
    const card = v("--g-card", "#1b1d23");
    const border = v("--g-border", "rgba(255,255,255,.14)");
    const edge = v("--g-edge", "#5b6472");
    const key = v("--g-key", "#7fb2ff");
    const str = v("--g-string", "#d7dae0");
    const num = v("--g-number", "#e2b93b");
    const bool = v("--g-boolean", "#c586ff");
    const nul = v("--g-null", "#8b93a1");
    const summ = v("--g-summary", "#9aa4b2");
    const titlebar = v("--g-titlebar-bg", "#2a3450");
    const titletext = v("--g-titlebar-fg", "#cfe0ff");
    const font = "13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
    return [
      ".g-cardbg{fill:" + card + ";stroke:" + border + ";stroke-width:1}",
      ".g-titlebar{fill:" + titlebar + "}",
      ".g-title{fill:" + titletext + ";font:700 13px ui-monospace,Menlo,Consolas,monospace}",
      ".g-titlesep{stroke:" + border + ";stroke-width:1}",
      ".g-rowsep{stroke:" + border + ";stroke-width:1}",
      ".g-row{font:" + font + "}",
      ".g-key{fill:" + key + "}",
      ".g-string{fill:" + str + "}",
      ".g-number{fill:" + num + "}",
      ".g-boolean{fill:" + bool + "}",
      ".g-null{fill:" + nul + "}",
      ".g-summary{fill:" + summ + "}",
      ".g-edge{fill:none;stroke:" + edge + ";stroke-width:1.5}",
      ".g-swatch{stroke:" + border + ";stroke-width:1}",
    ].join("");
  }

  /* Minimal single-page PDF embedding a baseline JPEG (DCTDecode). */
  function jpegToPdf(jpeg, w, h) {
    const chunks = [];
    const offsets = [];
    let length = 0;
    const enc = new TextEncoder();
    function push(part) {
      const bytes = typeof part === "string" ? enc.encode(part) : part;
      chunks.push(bytes);
      length += bytes.length;
      return bytes.length;
    }
    function obj(str) { offsets.push(length); push(str); }

    push("%PDF-1.4\n");
    obj("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    obj("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
    obj(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + w + " " + h + "] " +
      "/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n"
    );
    obj(
      "4 0 obj\n<< /Type /XObject /Subtype /Image /Width " + w + " /Height " + h +
      " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " +
      jpeg.length + " >>\nstream\n"
    );
    push(jpeg);
    push("\nendstream\nendobj\n");
    const content = "q\n" + w + " 0 0 " + h + " 0 0 cm\n/Im0 Do\nQ\n";
    obj("5 0 obj\n<< /Length " + content.length + " >>\nstream\n" + content + "endstream\nendobj\n");

    const xrefPos = length;
    let xref = "xref\n0 6\n0000000000 65535 f \n";
    for (let i = 0; i < offsets.length; i++) {
      xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    }
    push(xref);
    push("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xrefPos + "\n%%EOF");

    const out = new Uint8Array(length);
    let p = 0;
    chunks.forEach((c) => { out.set(c, p); p += c.length; });
    return out;
  }

  function exportName(ext) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const ts = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      "_" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    return "OPENXMLJSON_Graph_" + ts + "." + ext;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  return { render, destroy };
})();
