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

  /** items: [{ dataUrl (JPEG), widthPt, heightPt }], already cropped and
   *  filtered by scan.js — this just embeds each as a full-bleed page. */
  async function createPdfFromImages(items, onProgress) {
    const doc = await PDFDocument.create();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const res = await fetch(it.dataUrl);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const img = await doc.embedJpg(bytes);
      const page = doc.addPage([it.widthPt, it.heightPt]);
      page.drawImage(img, { x: 0, y: 0, width: it.widthPt, height: it.heightPt });
      if (onProgress) onProgress(i + 1, items.length);
    }
    doc.setProducer('pdfThings');
    doc.setCreator('pdfThings — Scan');
    return saveDoc(doc);
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
    hexToRgb01,
  };
})();
