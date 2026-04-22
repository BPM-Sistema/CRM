/**
 * BPM — Stock Alerts Snippet (Tiendanube theme "Recife")
 *
 * Fase 1: solo captura de intención. No envía mensajes todavía.
 *
 * Qué hace:
 *   1. Detalle de producto sin stock → bloque inline "Avisame" debajo del form.
 *   2. Listado: cada producto cuyos variants están todos sin stock (ningún
 *      variant con `available: true`) recibe un botón "🔔 Avisarme" debajo del
 *      precio. Click abre un modal con input teléfono + confirmar; al confirmar
 *      se cierra solo.
 *
 * Integración:
 *   <script src="https://api.bpmadministrador.com/stock-alerts-snippet.js" defer></script>
 */
(function () {
  'use strict';

  var API_URL = 'https://api.bpmadministrador.com/stock-alerts';
  var STORAGE_KEY = 'bpm_stock_alerts_sent_v1';
  var STYLE_ID = 'bpm-stock-alerts-style';
  var AUTO_CLOSE_MS = 1800;

  // =====================================================
  // Estilos
  // =====================================================
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      // Bloque inline en detalle
      '.bpm-sa-box{margin:16px 0;padding:16px;border:1px solid #e5e5e5;border-radius:10px;background:#fafafa;font-family:inherit;color:#222;}',
      '.bpm-sa-box h4{margin:0 0 6px;font-size:15px;font-weight:700;color:#222;line-height:1.3;}',
      '.bpm-sa-box p{margin:0 0 12px;font-size:13px;color:#555;line-height:1.4;}',
      '.bpm-sa-row{display:flex;gap:8px;flex-wrap:wrap;align-items:stretch;}',
      '.bpm-sa-row input{flex:1 1 180px;min-width:0;padding:11px 12px;border:1px solid #ccc;border-radius:8px;font-size:15px;outline:none;background:#fff;color:#222;box-sizing:border-box;}',
      '.bpm-sa-row input:focus{border-color:#25D366;}',
      '.bpm-sa-row button{padding:11px 18px;background:#25D366;color:#fff;border:0;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap;}',
      '.bpm-sa-row button:hover{background:#1ebe5d;}',
      '.bpm-sa-row button:disabled{opacity:.6;cursor:not-allowed;}',
      '.bpm-sa-msg{margin-top:10px;font-size:13px;line-height:1.4;}',
      '.bpm-sa-msg.ok{color:#0a7a2b;}',
      '.bpm-sa-msg.err{color:#c00;}',
      // Botón en listado
      '.bpm-sa-listbtn{display:inline-flex;align-items:center;gap:6px;margin-top:8px;padding:8px 12px;background:#25D366;color:#fff !important;border:0;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;line-height:1;font-family:inherit;}',
      '.bpm-sa-listbtn:hover{background:#1ebe5d;color:#fff !important;text-decoration:none;}',
      '.bpm-sa-listbtn:disabled{opacity:.6;cursor:not-allowed;}',
      // Modal
      '.bpm-sa-modal{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.55);font-family:inherit;color:#222;}',
      '.bpm-sa-modal *{box-sizing:border-box;}',
      '.bpm-sa-modal-card{background:#fff;border-radius:14px;width:100%;max-width:380px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.25);position:relative;animation:bpmSaIn .18s ease-out;}',
      '@keyframes bpmSaIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}',
      '.bpm-sa-modal-close{position:absolute;top:10px;right:10px;width:30px;height:30px;border:0;background:transparent;color:#666;font-size:22px;line-height:1;cursor:pointer;border-radius:50%;}',
      '.bpm-sa-modal-close:hover{background:#f2f2f2;color:#222;}',
      '.bpm-sa-modal h4{margin:0 0 4px;font-size:16px;font-weight:700;color:#222;line-height:1.3;}',
      '.bpm-sa-modal .bpm-sa-modal-product{margin:0 0 14px;font-size:13px;color:#666;line-height:1.35;}',
      '.bpm-sa-modal input[type="tel"]{width:100%;padding:12px 14px;border:1px solid #ccc;border-radius:9px;font-size:15px;outline:none;background:#fff;color:#222;margin-bottom:10px;font-family:inherit;}',
      '.bpm-sa-modal input[type="tel"]:focus{border-color:#25D366;}',
      '.bpm-sa-modal .bpm-sa-modal-submit{width:100%;padding:13px;background:#25D366;color:#fff;border:0;border-radius:9px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;}',
      '.bpm-sa-modal .bpm-sa-modal-submit:hover{background:#1ebe5d;}',
      '.bpm-sa-modal .bpm-sa-modal-submit:disabled{opacity:.6;cursor:not-allowed;}',
      '.bpm-sa-modal .bpm-sa-modal-msg{margin-top:10px;font-size:13px;line-height:1.4;min-height:18px;}',
      '.bpm-sa-modal .bpm-sa-modal-msg.ok{color:#0a7a2b;}',
      '.bpm-sa-modal .bpm-sa-modal-msg.err{color:#c00;}',
      '.bpm-sa-modal-success{text-align:center;padding:6px 0 2px;}',
      '.bpm-sa-modal-success .bpm-sa-check{font-size:44px;line-height:1;margin-bottom:10px;}',
      '.bpm-sa-modal-success p{margin:0;font-size:14px;color:#333;}',
    ].join('');
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  // =====================================================
  // Utils
  // =====================================================
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function normalizePhone(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.indexOf('54') === 0) d = d.slice(2);
    return d;
  }
  function isValidPhone(d) { return d.length >= 10 && d.length <= 15; }

  function getSentMap() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function setSent(key) {
    try {
      var m = getSentMap();
      m[key] = Date.now();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(m));
    } catch (e) {}
  }
  function alreadySent(key) {
    var m = getSentMap();
    if (!m[key]) return false;
    return (Date.now() - m[key]) < 24 * 60 * 60 * 1000;
  }

  function postAlert(payload) {
    return fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, body: j }; });
    });
  }

  // =====================================================
  // Contexto del producto en la página de detalle
  // =====================================================
  function findProductContext() {
    var form = document.getElementById('product_form');
    if (!form || !form.classList.contains('js-product-form')) return null;

    var addInput = form.querySelector('input[name="add_to_cart"]');
    var productId = addInput ? String(addInput.value || '').trim() : null;
    if (!productId) {
      var ds = form.getAttribute('data-store') || '';
      var m = ds.match(/product-form-(\d+)/);
      if (m) productId = m[1];
    }
    if (!productId) return null;

    var buyBtn = form.querySelector('input[data-store="product-buy-button"], input.js-addtocart');
    var outOfStock = false;
    if (buyBtn) {
      if (buyBtn.disabled === true || buyBtn.getAttribute('disabled') !== null) outOfStock = true;
      if (buyBtn.classList.contains('nostock')) outOfStock = true;
      var val = String(buyBtn.value || '').toLowerCase();
      if (/sin\s*stock|agotado|sold.?out|no\s*disponible/.test(val)) outOfStock = true;
    }

    var productName = null;
    var h1 = document.querySelector('h1');
    if (h1 && h1.textContent) productName = h1.textContent.trim();
    if (!productName) {
      var og = document.querySelector('meta[property="og:title"]');
      if (og) productName = og.getAttribute('content');
    }

    var variantName = '';
    $$('select.js-variation-option, select[name^="variation"]', form).forEach(function (sel) {
      var opt = sel.options && sel.options[sel.selectedIndex];
      if (opt && opt.text) {
        var t = opt.text.trim();
        if (t) variantName += (variantName ? ' / ' : '') + t;
      }
    });
    if (!variantName) {
      $$('.js-insta-variant.selected', form).forEach(function (btn) {
        var inner = btn.querySelector('[data-name]');
        var t = (inner && inner.getAttribute('data-name')) || btn.getAttribute('title') || btn.textContent || '';
        t = t.trim();
        if (t) variantName += (variantName ? ' / ' : '') + t;
      });
    }
    if (!variantName) {
      $$('strong.js-insta-variation-label', form).forEach(function (el) {
        var t = (el.textContent || '').trim();
        if (t) variantName += (variantName ? ' / ' : '') + t;
      });
    }

    var variantId = resolveVariantId(form, productId);

    return {
      productId: productId,
      variantId: variantId,
      productName: productName || null,
      variantName: variantName || null,
      outOfStock: outOfStock,
    };
  }

  function resolveVariantId(form) {
    var container = document.querySelector('[data-variants][data-quickshop-id]');
    var variantsJson = null;
    if (container) {
      try { variantsJson = JSON.parse(container.getAttribute('data-variants')); } catch (e) {}
    }
    var selectedOptionIds = [];
    $$('select.js-variation-option, select[name^="variation"]', form).forEach(function (sel) {
      if (sel.value) selectedOptionIds.push(String(sel.value));
    });
    $$('.js-insta-variant.selected', form).forEach(function (btn) {
      var id = btn.getAttribute('data-option');
      if (id) selectedOptionIds.push(String(id));
    });
    if (!variantsJson || !Array.isArray(variantsJson) || selectedOptionIds.length === 0) return null;
    for (var i = 0; i < variantsJson.length; i++) {
      var v = variantsJson[i];
      var opts = [v.option1, v.option2, v.option3].filter(function (x) { return x != null; }).map(String);
      var allMatch = selectedOptionIds.every(function (s) { return opts.indexOf(String(s)) !== -1; });
      if (allMatch) return String(v.id);
    }
    return null;
  }

  // =====================================================
  // Bloque inline en detalle
  // =====================================================
  function renderDetailBlock(ctx) {
    var form = document.getElementById('product_form');
    if (!form) return;

    var existing = document.getElementById('bpm-sa-block');
    var key = ctx.productId + ':' + (ctx.variantId || 'null');

    if (existing) {
      existing.setAttribute('data-product-id', ctx.productId);
      existing.setAttribute('data-variant-id', ctx.variantId || '');
      existing.setAttribute('data-product-name', ctx.productName || '');
      existing.setAttribute('data-variant-name', ctx.variantName || '');
      existing.style.display = '';
      if (alreadySent(key)) showSuccess(existing);
      return;
    }

    var box = document.createElement('div');
    box.id = 'bpm-sa-block';
    box.className = 'bpm-sa-box';
    box.setAttribute('data-product-id', ctx.productId);
    box.setAttribute('data-variant-id', ctx.variantId || '');
    box.setAttribute('data-product-name', ctx.productName || '');
    box.setAttribute('data-variant-name', ctx.variantName || '');

    box.innerHTML = [
      '<h4>📲 Avisame cuando reingrese</h4>',
      '<p>Dejanos tu número de WhatsApp y te avisamos apenas ingrese.</p>',
      '<div class="bpm-sa-row">',
      '  <input id="bpm-sa-phone" type="tel" inputmode="numeric" placeholder="Ej: 11 2345 6789" autocomplete="tel" />',
      '  <button id="bpm-sa-submit" type="button">Avisarme por WhatsApp</button>',
      '</div>',
      '<div id="bpm-sa-msg" class="bpm-sa-msg"></div>',
    ].join('');

    if (form.parentNode) form.parentNode.insertBefore(box, form.nextSibling);

    if (alreadySent(key)) { showSuccess(box); return; }

    box.querySelector('#bpm-sa-submit').addEventListener('click', function () { submitInline(box); });
    box.querySelector('#bpm-sa-phone').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitInline(box); }
    });
  }

  function hideDetailBlock() {
    var existing = document.getElementById('bpm-sa-block');
    if (existing) existing.style.display = 'none';
  }

  function showSuccess(box) {
    var row = box.querySelector('.bpm-sa-row');
    if (row) row.style.display = 'none';
    var msg = box.querySelector('#bpm-sa-msg');
    if (msg) {
      msg.className = 'bpm-sa-msg ok';
      msg.textContent = '✅ Listo, te vamos a avisar apenas ingrese stock.';
    }
  }

  function submitInline(box) {
    var phoneInput = box.querySelector('#bpm-sa-phone');
    var btn = box.querySelector('#bpm-sa-submit');
    var msg = box.querySelector('#bpm-sa-msg');
    var phone = normalizePhone(phoneInput.value.trim());

    if (!isValidPhone(phone)) {
      msg.className = 'bpm-sa-msg err';
      msg.textContent = 'Ingresá un teléfono válido (10-15 dígitos).';
      return;
    }

    btn.disabled = true;
    var originalLabel = btn.textContent;
    btn.textContent = 'Enviando...';
    msg.textContent = '';

    var payload = {
      product_id: box.getAttribute('data-product-id'),
      variant_id: box.getAttribute('data-variant-id') || null,
      product_name: box.getAttribute('data-product-name') || null,
      variant_name: box.getAttribute('data-variant-name') || null,
      phone: phone,
      source: 'tiendanube',
    };

    postAlert(payload)
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = originalLabel;
        if (res.ok && res.body && res.body.success) {
          setSent(payload.product_id + ':' + (payload.variant_id || 'null'));
          showSuccess(box);
        } else {
          msg.className = 'bpm-sa-msg err';
          msg.textContent = (res.body && res.body.error) || 'No pudimos registrar tu aviso.';
        }
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = originalLabel;
        msg.className = 'bpm-sa-msg err';
        msg.textContent = 'Error de conexión. Intentá de nuevo.';
      });
  }

  // =====================================================
  // Listado: detectar "todos los variants sin stock"
  // =====================================================
  function parseItemVariants(itemEl) {
    // El contenedor con data-variants está adentro del item
    var holder = itemEl.querySelector('[data-variants]');
    if (!holder) return null;
    try {
      var raw = holder.getAttribute('data-variants');
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function itemIsFullyOutOfStock(itemEl) {
    var variants = parseItemVariants(itemEl);
    if (!variants || !Array.isArray(variants) || variants.length === 0) return false;
    // Sin stock = NINGÚN variant available=true
    return variants.every(function (v) {
      return v && v.available !== true;
    });
  }

  function getItemProductName(itemEl) {
    var nameEl = itemEl.querySelector('.js-item-name, [data-store^="product-item-name"]');
    if (nameEl) return (nameEl.textContent || '').trim();
    return null;
  }

  function decorateListing() {
    $$('.js-item-product[data-product-id]').forEach(function (item) {
      if (item.getAttribute('data-bpm-sa-decorated') === '1') return;
      if (!itemIsFullyOutOfStock(item)) return;

      var productId = item.getAttribute('data-product-id');
      if (!productId) return;

      var productName = getItemProductName(item);

      // Insertar el botón al final de la descripción (después del precio)
      var anchor = item.querySelector('.item-description') || item;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bpm-sa-listbtn';
      btn.innerHTML = '🔔 Avisame cuando reingrese';
      btn.setAttribute('data-product-id', productId);
      btn.setAttribute('data-product-name', productName || '');

      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openModal({
          productId: productId,
          productName: productName,
          variantId: null,
          variantName: null,
        });
      });

      anchor.appendChild(btn);
      item.setAttribute('data-bpm-sa-decorated', '1');
    });
  }

  // =====================================================
  // Modal compartido
  // =====================================================
  var modalEl = null;

  function buildModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'bpm-sa-modal';
    modalEl.style.display = 'none';
    modalEl.innerHTML = [
      '<div class="bpm-sa-modal-card" role="dialog" aria-modal="true">',
      '  <button type="button" class="bpm-sa-modal-close" aria-label="Cerrar">&times;</button>',
      '  <div class="bpm-sa-modal-form">',
      '    <h4>📲 Avisame cuando reingrese</h4>',
      '    <p class="bpm-sa-modal-product"></p>',
      '    <input type="tel" inputmode="numeric" placeholder="Tu WhatsApp (ej: 11 2345 6789)" autocomplete="tel" />',
      '    <button type="button" class="bpm-sa-modal-submit">Confirmar</button>',
      '    <div class="bpm-sa-modal-msg"></div>',
      '  </div>',
      '  <div class="bpm-sa-modal-success" style="display:none;">',
      '    <div class="bpm-sa-check">✅</div>',
      '    <p>Listo, te avisamos cuando vuelva a stock.</p>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(modalEl);

    // Eventos
    modalEl.addEventListener('click', function (e) {
      // Click en el backdrop (fuera de la card) cierra
      if (e.target === modalEl) closeModal();
    });
    modalEl.querySelector('.bpm-sa-modal-close').addEventListener('click', closeModal);
    modalEl.querySelector('.bpm-sa-modal-submit').addEventListener('click', submitModal);
    modalEl.querySelector('input[type="tel"]').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitModal(); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modalEl && modalEl.style.display !== 'none') closeModal();
    });

    return modalEl;
  }

  function openModal(ctx) {
    var m = buildModal();
    m.setAttribute('data-product-id', ctx.productId || '');
    m.setAttribute('data-variant-id', ctx.variantId || '');
    m.setAttribute('data-product-name', ctx.productName || '');
    m.setAttribute('data-variant-name', ctx.variantName || '');

    var productEl = m.querySelector('.bpm-sa-modal-product');
    productEl.textContent = ctx.productName ? ctx.productName : 'Producto sin stock';

    // Reset estados (por si abre de nuevo después de éxito)
    m.querySelector('.bpm-sa-modal-form').style.display = '';
    m.querySelector('.bpm-sa-modal-success').style.display = 'none';
    var input = m.querySelector('input[type="tel"]');
    input.value = '';
    input.disabled = false;
    var msg = m.querySelector('.bpm-sa-modal-msg');
    msg.textContent = '';
    msg.className = 'bpm-sa-modal-msg';
    var btn = m.querySelector('.bpm-sa-modal-submit');
    btn.disabled = false;
    btn.textContent = 'Confirmar';

    // Si ya lo envió recién, mostrar éxito directo
    var key = (ctx.productId || '') + ':' + (ctx.variantId || 'null');
    if (alreadySent(key)) {
      m.querySelector('.bpm-sa-modal-form').style.display = 'none';
      m.querySelector('.bpm-sa-modal-success').style.display = '';
    }

    m.style.display = 'flex';
    setTimeout(function () { input.focus(); }, 50);
  }

  function closeModal() {
    if (modalEl) modalEl.style.display = 'none';
  }

  function submitModal() {
    var m = modalEl;
    if (!m) return;
    var input = m.querySelector('input[type="tel"]');
    var btn = m.querySelector('.bpm-sa-modal-submit');
    var msg = m.querySelector('.bpm-sa-modal-msg');

    var phone = normalizePhone(input.value.trim());
    if (!isValidPhone(phone)) {
      msg.className = 'bpm-sa-modal-msg err';
      msg.textContent = 'Ingresá un teléfono válido (10-15 dígitos).';
      return;
    }

    btn.disabled = true;
    input.disabled = true;
    btn.textContent = 'Enviando...';
    msg.textContent = '';

    var payload = {
      product_id: m.getAttribute('data-product-id'),
      variant_id: m.getAttribute('data-variant-id') || null,
      product_name: m.getAttribute('data-product-name') || null,
      variant_name: m.getAttribute('data-variant-name') || null,
      phone: phone,
      source: 'tiendanube',
    };

    postAlert(payload)
      .then(function (res) {
        if (res.ok && res.body && res.body.success) {
          setSent(payload.product_id + ':' + (payload.variant_id || 'null'));
          m.querySelector('.bpm-sa-modal-form').style.display = 'none';
          m.querySelector('.bpm-sa-modal-success').style.display = '';
          setTimeout(closeModal, AUTO_CLOSE_MS);
        } else {
          btn.disabled = false;
          input.disabled = false;
          btn.textContent = 'Confirmar';
          msg.className = 'bpm-sa-modal-msg err';
          msg.textContent = (res.body && res.body.error) || 'No pudimos registrar tu aviso.';
        }
      })
      .catch(function () {
        btn.disabled = false;
        input.disabled = false;
        btn.textContent = 'Confirmar';
        msg.className = 'bpm-sa-modal-msg err';
        msg.textContent = 'Error de conexión. Intentá de nuevo.';
      });
  }

  // =====================================================
  // Orquestación
  // =====================================================
  function run() {
    injectStyles();

    var ctx = findProductContext();
    if (ctx && ctx.outOfStock) renderDetailBlock(ctx);
    else hideDetailBlock();

    decorateListing();
  }

  function init() {
    run();
    var debounceId = null;
    var mo = new MutationObserver(function () {
      clearTimeout(debounceId);
      debounceId = setTimeout(run, 250);
    });
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'disabled', 'value', 'selected', 'data-variants'],
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
