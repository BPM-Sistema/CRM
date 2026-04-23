/**
 * BPM — Stock Alerts Snippet (Tiendanube theme "Recife")
 *
 * Fase 1: captura de intención. No envía mensajes todavía.
 *
 * Qué hace:
 *   1. LISTADO: productos cuyos variants están todos sin stock → botón V5
 *      (card blanca + borde verde + ícono campana) debajo del precio.
 *      Click abre modal V5 (toast oscuro abajo-derecha) con:
 *        · Primer nombre · WhatsApp · checkbox novedades · Confirmar
 *      Al confirmar se cierra solo.
 *   2. DETALLE: bloque inline debajo del form cuando el producto/variante
 *      seleccionada está sin stock. Mismo form (nombre + WhatsApp + checkbox).
 *
 * Integración:
 *   <script src="https://api.bpmadministrador.com/stock-alerts-snippet.js" defer></script>
 */
(function () {
  'use strict';

  var API_URL = 'https://api.bpmadministrador.com/stock-alerts';
  var STORAGE_KEY = 'bpm_stock_alerts_sent_v2';
  var STYLE_ID = 'bpm-stock-alerts-style';
  var AUTO_CLOSE_MS = 1800;
  var ACCENT = '#25D366'; // borde verde WhatsApp

  // =====================================================
  // Estilos
  // =====================================================
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      // ========= Detalle: bloque inline =========
      '.bpm-sa-box{margin:16px 0;padding:18px;border:1.5px solid ' + ACCENT + ';border-radius:12px;background:#fff;font-family:inherit;color:#222;box-shadow:0 1px 3px rgba(37,211,102,.08);}',
      '.bpm-sa-box h4{margin:0 0 6px;font-size:15px;font-weight:700;color:#222;line-height:1.3;}',
      '.bpm-sa-box p.bpm-sa-lead{margin:0 0 14px;font-size:13px;color:#555;line-height:1.45;}',
      '.bpm-sa-box .bpm-sa-field{margin-bottom:10px;}',
      '.bpm-sa-box input[type="text"], .bpm-sa-box input[type="tel"]{width:100%;padding:11px 13px;border:1px solid #d8d8d6;border-radius:9px;font:inherit;font-size:14px;outline:none;background:#fff;color:#222;box-sizing:border-box;}',
      '.bpm-sa-box input[type="text"]:focus, .bpm-sa-box input[type="tel"]:focus{border-color:' + ACCENT + ';}',
      '.bpm-sa-box .bpm-sa-check{display:flex;align-items:flex-start;gap:8px;margin:2px 0 14px;font-size:12.5px;color:#555;line-height:1.4;cursor:pointer;}',
      '.bpm-sa-box .bpm-sa-check input[type="checkbox"]{flex-shrink:0;margin-top:2px;width:14px;height:14px;accent-color:' + ACCENT + ';}',
      '.bpm-sa-box button.bpm-sa-submit{width:100%;padding:12px;background:' + ACCENT + ';color:#fff;border:0;border-radius:9px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;}',
      '.bpm-sa-box button.bpm-sa-submit:hover{background:#1ebe5d;}',
      '.bpm-sa-box button.bpm-sa-submit:disabled{opacity:.6;cursor:not-allowed;}',
      '.bpm-sa-box .bpm-sa-msg{margin-top:10px;font-size:13px;line-height:1.4;min-height:18px;}',
      '.bpm-sa-box .bpm-sa-msg.ok{color:#0a7a2b;}',
      '.bpm-sa-box .bpm-sa-msg.err{color:#c00;}',

      // ========= Botón en listado (V5 con borde verde) =========
      '.bpm-sa-listbtn{display:inline-flex;align-items:center;gap:7px;margin-top:8px;padding:8px 13px;background:#fff;border:1.5px solid ' + ACCENT + ';border-radius:8px;color:#1a1a1a !important;font:inherit;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none !important;line-height:1;box-shadow:0 1px 2px rgba(37,211,102,.1);font-family:inherit;}',
      '.bpm-sa-listbtn:hover{background:' + ACCENT + ';color:#fff !important;border-color:' + ACCENT + ';text-decoration:none !important;}',
      '.bpm-sa-listbtn:hover svg{color:#fff;}',
      '.bpm-sa-listbtn svg{width:14px;height:14px;color:' + ACCENT + ';flex-shrink:0;}',

      // ========= Modal V5 (toast oscuro abajo-derecha) =========
      '.bpm-sa-modal{position:fixed;inset:0;z-index:2147483000;pointer-events:none;display:flex;align-items:flex-end;justify-content:flex-end;padding:24px;font-family:inherit;}',
      '.bpm-sa-modal.open{display:flex;}',
      '.bpm-sa-modal *{box-sizing:border-box;}',
      '.bpm-sa-modal-card{pointer-events:auto;background:#1a1a1a;color:#fff;border:1.5px solid ' + ACCENT + ';border-radius:14px;max-width:340px;width:100%;padding:20px 22px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.35);animation:bpmSaFadeUp .2s ease-out;}',
      '@keyframes bpmSaFadeUp{from{transform:translateY(14px);opacity:0}to{transform:translateY(0);opacity:1}}',
      '.bpm-sa-modal-close{position:absolute;top:8px;right:12px;background:none;border:0;color:#888;font-size:18px;cursor:pointer;width:26px;height:26px;line-height:1;border-radius:4px;}',
      '.bpm-sa-modal-close:hover{background:#2a2a2a;color:#fff;}',
      '.bpm-sa-modal h4{margin:0 0 4px;font-size:15px;font-weight:700;color:#fff;}',
      '.bpm-sa-modal p.bpm-sa-modal-lead{margin:0 0 14px;font-size:12.5px;color:#b8b8b8;line-height:1.4;}',
      '.bpm-sa-modal input[type="text"], .bpm-sa-modal input[type="tel"]{width:100%;padding:10px 12px;border:1px solid #333;background:#000;color:#fff;border-radius:8px;font:inherit;font-size:13px;outline:none;margin-bottom:8px;}',
      '.bpm-sa-modal input[type="text"]::placeholder, .bpm-sa-modal input[type="tel"]::placeholder{color:#666;}',
      '.bpm-sa-modal input[type="text"]:focus, .bpm-sa-modal input[type="tel"]:focus{border-color:' + ACCENT + ';}',
      '.bpm-sa-modal .bpm-sa-modal-check{display:flex;align-items:flex-start;gap:8px;margin:8px 0 12px;font-size:12px;color:#d0d0d0;line-height:1.4;cursor:pointer;}',
      '.bpm-sa-modal .bpm-sa-modal-check input[type="checkbox"]{flex-shrink:0;margin-top:1px;width:14px;height:14px;accent-color:' + ACCENT + ';}',
      '.bpm-sa-modal .bpm-sa-modal-submit{width:100%;padding:10px;background:' + ACCENT + ';color:#fff;border:0;border-radius:8px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;}',
      '.bpm-sa-modal .bpm-sa-modal-submit:hover{background:#1ebe5d;}',
      '.bpm-sa-modal .bpm-sa-modal-submit:disabled{opacity:.6;cursor:not-allowed;}',
      '.bpm-sa-modal .bpm-sa-modal-msg{margin-top:8px;font-size:12px;line-height:1.4;min-height:16px;}',
      '.bpm-sa-modal .bpm-sa-modal-msg.err{color:#ff6b6b;}',
      '.bpm-sa-modal-success{text-align:center;padding:6px 0 2px;}',
      '.bpm-sa-modal-success .bpm-sa-check-icon{font-size:36px;line-height:1;margin-bottom:8px;color:' + ACCENT + ';}',
      '.bpm-sa-modal-success p{margin:0;font-size:13px;color:#e5e5e5;}',
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
  // Contexto en detalle
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

    var variantId = resolveVariantId(form);

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
  var BOX_HTML = [
    '<h4>📲 Avisame cuando reingrese</h4>',
    '<p class="bpm-sa-lead">Si querés enterarte rápido apenas ingrese este producto, dejá tu WhatsApp acá.</p>',
    '<div class="bpm-sa-field"><input type="text" class="bpm-sa-name" placeholder="Primer nombre" autocomplete="given-name" /></div>',
    '<div class="bpm-sa-field"><input type="tel" class="bpm-sa-phone" placeholder="Número de WhatsApp" inputmode="numeric" autocomplete="tel" /></div>',
    '<label class="bpm-sa-check"><input type="checkbox" class="bpm-sa-news" /><span>Quiero enterarme también de novedades y nuevos ingresos</span></label>',
    '<button type="button" class="bpm-sa-submit">Avisarme por WhatsApp</button>',
    '<div class="bpm-sa-msg"></div>',
  ].join('');

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
      if (alreadySent(key)) showInlineSuccess(existing);
      return;
    }

    var box = document.createElement('div');
    box.id = 'bpm-sa-block';
    box.className = 'bpm-sa-box';
    box.setAttribute('data-product-id', ctx.productId);
    box.setAttribute('data-variant-id', ctx.variantId || '');
    box.setAttribute('data-product-name', ctx.productName || '');
    box.setAttribute('data-variant-name', ctx.variantName || '');
    box.innerHTML = BOX_HTML;

    if (form.parentNode) form.parentNode.insertBefore(box, form.nextSibling);

    if (alreadySent(key)) { showInlineSuccess(box); return; }

    box.querySelector('.bpm-sa-submit').addEventListener('click', function () { submitInline(box); });
    ['.bpm-sa-name', '.bpm-sa-phone'].forEach(function (sel) {
      var el = box.querySelector(sel);
      if (el) el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitInline(box); }
      });
    });
  }

  function hideDetailBlock() {
    var existing = document.getElementById('bpm-sa-block');
    if (existing) existing.style.display = 'none';
  }

  function showInlineSuccess(box) {
    // Oculta todos los hijos interactivos
    $$('.bpm-sa-field, .bpm-sa-check, .bpm-sa-submit', box).forEach(function (el) { el.style.display = 'none'; });
    var msg = box.querySelector('.bpm-sa-msg');
    if (msg) {
      msg.className = 'bpm-sa-msg ok';
      msg.textContent = '✅ Listo, te avisamos apenas reingrese.';
    }
  }

  function submitInline(box) {
    var nameInput = box.querySelector('.bpm-sa-name');
    var phoneInput = box.querySelector('.bpm-sa-phone');
    var newsInput = box.querySelector('.bpm-sa-news');
    var btn = box.querySelector('.bpm-sa-submit');
    var msg = box.querySelector('.bpm-sa-msg');

    var name = (nameInput.value || '').trim();
    var phone = normalizePhone(phoneInput.value.trim());

    if (!name) {
      msg.className = 'bpm-sa-msg err';
      msg.textContent = 'Ingresá tu primer nombre.';
      return;
    }
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
      first_name: name,
      wants_news: !!(newsInput && newsInput.checked),
      source: 'tiendanube',
    };

    postAlert(payload)
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = originalLabel;
        if (res.ok && res.body && res.body.success) {
          setSent(payload.product_id + ':' + (payload.variant_id || 'null'));
          showInlineSuccess(box);
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
    var holder = itemEl.querySelector('[data-variants]');
    if (!holder) return null;
    try { return JSON.parse(holder.getAttribute('data-variants')); } catch (e) { return null; }
  }

  function itemIsFullyOutOfStock(itemEl) {
    var variants = parseItemVariants(itemEl);
    if (!variants || !Array.isArray(variants) || variants.length === 0) return false;
    return variants.every(function (v) { return v && v.available !== true; });
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

      var anchor = item.querySelector('.item-description') || item;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bpm-sa-listbtn';
      btn.innerHTML = [
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
        '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>',
        '<path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
        '</svg>',
        '<span>Avisame cuando reingrese</span>',
      ].join('');

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
  // Modal V5
  // =====================================================
  var modalEl = null;

  function buildModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'bpm-sa-modal';
    modalEl.innerHTML = [
      '<div class="bpm-sa-modal-card" role="dialog" aria-modal="true">',
      '  <button type="button" class="bpm-sa-modal-close" aria-label="Cerrar">&times;</button>',
      '  <div class="bpm-sa-modal-form">',
      '    <h4>📲 Avisame cuando reingrese</h4>',
      '    <p class="bpm-sa-modal-lead">Si querés enterarte rápido apenas ingrese este producto, dejá tu WhatsApp acá.</p>',
      '    <input type="text" class="bpm-sa-modal-name" placeholder="Primer nombre" autocomplete="given-name" />',
      '    <input type="tel" class="bpm-sa-modal-phone" placeholder="Número de WhatsApp" inputmode="numeric" autocomplete="tel" />',
      '    <label class="bpm-sa-modal-check"><input type="checkbox" class="bpm-sa-modal-news" /><span>Quiero enterarme también de novedades y nuevos ingresos</span></label>',
      '    <button type="button" class="bpm-sa-modal-submit">Confirmar</button>',
      '    <div class="bpm-sa-modal-msg"></div>',
      '  </div>',
      '  <div class="bpm-sa-modal-success" style="display:none;">',
      '    <div class="bpm-sa-check-icon">✓</div>',
      '    <p>Listo, te avisamos cuando reingrese.</p>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(modalEl);

    modalEl.querySelector('.bpm-sa-modal-close').addEventListener('click', closeModal);
    modalEl.querySelector('.bpm-sa-modal-submit').addEventListener('click', submitModal);
    ['.bpm-sa-modal-name', '.bpm-sa-modal-phone'].forEach(function (sel) {
      var el = modalEl.querySelector(sel);
      if (el) el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitModal(); }
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modalEl && modalEl.classList.contains('open')) closeModal();
    });

    return modalEl;
  }

  function openModal(ctx) {
    var m = buildModal();
    m.setAttribute('data-product-id', ctx.productId || '');
    m.setAttribute('data-variant-id', ctx.variantId || '');
    m.setAttribute('data-product-name', ctx.productName || '');
    m.setAttribute('data-variant-name', ctx.variantName || '');

    m.querySelector('.bpm-sa-modal-form').style.display = '';
    m.querySelector('.bpm-sa-modal-success').style.display = 'none';
    var name = m.querySelector('.bpm-sa-modal-name'); name.value = ''; name.disabled = false;
    var phone = m.querySelector('.bpm-sa-modal-phone'); phone.value = ''; phone.disabled = false;
    var news = m.querySelector('.bpm-sa-modal-news'); if (news) news.checked = false;
    var msg = m.querySelector('.bpm-sa-modal-msg'); msg.textContent = ''; msg.className = 'bpm-sa-modal-msg';
    var btn = m.querySelector('.bpm-sa-modal-submit'); btn.disabled = false; btn.textContent = 'Confirmar';

    var key = (ctx.productId || '') + ':' + (ctx.variantId || 'null');
    if (alreadySent(key)) {
      m.querySelector('.bpm-sa-modal-form').style.display = 'none';
      m.querySelector('.bpm-sa-modal-success').style.display = '';
    }

    m.classList.add('open');
    setTimeout(function () { name.focus(); }, 50);
  }

  function closeModal() {
    if (modalEl) modalEl.classList.remove('open');
  }

  function submitModal() {
    var m = modalEl;
    if (!m) return;
    var nameInput = m.querySelector('.bpm-sa-modal-name');
    var phoneInput = m.querySelector('.bpm-sa-modal-phone');
    var newsInput = m.querySelector('.bpm-sa-modal-news');
    var btn = m.querySelector('.bpm-sa-modal-submit');
    var msg = m.querySelector('.bpm-sa-modal-msg');

    var name = (nameInput.value || '').trim();
    var phone = normalizePhone(phoneInput.value.trim());

    if (!name) {
      msg.className = 'bpm-sa-modal-msg err';
      msg.textContent = 'Ingresá tu primer nombre.';
      return;
    }
    if (!isValidPhone(phone)) {
      msg.className = 'bpm-sa-modal-msg err';
      msg.textContent = 'Ingresá un teléfono válido (10-15 dígitos).';
      return;
    }

    btn.disabled = true;
    nameInput.disabled = true;
    phoneInput.disabled = true;
    btn.textContent = 'Enviando...';
    msg.textContent = '';

    var payload = {
      product_id: m.getAttribute('data-product-id'),
      variant_id: m.getAttribute('data-variant-id') || null,
      product_name: m.getAttribute('data-product-name') || null,
      variant_name: m.getAttribute('data-variant-name') || null,
      phone: phone,
      first_name: name,
      wants_news: !!(newsInput && newsInput.checked),
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
          nameInput.disabled = false;
          phoneInput.disabled = false;
          btn.textContent = 'Confirmar';
          msg.className = 'bpm-sa-modal-msg err';
          msg.textContent = (res.body && res.body.error) || 'No pudimos registrar tu aviso.';
        }
      })
      .catch(function () {
        btn.disabled = false;
        nameInput.disabled = false;
        phoneInput.disabled = false;
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
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'disabled', 'value', 'selected', 'data-variants'],
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
