/*
 * ai.js — "Text tools" panel.
 *
 * Honesty note: these are lightweight, deterministic text heuristics that
 * run instantly with no download (word-frequency extractive summarization,
 * simple keyword ranking). They are NOT a generative language model.
 * Tasks that genuinely need one — natural-language translation, fluent
 * grammar rewriting, free-form explanation — are labelled as unavailable
 * here rather than faked, since a static site has no server to run a real
 * model on and shipping one to the browser would mean a multi-hundred-MB
 * download most people wouldn't want by default.
 */
(function () {
  const STOPWORDS = new Set(('a an the and or but if then else when while of to in on at for with as by from is are was were ' +
    'be been being this that these those it its it\'s not no do does did doing have has had having will would shall should ' +
    'can could may might must i you he she we they them his her our your their there here what which who whom so than too ' +
    'very just also into out up down about over under again further once').split(' '));

  function sentences(text) {
    return (text || '').replace(/\s+/g, ' ').trim()
      .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
      .map((s) => s.trim()).filter(Boolean);
  }
  function words(text) {
    return (text.toLowerCase().match(/[a-z0-9']+/g) || []);
  }

  function summarize(text, sentenceCount) {
    const sents = sentences(text);
    if (sents.length <= sentenceCount) return sents.join(' ');
    const freq = {};
    words(text).forEach((w) => { if (!STOPWORDS.has(w) && w.length > 2) freq[w] = (freq[w] || 0) + 1; });
    const scored = sents.map((s, i) => {
      const ws = words(s);
      const score = ws.reduce((sum, w) => sum + (freq[w] || 0), 0) / Math.max(1, ws.length);
      return { i, s, score };
    });
    const top = scored.slice().sort((a, b) => b.score - a.score).slice(0, sentenceCount);
    top.sort((a, b) => a.i - b.i); // restore original order
    return top.map((t) => t.s).join(' ');
  }

  function keywords(text, count) {
    const freq = {};
    words(text).forEach((w) => { if (!STOPWORDS.has(w) && w.length > 2) freq[w] = (freq[w] || 0) + 1; });
    return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, count).map(([w]) => w);
  }

  function title(text) {
    const kws = keywords(text, 5);
    const sents = sentences(text);
    if (!sents.length) return kws.slice(0, 4).map(cap).join(' ');
    const best = sents.slice(0, 5).sort((a, b) => words(b).filter((w) => kws.includes(w)).length - words(a).filter((w) => kws.includes(w)).length)[0];
    const trimmed = best.split(' ').slice(0, 10).join(' ');
    return cap(trimmed.replace(/[.,;:]+$/, ''));
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function cleanup(text) {
    return text
      .replace(/[ \t]+/g, ' ')
      .replace(/ +([.,;:!?])/g, '$1')
      .replace(/([.,;:!?])(?=[A-Za-z])/g, '$1 ')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n').map((line) => line.trim() ? line.trim().replace(/^[a-z]/, (c) => c.toUpperCase()) : line).join('\n')
      .trim();
  }

  async function extractPageText(pageIndex) {
    const pdfjsDoc = window.PTApp.getPdfjsDoc();
    const page = await pdfjsDoc.getPage(pageIndex + 1);
    const content = await page.getTextContent();
    return content.items.map((it) => it.str).join(' ');
  }
  async function extractAllText(maxPages) {
    const pdfjsDoc = window.PTApp.getPdfjsDoc();
    const n = Math.min(pdfjsDoc.numPages, maxPages || pdfjsDoc.numPages);
    let out = '';
    for (let i = 0; i < n; i++) {
      const page = await pdfjsDoc.getPage(i + 1);
      const content = await page.getTextContent();
      out += content.items.map((it) => it.str).join(' ') + '\n\n';
    }
    return out;
  }

  async function renderPanel(el) {
    if (!window.PTApp.getWorkingBytes()) { el.innerHTML = '<p class="hint">Open a PDF first.</p>'; return; }
    el.innerHTML = `
      <div class="section-title">Text tools — on this device</div>
      <p class="hint">Instant word-frequency heuristics with no download. Not a language model — good for a quick gist, not a substitute for reading the document.</p>
      <div class="field">
        <label>Scope</label>
        <select id="scopeSel">
          <option value="page">Current page</option>
          <option value="doc">Whole document</option>
        </select>
      </div>
      <div class="chip-row">
        <button class="chip active" data-mode="summary">Summarize</button>
        <button class="chip" data-mode="keywords">Keywords</button>
        <button class="chip" data-mode="title">Suggest title</button>
        <button class="chip" data-mode="cleanup">Clean up spacing</button>
      </div>
      <button class="btn btn-primary btn-block" id="btnRunAi">Run</button>
      <div id="aiOut"></div>
      <hr class="hr">
      <div class="section-title">Needs a downloaded model</div>
      <p class="hint">Translation, fluent grammar rewriting, and free-form "explain this" aren't available in this build — they need a real language model, which isn't bundled by default to keep the app a fast, no-install page load. Not included here rather than faked.</p>
    `;
    let mode = 'summary';
    el.querySelectorAll('.chip').forEach((c) => c.onclick = () => {
      el.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
      c.classList.add('active'); mode = c.dataset.mode;
    });
    el.querySelector('#btnRunAi').onclick = async () => {
      const out = el.querySelector('#aiOut');
      out.innerHTML = '<p class="hint">Reading text…</p>';
      const scope = el.querySelector('#scopeSel').value;
      const text = scope === 'page' ? await extractPageText(window.PTApp.getCurrentPageIndex()) : await extractAllText(60);
      if (!text.trim()) { out.innerHTML = '<p class="hint warn">No extractable text found (this may be a scanned page — try OCR first).</p>'; return; }
      renderOut(out, mode, text);
    };
  }

  function renderOut(out, mode, text) {
    if (mode === 'summary') {
      const s = summarize(text, 5);
      out.innerHTML = `<div class="ocr-text-box">${escapeHtml(s)}</div>${copyBtn(s)}`;
    } else if (mode === 'keywords') {
      const kws = keywords(text, 12);
      out.innerHTML = `<div class="kw-chip-list">${kws.map((k) => `<span class="chip">${escapeHtml(k)}</span>`).join('')}</div>${copyBtn(kws.join(', '))}`;
    } else if (mode === 'title') {
      const t = title(text);
      out.innerHTML = `<div class="ocr-text-box">${escapeHtml(t)}</div>${copyBtn(t)}`;
    } else if (mode === 'cleanup') {
      const c = cleanup(text);
      out.innerHTML = `<div class="ocr-text-box">${escapeHtml(c)}</div>${copyBtn(c)}<p class="hint">Basic whitespace/punctuation/capitalization tidy-up — not grammar correction.</p>`;
    }
    const btn = out.querySelector('#btnCopyAi');
    if (btn) btn.onclick = async () => { await navigator.clipboard.writeText(btn.dataset.text); window.PTApp.toast('Copied', 'success'); };
  }
  function copyBtn(text) { return `<button class="btn btn-sm" id="btnCopyAi" data-text="${escapeAttr(text)}" style="margin-top:8px;">Copy</button>`; }
  function escapeHtml(s) { return String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

  window.PTAi = { renderPanel, summarize, keywords, title, cleanup };
})();
