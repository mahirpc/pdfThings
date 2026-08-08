/*
 * annotate.js — the overlay annotation engine.
 *
 * Coordinate convention: every annotation's x/y/width/height/rotation is
 * stored in "page viewport space at scale 1" — i.e. pdf.js's own
 * getViewport({scale:1, rotation: page.rotate}) space: origin top-left,
 * y grows downward, already adjusted for any page rotation. That makes
 * on-screen math a plain uniform scale by the current zoom factor.
 *
 * At bake time we convert back to true PDF content-stream space (origin
 * bottom-left, y-up, rotation-independent) using pdf.js's own
 * viewport.convertToPdfPoint(), so we never hand-roll rotation trig for
 * the common (unrotated-page) case, and apply a documented best-effort
 * compensation for pages the user has structurally rotated.
 */
(function () {
  let nextId = 1;
  const state = {
    tool: 'select',
    color: '#c0392b',
    strokeWidth: 3,
    opacity: 1,
    fontSize: 16,
    fontFamily: 'IBM Plex Sans, sans-serif',
    stampArm: null, // preset stamp waiting to be placed
  };

  /** pageIndex -> [] of annotation objects */
  const store = {};
  /** pageIndex -> { overlayCanvas, viewport, textLayerEl } currently mounted */
  const surfaces = {};
  /** currently selected annotation {pageIndex, id} */
  let selection = null;
  let onChange = () => {};

  const STAMP_PRESETS = [
    { id: 'approved', label: 'APPROVED', color: '#1b7a72' },
    { id: 'draft', label: 'DRAFT', color: '#d69e2e' },
    { id: 'confidential', label: 'CONFIDENTIAL', color: '#c0392b' },
    { id: 'reviewed', label: 'REVIEWED', color: '#1b7a72' },
    { id: 'rejected', label: 'REJECTED', color: '#c0392b' },
    { id: 'final', label: 'FINAL', color: '#22262c' },
  ];
  const SCRIPT_FONTS = ['"Segoe Script", cursive', '"Brush Script MT", cursive', 'italic 1em Georgia, serif'];

  function getAll() {
    return store;
  }
  function setAll(data) {
    Object.keys(store).forEach((k) => delete store[k]);
    Object.entries(data || {}).forEach(([k, v]) => { store[k] = v.map((a) => Object.assign({}, a)); });
  }
  function pageAnns(pageIndex) {
    if (!store[pageIndex]) store[pageIndex] = [];
    return store[pageIndex];
  }
  function setOnChange(fn) { onChange = fn; }
  function notify() { onChange(); }

  function addAnnotation(pageIndex, partial) {
    const obj = Object.assign({ id: 'a' + nextId++, page: pageIndex, rotation: 0, opacity: 1 }, partial);
    pageAnns(pageIndex).push(obj);
    notify();
    return obj;
  }
  function removeAnnotation(pageIndex, id) {
    store[pageIndex] = pageAnns(pageIndex).filter((a) => a.id !== id);
    if (selection && selection.id === id) selection = null;
    notify();
  }
  function updateAnnotation(pageIndex, id, patch) {
    const a = pageAnns(pageIndex).find((x) => x.id === id);
    if (a) Object.assign(a, patch);
    notify();
  }

  /* -------------------- rendering -------------------- */

  function registerSurface(pageIndex, overlayCanvas, viewport, textLayerEl) {
    surfaces[pageIndex] = { overlayCanvas, viewport, textLayerEl };
    attachPointerHandlers(pageIndex);
    updateInteractivity();
    redraw(pageIndex);
  }
  function unregisterSurface(pageIndex) {
    delete surfaces[pageIndex];
  }

  function redraw(pageIndex) {
    const surf = surfaces[pageIndex];
    if (!surf) return;
    const { overlayCanvas, viewport } = surf;
    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    const scale = overlayCanvas.width / viewport.width;
    ctx.save();
    ctx.scale(scale, scale);
    pageAnns(pageIndex).forEach((a) => drawOne(ctx, a));
    if (selection && selection.page === pageIndex) drawSelectionChrome(ctx, findAnn(selection.page, selection.id));
    ctx.restore();
  }

  function findAnn(pageIndex, id) {
    return pageAnns(pageIndex).find((a) => a.id === id);
  }

  function withTransform(ctx, a, fn) {
    ctx.save();
    const cx = a.x + (a.width || 0) / 2;
    const cy = a.y + (a.height || 0) / 2;
    if (a.rotation) {
      ctx.translate(cx, cy);
      ctx.rotate((a.rotation * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }
    fn();
    ctx.restore();
  }

  function drawOne(ctx, a) {
    ctx.globalAlpha = a.opacity == null ? 1 : a.opacity;
    switch (a.type) {
      case 'highlight':
        ctx.fillStyle = a.color; ctx.globalAlpha = (a.opacity == null ? 0.35 : a.opacity);
        ctx.fillRect(a.x, a.y, a.width, a.height);
        break;
      case 'underline':
        ctx.strokeStyle = a.color; ctx.lineWidth = Math.max(1.5, a.height * 0.08);
        ctx.beginPath(); ctx.moveTo(a.x, a.y + a.height - 1); ctx.lineTo(a.x + a.width, a.y + a.height - 1); ctx.stroke();
        break;
      case 'strike':
        ctx.strokeStyle = a.color; ctx.lineWidth = Math.max(1.5, a.height * 0.08);
        ctx.beginPath(); ctx.moveTo(a.x, a.y + a.height / 2); ctx.lineTo(a.x + a.width, a.y + a.height / 2); ctx.stroke();
        break;
      case 'draw':
        ctx.strokeStyle = a.color; ctx.lineWidth = a.strokeWidth; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.beginPath();
        (a.points || []).forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.stroke();
        break;
      case 'rect':
        withTransform(ctx, a, () => {
          ctx.strokeStyle = a.color; ctx.lineWidth = a.strokeWidth;
          if (a.fill) { ctx.fillStyle = a.color; ctx.globalAlpha *= 0.2; ctx.fillRect(a.x, a.y, a.width, a.height); ctx.globalAlpha = a.opacity == null ? 1 : a.opacity; }
          ctx.strokeRect(a.x, a.y, a.width, a.height);
        });
        break;
      case 'ellipse':
        withTransform(ctx, a, () => {
          ctx.strokeStyle = a.color; ctx.lineWidth = a.strokeWidth;
          ctx.beginPath();
          ctx.ellipse(a.x + a.width / 2, a.y + a.height / 2, Math.abs(a.width / 2), Math.abs(a.height / 2), 0, 0, Math.PI * 2);
          ctx.stroke();
        });
        break;
      case 'line':
      case 'arrow': {
        const [p0, p1] = a.points;
        ctx.strokeStyle = a.color; ctx.lineWidth = a.strokeWidth; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
        if (a.type === 'arrow') {
          const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
          const hs = 8 + a.strokeWidth;
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p1.x - hs * Math.cos(ang - 0.4), p1.y - hs * Math.sin(ang - 0.4));
          ctx.lineTo(p1.x - hs * Math.cos(ang + 0.4), p1.y - hs * Math.sin(ang + 0.4));
          ctx.closePath(); ctx.fillStyle = a.color; ctx.fill();
        }
        break;
      }
      case 'text':
        withTransform(ctx, a, () => {
          ctx.fillStyle = a.color; ctx.font = `${a.fontWeight || 400} ${a.fontSize}px ${a.fontFamily || 'IBM Plex Sans, sans-serif'}`;
          ctx.textBaseline = 'top';
          (a.text || '').split('\n').forEach((line, i) => ctx.fillText(line, a.x + 2, a.y + 2 + i * a.fontSize * 1.25));
        });
        break;
      case 'note': {
        const ncx = a.x + a.width / 2, ncy = a.y + a.height / 2;
        ctx.fillStyle = a.color || '#d69e2e';
        ctx.beginPath(); ctx.arc(ncx, ncy, a.width / 2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#14181f'; ctx.font = '11px IBM Plex Mono, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('!', ncx, ncy + 1);
        ctx.textAlign = 'start';
        break;
      }
      case 'stamp':
        withTransform(ctx, a, () => {
          ctx.strokeStyle = a.color; ctx.lineWidth = 3;
          ctx.strokeRect(a.x, a.y, a.width, a.height);
          ctx.fillStyle = a.color;
          ctx.font = `700 ${a.height * 0.42}px IBM Plex Mono, monospace`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(a.text, a.x + a.width / 2, a.y + a.height / 2);
          ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
        });
        break;
      case 'image':
      case 'signature':
        withTransform(ctx, a, () => {
          if (a._img) ctx.drawImage(a._img, a.x, a.y, a.width, a.height);
        });
        break;
    }
    ctx.globalAlpha = 1;
  }

  /** Bounding box in the same page-space as everything else. Objects with
   *  explicit x/y/width/height report that directly; point-based objects
   *  (freehand draw, line, arrow) derive it from their point list so they
   *  remain selectable/movable/deletable even without resize handles. */
  function bbox(a) {
    if (a.width != null) {
      return { x: Math.min(a.x, a.x + a.width), y: Math.min(a.y, a.y + a.height), width: Math.abs(a.width), height: Math.abs(a.height) };
    }
    if (a.points && a.points.length) {
      const xs = a.points.map((p) => p.x), ys = a.points.map((p) => p.y);
      const pad = (a.strokeWidth || 3) + 4;
      return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, width: Math.max(...xs) - Math.min(...xs) + pad * 2, height: Math.max(...ys) - Math.min(...ys) + pad * 2 };
    }
    return { x: a.x || 0, y: a.y || 0, width: 0, height: 0 };
  }
  function isPointBased(a) { return a.width == null && !!a.points; }

  function drawSelectionChrome(ctx, a) {
    if (!a) return;
    const b = bbox(a);
    if (isPointBased(a)) {
      ctx.save();
      ctx.strokeStyle = '#1b7a72'; ctx.lineWidth = 1.4; ctx.setLineDash([5, 4]);
      ctx.strokeRect(b.x, b.y, b.width, b.height);
      ctx.setLineDash([]);
      ctx.restore();
      return;
    }
    withTransform(ctx, a, () => {
      ctx.save();
      ctx.strokeStyle = '#1b7a72'; ctx.lineWidth = 1.4; ctx.setLineDash([5, 4]);
      ctx.strokeRect(a.x - 3, a.y - 3, a.width + 6, a.height + 6);
      ctx.setLineDash([]);
      ctx.fillStyle = '#1b7a72';
      const hs = 6;
      handlePoints(a).forEach((p) => ctx.fillRect(p.x - hs / 2, p.y - hs / 2, hs, hs));
      ctx.restore();
    });
  }
  function handlePoints(a) {
    return [
      { x: a.x, y: a.y, k: 'nw' }, { x: a.x + a.width, y: a.y, k: 'ne' },
      { x: a.x, y: a.y + a.height, k: 'sw' }, { x: a.x + a.width, y: a.y + a.height, k: 'se' },
      { x: a.x + a.width / 2, y: a.y - 22, k: 'rot' },
    ];
  }

  /* -------------------- interaction -------------------- */

  /** Whether the overlay canvas should intercept pointer events at all.
   *  highlight/underline/strike work by selecting real text in the layer
   *  underneath, so the overlay must get out of the way entirely for
   *  those — otherwise, being on top, it would swallow every touch/click
   *  before the text layer ever saw it (and also block native scrolling). */
  function updateInteractivity() {
    const passThrough = ['highlight', 'underline', 'strike'].includes(state.tool);
    Object.values(surfaces).forEach((s) => {
      if (s.overlayCanvas) s.overlayCanvas.style.pointerEvents = passThrough ? 'none' : 'auto';
    });
  }

  function attachPointerHandlers(pageIndex) {
    const surf = surfaces[pageIndex];
    const canvas = surf.overlayCanvas;
    let drag = null;

    function toPage(evt) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = surf.viewport.width / rect.width;
      const scaleY = surf.viewport.height / rect.height;
      return {
        x: (evt.clientX - rect.left) * scaleX,
        y: (evt.clientY - rect.top) * scaleY,
      };
    }

    canvas.addEventListener('pointerdown', (evt) => {
      const p = toPage(evt);

      if (state.stampArm) {
        placeStamp(pageIndex, p); // single tap to place — no drag, no capture needed
        return;
      }
      if (state.tool === 'select') {
        const hit = hitTest(pageIndex, p);
        if (hit && hit.handle) {
          canvas.setPointerCapture(evt.pointerId);
          drag = { mode: 'resize', handle: hit.handle, ann: hit.ann, start: p, orig: Object.assign({}, hit.ann) };
        } else if (hit) {
          canvas.setPointerCapture(evt.pointerId);
          selection = { page: pageIndex, id: hit.ann.id };
          drag = {
            mode: 'move', ann: hit.ann, start: p,
            orig: { x: hit.ann.x, y: hit.ann.y, points: hit.ann.points ? hit.ann.points.map((pt) => ({ x: pt.x, y: pt.y })) : null },
          };
          notifySelection();
        } else {
          // tapped empty page space — don't capture the pointer, so the
          // browser is free to treat this gesture as a normal page scroll
          selection = null; notifySelection();
        }
        redraw(pageIndex);
        return;
      }
      if (state.tool === 'draw') {
        canvas.setPointerCapture(evt.pointerId);
        drag = { mode: 'draw', points: [p] };
        addAnnotation(pageIndex, { type: 'draw', color: state.color, strokeWidth: state.strokeWidth, points: drag.points });
        return;
      }
      if (['rect', 'ellipse', 'line', 'arrow'].includes(state.tool)) {
        canvas.setPointerCapture(evt.pointerId);
        const type = state.tool;
        if (type === 'line' || type === 'arrow') {
          drag = { mode: 'shape', type, ann: addAnnotation(pageIndex, { type, color: state.color, strokeWidth: state.strokeWidth, points: [p, p] }) };
        } else {
          drag = { mode: 'shape', type, ann: addAnnotation(pageIndex, { type, color: state.color, strokeWidth: state.strokeWidth, x: p.x, y: p.y, width: 1, height: 1 }) };
        }
        return;
      }
      if (state.tool === 'text') {
        const ann = addAnnotation(pageIndex, { type: 'text', color: state.color, fontSize: state.fontSize, fontFamily: state.fontFamily, x: p.x, y: p.y, width: 220, height: state.fontSize * 1.4, text: '' });
        selection = { page: pageIndex, id: ann.id };
        openTextEditor(pageIndex, ann);
        return;
      }
      if (state.tool === 'note') {
        const ann = addAnnotation(pageIndex, { type: 'note', color: '#d69e2e', x: p.x - 9, y: p.y - 9, width: 18, height: 18, text: '' });
        openNoteEditor(pageIndex, ann);
        return;
      }
    });

    canvas.addEventListener('pointermove', (evt) => {
      if (!drag) return;
      const p = toPage(evt);
      if (drag.mode === 'draw') { drag.points.push(p); redraw(pageIndex); return; }
      if (drag.mode === 'move') {
        const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
        if (drag.orig.points) {
          drag.ann.points = drag.orig.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
        } else {
          drag.ann.x = drag.orig.x + dx;
          drag.ann.y = drag.orig.y + dy;
        }
        redraw(pageIndex); return;
      }
      if (drag.mode === 'resize') {
        applyResize(drag, p); redraw(pageIndex); return;
      }
      if (drag.mode === 'shape') {
        if (drag.type === 'line' || drag.type === 'arrow') { drag.ann.points[1] = p; }
        else {
          const a = drag.ann;
          const start = drag.ann._start || (drag.ann._start = { x: a.x, y: a.y });
          a.x = Math.min(start.x, p.x); a.y = Math.min(start.y, p.y);
          a.width = Math.abs(p.x - start.x); a.height = Math.abs(p.y - start.y);
        }
        redraw(pageIndex);
      }
    });

    ['pointerup', 'pointercancel'].forEach((ev) => canvas.addEventListener(ev, () => {
      if (drag && drag.mode === 'shape') delete drag.ann._start;
      drag = null;
      notify();
    }));

    // text-layer selection -> highlight/underline/strike
    if (surf.textLayerEl) {
      const applySelectionAsAnnotation = () => {
        if (!['highlight', 'underline', 'strike'].includes(state.tool)) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        if (!surf.textLayerEl.contains(range.commonAncestorContainer)) return;
        const rects = Array.from(range.getClientRects());
        const layerRect = surf.textLayerEl.getBoundingClientRect();
        const scaleX = surf.viewport.width / layerRect.width;
        const scaleY = surf.viewport.height / layerRect.height;
        rects.forEach((r) => {
          addAnnotation(pageIndex, {
            type: state.tool, color: state.color,
            x: (r.left - layerRect.left) * scaleX, y: (r.top - layerRect.top) * scaleY,
            width: r.width * scaleX, height: r.height * scaleY,
          });
        });
        sel.removeAllRanges();
        redraw(pageIndex);
      };
      surf.textLayerEl.addEventListener('mouseup', applySelectionAsAnnotation);
      surf.textLayerEl.addEventListener('touchend', applySelectionAsAnnotation);
    }
  }

  function applyResize(drag, p) {
    const a = drag.ann, o = drag.orig;
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (drag.handle === 'rot') {
      const cx = o.x + o.width / 2, cy = o.y + o.height / 2;
      const ang = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI + 90;
      a.rotation = Math.round(ang);
      return;
    }
    let { x, y, width, height } = o;
    if (drag.handle.includes('e')) width = Math.max(8, o.width + dx);
    if (drag.handle.includes('s')) height = Math.max(8, o.height + dy);
    if (drag.handle.includes('w')) { width = Math.max(8, o.width - dx); x = o.x + dx; }
    if (drag.handle.includes('n')) { height = Math.max(8, o.height - dy); y = o.y + dy; }
    Object.assign(a, { x, y, width, height });
  }

  function hitTest(pageIndex, p) {
    const anns = pageAnns(pageIndex);
    if (selection && selection.page === pageIndex) {
      const cur = findAnn(pageIndex, selection.id);
      if (cur && cur.width != null) {
        for (const h of handlePoints(cur)) {
          if (Math.hypot(h.x - p.x, h.y - p.y) < 10) return { ann: cur, handle: h.k };
        }
      }
    }
    for (let i = anns.length - 1; i >= 0; i--) {
      const a = anns[i];
      const b = bbox(a);
      if (p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height) return { ann: a };
    }
    return null;
  }

  let onSelectionChange = () => {};
  function setOnSelectionChange(fn) { onSelectionChange = fn; }
  function notifySelection() { onSelectionChange(selection); }
  function deleteSelected() {
    if (!selection) return;
    removeAnnotation(selection.page, selection.id);
    redraw(selection.page);
  }
  function clearSelection() { selection = null; notifySelection(); }

  function openTextEditor(pageIndex, ann) {
    const surf = surfaces[pageIndex];
    const rect = surf.overlayCanvas.getBoundingClientRect();
    const scale = rect.width / surf.viewport.width;
    const ta = document.createElement('textarea');
    ta.value = ann.text || '';
    Object.assign(ta.style, {
      position: 'fixed', left: rect.left + ann.x * scale + 'px', top: rect.top + ann.y * scale + 'px',
      width: ann.width * scale + 'px', minHeight: ann.height * scale + 'px', font: `${ann.fontSize * scale}px ${ann.fontFamily}`,
      color: ann.color, border: '1px dashed #1b7a72', background: 'rgba(255,255,255,.85)', zIndex: 999, padding: '2px', resize: 'both',
    });
    document.body.appendChild(ta);
    ta.focus();
    function commit() {
      ann.text = ta.value;
      document.body.removeChild(ta);
      if (!ann.text.trim()) removeAnnotation(pageIndex, ann.id);
      redraw(pageIndex);
    }
    ta.addEventListener('blur', commit);
  }

  function openNoteEditor(pageIndex, ann) {
    const text = prompt('Note text:', ann.text || '');
    if (text == null) { removeAnnotation(pageIndex, ann.id); return; }
    ann.text = text;
    redraw(pageIndex);
  }

  function placeStamp(pageIndex, p) {
    const preset = state.stampArm;
    const w = Math.max(120, preset.label.length * 14), h = 46;
    addAnnotation(pageIndex, { type: 'stamp', text: preset.label, color: preset.color, x: p.x - w / 2, y: p.y - h / 2, width: w, height: h, rotation: -8 });
    const surf = surfaces[pageIndex];
    if (surf) {
      surf.overlayCanvas.classList.remove('stamp-thunk'); void surf.overlayCanvas.offsetWidth;
      surf.overlayCanvas.classList.add('stamp-thunk');
    }
    state.stampArm = null;
  }

  function placeImageOrSignature(pageIndex, type, dataUrl, opts) {
    const img = new Image();
    img.src = dataUrl;
    const defaultW = (opts && opts.width) || 180;
    img.onload = () => {
      const ratio = img.naturalHeight / img.naturalWidth || 0.4;
      const surf = surfaces[pageIndex];
      const cx = surf ? surf.viewport.width / 2 : 300;
      const cy = surf ? surf.viewport.height / 2 : 400;
      const ann = addAnnotation(pageIndex, {
        type, imageDataUrl: dataUrl, x: cx - defaultW / 2, y: cy - (defaultW * ratio) / 2,
        width: defaultW, height: defaultW * ratio,
      });
      ann._img = img;
      selection = { page: pageIndex, id: ann.id };
      redraw(pageIndex);
      notifySelection();
    };
  }

  // pre-load any images already in the store (e.g. after undo/redo restore)
  function hydrateImages(pageIndex) {
    pageAnns(pageIndex).forEach((a) => {
      if ((a.type === 'image' || a.type === 'signature') && a.imageDataUrl && !a._img) {
        const img = new Image(); img.onload = () => redraw(pageIndex); img.src = a.imageDataUrl; a._img = img;
      }
    });
  }

  /* -------------------- signatures store -------------------- */

  async function listSavedSignatures() {
    const rows = await window.PTDB.getAll('signatures');
    return rows.map((r) => r.value).sort((a, b) => b.created - a.created);
  }
  async function saveSignature(dataUrl, label) {
    const rec = { id: 'sig' + Date.now(), dataUrl, label: label || 'Signature', created: Date.now() };
    await window.PTDB.set('signatures', rec.id, rec);
    return rec;
  }
  async function deleteSignature(id) {
    await window.PTDB.delete('signatures', id);
  }

  /* -------------------- bake into final PDF -------------------- */

  async function bakeIntoDoc(pdfLibDoc, annotationsByPage, PDFLib, pdfjsDoc) {
    const { rgb, degrees, StandardFonts } = PDFLib;
    const helv = await pdfLibDoc.embedFont(StandardFonts.Helvetica);
    const helvBold = await pdfLibDoc.embedFont(StandardFonts.HelveticaBold);
    const imgCache = new Map();

    async function embedImage(doc, dataUrl) {
      if (imgCache.has(dataUrl)) return imgCache.get(dataUrl);
      const res = await fetch(dataUrl);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const isPng = dataUrl.startsWith('data:image/png');
      const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      imgCache.set(dataUrl, img);
      return img;
    }

    for (const [pageIndexStr, anns] of Object.entries(annotationsByPage)) {
      const pageIndex = Number(pageIndexStr);
      if (!anns || !anns.length) continue;
      const page = pdfLibDoc.getPage(pageIndex);
      const pdfjsPage = await pdfjsDoc.getPage(pageIndex + 1);
      const pageRotation = pdfjsPage.rotate || 0;
      const vp = pdfjsPage.getViewport({ scale: 1, rotation: pageRotation });

      const toPdf = (x, y) => vp.convertToPdfPoint(x, y); // returns [x,y] in raw PDF space
      const rotAdjust = (deg) => deg - pageRotation;

      for (const a of anns) {
        try {
          await bakeOne(a);
        } catch (e) { /* one bad annotation shouldn't sink the export */ console.warn('bake skip', a.type, e); }
      }

      async function bakeOne(a) {
        switch (a.type) {
          case 'highlight': {
            const [x0, y0] = toPdf(a.x, a.y + a.height);
            page.drawRectangle({ x: x0, y: y0, width: a.width, height: a.height, color: PTTools.hexToRgb01(a.color), opacity: a.opacity == null ? 0.35 : a.opacity });
            break;
          }
          case 'underline':
          case 'strike': {
            const yFrac = a.type === 'underline' ? a.height - 1 : a.height / 2;
            const [x0, y0] = toPdf(a.x, a.y + yFrac);
            const [x1] = toPdf(a.x + a.width, a.y + yFrac);
            page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y0 }, thickness: Math.max(1, a.height * 0.08), color: PTTools.hexToRgb01(a.color) });
            break;
          }
          case 'draw': {
            const pts = (a.points || []).map((p) => toPdf(p.x, p.y));
            for (let i = 1; i < pts.length; i++) {
              page.drawLine({ start: { x: pts[i - 1][0], y: pts[i - 1][1] }, end: { x: pts[i][0], y: pts[i][1] }, thickness: a.strokeWidth, color: PTTools.hexToRgb01(a.color) });
            }
            break;
          }
          case 'line':
          case 'arrow': {
            const [x0, y0] = toPdf(a.points[0].x, a.points[0].y);
            const [x1, y1] = toPdf(a.points[1].x, a.points[1].y);
            page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: a.strokeWidth, color: PTTools.hexToRgb01(a.color) });
            if (a.type === 'arrow') {
              const ang = Math.atan2(y1 - y0, x1 - x0);
              const hs = 9 + a.strokeWidth;
              const p2 = { x: x1 - hs * Math.cos(ang - 0.4), y: y1 - hs * Math.sin(ang - 0.4) };
              const p3 = { x: x1 - hs * Math.cos(ang + 0.4), y: y1 - hs * Math.sin(ang + 0.4) };
              page.drawLine({ start: { x: x1, y: y1 }, end: p2, thickness: a.strokeWidth, color: PTTools.hexToRgb01(a.color) });
              page.drawLine({ start: { x: x1, y: y1 }, end: p3, thickness: a.strokeWidth, color: PTTools.hexToRgb01(a.color) });
            }
            break;
          }
          case 'rect': {
            const [x0, y0] = toPdf(a.x, a.y + a.height);
            page.drawRectangle({ x: x0, y: y0, width: a.width, height: a.height, borderColor: PTTools.hexToRgb01(a.color), borderWidth: a.strokeWidth, rotate: degrees(rotAdjust(a.rotation || 0)), color: a.fill ? PTTools.hexToRgb01(a.color) : undefined, opacity: a.fill ? 0.2 : undefined, borderOpacity: 1 });
            break;
          }
          case 'ellipse': {
            const [cx, cy] = toPdf(a.x + a.width / 2, a.y + a.height / 2);
            page.drawEllipse({ x: cx, y: cy, xScale: Math.abs(a.width / 2), yScale: Math.abs(a.height / 2), borderColor: PTTools.hexToRgb01(a.color), borderWidth: a.strokeWidth });
            break;
          }
          case 'text': {
            const [x0] = toPdf(a.x, 0);
            const lines = (a.text || '').split('\n');
            lines.forEach((line, i) => {
              const [, ly] = toPdf(0, a.y + 2 + i * a.fontSize * 1.25 + a.fontSize * 0.8);
              page.drawText(line, { x: x0 + 2, y: ly, size: a.fontSize, font: helv, color: PTTools.hexToRgb01(a.color), rotate: degrees(rotAdjust(a.rotation || 0)) });
            });
            break;
          }
          case 'note': {
            const [x0, y0] = toPdf(a.x + a.width / 2, a.y + a.height / 2);
            page.drawText('*', { x: x0 - 3, y: y0 - 5, size: 16, font: helvBold, color: PTTools.hexToRgb01(a.color) });
            if (a.text) page.drawText(('Note: ' + a.text).slice(0, 90), { x: x0 + 10, y: y0 - 4, size: 8, font: helv, color: rgb(0.2, 0.2, 0.2) });
            break;
          }
          case 'stamp': {
            const [x0, y0] = toPdf(a.x, a.y + a.height);
            page.drawRectangle({ x: x0, y: y0, width: a.width, height: a.height, borderColor: PTTools.hexToRgb01(a.color), borderWidth: 3, rotate: degrees(rotAdjust(a.rotation || 0)) });
            const [tx, ty] = toPdf(a.x + a.width / 2, a.y + a.height / 2);
            const size = a.height * 0.4;
            const tw = helvBold.widthOfTextAtSize(a.text, size);
            page.drawText(a.text, { x: tx - tw / 2, y: ty - size / 3, size, font: helvBold, color: PTTools.hexToRgb01(a.color), rotate: degrees(rotAdjust(a.rotation || 0)) });
            break;
          }
          case 'image':
          case 'signature': {
            const img = await embedImage(pdfLibDoc, a.imageDataUrl);
            const [x0, y0] = toPdf(a.x, a.y + a.height);
            page.drawImage(img, { x: x0, y: y0, width: a.width, height: a.height, rotate: degrees(rotAdjust(a.rotation || 0)) });
            break;
          }
        }
      }
    }
  }

  /* -------------------- right-panel UI -------------------- */

  function toolButton(label, tool, svg) {
    return `<button class="tool-card ${state.tool === tool ? 'active' : ''}" data-tool="${tool}">${svg}<span>${label}</span></button>`;
  }

  function renderAnnotatePanel(el) {
    el.innerHTML = `
      <div class="section-title">Draw &amp; markup</div>
      <div class="tool-grid">
        ${toolButton('Select', 'select', icon('cursor'))}
        ${toolButton('Text', 'text', icon('text'))}
        ${toolButton('Highlight', 'highlight', icon('highlight'))}
        ${toolButton('Underline', 'underline', icon('underline'))}
        ${toolButton('Strikethrough', 'strike', icon('strike'))}
        ${toolButton('Freehand', 'draw', icon('pen'))}
        ${toolButton('Rectangle', 'rect', icon('rect'))}
        ${toolButton('Ellipse', 'ellipse', icon('ellipse'))}
        ${toolButton('Line', 'line', icon('line'))}
        ${toolButton('Arrow', 'arrow', icon('arrow'))}
        ${toolButton('Sticky note', 'note', icon('note'))}
        ${toolButton('Image', 'image', icon('image'))}
      </div>
      <hr class="hr">
      <div class="field">
        <label>Color</label>
        <div class="swatches" id="colorSwatches"></div>
      </div>
      <div class="field">
        <label>Stroke / size <span id="strokeVal">${state.strokeWidth}px</span></label>
        <input type="range" min="1" max="20" value="${state.strokeWidth}" id="strokeRange">
      </div>
      <div class="field">
        <label>Font size (text tool) <span id="fontVal">${state.fontSize}px</span></label>
        <input type="range" min="8" max="72" value="${state.fontSize}" id="fontRange">
      </div>
      <hr class="hr">
      <div id="selectionActions"></div>
      <input type="file" id="imageFileInput" accept="image/png,image/jpeg" hidden>
    `;
    const colors = ['#c0392b', '#d69e2e', '#1b7a72', '#2b6fc0', '#7a2bc0', '#14181f', '#ffffff'];
    const sw = el.querySelector('#colorSwatches');
    colors.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'swatch' + (state.color === c ? ' active' : '');
      b.style.background = c; b.style.borderColor = c === '#ffffff' ? '#666' : 'transparent';
      b.onclick = () => { state.color = c; renderAnnotatePanel(el); };
      sw.appendChild(b);
    });
    el.querySelectorAll('[data-tool]').forEach((btn) => btn.onclick = () => {
      state.tool = btn.dataset.tool; state.stampArm = null;
      updateInteractivity();
      if (state.tool === 'image') { el.querySelector('#imageFileInput').click(); state.tool = 'select'; }
      renderAnnotatePanel(el);
    });
    el.querySelector('#strokeRange').oninput = (e) => { state.strokeWidth = +e.target.value; el.querySelector('#strokeVal').textContent = state.strokeWidth + 'px'; };
    el.querySelector('#fontRange').oninput = (e) => { state.fontSize = +e.target.value; el.querySelector('#fontVal').textContent = state.fontSize + 'px'; };
    el.querySelector('#imageFileInput').onchange = (e) => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => placeImageOrSignature(window.PTApp.getCurrentPageIndex(), 'image', reader.result, { width: 220 });
      reader.readAsDataURL(file);
    };
    renderSelectionActions(el.querySelector('#selectionActions'));
  }

  function renderSelectionActions(el) {
    if (!el) return;
    if (!selection) { el.innerHTML = '<p class="hint">Select an object on the page to move, resize, rotate, or delete it.</p>'; return; }
    el.innerHTML = `<button class="btn btn-danger btn-block" id="btnDeleteSel">Delete selected object</button>`;
    el.querySelector('#btnDeleteSel').onclick = () => { deleteSelected(); renderSelectionActions(el); };
  }

  function renderStampsPanel(el) {
    el.innerHTML = `
      <div class="section-title">Stamps</div>
      <div class="tool-grid" id="stampGrid"></div>
      <hr class="hr">
      <div class="section-title">Signatures &amp; initials</div>
      <button class="btn btn-primary btn-block" id="btnNewSig">+ New signature</button>
      <div id="sigList" class="list-simple" style="margin-top:10px;"></div>
    `;
    const grid = el.querySelector('#stampGrid');
    STAMP_PRESETS.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'tool-card' + (state.stampArm && state.stampArm.id === s.id ? ' active' : '');
      b.innerHTML = `<span style="font-family:var(--font-mono);font-weight:700;color:${s.color};font-size:11px;">${s.label}</span>`;
      b.onclick = () => { state.stampArm = s; state.tool = 'select'; updateInteractivity(); window.PTApp.toast('Click a page to place the ' + s.label + ' stamp', 'info'); };
      grid.appendChild(b);
    });
    el.querySelector('#btnNewSig').onclick = () => window.PTApp.openSignatureModal((dataUrl, label) => {
      saveSignature(dataUrl, label).then(() => renderStampsPanel(el));
    });
    listSavedSignatures().then((sigs) => {
      const list = el.querySelector('#sigList');
      if (!sigs.length) { list.innerHTML = '<p class="hint">No saved signatures yet.</p>'; return; }
      list.innerHTML = '';
      sigs.forEach((s) => {
        const row = document.createElement('div');
        row.className = 'sig-item';
        row.innerHTML = `<div class="sig-preview"><img src="${s.dataUrl}" alt="${s.label}"></div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm btn-primary" style="flex:1;">Place on page</button>
            <button class="btn btn-sm btn-danger" title="Delete">✕</button>
          </div>`;
        row.querySelector('.btn-primary').onclick = () => placeImageOrSignature(window.PTApp.getCurrentPageIndex(), 'signature', s.dataUrl, { width: 170 });
        row.querySelector('.btn-danger').onclick = async () => { await deleteSignature(s.id); renderStampsPanel(el); };
        list.appendChild(row);
      });
    });
  }

  function icon(name) {
    const paths = {
      cursor: '<path d="M5 3l14 6-6 2-2 6-6-14Z"/>',
      text: '<path d="M5 6h14M12 6v13"/>',
      highlight: '<path d="M4 20h16M6 15l9-9 3 3-9 9H6v-3Z"/>',
      underline: '<path d="M6 4v7a6 6 0 0 0 12 0V4M4 20h16"/>',
      strike: '<path d="M5 12h14M8 6c0-1.5 1.8-3 4-3s4 1 4 2.6M8 18c0 1.5 1.8 3 4 3s4-1.3 4-3"/>',
      pen: '<path d="M4 20c3-1 5-2 7-4L19 8l-3-3L8 13c-2 2-3 4-4 7Z"/>',
      rect: '<rect x="4" y="6" width="16" height="12" rx="1.5"/>',
      ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>',
      line: '<path d="M5 19 19 5"/>',
      arrow: '<path d="M5 19 19 5M19 5h-6M19 5v6"/>',
      note: '<path d="M5 4h14v11H10l-5 5Z"/>',
      image: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-6-6-9 9"/>',
    };
    return `<svg viewBox="0 0 24 24">${paths[name] || ''}</svg>`;
  }

  window.PTAnnotate = {
    setTool: (t) => { state.tool = t; state.stampArm = null; updateInteractivity(); },
    getTool: () => state.tool,
    getState: () => state,
    getAll, setAll, pageAnns, addAnnotation, removeAnnotation, updateAnnotation,
    registerSurface, unregisterSurface, redraw, hydrateImages,
    setOnChange, setOnSelectionChange, deleteSelected, clearSelection,
    placeImageOrSignature,
    listSavedSignatures, saveSignature, deleteSignature,
    bakeIntoDoc,
    renderAnnotatePanel, renderStampsPanel,
    hasArmedStamp: () => !!state.stampArm,
    SCRIPT_FONTS,
  };
})();
