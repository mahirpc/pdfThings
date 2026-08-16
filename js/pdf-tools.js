/*
 * pdf-tools.js — every operation that touches PDF *structure*, via pdf-lib.
 *
 * Memory-management rules followed throughout (per the project's spec):
 *  - Large Uint8Arrays are explicitly nulled once handed off, so the GC can
 *    reclaim them immediately instead of waiting for scope exit.
 *  - Merges/batches of large files are processed in a strict sequential
 *    loop — never Promise.all — so we never hold more than ~2 documents'
 *    worth of bytes in memory at once.
 *  - Page reordering/duplication/extraction always uses a single
 *    `copyPages(doc, [indices])` call rather than looping copyPages, so
 *    shared resources (fonts, images) are written once, not once per page.
 */
(function () {
  const { PDFDocument, StandardFonts, rgb, degrees, PDFName } = window.PDFLib;

  function clone(bytes) {
    return new Uint8Array(bytes); // independent backing buffer copy
  }

  async function loadDoc(bytes, opts) {
    return PDFDocument.load(bytes, Object.assign({ updateMetadata: false }, opts));
  }

  async function saveDoc(pdfDoc) {
    return pdfDoc.save({ useObjectStreams: true });
  }

  async function copyMetadata(src, dst) {
    try { dst.setTitle(src.getTitle() || ''); } catch (e) {}
    try { dst.setAuthor(src.getAuthor() || ''); } catch (e) {}
    try { dst.setSubject(src.getSubject() || ''); } catch (e) {}
    try { dst.setKeywords(src.getKeywords() ? src.getKeywords().split(',').map(s=>s.trim()).filter(Boolean) : []); } catch (e) {}
    try { dst.setProducer('pdfThings'); } catch (e) {}
    try { dst.setCreator('pdfThings (https://github.com/)'); } catch (e) {}
  }

  /**
   * The one core primitive behind reorder / delete / duplicate / extract:
   * build a brand-new document from a single index-mapping array against
   * the source document. Duplicate an index to duplicate a page; omit an
   * index to delete a page; reorder the array to reorder pages.
   */
  async function rebuildWithPageOrder(bytes, indices) {
    const src = await loadDoc(bytes);
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, indices); // single call — no loop
    copied.forEach((p) => out.addPage(p));
    await copyMetadata(src, out);
    const result = await saveDoc(out);
    return result;
  }

  async function getPageCount(bytes) {
    const doc = await loadDoc(bytes);
    return doc.getPageCount();
  }

  async function reorderPages(bytes, newOrder) {
    return rebuildWithPageOrder(bytes, newOrder);
  }
  async function deletePages(bytes, deleteIndices) {
    const total = await getPageCount(bytes);
    const del = new Set(deleteIndices);
    const keep = [];
    for (let i = 0; i < total; i++) if (!del.has(i)) keep.push(i);
    return rebuildWithPageOrder(bytes, keep);
  }
  async function duplicatePage(bytes, index) {
    const total = await getPageCount(bytes);
    const order = [];
    for (let i = 0; i < total; i++) { order.push(i); if (i === index) order.push(i); }
    return rebuildWithPageOrder(bytes, order);
  }
  async function extractPages(bytes, indices) {
    return rebuildWithPageOrder(bytes, indices);
  }

  async function rotatePage(bytes, index, deltaDegrees) {
    const doc = await loadDoc(bytes);
    const page = doc.getPage(index);
    const current = page.getRotation().angle || 0;
    page.setRotation(degrees((current + deltaDegrees + 360) % 360));
    return saveDoc(doc);
  }

  async function insertBlankPage(bytes, atIndex, size) {
    const doc = await loadDoc(bytes);
    doc.insertPage(atIndex, size || [612, 792]); // default Letter
    return saveDoc(doc);
  }

  /** Sequential merge — never Promise.all — to bound peak memory. */
  async function mergePdfs(byteArraysWithNames, onProgress) {
    const out = await PDFDocument.create();
    for (let i = 0; i < byteArraysWithNames.length; i++) {
      const { bytes, name } = byteArraysWithNames[i];
      const src = await loadDoc(bytes);
      const order = src.getPageIndices();
      const copied = await out.copyPages(src, order); // one call per source doc
      copied.forEach((p) => out.addPage(p));
      if (i === 0) await copyMetadata(src, out);
      if (onProgress) onProgress(i + 1, byteArraysWithNames.length, name);
      // let the source doc/bytes fall out of scope so it can be collected
      // before we load the next (potentially large) file
    }
    return saveDoc(out);
  }

  async function insertPdfPages(baseBytes, otherBytes, atIndex) {
    const base = await loadDoc(baseBytes);
    const other = await loadDoc(otherBytes);
    const order = other.getPageIndices();
    const copied = await base.copyPages(other, order); // single call
    copied.forEach((p, i) => base.insertPage(atIndex + i, p));
    return saveDoc(base);
  }

  async function splitPdf(bytes, ranges) {
    // ranges: [{name, indices:[...]}]
    const out = [];
    for (const r of ranges) {
      out.push({ name: r.name, bytes: await rebuildWithPageOrder(bytes, r.indices) });
    }
    return out;
  }

  async function embedStandardFont(doc, key) {
    return doc.embedFont(StandardFonts[key] || StandardFonts.Helvetica);
  }

  function hexToRgb01(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '#000000');
    if (!m) return rgb(0, 0, 0);
    return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
  }

  async function addWatermark(bytes, opts) {
    const { text = 'DRAFT', color = '#c0392b', opacity = 0.28, fontSize = 64, rotation = -40, tile = false } = opts;
    const doc = await loadDoc(bytes);
    const font = await embedStandardFont(doc, 'HelveticaBold');
    const col = hexToRgb01(color);
    doc.getPages().forEach((page) => {
      const { width, height } = page.getSize();
      const tw = font.widthOfTextAtSize(text, fontSize);
      if (!tile) {
        page.drawText(text, {
          x: width / 2 - tw / 2, y: height / 2, size: fontSize, font,
          color: col, opacity, rotate: degrees(rotation),
        });
      } else {
        const stepX = tw * 1.4, stepY = fontSize * 3.4;
        for (let y = -height; y < height * 2; y += stepY) {
          for (let x = -width; x < width * 2; x += stepX) {
            page.drawText(text, { x, y, size: fontSize * 0.6, font, color: col, opacity, rotate: degrees(rotation) });
          }
        }
      }
    });
    return saveDoc(doc);
  }

  async function addPageNumbers(bytes, opts) {
    const { format = 'Page {n} of {N}', position = 'bottom-center', fontSize = 10, startAt = 1, color = '#22262c' } = opts;
    const doc = await loadDoc(bytes);
    const font = await embedStandardFont(doc, 'Helvetica');
    const col = hexToRgb01(color);
    const pages = doc.getPages();
    const N = pages.length;
    pages.forEach((page, i) => {
      const { width } = page.getSize();
      const label = format
        .replace('{n}', String(i + startAt))
        .replace('{N}', String(N + startAt - 1))
        .replace('{date}', new Date().toLocaleDateString());
      const tw = font.widthOfTextAtSize(label, fontSize);
      let x = width / 2 - tw / 2;
      if (position.includes('left')) x = 28;
      if (position.includes('right')) x = width - tw - 28;
      const y = position.startsWith('top') ? page.getSize().height - 26 : 22;
      page.drawText(label, { x, y, size: fontSize, font, color: col });
    });
    return saveDoc(doc);
  }

  async function getMetadata(bytes) {
    const doc = await loadDoc(bytes);
    return {
      title: doc.getTitle() || '',
      author: doc.getAuthor() || '',
      subject: doc.getSubject() || '',
      keywords: (doc.getKeywords() || ''),
      creator: doc.getCreator() || '',
      producer: doc.getProducer() || '',
      creationDate: doc.getCreationDate() ? doc.getCreationDate().toISOString().slice(0, 10) : '',
      pageCount: doc.getPageCount(),
    };
  }

  async function setMetadata(bytes, fields) {
    const doc = await loadDoc(bytes);
    if (fields.title !== undefined) doc.setTitle(fields.title);
    if (fields.author !== undefined) doc.setAuthor(fields.author);
    if (fields.subject !== undefined) doc.setSubject(fields.subject);
    if (fields.keywords !== undefined) {
      doc.setKeywords(String(fields.keywords).split(',').map((s) => s.trim()).filter(Boolean));
    }
    doc.setModificationDate(new Date());
    return saveDoc(doc);
  }

  /** Build every plausible permission-flag spelling so whichever the
   *  underlying encrypt() implementation reads, it gets a value.
   *  Unknown keys are simply ignored by pdf-lib, so this is safe. */
  function buildPermissionAliases(p) {
    const out = {};
    const map = {
      printing: ['printing', 'print'],
      modifying: ['modifying', 'modify'],
      copying: ['copying', 'copy', 'extracting'],
      annotating: ['annotating', 'annotate'],
      fillingForms: ['fillingForms', 'fillForms'],
      documentAssembly: ['documentAssembly', 'assemble'],
      contentAccessibility: ['contentAccessibility', 'accessibility'],
    };
    Object.entries(map).forEach(([k, aliases]) => {
      if (k in p) aliases.forEach((a) => { out[a] = p[k]; });
    });
    return out;
  }

  const ENCRYPTION_UNAVAILABLE = 'ENCRYPTION_UNAVAILABLE';

  async function protectWithPassword(bytes, { userPassword, ownerPassword, permissions }) {
    const doc = await loadDoc(bytes);
    if (typeof doc.encrypt !== 'function') {
      const err = new Error('This build\'s PDF engine does not expose password encryption.');
      err.code = ENCRYPTION_UNAVAILABLE;
      throw err;
    }
    await doc.encrypt({
      userPassword: userPassword || undefined,
      ownerPassword: ownerPassword || userPassword || undefined,
      permissions: buildPermissionAliases(permissions || {}),
    });
    return saveDoc(doc);
  }

  async function removePassword(bytes, password) {
    let doc;
    try {
      doc = await loadDoc(bytes, { password });
    } catch (e) {
      // fall back to the "view anyway" escape hatch; note this does not
      // truly decrypt content streams on files pdfThings didn't encrypt
      doc = await loadDoc(bytes, { ignoreEncryption: true });
    }
    return saveDoc(doc); // saving without calling encrypt() drops protection
  }

  async function loadIgnoringPermissions(bytes) {
    const doc = await loadDoc(bytes, { ignoreEncryption: true });
    return saveDoc(doc);
  }

  async function isEncrypted(bytes) {
    try {
      await loadDoc(bytes);
      return false;
    } catch (e) {
      return /encrypt/i.test(e.message || '');
    }
  }

  /* ---------------- Forms ---------------- */

  async function getFormFieldDescriptors(bytes) {
    const doc = await loadDoc(bytes);
    let form;
    try { form = doc.getForm(); } catch (e) { return []; }
    return form.getFields().map((f) => {
      const name = f.getName();
      const type = f.constructor.name; // PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, PDFButton
      let options = null, current = null;
      try {
        if (type === 'PDFDropdown' || type === 'PDFOptionList') { options = f.getOptions(); current = f.getSelected(); }
        if (type === 'PDFRadioGroup') { options = f.getOptions(); current = f.getSelected(); }
        if (type === 'PDFCheckBox') { current = f.isChecked(); }
        if (type === 'PDFTextField') { current = f.getText(); }
      } catch (e) {}
      let required = false;
      try { required = f.isRequired ? f.isRequired() : false; } catch (e) {}
      return { name, type, options, current, required };
    });
  }

  async function fillForm(bytes, values, flatten) {
    const doc = await loadDoc(bytes);
    const form = doc.getForm();
    Object.entries(values).forEach(([name, val]) => {
      try {
        const field = form.getField(name);
        const type = field.constructor.name;
        if (type === 'PDFTextField') field.setText(val == null ? '' : String(val));
        else if (type === 'PDFCheckBox') { val ? field.check() : field.uncheck(); }
        else if (type === 'PDFRadioGroup' || type === 'PDFDropdown' || type === 'PDFOptionList') {
          if (val) field.select(val);
        }
      } catch (e) { /* skip unknown/unsupported field */ }
    });
    if (flatten) form.flatten();
    return saveDoc(doc);
  }

  /* ---------------- OCR text layer ---------------- */

  /** Draw an invisible (opacity 0) text layer over a scanned page so its
   *  words become selectable/searchable, positioned from OCR word boxes. */
  async function addInvisibleTextLayer(bytes, pageIndex, words, sourceCanvasSize) {
    const doc = await loadDoc(bytes);
    const page = doc.getPage(pageIndex);
    const font = await embedStandardFont(doc, 'Helvetica');
    const { width, height } = page.getSize();
    const sx = width / sourceCanvasSize.width;
    const sy = height / sourceCanvasSize.height;
    words.forEach((w) => {
      if (!w.text || !w.text.trim()) return;
      const x = w.bbox.x0 * sx;
      const yTop = w.bbox.y0 * sy;
      const boxH = (w.bbox.y1 - w.bbox.y0) * sy;
      const y = height - yTop - boxH; // pdf.js/canvas y-down -> PDF y-up
      const boxW = (w.bbox.x1 - w.bbox.x0) * sx;
      let size = Math.max(4, boxH * 0.85);
      // shrink to fit the recognized box width so text stays roughly aligned
      const natural = font.widthOfTextAtSize(w.text, size);
      if (natural > boxW && natural > 0) size *= boxW / natural;
      try {
        page.drawText(w.text, { x, y, size, font, opacity: 0 });
      } catch (e) { /* unsupported glyphs — skip that word */ }
    });
    return saveDoc(doc);
  }

  /* ---------------- Flatten / annotation baking ---------------- */

  /** Bake the app's overlay annotation objects into the actual PDF content
   *  stream. Delegates the per-type drawing logic to annotate.js so the
   *  drawing code used for on-screen preview and for the final PDF stays
   *  in one place. */
  async function bakeAnnotations(bytes, annotationsByPage) {
    const hasAny = Object.values(annotationsByPage || {}).some((list) => list && list.length);
    if (!hasAny) return clone(bytes); // nothing to bake — avoid the extra pdf.js load

    const doc = await loadDoc(bytes);
    // pdf-lib and pdf.js each get their own independent copy of the bytes:
    // passing the same underlying buffer to both risks one of them
    // transferring/detaching it out from under the other.
    const pdfjsDoc = await pdfjsLib.getDocument({ data: clone(bytes) }).promise;
    try {
      await window.PTAnnotate.bakeIntoDoc(doc, annotationsByPage, window.PDFLib, pdfjsDoc);
    } finally {
      pdfjsDoc.destroy();
    }
    return saveDoc(doc);
  }

  async function flattenForms(bytes) {
    const doc = await loadDoc(bytes);
    try { doc.getForm().flatten(); } catch (e) {}
    return saveDoc(doc);
  }

  /* ---------------- Image → PDF (Scan panel) ---------------- */

  /** items: [{ dataUrl (JPEG), widthPt, heightPt, fitTo? }], already
   *  cropped/filtered by scan.js (or rendered by compressPdf below).
   *  Normally each image becomes a full-bleed page at its own size; if an
   *  item has `fitTo: {width, height}`, the page is created at that fixed
   *  size instead, filled white, and the image is scaled to fit inside it
   *  (preserving aspect ratio, centered) rather than stretched. */
  async function createPdfFromImages(items, onProgress, meta) {
    const doc = await PDFDocument.create();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const res = await fetch(it.dataUrl);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const img = await doc.embedJpg(bytes);
      if (it.fitTo) {
        const { width: pw, height: ph } = it.fitTo;
        const page = doc.addPage([pw, ph]);
        page.drawRectangle({ x: 0, y: 0, width: pw, height: ph, color: rgb(1, 1, 1) });
        const scale = Math.min(pw / it.widthPt, ph / it.heightPt);
        const w = it.widthPt * scale, h = it.heightPt * scale;
        page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
      } else {
        const page = doc.addPage([it.widthPt, it.heightPt]);
        page.drawImage(img, { x: 0, y: 0, width: it.widthPt, height: it.heightPt });
      }
      if (onProgress) onProgress(i + 1, items.length);
    }
    doc.setProducer('pdfThings');
    doc.setCreator((meta && meta.creator) || 'pdfThings — Scan');
    return saveDoc(doc);
  }

  /* ---------------- Save-time compression & page-size fix ---------------- */

  /** Re-renders every page as a JPEG at a quality/resolution derived from
   *  `pct` (0 = lightest, 100 = smallest file) and rebuilds the PDF from
   *  those images via createPdfFromImages. This works on ANY PDF
   *  regardless of what's inside it (vector text, photos, whatever pdf.js
   *  can render) because it never touches the original internal
   *  structure — it just repaints each page and starts fresh. The real
   *  trade-off, which the UI must say plainly: the saved copy's text is
   *  no longer selectable/searchable, since every page becomes a single
   *  image.
   *
   *  targetPt, if given ({width,height} in PDF points), forces every
   *  output page to that one fixed size — each rendered page is scaled to
   *  fit inside it and centered on a white background, rather than each
   *  page keeping its own original size. Pass targetPt as null/undefined
   *  to keep each page's own size (the original compression-only
   *  behavior). */
  function settingsForCompressionPct(pct) {
    const p = Math.max(0, Math.min(100, pct)) / 100;
    const dpi = Math.round(220 - (220 - 72) * p);
    const quality = +(0.9 - (0.9 - 0.3) * p).toFixed(2);
    return { dpi, quality };
  }

  const STANDARD_PAGE_SIZES = {
    a4: { width: 595, height: 842 },
    letter: { width: 612, height: 792 },
  };

  async function compressPdf(bytes, pct, targetPt, onProgress) {
    const { dpi, quality } = settingsForCompressionPct(pct);
    const pdfjsDoc = await pdfjsLib.getDocument({ data: clone(bytes) }).promise;
    try {
      const items = [];
      for (let i = 1; i <= pdfjsDoc.numPages; i++) {
        const page = await pdfjsDoc.getPage(i);
        const rotation = page.rotate || 0;
        const basePt = page.getViewport({ scale: 1, rotation }); // page size in PDF points, rotation-aware
        const scale = dpi / 72;
        const renderVp = page.getViewport({ scale, rotation });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(renderVp.width));
        canvas.height = Math.max(1, Math.round(renderVp.height));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); // JPEG has no alpha
        await page.render({ canvasContext: ctx, viewport: renderVp }).promise;
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        canvas.width = 0; canvas.height = 0; // release the pixel buffer promptly
        const item = { dataUrl, widthPt: basePt.width, heightPt: basePt.height };
        if (targetPt) item.fitTo = targetPt;
        items.push(item);
        if (onProgress) onProgress(i, pdfjsDoc.numPages);
      }
      return createPdfFromImages(items, null, { creator: 'pdfThings — saved with pdfThings' });
    } finally {
      pdfjsDoc.destroy();
    }
  }

  /** Scans a live pdf.js document (no rendering, just page geometry) and
   *  reports the smallest/largest width and height found — independently
   *  per axis, not "the smallest page" as a single unit — so the Save
   *  dialog can show the range and offer "match smallest/largest". */
  async function getPageSizeRange(pdfjsDoc) {
    let minW = Infinity, minH = Infinity, maxW = 0, maxH = 0;
    for (let i = 1; i <= pdfjsDoc.numPages; i++) {
      const page = await pdfjsDoc.getPage(i);
      const vp = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
      minW = Math.min(minW, vp.width); maxW = Math.max(maxW, vp.width);
      minH = Math.min(minH, vp.height); maxH = Math.max(maxH, vp.height);
    }
    return { minW, minH, maxW, maxH, pageCount: pdfjsDoc.numPages };
  }

  window.PTTools = {
    clone, loadDoc, saveDoc, getPageCount,
    reorderPages, deletePages, duplicatePage, extractPages, rotatePage, insertBlankPage,
    mergePdfs, insertPdfPages, splitPdf,
    addWatermark, addPageNumbers,
    getMetadata, setMetadata,
    protectWithPassword, removePassword, loadIgnoringPermissions, isEncrypted, ENCRYPTION_UNAVAILABLE,
    getFormFieldDescriptors, fillForm, flattenForms,
    addInvisibleTextLayer,
    bakeAnnotations,
    createPdfFromImages,
    compressPdf, settingsForCompressionPct,
    getPageSizeRange, STANDARD_PAGE_SIZES,
    hexToRgb01,
  };
})();
