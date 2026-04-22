/**
 * BPM — Stock Alerts Snippet (Tiendanube theme "Recife")
 *
 * Fase 1: solo captura de intención. No envía mensajes todavía.
 *
 * Detecta:
 *   - Página de detalle: <form id="product_form"> con <input name="add_to_cart" value="{product.id}">
 *   - Botón "Sin stock": <input data-store="product-buy-button" class="... nostock" disabled>
 *   - Variante seleccionada: selects <select class="js-variation-option"> + botones .js-insta-variant.selected
 *
 * Integración:
 *   <script src="https://api.bpmadministrador.com/stock-alerts-snippet.js" defer></script>
 *   (se carga desde layout.tpl, corre en todas las páginas, se auto-desactiva donde no aplica)
 */
(function () {
  'use strict';

  var API_URL = 'https://api.bpmadministrador.com/stock-alerts';
  var STORAGE_KEY = 'bpm_stock_alerts_sent_v1';
  var STYLE_ID = 'bpm-stock-alerts-style';

  // =====================================================
  // Estilos
  // =====================================================
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
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

  // =====================================================
  // Contexto del producto en la página de detalle (theme Recife)
  // =====================================================
  function findProductContext() {
    // Form exclusivo de la página de detalle: <form id="product_form" class="js-product-form" data-store="product-form-{id}">
    var form = document.getElementById('product_form');
    if (!form || !form.classList.contains('js-product-form')) return null;

    // product_id — siempre está en <input name="add_to_cart">
    var addInput = form.querySelector('input[name="add_to_cart"]');
    var productId = addInput ? String(addInput.value || '').trim() : null;
    if (!productId) {
      // Fallback: parsear data-store="product-form-{id}"
      var ds = form.getAttribute('data-store') || '';
      var m = ds.match(/product-form-(\d+)/);
      if (m) productId = m[1];
    }
    if (!productId) return null;

    // Sin stock — input[data-store="product-buy-button"] con clase nostock o disabled
    var buyBtn = form.querySelector('input[data-store="product-buy-button"], input.js-addtocart');
    var outOfStock = false;
    if (buyBtn) {
      if (buyBtn.disabled === true || buyBtn.getAttribute('disabled') !== null) outOfStock = true;
      if (buyBtn.classList.contains('nostock')) outOfStock = true;
      var val = String(buyBtn.value || '').toLowerCase();
      if (/sin\s*stock|agotado|sold.?out|no\s*disponible/.test(val)) outOfStock = true;
    }

    // Nombre del producto
    var productName = null;
    var h1 = document.querySelector('h1');
    if (h1 && h1.textContent) productName = h1.textContent.trim();
    if (!productName) {
      var og = document.querySelector('meta[property="og:title"]');
      if (og) productName = og.getAttribute('content');
    }

    // Variante seleccionada: concatena nombres de opciones activas
    var variantName = '';
    // 1) Selects clásicos
    $$('select.js-variation-option, select[name^="variation"]', form).forEach(function (sel) {
      var opt = sel.options && sel.options[sel.selectedIndex];
      if (opt && opt.text) {
        var t = opt.text.trim();
        if (t) variantName += (variantName ? ' / ' : '') + t;
      }
    });
    // 2) Botones bullet / color (fallback si no hay selects visibles)
    if (!variantName) {
      $$('.js-insta-variant.selected', form).forEach(function (btn) {
        var inner = btn.querySelector('[data-name]');
        var t = (inner && inner.getAttribute('data-name')) || btn.getAttribute('title') || btn.textContent || '';
        t = t.trim();
        if (t) variantName += (variantName ? ' / ' : '') + t;
      });
    }
    // 3) Label js-insta-variation-label
    if (!variantName) {
      $$('strong.js-insta-variation-label', form).forEach(function (el) {
        var t = (el.textContent || '').trim();
        if (t) variantName += (variantName ? ' / ' : '') + t;
      });
    }

    // variant_id: este theme no expone el variant_id actual como input hidden de forma confiable.
    // Intentamos resolverlo usando product.variants_object si está disponible en algún contenedor.
    var variantId = resolveVariantId(form, productId);

    return {
      productId: productId,
      variantId: variantId,
      productName: productName || null,
      variantName: variantName || null,
      outOfStock: outOfStock,
    };
  }

  function resolveVariantId(form, productId) {
    // 1) data-variants JSON en contenedor de quickshop (a veces presente también en detalle)
    var container = document.querySelector('[data-variants][data-quickshop-id]');
    var variantsJson = null;
    if (container) {
      try { variantsJson = JSON.parse(container.getAttribute('data-variants')); } catch (e) {}
    }

    // 2) Opciones actualmente seleccionadas (option IDs)
    var selectedOptionIds = [];
    $$('select.js-variation-option, select[name^="variation"]', form).forEach(function (sel) {
      if (sel.value) selectedOptionIds.push(String(sel.value));
    });
    $$('.js-insta-variant.selected', form).forEach(function (btn) {
      var id = btn.getAttribute('data-option');
      if (id) selectedOptionIds.push(String(id));
    });

    if (!variantsJson || !Array.isArray(variantsJson) || selectedOptionIds.length === 0) return null;

    // Match: variant cuyas values (option1/option2/option3) matchean todas las seleccionadas
    for (var i = 0; i < variantsJson.length; i++) {
      var v = variantsJson[i];
      var opts = [v.option1, v.option2, v.option3].filter(function (x) { return x != null; }).map(String);
      var allMatch = selectedOptionIds.every(function (s) { return opts.indexOf(String(s)) !== -1; });
      if (allMatch) return String(v.id);
    }
    return null;
  }

  // =====================================================
  // UI: bloque "Avisame cuando vuelva a stock" en detalle
  // =====================================================
  function renderDetailBlock(ctx) {
    var form = document.getElementById('product_form');
    if (!form) return;

    var existing = document.getElementById('bpm-sa-block');
    var key = ctx.productId + ':' + (ctx.variantId || 'null');

    if (existing) {
      // Actualizar contexto
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
      '<h4>📲 Avisame cuando vuelva a stock</h4>',
      '<p>Dejanos tu número de WhatsApp y te avisamos apenas ingrese.</p>',
      '<div class="bpm-sa-row">',
      '  <input id="bpm-sa-phone" type="tel" inputmode="numeric" placeholder="Ej: 11 2345 6789" autocomplete="tel" />',
      '  <button id="bpm-sa-submit" type="button">Avisarme por WhatsApp</button>',
      '</div>',
      '<div id="bpm-sa-msg" class="bpm-sa-msg"></div>',
    ].join('');

    // Insertar inmediatamente después del form (queda debajo del botón "Sin stock")
    if (form.parentNode) {
      form.parentNode.insertBefore(box, form.nextSibling);
    }

    if (alreadySent(key)) {
      showSuccess(box);
      return;
    }

    var submitBtn = box.querySelector('#bpm-sa-submit');
    var phoneInput = box.querySelector('#bpm-sa-phone');
    submitBtn.addEventListener('click', function () { submit(box); });
    phoneInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(box); }
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

  function submit(box) {
    var phoneInput = box.querySelector('#bpm-sa-phone');
    var btn = box.querySelector('#bpm-sa-submit');
    var msg = box.querySelector('#bpm-sa-msg');

    var phoneRaw = phoneInput.value.trim();
    var phone = normalizePhone(phoneRaw);

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

    fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = originalLabel;
        if (res.ok && res.body && res.body.success) {
          var key = payload.product_id + ':' + (payload.variant_id || 'null');
          setSent(key);
          showSuccess(box);
        } else {
          msg.className = 'bpm-sa-msg err';
          msg.textContent = (res.body && res.body.error) || 'No pudimos registrar tu aviso. Intentá más tarde.';
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
  // Orquestación
  // =====================================================
  function run() {
    injectStyles();
    var ctx = findProductContext();
    if (ctx && ctx.outOfStock) {
      renderDetailBlock(ctx);
    } else {
      hideDetailBlock();
    }
  }

  function init() {
    run();

    // Observa cambios (cambio de variante, ajax, re-render de precio/stock)
    var debounceId = null;
    var mo = new MutationObserver(function () {
      clearTimeout(debounceId);
      debounceId = setTimeout(run, 250);
    });
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'disabled', 'value', 'selected'],
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
