/*
 * thumbnails.js — the left page-thumbnail strip.
 *
 * Memory discipline: thumbnails are virtualized with IntersectionObserver.
 * A thumbnail canvas is only rendered while it's within a viewport buffer;
 * as soon as it scrolls out, we clearRect() it and revoke its render's
 * object URL (if any) so the pixel buffer doesn't linger in memory for a
 * 200+ page document.
 */
(function () {
  let container, sortable, observer;
  let renderedPages = new Set();

  function init(listEl) {
    container = listEl;
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(onIntersect, { root: listEl, rootMargin: '400px 0px' });
  }

  function onIntersect(entries) {
    entries.forEach((entry) => {
      const idx = Number(entry.target.dataset.index);
      if (entry.isIntersecting) {
        if (!renderedPages.has(idx)) renderThumb(idx);
      } else {
        clearThumb(idx);
      }
    });
  }

  async function renderThumb(idx) {
    const pdfjsDoc = window.PTApp.getPdfjsDoc();
    if (!pdfjsDoc) return;
    const el = container.querySelector(`.thumb-item[data-index="${idx}"]`);
    if (!el) return;
    const canvas = el.querySelector('canvas');
    try {
      const page = await pdfjsDoc.getPage(idx + 1);
      const viewport = page.getViewport({ scale: 1 });
      const scale = (container.clientWidth - 24) / viewport.width;
      const vp = page.getViewport({ scale });
      canvas.width = vp.width; canvas.height = vp.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      renderedPages.add(idx);
    } catch (e) { /* page may have been removed mid-render during a fast edit */ }
  }

  function clearThumb(idx) {
    const el = container && container.querySelector(`.thumb-item[data-index="${idx}"]`);
    if (!el) { renderedPages.delete(idx); return; }
    const canvas = el.querySelector('canvas');
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 0; canvas.height = 0; // fully release the backing pixel buffer
    }
    renderedPages.delete(idx);
  }

  function build(numPages, currentIndex, callbacks) {
    renderedPages.clear();
    container.innerHTML = '';
    for (let i = 0; i < numPages; i++) {
      const item = document.createElement('div');
      item.className = 'thumb-item' + (i === currentIndex ? ' current' : '');
      item.dataset.index = i;
      item.innerHTML = `
        <div class="thumb-card"><canvas></canvas></div>
        <div class="thumb-num">${i + 1}</div>
        <div class="thumb-tools">
          <button data-act="rotate" title="Rotate 90°"><svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="2"><path d="M4 4v6h6M20 20v-6h-6"/><path d="M5.6 15a8 8 0 1 0 1-9.4L4 9"/></svg></button>
          <button data-act="duplicate" title="Duplicate"><svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="2"><rect x="7" y="7" width="12" height="12" rx="1"/><path d="M5 15V5h10"/></svg></button>
          <button data-act="delete" title="Delete"><svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="2"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg></button>
        </div>`;
      item.addEventListener('click', (e) => { if (!e.target.closest('.thumb-tools')) callbacks.onOpen(i); });
      item.querySelector('[data-act="rotate"]').onclick = (e) => { e.stopPropagation(); callbacks.onRotate(i); };
      item.querySelector('[data-act="duplicate"]').onclick = (e) => { e.stopPropagation(); callbacks.onDuplicate(i); };
      item.querySelector('[data-act="delete"]').onclick = (e) => { e.stopPropagation(); callbacks.onDelete(i); };
      container.appendChild(item);
      observer.observe(item);
    }
    if (sortable) sortable.destroy();
    sortable = new Sortable(container, {
      animation: 150, ghostClass: 'sortable-ghost', delay: 80, delayOnTouchOnly: true,
      onEnd: (evt) => {
        if (evt.oldIndex === evt.newIndex) return;
        callbacks.onReorder(evt.oldIndex, evt.newIndex);
      },
    });
  }

  function setCurrent(idx) {
    if (!container) return;
    container.querySelectorAll('.thumb-item').forEach((el) => el.classList.toggle('current', Number(el.dataset.index) === idx));
    const cur = container.querySelector(`.thumb-item[data-index="${idx}"]`);
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function destroy() {
    if (observer) observer.disconnect();
    if (sortable) sortable.destroy();
    renderedPages.clear();
    if (container) container.innerHTML = '';
  }

  window.PTThumbs = { init, build, setCurrent, destroy };
})();
