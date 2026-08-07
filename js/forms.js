/*
 * forms.js — interactive form filling.
 * Reads AcroForm fields with pdf-lib (via pdf-tools.js) and renders a
 * matching input for each field type; writes values back on demand.
 */
(function () {
  let cachedValues = {};

  async function renderPanel(el) {
    el.innerHTML = `<p class="hint">Reading form fields…</p>`;
    const bytes = window.PTApp.getWorkingBytes();
    if (!bytes) { el.innerHTML = '<p class="hint">Open a PDF first.</p>'; return; }
    let fields;
    try {
      fields = await window.PTTools.getFormFieldDescriptors(bytes);
    } catch (e) {
      el.innerHTML = `<p class="hint warn">Could not read form fields: ${escapeHtml(e.message)}</p>`;
      return;
    }
    if (!fields.length) {
      el.innerHTML = `<p class="hint">This PDF has no fillable form fields.</p>
        <p class="hint">You can still add text, checkboxes and signatures anywhere using the Annotate and Sign tools.</p>`;
      return;
    }

    const requiredMissing = fields.filter((f) => f.required && !cachedValues[f.name] && !f.current);

    el.innerHTML = `
      <div class="section-title">${fields.length} field${fields.length === 1 ? '' : 's'} found</div>
      <div class="list-simple" id="fieldList"></div>
      <hr class="hr">
      <label class="checkline"><input type="checkbox" id="flattenAfter"> Flatten form after filling (make values permanent, non-editable)</label>
      <button class="btn btn-primary btn-block" id="btnFillSave">Apply values to document</button>
      <p class="hint" id="reqWarning" ${requiredMissing.length ? '' : 'hidden'}>⚠ ${requiredMissing.length} required field${requiredMissing.length === 1 ? '' : 's'} still empty.</p>
    `;
    const list = el.querySelector('#fieldList');
    fields.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'form-field-row';
      row.innerHTML = `<div class="field"><label>${escapeHtml(f.name)}${f.required ? ' *' : ''}</label>${fieldInput(f)}</div>`;
      list.appendChild(row);
      const input = row.querySelector('[data-field]');
      if (!input) return;
      const val = cachedValues[f.name] !== undefined ? cachedValues[f.name] : f.current;
      if (f.type === 'PDFCheckBox') input.checked = !!val;
      else if (input.tagName === 'SELECT') input.value = val || '';
      else input.value = val || '';
      input.addEventListener('input', () => {
        cachedValues[f.name] = f.type === 'PDFCheckBox' ? input.checked : input.value;
      });
      input.addEventListener('change', () => {
        cachedValues[f.name] = f.type === 'PDFCheckBox' ? input.checked : input.value;
      });
    });

    el.querySelector('#btnFillSave').onclick = async () => {
      const flatten = el.querySelector('#flattenAfter').checked;
      try {
        const out = await window.PTTools.fillForm(window.PTApp.getWorkingBytes(), cachedValues, flatten);
        await window.PTApp.applyStructuralChange(out, flatten ? 'Filled and flattened form' : 'Filled form');
        window.PTApp.toast('Form values applied', 'success');
      } catch (e) {
        window.PTApp.toast('Could not fill form: ' + e.message, 'error');
      }
    };
  }

  function fieldInput(f) {
    if (f.type === 'PDFCheckBox') return `<input type="checkbox" data-field style="width:20px;height:20px;">`;
    if (f.type === 'PDFDropdown' || f.type === 'PDFOptionList' || f.type === 'PDFRadioGroup') {
      const opts = (f.options || []).map((o) => `<option value="${escapeAttr(o)}">${escapeHtml(o)}</option>`).join('');
      return `<select data-field><option value="">—</option>${opts}</select>`;
    }
    return `<input type="text" data-field placeholder="Enter value">`;
  }

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function escapeAttr(s) { return escapeHtml(s); }

  window.PTForms = { renderPanel, resetCache: () => { cachedValues = {}; } };
})();
