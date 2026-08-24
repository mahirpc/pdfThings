/*
 * app.js — orchestration layer: document state, page rendering (with
 * viewport virtualization), the right-hand context panel router, modals,
 * undo/redo, save/export, and the empty-state / recent-files screen.
 */
(function () {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const HISTORY_CAP = 15;

  const state = {
    fileName: null,
    workingBytes: null,
    pdfjsDoc: null,
    numPages: 0,
    currentPageIndex: 0,
    zoom: 1,
    fitWidth: true,
    dark: false,
    dirty: false,
    fileHandle: null,
    history: [],
    histIndex: -1,
    activePanel: 'view',
    pageObservers: null,
    pageSizesAtScale1: [],
  };

  /* ---------------- DOM shortcuts ---------------- */
  const $ = (sel) => document.querySelector(sel);
  const el = {
    appBody: $('.app-body'),
    topbar: $('.topbar'),
    docName: $('#docName'),
    dirtyDot: $('#dirtyDot'),
    btnSave: $('#btnSave'),
    btnUndo: $('#btnUndo'),
    btnRedo: $('#btnRedo'),
    zoomLabel: $('#zoomLabel'),
    rail: $('#rail'),
    thumbRail: $('#thumbRail'),
    thumbList: $('#thumbList'),
    viewport: $('#viewport'),
    emptyState: $('#emptyState'),
    dropZone: $('#dropZone'),
    fileInput: $('#fileInput'),
    pageScroller: $('#pageScroller'),
    recentsWrap: $('#recentsWrap'),
    recentsList: $('#recentsList'),
    contextPanel: $('#contextPanel'),
    ctxTitle: $('#ctxTitle'),
    ctxBody: $('#ctxBody'),
    toastStack: $('#toastStack'),
    modalRoot: $('#modalRoot'),
    floatingToolbar: $('#floatingToolbar'),
  };

  const PANEL_TITLES = { view: 'View', pages: 'Pages', scan: 'Scan', annotate: 'Annotate', stamps: 'Sign', forms: 'Forms', ocr: 'OCR', ai: 'Text tools', security: 'Security', settings: 'Settings' };

  /* ================= toast ================= */
  function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    el.toastStack.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .25s'; setTimeout(() => t.remove(), 260); }, 2600);
  }

  /* ================= modal helper ================= */
  function openModal({ title, bodyHtml, footHtml, wide, onMount, onClose }) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal-card ${wide ? 'wide' : ''}">
        <div class="modal-head"><h3>${title}</h3><button class="icon-btn small" data-close>✕</button></div>
        <div class="modal-body">${bodyHtml}</div>
        ${footHtml ? `<div class="modal-foot">${footHtml}</div>` : ''}
      </div>`;
    el.modalRoot.appendChild(backdrop);
    function close() { backdrop.remove(); if (onClose) onClose(); }
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelectorAll('[data-close]').forEach((b) => b.onclick = close);
    const card = backdrop.querySelector('.modal-card');
    if (onMount) onMount(card, close);
    return { close, card };
  }

  /* ================= dark mode ================= */
  function applyDark(v) {
    state.dark = v;
    el.viewport.dataset.theme = v ? 'dark-canvas' : '';
    el.contextPanel.style.colorScheme = '';
    PTDB.set('settings', 'darkMode', v);
  }

  /* ================= panel switching ================= */
  function switchPanel(name) {
    state.activePanel = name;
    el.ctxTitle.textContent = PANEL_TITLES[name];
    document.querySelectorAll('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
    renderPanel(name);
    if (window.innerWidth <= 980) { el.contextPanel.classList.add('open'); showScrim('ctx'); }
  }

  function renderPanel(name) {
    const body = el.ctxBody;
    if (name === 'view') return renderViewPanel(body);
    if (name === 'pages') return renderPagesPanel(body);
    if (name === 'scan') return PTScan.renderPanel(body);
    if (name === 'annotate') return PTAnnotate.renderAnnotatePanel(body);
    if (name === 'stamps') return PTAnnotate.renderStampsPanel(body);
    if (name === 'forms') return PTForms.renderPanel(body);
    if (name === 'ocr') return PTOcr.renderPanel(body);
    if (name === 'ai') return PTAi.renderPanel(body);
    if (name === 'security') return renderSecurityPanel(body);
    if (name === 'settings') return renderSettingsPanel(body);
  }

  /* ================= view panel ================= */
  function renderViewPanel(body) {
    if (!state.workingBytes) { body.innerHTML = '<p class="hint">Open a PDF to see view options.</p>'; return; }
    const sizeKb = Math.round(state.workingBytes.length / 1024);
    body.innerHTML = `
      <div class="section-title">Zoom</div>
      <div class="chip-row">
        <button class="chip" id="vZoomOut">−</button>
        <span class="chip" style="cursor:default;">${Math.round(state.zoom * 100)}%</span>
        <button class="chip" id="vZoomIn">+</button>
        <button class="chip ${state.fitWidth ? 'active' : ''}" id="vFitWidth">Fit width</button>
      </div>
      <hr class="hr">
      <div class="section-title">Current page</div>
      <div class="chip-row">
        <button class="chip" id="vRotateL">Rotate ↺</button>
        <button class="chip" id="vRotateR">Rotate ↻</button>
      </div>
      <hr class="hr">
      <div class="section-title">Find in document</div>
      <div class="field"><input type="text" id="searchBox" placeholder="Search text…"></div>
      <div id="searchResults" class="list-simple"></div>
      <hr class="hr">
      <div class="section-title">Document</div>
      <p class="hint">${state.numPages} page${state.numPages === 1 ? '' : 's'} · ${sizeKb} KB · ${escapeHtml(state.fileName || '')}</p>
    `;
    body.querySelector('#vZoomOut').onclick = () => setZoom(state.zoom - 0.1);
    body.querySelector('#vZoomIn').onclick = () => setZoom(state.zoom + 0.1);
    body.querySelector('#vFitWidth').onclick = () => { state.fitWidth = true; fitToWidth(); renderViewPanel(body); };
    body.querySelector('#vRotateL').onclick = () => rotateCurrentPage(-90);
    body.querySelector('#vRotateR').onclick = () => rotateCurrentPage(90);
    let searchTimer;
    body.querySelector('#searchBox').oninput = (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(e.target.value, body.querySelector('#searchResults')), 250);
    };
  }

  async function runSearch(query, resultsEl) {
    if (!query || query.trim().length < 2) { resultsEl.innerHTML = ''; return; }
    resultsEl.innerHTML = '<p class="hint">Searching…</p>';
    const q = query.toLowerCase();
    const hits = [];
    for (let i = 0; i < state.numPages; i++) {
      const page = await state.pdfjsDoc.getPage(i + 1);
      const content = await page.getTextContent();
      const text = content.items.map((it) => it.str).join(' ').toLowerCase();
      const count = text.split(q).length - 1;
      if (count > 0) hits.push({ page: i, count });
    }
    if (!hits.length) { resultsEl.innerHTML = '<p class="hint">No matches.</p>'; return; }
    resultsEl.innerHTML = '';
    hits.forEach((h) => {
      const row = document.createElement('div');
      row.className = 'chip';
      row.style.cursor = 'pointer';
      row.textContent = `Page ${h.page + 1} · ${h.count} match${h.count === 1 ? '' : 'es'}`;
      row.onclick = () => jumpToPage(h.page, true);
      resultsEl.appendChild(row);
    });
  }

  /* ================= pages panel ================= */
  function renderPagesPanel(body) {
    if (!state.workingBytes) { body.innerHTML = '<p class="hint">Open a PDF to manage pages.</p>'; return; }
    body.innerHTML = `
      <p class="hint">Drag thumbnails on the left to reorder. Use the icons on a thumbnail to rotate, duplicate, or delete a page.</p>
      <div class="section-title">Insert</div>
      <button class="btn btn-block" id="btnInsertBlank">+ Blank page after current</button>
      <button class="btn btn-block" id="btnInsertFrom">+ Pages from another PDF…</button>
      <hr class="hr">
      <div class="section-title">Combine</div>
      <button class="btn btn-block" id="btnMerge">Merge PDFs into this one…</button>
      <hr class="hr">
      <div class="section-title">Split / extract</div>
      <div class="field"><label>Page ranges (e.g. 1-3,5,8-9)</label><input type="text" id="rangeInput" placeholder="1-3,5"></div>
      <button class="btn btn-block" id="btnExtract">Extract ranges as a new PDF</button>
      <button class="btn btn-block" id="btnSplitEach">Split into one PDF per page</button>
      <hr class="hr">
      <div class="section-title">Watermark</div>
      <div class="field"><input type="text" id="wmText" placeholder="Watermark text" value="DRAFT"></div>
      <div class="field"><label>Opacity</label><input type="range" id="wmOpacity" min="5" max="80" value="28"></div>
      <label class="checkline"><input type="checkbox" id="wmTile"> Tile across page</label>
      <button class="btn btn-block" id="btnWatermark">Apply watermark to all pages</button>
      <hr class="hr">
      <div class="section-title">Page numbers</div>
      <div class="field"><input type="text" id="pnFormat" value="Page {n} of {N}"></div>
      <div class="field"><label>Position</label>
        <select id="pnPos"><option value="bottom-center">Bottom center</option><option value="bottom-right">Bottom right</option><option value="top-center">Top center</option></select>
      </div>
      <button class="btn btn-block" id="btnPageNumbers">Add page numbers</button>
      <input type="file" id="insertFileInput" accept="application/pdf" hidden>
      <input type="file" id="mergeFileInput" accept="application/pdf" multiple hidden>
    `;
    body.querySelector('#btnInsertBlank').onclick = async () => {
      const out = await PTTools.insertBlankPage(state.workingBytes, state.currentPageIndex + 1);
      await applyStructuralChange(out, 'Insert blank page');
    };
    body.querySelector('#btnInsertFrom').onclick = () => body.querySelector('#insertFileInput').click();
    body.querySelector('#insertFileInput').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const out = await PTTools.insertPdfPages(state.workingBytes, bytes, state.currentPageIndex + 1);
      await applyStructuralChange(out, 'Insert pages from ' + f.name);
    };
    body.querySelector('#btnMerge').onclick = () => body.querySelector('#mergeFileInput').click();
    body.querySelector('#mergeFileInput').onchange = async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      toast('Merging ' + (files.length + 1) + ' files…', 'info');
      const list = [{ bytes: state.workingBytes, name: state.fileName }];
      for (const f of files) list.push({ bytes: new Uint8Array(await f.arrayBuffer()), name: f.name });
      const out = await PTTools.mergePdfs(list, (i, total) => toast(`Merging ${i}/${total}…`, 'info'));
      await applyStructuralChange(out, 'Merge ' + files.length + ' file(s)');
      toast('Merge complete', 'success');
    };
    body.querySelector('#btnExtract').onclick = async () => {
      const idx = parseRanges(body.querySelector('#rangeInput').value, state.numPages);
      if (!idx.length) return toast('Enter a valid page range', 'error');
      const bytes = await PTTools.extractPages(state.workingBytes, idx);
      downloadBytes(bytes, suggestName('extract'));
    };
    body.querySelector('#btnSplitEach').onclick = async () => {
      const ranges = [];
      for (let i = 0; i < state.numPages; i++) ranges.push({ name: `page-${i + 1}`, indices: [i] });
      const parts = await PTTools.splitPdf(state.workingBytes, ranges);
      toast(`Downloading ${parts.length} files…`, 'info');
      for (const p of parts) { downloadBytes(p.bytes, p.name + '.pdf'); await new Promise((r) => setTimeout(r, 120)); }
    };
    body.querySelector('#btnWatermark').onclick = async () => {
      const out = await PTTools.addWatermark(state.workingBytes, {
        text: body.querySelector('#wmText').value || 'DRAFT',
        opacity: (+body.querySelector('#wmOpacity').value) / 100,
        tile: body.querySelector('#wmTile').checked,
      });
      await applyStructuralChange(out, 'Add watermark');
    };
    body.querySelector('#btnPageNumbers').onclick = async () => {
      const out = await PTTools.addPageNumbers(state.workingBytes, {
        format: body.querySelector('#pnFormat').value, position: body.querySelector('#pnPos').value,
      });
      await applyStructuralChange(out, 'Add page numbers');
    };
  }

  function parseRanges(str, max) {
    const out = new Set();
    (str || '').split(',').forEach((part) => {
      part = part.trim(); if (!part) return;
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) { for (let i = +m[1]; i <= +m[2]; i++) if (i >= 1 && i <= max) out.add(i - 1); }
      else if (/^\d+$/.test(part)) { const n = +part; if (n >= 1 && n <= max) out.add(n - 1); }
    });
    return Array.from(out).sort((a, b) => a - b);
  }

  /* ================= security panel ================= */
  function renderSecurityPanel(body) {
    if (!state.workingBytes) { body.innerHTML = '<p class="hint">Open a PDF to manage security &amp; metadata.</p>'; return; }
    body.innerHTML = `<p class="hint">Loading…</p>`;
    PTTools.getMetadata(state.workingBytes).then((meta) => {
      body.innerHTML = `
        <div class="section-title">Metadata</div>
        <div class="field"><label>Title</label><input type="text" id="mTitle" value="${escapeAttr(meta.title)}"></div>
        <div class="field"><label>Author</label><input type="text" id="mAuthor" value="${escapeAttr(meta.author)}"></div>
        <div class="field"><label>Subject</label><input type="text" id="mSubject" value="${escapeAttr(meta.subject)}"></div>
        <div class="field"><label>Keywords (comma separated)</label><input type="text" id="mKeywords" value="${escapeAttr(meta.keywords)}"></div>
        <button class="btn btn-block" id="btnSaveMeta">Save metadata</button>
        <hr class="hr">
        <div class="section-title">Password protection</div>
        <div class="field"><label>Password to open (user password)</label><input type="password" id="secUserPwd"></div>
        <div class="field"><label>Owner password (controls permissions) — optional</label><input type="password" id="secOwnerPwd"></div>
        <label class="checkline"><input type="checkbox" id="pPrint" checked> Allow printing</label>
        <label class="checkline"><input type="checkbox" id="pCopy" checked> Allow copying text</label>
        <label class="checkline"><input type="checkbox" id="pModify"> Allow editing</label>
        <label class="checkline"><input type="checkbox" id="pAnnotate" checked> Allow annotations</label>
        <button class="btn btn-primary btn-block" id="btnEncrypt">Protect with password</button>
        <p class="hint">Uses AES encryption entirely in this tab. The password itself is always enforced by compliant readers; the individual permission toggles are honored on a best-effort basis, since not every reader enforces them the same way.</p>
        <hr class="hr">
        <div class="section-title">Remove password</div>
        <div class="field"><input type="password" id="removePwd" placeholder="Current password"></div>
        <button class="btn btn-block" id="btnRemovePwd">Remove password</button>
        <hr class="hr">
        <div class="section-title">Flatten &amp; tidy</div>
        <button class="btn btn-block" id="btnFlatten">Flatten annotations now</button>
        <button class="btn btn-block" id="btnCompress">Re-save (tidy structure)</button>
        <p class="hint">Cleans up internal overhead without changing image quality. For real file-size reduction, use the compression options in the Save dialog instead.</p>
      `;
      body.querySelector('#btnSaveMeta').onclick = async () => {
        const out = await PTTools.setMetadata(state.workingBytes, {
          title: body.querySelector('#mTitle').value, author: body.querySelector('#mAuthor').value,
          subject: body.querySelector('#mSubject').value, keywords: body.querySelector('#mKeywords').value,
        });
        await applyStructuralChange(out, 'Update metadata');
        toast('Metadata saved', 'success');
      };
      body.querySelector('#btnEncrypt').onclick = async () => {
        const userPassword = body.querySelector('#secUserPwd').value;
        if (!userPassword) return toast('Enter a password to open the document', 'error');
        try {
          const out = await PTTools.protectWithPassword(state.workingBytes, {
            userPassword, ownerPassword: body.querySelector('#secOwnerPwd').value,
            permissions: {
              printing: body.querySelector('#pPrint').checked, copying: body.querySelector('#pCopy').checked,
              modifying: body.querySelector('#pModify').checked, annotating: body.querySelector('#pAnnotate').checked,
            },
          });
          await applyStructuralChange(out, 'Protect with password');
          toast('Password protection applied', 'success');
        } catch (e) {
          if (e.code === PTTools.ENCRYPTION_UNAVAILABLE) {
            toast('Encryption engine unavailable right now — check your connection and reload.', 'error');
          } else toast('Could not encrypt: ' + e.message, 'error');
        }
      };
      body.querySelector('#btnRemovePwd').onclick = async () => {
        try {
          const out = await PTTools.removePassword(state.workingBytes, body.querySelector('#removePwd').value);
          await applyStructuralChange(out, 'Remove password');
          toast('Password removed', 'success');
        } catch (e) { toast('Could not remove password: ' + e.message, 'error'); }
      };
      body.querySelector('#btnFlatten').onclick = async () => {
        const out = await PTTools.bakeAnnotations(state.workingBytes, PTAnnotate.getAll());
        Object.keys(PTAnnotate.getAll()).forEach((k) => { PTAnnotate.getAll()[k] = []; });
        await applyStructuralChange(out, 'Flatten annotations');
        toast('Annotations flattened', 'success');
      };
      body.querySelector('#btnCompress').onclick = async () => {
        const doc = await PTTools.loadDoc(state.workingBytes);
        const out = await PTTools.saveDoc(doc);
        await applyStructuralChange(out, 'Re-save (tidy structure)');
        toast('Re-saved', 'success');
      };
    });
  }

  /* ================= settings panel ================= */
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstallPrompt = e; });

  function renderSettingsPanel(body) {
    body.innerHTML = `
      <div class="section-title">Appearance</div>
      <label class="checkline"><input type="checkbox" id="setDark" ${state.dark ? 'checked' : ''}> Dark canvas</label>
      <hr class="hr">
      <div class="section-title">App</div>
      <button class="btn btn-block" id="btnInstall">Install pdfThings</button>
      <p class="hint">Installing lets it open in its own window and work fully offline.</p>
      <hr class="hr">
      <div class="section-title">Your data, on this device only</div>
      <p class="hint" id="storageInfo">Checking storage…</p>
      <button class="btn btn-block btn-danger" id="btnClearData">Clear saved signatures &amp; recent files</button>
      <hr class="hr">
      <div class="section-title">What this can't do</div>
      <p class="hint">Real-time collaboration, accounts, cloud sync, email delivery, audit logs, and enterprise digital-signing services all need a server this app intentionally doesn't have. Everything else in the toolbar runs right here.</p>
      <p class="hint">pdfThings · a private, static PDF workbench.</p>
    `;
    body.querySelector('#setDark').onchange = (e) => applyDark(e.target.checked);
    body.querySelector('#btnInstall').onclick = async () => {
      if (deferredInstallPrompt) { deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; }
      else toast('Your browser will offer an install option in its menu, or this may already be installed.', 'info');
    };
    body.querySelector('#btnClearData').onclick = async () => {
      if (!confirm('Delete all saved signatures and the recent-files list from this browser?')) return;
      await PTDB.clear('signatures'); await PTDB.clear('recents');
      toast('Cleared', 'success');
    };
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then((est) => {
        const used = Math.round((est.usage || 0) / 1024 / 1024);
        const quota = Math.round((est.quota || 0) / 1024 / 1024 / 1024);
        const infoEl = body.querySelector('#storageInfo');
        if (infoEl) infoEl.textContent = `Using about ${used} MB on this device (browsers typically allow well over ${quota || 1} GB).`;
      });
    }
  }

  /* ================= document lifecycle ================= */

  async function loadDocument(bytes, name, fileHandle) {
    try {
      resetDocument();
      state.fileName = name;
      state.fileHandle = fileHandle || null;
      state.workingBytes = bytes;
      state.dirty = false;
      await mountPdfjs(bytes);
      pushHistory('Open document', true);
      el.emptyState.hidden = true;
      el.pageScroller.hidden = false;
      el.docName.textContent = name;
      el.btnSave.disabled = false;
      updateDirty();
      switchPanel('view');
      saveRecent(name, bytes.length, fileHandle);
      checkEncryptionBanner(bytes);
    } catch (e) {
      console.error(e);
      toast('Could not open this PDF: ' + e.message, 'error');
    }
  }

  async function checkEncryptionBanner(bytes) {
    if (await PTTools.isEncrypted(bytes)) {
      toast('This PDF is password protected — some edit tools may be limited until you remove the password (Security panel).', 'info');
    }
  }

  function resetDocument() {
    if (state.pdfjsDoc) { try { state.pdfjsDoc.destroy(); } catch (e) {} }
    state.pdfjsDoc = null; state.numPages = 0; state.currentPageIndex = 0; state.history = []; state.histIndex = -1;
    PTAnnotate.setAll({});
    PTThumbs.destroy();
    el.pageScroller.innerHTML = '';
    updateUndoRedoButtons();
  }

  async function mountPdfjs(bytes) {
    if (state.pdfjsDoc) { try { await state.pdfjsDoc.destroy(); } catch (e) {} }
    const task = pdfjsLib.getDocument({
      data: bytes.slice(),
      onPassword: (updatePassword, reason) => promptForPassword(updatePassword, reason),
    });
    state.pdfjsDoc = await task.promise;
    state.numPages = state.pdfjsDoc.numPages;
    PTThumbs.init(el.thumbList);
    PTThumbs.build(state.numPages, state.currentPageIndex, {
      onOpen: (i) => jumpToPage(i, true),
      onRotate: (i) => rotateCurrentPage(90, i),
      onDuplicate: (i) => duplicatePageAt(i),
      onDelete: (i) => deletePageAt(i),
      onReorder: (oldIdx, newIdx) => reorderPage(oldIdx, newIdx),
    });
    buildPageScroller();
  }

  function promptForPassword(updatePassword, reason) {
    openModal({
      title: 'Password required', bodyHtml: `
        <p class="hint">${reason === 2 ? 'That password was incorrect. Try again.' : 'This PDF is password protected.'}</p>
        <div class="field"><input type="password" id="openPwd" placeholder="Password"></div>`,
      footHtml: `<button class="btn btn-primary" id="okPwd">Open</button>`,
      onMount: (card, close) => {
        card.querySelector('#okPwd').onclick = () => { const v = card.querySelector('#openPwd').value; close(); updatePassword(v); };
      },
    });
  }

  /* ---------------- page scroller (virtualized) ---------------- */

  function buildPageScroller() {
    el.pageScroller.innerHTML = '';
    if (state.pageObservers) state.pageObservers.disconnect();
    state.pageObservers = new IntersectionObserver(onPageIntersect, { root: el.viewport, rootMargin: '600px 0px', threshold: 0.01 });
    state.pageSizesAtScale1 = [];
    // Every page-block element above was just destroyed and is about to be
    // rebuilt from scratch (this runs after ANY structural change — rotate,
    // insert, delete, page numbers, etc. — not just opening a new file).
    // Both of these track state tied to the DOM elements that just got
    // wiped, so they must be reset here too, or the render function below
    // thinks pages are "already rendered" and skips drawing the new,
    // actually-empty ones — the page area then just stays blank.
    renderedPages.clear();
    PTAnnotate.unregisterAllSurfaces();

    for (let i = 0; i < state.numPages; i++) {
      const block = document.createElement('div');
      block.className = 'page-block';
      block.dataset.index = i;
      block.style.width = '1px'; block.style.height = '1px'; // placeholder until sized
      const label = document.createElement('div');
      label.className = 'page-label';
      label.textContent = `Page ${i + 1}`;
      const wrap = document.createElement('div');
      wrap.appendChild(block); wrap.appendChild(label);
      el.pageScroller.appendChild(wrap);
      state.pageObservers.observe(block);
    }
    sizeAllPlaceholders();
  }

  async function sizeAllPlaceholders() {
    for (let i = 0; i < state.numPages; i++) {
      const page = await state.pdfjsDoc.getPage(i + 1);
      const vp1 = page.getViewport({ scale: 1 });
      state.pageSizesAtScale1[i] = { width: vp1.width, height: vp1.height };
      const block = el.pageScroller.querySelector(`.page-block[data-index="${i}"]`);
      if (block && !block.dataset.sized) {
        const scale = currentScaleFor(vp1.width);
        block.style.width = Math.round(vp1.width * scale) + 'px';
        block.style.height = Math.round(vp1.height * scale) + 'px';
        block.dataset.sized = '1';
      }
    }
    updateCurrentPageFromScroll();
  }

  function currentScaleFor(nativeWidth) {
    if (state.fitWidth) {
      const avail = el.viewport.clientWidth - 64;
      return Math.max(0.2, Math.min(3, avail / nativeWidth));
    }
    return state.zoom;
  }

  const renderedPages = new Set();

  function onPageIntersect(entries) {
    entries.forEach((entry) => {
      const idx = Number(entry.target.dataset.index);
      if (entry.isIntersecting) { renderPageBlock(idx); }
      else releasePageBlock(idx);
    });
  }

  /** The render/virtualization observer above uses a large rootMargin (to
   *  pre-render pages just outside the viewport), so several pages count
   *  as "intersecting" at once — not a reliable signal for which page the
   *  person is actually looking at. Track that separately from real
   *  scroll position instead, throttled to one check per frame. */
  let scrollRaf = null;
  function onViewportScroll() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = null; updateCurrentPageFromScroll(); });
  }
  function updateCurrentPageFromScroll() {
    if (!state.numPages) return;
    const vpRect = el.viewport.getBoundingClientRect();
    const targetY = vpRect.top + vpRect.height * 0.35;
    let best = null, bestDist = Infinity;
    el.pageScroller.querySelectorAll('.page-block').forEach((block) => {
      const r = block.getBoundingClientRect();
      if (r.bottom < vpRect.top || r.top > vpRect.bottom) return;
      const dist = Math.abs((r.top + r.height / 2) - targetY);
      if (dist < bestDist) { bestDist = dist; best = block; }
    });
    if (best) setCurrentPageIndex(Number(best.dataset.index));
  }

  /** Single place that updates which page is "current" — drives the
   *  thumbnail highlight, the outline drawn around the active page in the
   *  main view, and which page toolbar actions like Rotate apply to. */
  function setCurrentPageIndex(idx) {
    const changed = idx !== state.currentPageIndex;
    state.currentPageIndex = idx;
    PTThumbs.setCurrent(idx);
    el.pageScroller.querySelectorAll('.page-block.current-page').forEach((b) => b.classList.remove('current-page'));
    const block = el.pageScroller.querySelector(`.page-block[data-index="${idx}"]`);
    if (block) block.classList.add('current-page');
    if (changed && state.activePanel === 'view') renderPanel('view');
  }

  async function renderPageBlock(idx) {
    if (renderedPages.has(idx)) return;
    renderedPages.add(idx);
    const block = el.pageScroller.querySelector(`.page-block[data-index="${idx}"]`);
    if (!block) return;
    const page = await state.pdfjsDoc.getPage(idx + 1);
    const native = page.getViewport({ scale: 1 });
    const scale = currentScaleFor(native.width);
    const viewport = page.getViewport({ scale });
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    block.style.width = Math.round(viewport.width) + 'px';
    block.style.height = Math.round(viewport.height) + 'px';
    block.innerHTML = '';

    const base = document.createElement('canvas');
    base.className = 'base-canvas';
    base.width = Math.round(viewport.width * dpr); base.height = Math.round(viewport.height * dpr);
    base.style.width = viewport.width + 'px'; base.style.height = viewport.height + 'px';
    const ctx = base.getContext('2d');
    ctx.scale(dpr, dpr);

    const textLayer = document.createElement('div');
    textLayer.className = 'text-layer';
    textLayer.style.width = viewport.width + 'px'; textLayer.style.height = viewport.height + 'px';

    const overlay = document.createElement('canvas');
    overlay.className = 'overlay-canvas';
    overlay.width = Math.round(viewport.width * dpr); overlay.height = Math.round(viewport.height * dpr);
    overlay.style.width = viewport.width + 'px'; overlay.style.height = viewport.height + 'px';
    // no ctx.scale() here — annotate.js's redraw() derives the full
    // (zoom × DPR) scale itself from overlay.width/viewport.width and
    // applies it inside its own save()/restore() bracket each draw

    block.appendChild(base); block.appendChild(textLayer); block.appendChild(overlay);

    if (!renderedPages.has(idx) || block.dataset.index !== String(idx)) return; // safety after awaits
    try {
      await page.render({ canvasContext: ctx, viewport }).promise;
      const content = await page.getTextContent();
      // param name varies slightly across pdf.js releases — pass both so
      // whichever this build expects, it's satisfied
      const task = pdfjsLib.renderTextLayer({ textContent: content, textContentSource: content, container: textLayer, viewport, textDivs: [] });
      if (task && task.promise) await task.promise;
    } catch (e) { /* page may have been released mid-render */ }

    const vpScale1 = { width: native.width, height: native.height, rotation: page.rotate };
    // annotate.js draws in "viewport-at-scale-1" space, scaled to overlay pixels
    PTAnnotate.registerSurface(idx, overlay, vpScale1, textLayer);
    PTAnnotate.hydrateImages(idx);
  }

  function releasePageBlock(idx) {
    if (!renderedPages.has(idx)) return;
    renderedPages.delete(idx);
    PTAnnotate.unregisterSurface(idx);
    const block = el.pageScroller.querySelector(`.page-block[data-index="${idx}"]`);
    if (!block) return;
    block.querySelectorAll('canvas').forEach((c) => {
      const ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height);
      c.width = 0; c.height = 0; // release the backing pixel buffer
    });
    block.innerHTML = '';
  }

  function rerenderVisiblePages() {
    const visible = Array.from(renderedPages);
    visible.forEach(releasePageBlock);
    sizeAllPlaceholders().then(() => visible.forEach(renderPageBlock));
  }

  function setZoom(z) {
    state.fitWidth = false;
    state.zoom = Math.max(0.25, Math.min(4, z));
    el.zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
    rerenderVisiblePages();
  }
  function fitToWidth() { state.fitWidth = true; el.zoomLabel.textContent = 'Fit'; rerenderVisiblePages(); }

  function jumpToPage(idx, flash) {
    const block = el.pageScroller.querySelector(`.page-block[data-index="${idx}"]`);
    if (block) {
      block.parentElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (flash) { block.style.outline = '3px solid #d69e2e'; setTimeout(() => (block.style.outline = ''), 900); }
    }
    setCurrentPageIndex(idx);
  }

  /* ---------------- structural change / history ---------------- */

  async function applyStructuralChange(newBytes, label) {
    state.workingBytes = newBytes;
    state.dirty = true;
    await mountPdfjs(newBytes);
    updateDirty();
    pushHistory(label);
    if (state.activePanel) renderPanel(state.activePanel);
  }

  function snapshotAnnotations() {
    const raw = PTAnnotate.getAll();
    const clean = {};
    Object.entries(raw).forEach(([k, list]) => {
      clean[k] = list.map((a) => { const c = Object.assign({}, a); delete c._img; return c; });
    });
    return clean;
  }

  function pushHistory(label, isInitial) {
    const snap = { bytes: state.workingBytes.slice(), anns: snapshotAnnotations(), label };
    if (!isInitial) {
      state.history = state.history.slice(0, state.histIndex + 1);
    } else {
      state.history = [];
    }
    state.history.push(snap);
    if (state.history.length > HISTORY_CAP) {
      state.history[0] = null; // explicit release before shifting
      state.history.shift();
    }
    state.histIndex = state.history.length - 1;
    updateUndoRedoButtons();
  }

  const debouncedPushHistory = debounce(() => { if (state.workingBytes) pushHistory('Edit annotations'); state.dirty = true; updateDirty(); }, 700);
  PTAnnotate.setOnChange(debouncedPushHistory);
  PTAnnotate.setOnSelectionChange(() => { if (state.activePanel === 'annotate') renderPanel('annotate'); });

  async function restoreSnapshot(snap) {
    state.workingBytes = snap.bytes.slice();
    PTAnnotate.setAll(snap.anns);
    await mountPdfjs(state.workingBytes);
    state.dirty = true;
    updateDirty();
    if (state.activePanel) renderPanel(state.activePanel);
  }

  function undo() {
    if (state.histIndex <= 0) return;
    state.histIndex--;
    restoreSnapshot(state.history[state.histIndex]);
    updateUndoRedoButtons();
  }
  function redo() {
    if (state.histIndex >= state.history.length - 1) return;
    state.histIndex++;
    restoreSnapshot(state.history[state.histIndex]);
    updateUndoRedoButtons();
  }
  function updateUndoRedoButtons() {
    el.btnUndo.disabled = state.histIndex <= 0;
    el.btnRedo.disabled = state.histIndex >= state.history.length - 1;
  }
  function updateDirty() { el.dirtyDot.hidden = !state.dirty; }

  /* ---------------- page ops shortcuts used by thumbnails ---------------- */

  async function rotateCurrentPage(delta, idxOverride) {
    const idx = idxOverride != null ? idxOverride : state.currentPageIndex;
    const out = await PTTools.rotatePage(state.workingBytes, idx, delta);
    await applyStructuralChange(out, 'Rotate page ' + (idx + 1));
  }
  async function duplicatePageAt(idx) {
    const out = await PTTools.duplicatePage(state.workingBytes, idx);
    await applyStructuralChange(out, 'Duplicate page ' + (idx + 1));
  }
  async function deletePageAt(idx) {
    if (state.numPages <= 1) return toast("Can't delete the only page", 'error');
    const out = await PTTools.deletePages(state.workingBytes, [idx]);
    await applyStructuralChange(out, 'Delete page ' + (idx + 1));
  }
  async function reorderPage(oldIdx, newIdx) {
    const order = Array.from({ length: state.numPages }, (_, i) => i);
    const [moved] = order.splice(oldIdx, 1);
    order.splice(newIdx, 0, moved);
    const out = await PTTools.reorderPages(state.workingBytes, order);
    await applyStructuralChange(out, 'Reorder pages');
  }

  /* ---------------- save / export ---------------- */

  function suggestName(suffix) {
    const base = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
    return `${base}${suffix ? '-' + suffix : ''}.pdf`;
  }

  async function downloadBytes(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async function exportPdf() {
    const choice = await openSaveOptionsModal();
    if (!choice) return; // cancelled — save aborted, nothing touched
    el.btnSave.disabled = true;
    try {
      let finalBytes = await PTTools.bakeAnnotations(state.workingBytes, PTAnnotate.getAll());
      const beforeSize = finalBytes.length;
      const needsRaster = !choice.compression.skip || choice.pageSize.enabled;
      if (needsRaster) {
        toast(choice.pageSize.enabled ? 'Adjusting page size…' : 'Compressing…', 'info');
        // If only the page size is being fixed (compression left at "No
        // compression"), pct 0 still renders — that's unavoidable once
        // pages must be repainted onto a new fixed size — but pct 0 maps
        // to this app's highest-quality rendering settings, so the loss
        // versus the vector original is minimal.
        const pct = choice.compression.skip ? 0 : choice.compression.pct;
        const targetPt = choice.pageSize.enabled ? { width: choice.pageSize.widthPt, height: choice.pageSize.heightPt } : null;
        finalBytes = await PTTools.compressPdf(finalBytes, pct, targetPt, (i, n) => {
          if (n > 6 && i % 3 === 0) toast(`Processing page ${i} of ${n}…`, 'info');
        });
      }
      const name = state.fileName || 'document.pdf';
      if (window.showSaveFilePicker) {
        try {
          const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
          const writable = await handle.createWritable();
          await writable.write(finalBytes);
          await writable.close();
          state.dirty = false; updateDirty();
          toast(saveToast('Saved', beforeSize, finalBytes.length, !needsRaster), 'success');
          el.btnSave.disabled = false;
          return;
        } catch (e) {
          if (e.name === 'AbortError') { el.btnSave.disabled = false; return; }
          // fall through to anchor-download fallback
        }
      }
      await downloadBytes(finalBytes, name);
      state.dirty = false; updateDirty();
      toast(saveToast('Downloaded', beforeSize, finalBytes.length, !needsRaster), 'success');
    } catch (e) {
      console.error(e);
      toast('Could not save: ' + e.message, 'error');
    } finally {
      el.btnSave.disabled = false;
    }
  }

  function saveToast(verb, before, after, skipped) {
    if (skipped) return verb;
    const pct = before > 0 ? Math.round((1 - after / before) * 100) : 0;
    return `${verb} — ${formatKb(before)} → ${formatKb(after)}${pct > 0 ? ` (${pct}% smaller)` : ''}`;
  }
  function formatKb(bytes) {
    return bytes >= 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
  }
  function ptToIn(pt) { return pt / 72; }
  function inToPt(inches) { return inches * 72; }
  function fmtIn(pt) { return ptToIn(pt).toFixed(1) + '\u2033'; } // 1.0″

  const COMPRESSION_PRESETS = { low: 15, medium: 50, high: 85 };

  /** Resolves to { compression: {skip, pct}, pageSize: {enabled, widthPt, heightPt} }
   *  once the person confirms, or to null if they cancel. */
  function openSaveOptionsModal() {
    return new Promise((resolve) => {
      Promise.all([
        PTDB.get('settings', 'compressionPref'),
        PTDB.get('settings', 'pageSizePref'),
        state.pdfjsDoc ? PTTools.getPageSizeRange(state.pdfjsDoc) : Promise.resolve(null),
      ]).then(([savedComp, savedSize, range]) => {
        const compPref = savedComp || { skip: true, pct: COMPRESSION_PRESETS.medium };
        const sizePref = savedSize || { mode: 'keep', customW: 8.5, customH: 11 };
        let settled = false;

        const uniform = range && Math.abs(range.maxW - range.minW) < 0.5 && Math.abs(range.maxH - range.minH) < 0.5;
        const rangeText = !range
          ? ''
          : uniform
            ? `Every page in this document is already the same size (${fmtIn(range.maxW)} × ${fmtIn(range.maxH)}).`
            : `This document's pages range from ${fmtIn(range.minW)} × ${fmtIn(range.minH)} up to ${fmtIn(range.maxW)} × ${fmtIn(range.maxH)}.`;

        const { card, close } = openModal({
          title: 'Save options', wide: true,
          bodyHtml: `
            <div class="section-title">Compression</div>
            <p class="hint">Re-renders each page as an image to shrink the file, so text in the saved copy is no longer selectable or searchable — your document here in the editor is unaffected either way.</p>
            <div class="chip-row" id="compChips">
              <button class="chip" data-level="none">No compression</button>
              <button class="chip" data-level="low">Low</button>
              <button class="chip" data-level="medium">Medium</button>
              <button class="chip" data-level="high">High</button>
            </div>
            <div class="field" style="margin-top:14px;">
              <label>Compression amount <span id="compPctLabel">0%</span></label>
              <input type="range" id="compSlider" min="0" max="100" value="${compPref.pct}">
            </div>
            <p class="hint" id="compSliderHint"></p>
            <hr class="hr">
            <div class="section-title">Page size</div>
            <p class="hint">${rangeText || 'Open a document to see its page-size range.'}</p>
            <div class="field">
              <label>Make every page this size</label>
              <select id="pageSizeMode">
                <option value="keep">Keep each page's own size</option>
                <option value="min" ${!range ? 'disabled' : ''}>Match this document's smallest page</option>
                <option value="max" ${!range ? 'disabled' : ''}>Match this document's largest page</option>
                <option value="a4">A4 (8.27″ × 11.69″)</option>
                <option value="letter">US Letter (8.5″ × 11″)</option>
                <option value="custom">Custom size…</option>
              </select>
            </div>
            <div id="customSizeFields" style="display:flex;gap:10px;" hidden>
              <div class="field"><label>Width (in)</label><input type="number" id="customW" min="1" max="60" step="0.1" value="${sizePref.customW}"></div>
              <div class="field"><label>Height (in)</label><input type="number" id="customH" min="1" max="60" step="0.1" value="${sizePref.customH}"></div>
            </div>
            <p class="hint" id="pageSizeHint"></p>
          `,
          footHtml: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="compConfirm">Save PDF</button>`,
          onClose: () => { if (!settled) resolve(null); },
        });

        /* ---- compression controls (unchanged behavior) ---- */
        const chips = card.querySelectorAll('#compChips .chip');
        const slider = card.querySelector('#compSlider');
        const pctLabel = card.querySelector('#compPctLabel');
        const sliderHint = card.querySelector('#compSliderHint');
        function setLevel(level) {
          chips.forEach((c) => c.classList.toggle('active', c.dataset.level === level));
          const skip = level === 'none';
          slider.disabled = skip;
          if (level !== 'custom' && COMPRESSION_PRESETS[level]) slider.value = COMPRESSION_PRESETS[level];
          pctLabel.textContent = skip ? '—' : slider.value + '%';
          sliderHint.textContent = skip
            ? 'Saved exactly as edited — full quality, smallest possible compatibility risk.'
            : 'Higher = smaller file, softer text. Try Medium first if unsure.';
        }
        chips.forEach((chip) => chip.onclick = () => setLevel(chip.dataset.level));
        slider.oninput = () => {
          pctLabel.textContent = slider.value + '%';
          const matched = Object.entries(COMPRESSION_PRESETS).find(([, v]) => String(v) === slider.value);
          chips.forEach((c) => c.classList.toggle('active', matched ? c.dataset.level === matched[0] : false));
        };
        setLevel(compPref.skip ? 'none' : (Object.entries(COMPRESSION_PRESETS).find(([, v]) => v === compPref.pct)?.[0] || 'custom'));

        /* ---- page size controls ---- */
        const sizeSel = card.querySelector('#pageSizeMode');
        const customFields = card.querySelector('#customSizeFields');
        const customWInput = card.querySelector('#customW');
        const customHInput = card.querySelector('#customH');
        const pageSizeHint = card.querySelector('#pageSizeHint');
        sizeSel.value = range ? sizePref.mode : 'keep';
        function updateSizeUi() {
          const mode = sizeSel.value;
          customFields.hidden = mode !== 'custom';
          if (mode === 'keep') pageSizeHint.textContent = '';
          else pageSizeHint.textContent = 'Every page is scaled to fit this size and centered, with any extra space filled white — nothing is stretched or distorted.';
        }
        sizeSel.onchange = updateSizeUi;
        updateSizeUi();

        function currentTargetPt() {
          const mode = sizeSel.value;
          if (mode === 'keep') return null;
          if (mode === 'min' && range) return { width: range.minW, height: range.minH };
          if (mode === 'max' && range) return { width: range.maxW, height: range.maxH };
          if (mode === 'a4') return PTTools.STANDARD_PAGE_SIZES.a4;
          if (mode === 'letter') return PTTools.STANDARD_PAGE_SIZES.letter;
          if (mode === 'custom') {
            const w = Math.max(1, +customWInput.value || sizePref.customW);
            const h = Math.max(1, +customHInput.value || sizePref.customH);
            return { width: inToPt(w), height: inToPt(h) };
          }
          return null;
        }

        card.querySelector('#compConfirm').onclick = () => {
          const skip = slider.disabled;
          const compression = { skip, pct: Number(slider.value) };
          const target = currentTargetPt();
          const pageSize = { enabled: !!target, widthPt: target ? target.width : 0, heightPt: target ? target.height : 0 };
          PTDB.set('settings', 'compressionPref', compression);
          PTDB.set('settings', 'pageSizePref', { mode: sizeSel.value, customW: +customWInput.value || sizePref.customW, customH: +customHInput.value || sizePref.customH });
          settled = true;
          close();
          resolve({ compression, pageSize });
        };
      });
    });
  }

  /* ---------------- recent files ---------------- */

  async function saveRecent(name, size, fileHandle) {
    try {
      const key = name + '|' + size;
      await PTDB.set('recents', key, { name, size, at: Date.now(), handle: fileHandle || null });
      renderRecents();
    } catch (e) { /* structured clone of handle can fail on some browsers — ignore */ }
  }

  async function renderRecents() {
    const rows = (await PTDB.getAll('recents')).map((r) => r.value).sort((a, b) => b.at - a.at).slice(0, 8);
    if (!rows.length) { el.recentsWrap.hidden = true; return; }
    el.recentsWrap.hidden = false;
    el.recentsList.innerHTML = '';
    rows.forEach((r) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="r-name">${escapeHtml(r.name)}</span><span class="r-meta">${Math.round(r.size / 1024)} KB</span>`;
      li.onclick = () => openRecent(r);
      el.recentsList.appendChild(li);
    });
  }

  async function openRecent(r) {
    if (!r.handle) { toast('Reselect this file to reopen it — browsers don\'t let sites remember file contents without permission.', 'info'); el.fileInput.click(); return; }
    try {
      const perm = await r.handle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') {
        const req = await r.handle.requestPermission({ mode: 'read' });
        if (req !== 'granted') return toast('Permission denied', 'error');
      }
      const file = await r.handle.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      loadDocument(bytes, file.name, r.handle);
    } catch (e) { toast('Could not reopen: ' + e.message, 'error'); }
  }

  /* ---------------- open / drag&drop ---------------- */

  async function openFile(file, handle) {
    if (state.dirty && !confirm('You have unsaved changes in the current document. Open a new file anyway?')) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    loadDocument(bytes, file.name, handle);
  }

  /** Lets a tool panel (e.g. Scan) hand pdfThings a freshly-built PDF and
   *  have it become the working document, same unsaved-changes courtesy
   *  as opening a file from disk. */
  async function openBytesAsDocument(bytes, name) {
    if (state.dirty && !confirm('You have unsaved changes in the current document. Open the new PDF anyway?')) return false;
    await loadDocument(bytes, name);
    return true;
  }

  document.getElementById('btnOpenFile').onclick = async () => {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({ types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
        const file = await handle.getFile();
        openFile(file, handle);
        return;
      } catch (e) { if (e.name === 'AbortError') return; }
    }
    el.fileInput.click();
  };
  el.fileInput.onchange = (e) => { if (e.target.files[0]) openFile(e.target.files[0]); };

  ['dragenter', 'dragover'].forEach((ev) => document.body.addEventListener(ev, (e) => { e.preventDefault(); el.dropZone.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach((ev) => document.body.addEventListener(ev, (e) => { e.preventDefault(); el.dropZone.classList.remove('drag-over'); }));
  document.body.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') openFile(file);
    else if (file) toast('That doesn\'t look like a PDF', 'error');
  });

  /* ---------------- signature modal ---------------- */

  function openSignatureModal(onSave) {
    let mode = 'draw', typedFont = 0, uploadedDataUrl = null;
    const { card, close } = openModal({
      title: 'New signature', wide: false,
      bodyHtml: `
        <div class="sig-tabs">
          <button data-m="draw" class="active">Draw</button>
          <button data-m="type">Type</button>
          <button data-m="upload">Upload</button>
        </div>
        <div id="sigArea"></div>
        <div class="field"><label>Label (for your saved list)</label><input type="text" id="sigLabel" value="My signature"></div>
      `,
      footHtml: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="sigSaveBtn">Save signature</button>`,
    });
    const area = card.querySelector('#sigArea');

    function renderDraw() {
      area.innerHTML = `<canvas class="sig-pad-canvas" id="padCanvas"></canvas><button class="btn btn-sm" id="padClear" style="margin-top:8px;">Clear</button>`;
      const canvas = area.querySelector('#padCanvas');
      const ratio = window.devicePixelRatio || 1;
      canvas.width = canvas.clientWidth * ratio; canvas.height = canvas.clientHeight * ratio;
      const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio); ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.strokeStyle = '#14181f';
      let drawing = false, last = null;
      function pos(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
      canvas.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); });
      canvas.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; });
      window.addEventListener('pointerup', () => (drawing = false));
      area.querySelector('#padClear').onclick = () => ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    function renderType() {
      area.innerHTML = `<input class="sig-type-input" id="typeInput" placeholder="Your name" style="font-family:${PTAnnotate.SCRIPT_FONTS[0]};">
        <div class="font-choices" id="fontChoices" style="margin-top:10px;">
          <button class="active" data-f="0" style="font-family:${PTAnnotate.SCRIPT_FONTS[0]}">Style A</button>
          <button data-f="1" style="font-family:${PTAnnotate.SCRIPT_FONTS[1]}">Style B</button>
          <button data-f="2" style="font-family:${PTAnnotate.SCRIPT_FONTS[2]}">Style C</button>
        </div>`;
      area.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => {
        typedFont = +b.dataset.f;
        area.querySelectorAll('[data-f]').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        area.querySelector('#typeInput').style.fontFamily = PTAnnotate.SCRIPT_FONTS[typedFont];
      });
    }
    function renderUpload() {
      area.innerHTML = `<input type="file" accept="image/png,image/jpeg" id="upInput"><div id="upPreview" style="margin-top:10px;"></div>`;
      area.querySelector('#upInput').onchange = (e) => {
        const f = e.target.files[0]; if (!f) return;
        const reader = new FileReader();
        reader.onload = () => { uploadedDataUrl = reader.result; area.querySelector('#upPreview').innerHTML = `<div class="sig-preview"><img src="${reader.result}"></div>`; };
        reader.readAsDataURL(f);
      };
    }
    card.querySelectorAll('.sig-tabs button').forEach((b) => b.onclick = () => {
      card.querySelectorAll('.sig-tabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active'); mode = b.dataset.m;
      if (mode === 'draw') renderDraw(); else if (mode === 'type') renderType(); else renderUpload();
    });
    renderDraw();

    card.querySelector('#sigSaveBtn').onclick = () => {
      const label = card.querySelector('#sigLabel').value || 'Signature';
      let dataUrl = null;
      if (mode === 'draw') { const c = area.querySelector('#padCanvas'); dataUrl = c.toDataURL('image/png'); }
      else if (mode === 'type') {
        const text = area.querySelector('#typeInput').value.trim();
        if (!text) return toast('Type your name first', 'error');
        dataUrl = renderTypedSignatureToPng(text, PTAnnotate.SCRIPT_FONTS[typedFont]);
      } else if (mode === 'upload') {
        if (!uploadedDataUrl) return toast('Choose an image first', 'error');
        dataUrl = uploadedDataUrl;
      }
      close();
      onSave(dataUrl, label);
      toast('Signature saved', 'success');
    };
  }

  function renderTypedSignatureToPng(text, font) {
    const c = document.createElement('canvas'); c.width = 520; c.height = 160;
    const ctx = c.getContext('2d');
    ctx.font = `52px ${font}`; ctx.fillStyle = '#14181f'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.fillText(text, c.width / 2, c.height / 2);
    return c.toDataURL('image/png');
  }

  /* ---------------- helpers ---------------- */

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escapeAttr(s) { return escapeHtml(s); }

  /* ---------------- mobile drawer scrims ---------------- */
  function showScrim(which) {
    let scrim = document.querySelector('.' + (which === 'ctx' ? 'ctx-scrim' : 'rail-scrim'));
    if (!scrim) {
      scrim = document.createElement('div'); scrim.className = which === 'ctx' ? 'ctx-scrim' : 'rail-scrim';
      document.body.appendChild(scrim);
      scrim.onclick = () => { el.rail.classList.remove('open'); el.contextPanel.classList.remove('open'); scrim.classList.remove('show'); };
    }
    scrim.classList.add('show');
  }

  /* ================= wiring ================= */

  document.querySelectorAll('.rail-btn').forEach((b) => b.onclick = () => switchPanel(b.dataset.panel));
  $('#btnCloseCtx').onclick = () => { el.contextPanel.classList.remove('open'); document.querySelectorAll('.ctx-scrim').forEach((s) => s.classList.remove('show')); };
  $('#btnMenu').onclick = () => { el.rail.classList.add('open'); showScrim('rail'); };
  $('#btnHome').onclick = () => switchPanel('view');
  $('#btnSave').onclick = exportPdf;
  $('#btnUndo').onclick = undo;
  $('#btnRedo').onclick = redo;
  $('#btnZoomIn').onclick = () => setZoom(state.zoom + 0.1);
  $('#btnZoomOut').onclick = () => setZoom(state.zoom - 0.1);
  $('#zoomLabel').onclick = fitToWidth;
  $('#btnDark').onclick = () => applyDark(!state.dark);
  $('#btnCollapseThumbs').onclick = () => el.appBody.classList.toggle('thumbs-collapsed');

  window.addEventListener('resize', debounce(() => { if (state.fitWidth) rerenderVisiblePages(); }, 200));
  el.viewport.addEventListener('scroll', onViewportScroll, { passive: true });

  document.addEventListener('keydown', (e) => {
    const meta = e.ctrlKey || e.metaKey;
    if (meta && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (meta && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); }
    else if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); if (state.workingBytes) exportPdf(); }
    else if (meta && e.key.toLowerCase() === 'o') { e.preventDefault(); el.fileInput.click(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') PTAnnotate.deleteSelected(); }
    else if (e.key === 'Escape') { PTAnnotate.clearSelection(); PTAnnotate.setTool('select'); }
  });

  // restore saved dark-mode preference
  PTDB.get('settings', 'darkMode').then((v) => { if (v) applyDark(true); });
  renderRecents();
  renderPanel('view');

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline support just won't be available */ });
    });
  }

  /* ================= public API for the tool modules ================= */
  window.PTApp = {
    toast, openModal,
    getWorkingBytes: () => state.workingBytes,
    getPdfjsDoc: () => state.pdfjsDoc,
    getCurrentPageIndex: () => state.currentPageIndex,
    applyStructuralChange,
    openSignatureModal,
    openBytesAsDocument,
  };
})();
