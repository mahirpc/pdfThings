/*
 * ocr.js — client-side OCR via Tesseract.js (WebAssembly), loaded lazily
 * from a CDN only when the user opens this panel, since the language
 * data itself is several MB and there's no reason to fetch it up front.
 */
(function () {
  let worker = null;
  let lastResult = null; // { pageIndex, words, canvasSize, text }

  async function ensureWorker(onProgress) {
    if (worker) return worker;
    if (!window.Tesseract) {
      await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
    }
    worker = await Tesseract.createWorker('eng', 1, {
      logger: (m) => onProgress && onProgress(m),
    });
    return worker;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load OCR engine (offline?)'));
      document.head.appendChild(s);
    });
  }

  async function renderPageToCanvas(pageIndex, scale) {
    const pdfjsDoc = window.PTApp.getPdfjsDoc();
    const page = await pdfjsDoc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  }

  async function renderPanel(el) {
    if (!window.PTApp.getWorkingBytes()) { el.innerHTML = '<p class="hint">Open a PDF first.</p>'; return; }
    const pageIndex = window.PTApp.getCurrentPageIndex();
    el.innerHTML = `
      <div class="section-title">Recognize text — page ${pageIndex + 1}</div>
      <p class="hint">Runs fully offline in this tab using Tesseract.js (WebAssembly). Large or busy pages take longer and use more memory; this works best one page at a time.</p>
      <button class="btn btn-primary btn-block" id="btnRunOcr">Recognize this page</button>
      <div id="ocrProgressWrap" hidden>
        <div class="progress-bar"><i id="ocrProgressBar" style="width:0%"></i></div>
        <p class="hint" id="ocrProgressLabel"></p>
      </div>
      <div id="ocrResultWrap"></div>
    `;
    el.querySelector('#btnRunOcr').onclick = () => runOcr(el, pageIndex);
    if (lastResult && lastResult.pageIndex === pageIndex) renderResult(el);
  }

  async function runOcr(el, pageIndex) {
    const btn = el.querySelector('#btnRunOcr');
    const wrap = el.querySelector('#ocrProgressWrap');
    const bar = el.querySelector('#ocrProgressBar');
    const label = el.querySelector('#ocrProgressLabel');
    btn.disabled = true; wrap.hidden = false;
    label.textContent = 'Loading OCR engine…';
    try {
      const scale = 2.2; // higher scale improves recognition accuracy
      const canvas = await renderPageToCanvas(pageIndex, scale);
      const w = await ensureWorker((m) => {
        if (m.status) label.textContent = m.status.replace(/_/g, ' ');
        if (typeof m.progress === 'number') bar.style.width = Math.round(m.progress * 100) + '%';
      });
      const { data } = await w.recognize(canvas);
      lastResult = {
        pageIndex, text: data.text,
        words: (data.words || []).map((wd) => ({ text: wd.text, bbox: wd.bbox, confidence: wd.confidence })),
        canvasSize: { width: canvas.width, height: canvas.height },
      };
      // release the big canvas + its pixel buffer as soon as we're done with it
      canvas.width = 0; canvas.height = 0;
      renderResult(el);
      window.PTApp.toast('OCR complete', 'success');
    } catch (e) {
      window.PTApp.toast('OCR failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false; wrap.hidden = true;
    }
  }

  function renderResult(el) {
    const wrap = el.querySelector('#ocrResultWrap');
    const words = lastResult.words.filter((w) => w.text.trim());
    const avgConf = words.length ? Math.round(words.reduce((s, w) => s + w.confidence, 0) / words.length) : 0;
    wrap.innerHTML = `
      <hr class="hr">
      <div class="section-title">Result · ~${avgConf}% average confidence</div>
      <div class="ocr-text-box">${escapeHtml(lastResult.text || '(no text detected)')}</div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="btn btn-sm" id="btnCopyOcr" style="flex:1;">Copy text</button>
        <button class="btn btn-sm" id="btnDownloadOcr" style="flex:1;">Download .txt</button>
      </div>
      <button class="btn btn-primary btn-block" id="btnSearchable" style="margin-top:8px;">Make this page searchable</button>
      <p class="hint">Adds an invisible text layer aligned to the recognized words, so the scanned page becomes selectable and searchable — the visible image doesn't change.</p>
    `;
    wrap.querySelector('#btnCopyOcr').onclick = async () => {
      await navigator.clipboard.writeText(lastResult.text || '');
      window.PTApp.toast('Copied to clipboard', 'success');
    };
    wrap.querySelector('#btnDownloadOcr').onclick = () => {
      const blob = new Blob([lastResult.text || ''], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `page-${lastResult.pageIndex + 1}-ocr.txt`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    wrap.querySelector('#btnSearchable').onclick = async () => {
      try {
        const out = await window.PTTools.addInvisibleTextLayer(
          window.PTApp.getWorkingBytes(), lastResult.pageIndex, words, lastResult.canvasSize
        );
        await window.PTApp.applyStructuralChange(out, 'Made page ' + (lastResult.pageIndex + 1) + ' searchable');
        window.PTApp.toast('Page is now searchable', 'success');
      } catch (e) {
        window.PTApp.toast('Could not add text layer: ' + e.message, 'error');
      }
    };
  }

  function escapeHtml(s) { return String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  window.PTOcr = { renderPanel, terminate: () => { if (worker) { worker.terminate(); worker = null; } } };
})();
