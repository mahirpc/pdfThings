/*
 * scan.js — "Scan" panel: turn photos of pages into a PDF.
 *
 * Each added image gets its own lightweight state (rotation, crop rect,
 * brightness/contrast/grayscale) rather than being destructively edited,
 * so reopening the editor always starts from the original photo. Source
 * images are downscaled once on import (long edge capped) to keep memory
 * bounded for a multi-page phone-camera scan session, consistent with
 * the rest of the app's memory discipline.
 */
(function () {
  const MAX_SOURCE_DIM = 2200; // longest edge, px — plenty for readable text, bounds memory
  const OUTPUT_DPI = 150; // used only to size the PDF page from cropped pixel dimensions
  const JPEG_QUALITY = 0.88;

  let items = []; // { id, img, rotation, crop:{x,y,w,h}, brightness, contrast, grayscale, thumb }
  let nextId = 1;
  let sortable = null;

  /* -------------------- image loading -------------------- */

  function fileToImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read ' + file.name)); };
      img.src = url;
    });
  }

  function downscale(img) {
    const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
    if (longEdge <= MAX_SOURCE_DIM) return img;
    const scale = MAX_SOURCE_DIM / longEdge;
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const out = new Image();
    out.src = c.toDataURL('image/jpeg', 0.92);
    c.width = 0; c.height = 0; // release the scratch canvas's pixel buffer
    return out; // caller awaits whenReady() before using this
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    for (const file of files) {
      try {
        const raw = await fileToImage(file);
        const img = downscale(raw);
        await whenReady(img);
        const item = {
          id: 'img' + nextId++,
          name: file.name,
          img,
          rotation: 0,
          crop: { x: 0, y: 0, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height },
          brightness: 0, contrast: 0, grayscale: false,
          thumb: null,
        };
        item.rotatedCanvas = buildRotatedCanvas(item);
        item.crop = fullCrop(item);
        refreshThumb(item);
        items.push(item);
      } catch (e) {
        window.PTApp.toast(e.message, 'error');
      }
    }
    rerenderList();
  }

  function whenReady(img) {
    if (img.complete && img.naturalWidth) return Promise.resolve();
    return new Promise((resolve) => { img.onload = resolve; });
  }

  /* -------------------- processing pipeline -------------------- */

  function buildRotatedCanvas(item) {
    const w0 = item.img.naturalWidth, h0 = item.img.naturalHeight;
    const swap = item.rotation === 90 || item.rotation === 270;
    const cw = swap ? h0 : w0, ch = swap ? w0 : h0;
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const ctx = c.getContext('2d');
    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate((item.rotation * Math.PI) / 180);
    ctx.drawImage(item.img, -w0 / 2, -h0 / 2);
    ctx.restore();
    return c;
  }
  function fullCrop(item) {
    return { x: 0, y: 0, w: item.rotatedCanvas.width, h: item.rotatedCanvas.height };
  }
  function filterString(item) {
    const b = 100 + Math.round(item.brightness);
    const c = 100 + Math.round(item.contrast);
    return `brightness(${b}%) contrast(${c}%)${item.grayscale ? ' grayscale(1)' : ''}`;
  }
  /** Renders the current crop+filter to a new canvas at up to maxDim long edge. */
  function renderOutput(item, maxDim) {
    const cw = item.crop.w, ch = item.crop.h;
    const scale = maxDim ? Math.min(1, maxDim / Math.max(cw, ch)) : 1;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(cw * scale));
    out.height = Math.max(1, Math.round(ch * scale));
    const ctx = out.getContext('2d');
    ctx.filter = filterString(item);
    ctx.drawImage(item.rotatedCanvas, item.crop.x, item.crop.y, cw, ch, 0, 0, out.width, out.height);
    return out;
  }
  function refreshThumb(item) {
    const c = renderOutput(item, 220);
    item.thumb = c.toDataURL('image/jpeg', 0.82);
    c.width = 0; c.height = 0;
  }

  function rotateItem(item, delta) {
    item.rotation = (item.rotation + delta + 360) % 360;
    item.rotatedCanvas = buildRotatedCanvas(item);
    item.crop = fullCrop(item); // a crop from the old orientation rarely still makes sense
  }

  function removeItem(id) {
    items = items.filter((i) => i.id !== id);
    rerenderList();
  }

  /* -------------------- panel -------------------- */

  function renderPanel(el) {
    el.innerHTML = `
      <div class="section-title">Scan — build a PDF from photos</div>
      <p class="hint">Add a photo per page, crop it tight, and adjust brightness/contrast so text is easy to read. Pages are created in the order below.</p>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-primary" id="btnAddLibrary" style="flex:1;">+ Add photos</button>
        <button class="btn" id="btnAddCamera" style="flex:1;">Camera</button>
      </div>
      <input type="file" id="scanLibraryInput" accept="image/*" multiple hidden>
      <input type="file" id="scanCameraInput" accept="image/*" capture="environment" hidden>
      <hr class="hr">
      <div id="scanList" class="list-simple"></div>
      <hr class="hr" id="scanFootRule" ${items.length ? '' : 'hidden'}>
      <div id="scanFoot"></div>
    `;
    el.querySelector('#btnAddLibrary').onclick = () => el.querySelector('#scanLibraryInput').click();
    el.querySelector('#btnAddCamera').onclick = () => el.querySelector('#scanCameraInput').click();
    el.querySelector('#scanLibraryInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
    el.querySelector('#scanCameraInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
    renderList(el);
  }

  function rerenderList() {
    const el = document.getElementById('ctxBody');
    if (el && el.querySelector('#scanList')) renderList(el);
  }

  function renderList(root) {
    const list = root.querySelector('#scanList');
    const foot = root.querySelector('#scanFoot');
    const rule = root.querySelector('#scanFootRule');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = `<p class="hint">No pages added yet.</p>`;
      if (foot) foot.innerHTML = '';
      if (rule) rule.hidden = true;
      return;
    }
    if (rule) rule.hidden = false;
    list.innerHTML = '';
    items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'sig-item scan-row';
      row.dataset.id = item.id;
      row.innerHTML = `
        <div style="display:flex;gap:10px;align-items:center;">
          <div class="scan-drag" title="Drag to reorder">⠿</div>
          <div class="sig-preview" style="width:52px;height:68px;flex:none;"><img src="${item.thumb}" alt=""></div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:12.5px;font-weight:600;">Page ${i + 1}</div>
            <div style="font-size:11px;color:var(--ink-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.name)}</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <button class="btn btn-sm" style="flex:1;" data-act="edit">Crop &amp; adjust</button>
          <button class="btn btn-sm btn-danger" data-act="remove">Delete</button>
        </div>`;
      row.querySelector('[data-act="edit"]').onclick = () => openEditor(item, root);
      row.querySelector('[data-act="remove"]').onclick = () => removeItem(item.id);
      list.appendChild(row);
    });
    if (sortable) sortable.destroy();
    sortable = new Sortable(list, {
      handle: '.scan-drag', animation: 150, ghostClass: 'sortable-ghost',
      onEnd: (evt) => {
        if (evt.oldIndex === evt.newIndex) return;
        const [moved] = items.splice(evt.oldIndex, 1);
        items.splice(evt.newIndex, 0, moved);
        renderList(root);
      },
    });
    foot.innerHTML = `
      <button class="btn btn-primary btn-block" id="btnCreatePdf">Create PDF from ${items.length} page${items.length === 1 ? '' : 's'}</button>
      <label class="checkline" style="margin-top:8px;"><input type="checkbox" id="scanOpenAfter" checked> Open it in the editor when done</label>
      <button class="btn btn-block" id="btnClearAll" style="margin-top:8px;">Clear all</button>
    `;
    foot.querySelector('#btnCreatePdf').onclick = () => createPdf(foot.querySelector('#scanOpenAfter').checked);
    foot.querySelector('#btnClearAll').onclick = () => { if (confirm('Remove all added photos?')) { items = []; renderList(root); } };
  }

  /* -------------------- crop & adjust modal -------------------- */

  function openEditor(item, panelRoot) {
    let crop = Object.assign({}, item.crop);
    const displayMax = 380;
    const scale = Math.min(1, displayMax / Math.max(item.rotatedCanvas.width, item.rotatedCanvas.height));
    const dispW = Math.round(item.rotatedCanvas.width * scale);
    const dispH = Math.round(item.rotatedCanvas.height * scale);

    const { card, close } = window.PTApp.openModal({
      title: 'Crop & adjust', wide: true,
      bodyHtml: `
        <div class="crop-stage" id="cropStage" style="width:${dispW}px;height:${dispH}px;">
          <canvas id="cropCanvas" width="${dispW}" height="${dispH}"></canvas>
          <div class="crop-rect" id="cropRect">
            <div class="crop-handle nw" data-h="nw"></div>
            <div class="crop-handle ne" data-h="ne"></div>
            <div class="crop-handle sw" data-h="sw"></div>
            <div class="crop-handle se" data-h="se"></div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <button class="btn btn-sm" id="rotL" style="flex:1;">Rotate ↺</button>
          <button class="btn btn-sm" id="rotR" style="flex:1;">Rotate ↻</button>
          <button class="btn btn-sm" id="resetCrop" style="flex:1;">Reset crop</button>
        </div>
        <div class="field" style="margin-top:12px;"><label>Brightness <span id="brVal">${item.brightness}</span></label>
          <input type="range" id="brRange" min="-100" max="100" value="${item.brightness}"></div>
        <div class="field"><label>Contrast <span id="coVal">${item.contrast}</span></label>
          <input type="range" id="coRange" min="-100" max="100" value="${item.contrast}"></div>
        <label class="checkline"><input type="checkbox" id="grayChk" ${item.grayscale ? 'checked' : ''}> Grayscale (often improves scanned-text clarity)</label>
      `,
      footHtml: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="applyEdit">Apply</button>`,
      onMount: (modalCard) => setupEditor(modalCard),
    });

    function setupEditor(modalCard) {
      const stage = modalCard.querySelector('#cropStage');
      const canvas = modalCard.querySelector('#cropCanvas');
      const rectEl = modalCard.querySelector('#cropRect');
      const ctx = canvas.getContext('2d');

      function drawPreview() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.filter = filterString({ brightness: +modalCard.querySelector('#brRange').value, contrast: +modalCard.querySelector('#coRange').value, grayscale: modalCard.querySelector('#grayChk').checked });
        ctx.drawImage(item.rotatedCanvas, 0, 0, dispW, dispH);
        ctx.filter = 'none';
      }
      function syncRectStyle() {
        rectEl.style.left = crop.x * scale + 'px';
        rectEl.style.top = crop.y * scale + 'px';
        rectEl.style.width = crop.w * scale + 'px';
        rectEl.style.height = crop.h * scale + 'px';
      }
      drawPreview();
      syncRectStyle();

      modalCard.querySelector('#brRange').oninput = (e) => { modalCard.querySelector('#brVal').textContent = e.target.value; drawPreview(); };
      modalCard.querySelector('#coRange').oninput = (e) => { modalCard.querySelector('#coVal').textContent = e.target.value; drawPreview(); };
      modalCard.querySelector('#grayChk').onchange = drawPreview;

      modalCard.querySelector('#resetCrop').onclick = () => { crop = fullCrop(item); syncRectStyle(); };
      modalCard.querySelector('#rotL').onclick = () => { rotateInModal(-90); };
      modalCard.querySelector('#rotR').onclick = () => { rotateInModal(90); };
      function rotateInModal(delta) {
        item.rotation = (item.rotation + delta + 360) % 360;
        item.rotatedCanvas = buildRotatedCanvas(item);
        crop = fullCrop(item);
        close();
        openEditor(item, panelRoot); // reopen fresh at the new orientation/size
      }

      // drag the whole rect to move it
      let drag = null;
      rectEl.addEventListener('pointerdown', (evt) => {
        if (evt.target.dataset.h) return; // handles manage their own drag below
        evt.stopPropagation();
        rectEl.setPointerCapture(evt.pointerId);
        drag = { mode: 'move', startX: evt.clientX, startY: evt.clientY, orig: Object.assign({}, crop) };
      });
      rectEl.querySelectorAll('.crop-handle').forEach((h) => h.addEventListener('pointerdown', (evt) => {
        evt.stopPropagation();
        h.setPointerCapture(evt.pointerId);
        drag = { mode: 'resize', handle: h.dataset.h, startX: evt.clientX, startY: evt.clientY, orig: Object.assign({}, crop) };
      }));
      stage.addEventListener('pointermove', (evt) => {
        if (!drag) return;
        const dx = (evt.clientX - drag.startX) / scale, dy = (evt.clientY - drag.startY) / scale;
        const maxW = item.rotatedCanvas.width, maxH = item.rotatedCanvas.height;
        if (drag.mode === 'move') {
          crop.x = clamp(drag.orig.x + dx, 0, maxW - crop.w);
          crop.y = clamp(drag.orig.y + dy, 0, maxH - crop.h);
        } else {
          let { x, y, w, h } = drag.orig;
          const minSize = 24;
          if (drag.handle.includes('e')) w = clamp(drag.orig.w + dx, minSize, maxW - x);
          if (drag.handle.includes('s')) h = clamp(drag.orig.h + dy, minSize, maxH - y);
          if (drag.handle.includes('w')) { const nx = clamp(drag.orig.x + dx, 0, drag.orig.x + drag.orig.w - minSize); w = drag.orig.w + (drag.orig.x - nx); x = nx; }
          if (drag.handle.includes('n')) { const ny = clamp(drag.orig.y + dy, 0, drag.orig.y + drag.orig.h - minSize); h = drag.orig.h + (drag.orig.y - ny); y = ny; }
          crop = { x, y, w, h };
        }
        syncRectStyle();
      });
      ['pointerup', 'pointercancel'].forEach((ev) => stage.addEventListener(ev, () => { drag = null; }));

      modalCard.querySelector('#applyEdit').onclick = () => {
        item.brightness = +modalCard.querySelector('#brRange').value;
        item.contrast = +modalCard.querySelector('#coRange').value;
        item.grayscale = modalCard.querySelector('#grayChk').checked;
        item.crop = Object.assign({}, crop);
        refreshThumb(item);
        close();
        renderList(panelRoot);
      };
    }
  }
  function clamp(v, min, max) {
    if (max < min) max = min;
    return Math.max(min, Math.min(max, v));
  }

  /* -------------------- build the PDF -------------------- */

  async function createPdf(openAfter) {
    if (!items.length) return;
    window.PTApp.toast('Building PDF from ' + items.length + ' page(s)…', 'info');
    try {
      const payload = items.map((item) => {
        const out = renderOutput(item, 2200);
        const dataUrl = out.toDataURL('image/jpeg', JPEG_QUALITY);
        const widthPt = (out.width / OUTPUT_DPI) * 72;
        const heightPt = (out.height / OUTPUT_DPI) * 72;
        out.width = 0; out.height = 0; // release the scratch canvas promptly
        return { dataUrl, widthPt, heightPt };
      });
      const bytes = await window.PTTools.createPdfFromImages(payload);
      if (openAfter && window.PTApp.openBytesAsDocument) {
        const opened = await window.PTApp.openBytesAsDocument(bytes, 'Scanned-' + Date.now() + '.pdf');
        if (!opened) { window.PTApp.toast('Kept your photos — nothing was discarded.', 'info'); return; }
        items = [];
        window.PTApp.toast('PDF created and opened', 'success');
      } else {
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'Scanned-' + Date.now() + '.pdf';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        items = [];
        window.PTApp.toast('PDF downloaded', 'success');
      }
      const el = document.getElementById('ctxBody');
      if (el) renderPanel(el);
    } catch (e) {
      console.error(e);
      window.PTApp.toast('Could not build the PDF: ' + e.message, 'error');
    }
  }

  function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  window.PTScan = { renderPanel };
})();
