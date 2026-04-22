/**
 * BPM — Stock Alerts Snippet (Tiendanube)
 *
 * Inyecta:
 *  - En listado de productos: badge "Sin stock — Avisarme" si producto sin stock
 *  - En detalle de producto: bloque con input teléfono + botón "Avisarme por WhatsApp"
 *    (detecta la variante seleccionada actualmente)
 *
 * Fase 1: solo captura de intención. No envía mensajes.
 *
 * Cómo integrarlo en el theme de Tiendanube:
 *   Agregar en el layout principal (por ej. antes de </body>):
 *     <script src="https://api.bpmadministrador.com/stock-alerts-snippet.js" defer></script>
 *
 * Requiere que el theme exponga data-attrs estándar de TN en los botones "Comprar"
 * y en los elementos de producto de listado. Ver función `findContext()` para los
 * selectores usados.
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
      '.bpm-sa-badge{display:inline-block;padding:4px 10px;background:#fee;color:#c00;border-radius:999px;font-size:12px;font-weight:600;margin-top:6px;}',
      '.bpm-sa-box{margin:16px 0;padding:16px;border:1px solid #e5e5e5;border-radius:10px;background:#fafafa;font-family:inherit;}',
      '.bpm-sa-box h4{margin:0 0 6px;font-size:15px;font-weight:700;color:#222;}',
      '.bpm-sa-box p{margin:0 0 12px;font-size:13px;color:#555;}',
      '.bpm-sa-row{display:flex;gap:8px;flex-wrap:wrap;}',
      '.bpm-sa-row input{flex:1;min-width:180px;padding:11px 12px;border:1px solid #ccc;border-radius:8px;font-size:15px;outline:none;}',
      '.bpm-sa-row input:focus{border-color:#25D366;}',
      '.bpm-sa-row button{padding:11px 18px;background:#25D366;color:#fff;border:0;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap;}',
      '.bpm-sa-row button:disabled{opacity:.6;cursor:not-allowed;}',
      '.bpm-sa-msg{margin-top:10px;font-size:13px;}',
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
    // vigente 24h
    if (!m[key]) return false;
    return (Date.now() - m[key]) < 24 * 60 * 60 * 1000;
  }

  // =====================================================
  // Detección de contexto (producto / variante / stock)
  // =====================================================

  /**
   * Intenta detectar info del producto en la página de detalle.
   * Tiendanube expone en la mayoría de themes:
   *   - <meta property="og:url"> y og:title
   *   - <form data-store="product-form" data-product-id="...">
   *   - <select name="variation-{variant_attr_id}">  o botones con data-option
   *   - <input name="variant_id" value="...">
   *   - <span data-store="product-stock"> / data-max-stock
   */
  function findProductContext() {
    // 1. product_id — del form de producto
    var form = $('form[data-store="product-form"], form.js-product-form, form[data-product-id]');
    var productId = null;
    if (form) {
      productId = form.getAttribute('data-product-id')
        || (form.querySelector('input[name="variant_id"]') && form.querySelector('input[name="variant_id"]').getAttribute('data-product-id'))
        || null;
    }
    // Fallback: LD+JSON
    if (!productId) {
      var ld = $('script[type="application/ld+json"]');
      if (ld) {
        try {
          var j = JSON.parse(ld.textContent);
          if (j && j.productID) productId = String(j.productID);
          else if (j && j['@type'] === 'Product' && j.sku) productId = String(j.sku);
        } catch (e) {}
      }
    }
    if (!productId) return null;

    // 2. variant_id actualmente seleccionada
    var variantInput = form && form.querySelector('input[name="variant_id"]');
    var variantId = variantInput ? variantInput.value : null;

    // 3. nombres
    var productName = null;
    var titleEl = $('[data-store="product-title"], .js-product-name, h1.product-title, h1');
    if (titleEl) productName = titleEl.textContent.trim();
    if (!productName) {
      var ogt = $('meta[property="og:title"]');
      if (ogt) productName = ogt.getAttribute('content');
    }

    // nombre de variante: concatenación de los selects / opciones activas
    var variantName = '';
    var selects = form ? $$('select[name^="variation"]', form) : [];
    selects.forEach(function (sel) {
      if (sel.value && sel.options[sel.selectedIndex]) {
        variantName += (variantName ? ' / ' : '') + sel.options[sel.selectedIndex].text.trim();
      }
    });
    // Themes con botones
    if (!variantName && form) {
      var selBtns = $$('.js-variation-option-active, [data-option][aria-checked="true"], .is-active[data-option]', form);
      selBtns.forEach(function (b) {
        var t = b.textContent.trim();
        if (t) variantName += (variantName ? ' / ' : '') + t;
      });
    }

    // 4. stock — detectar "sin stock"
    var outOfStock = false;
    // Caso 1: botón de compra deshabilitado con texto "sin stock"
    var buyBtn = $('[data-store="product-buy-button"], .js-addtocart, button.btn-comprar, button[name="add-to-cart"]');
    if (buyBtn) {
      var txt = (buyBtn.textContent || '').toLowerCase();
      if (buyBtn.disabled || /sin stock|agotado|sold.?out|no disponible/.test(txt)) {
        outOfStock = true;
      }
    }
    // Caso 2: elemento con data-store="product-stock" con texto "sin stock"
    var stockEl = $('[data-store="product-stock"], .js-product-stock');
    if (stockEl) {
      var stxt = (stockEl.textContent || '').toLowerCase();
      if (/sin stock|agotado|sold.?out/.test(stxt)) outOfStock = true;
      // data-max-stock = 0
      var max = stockEl.getAttribute('data-max-stock');
      if (max !== null && Number(max) === 0) outOfStock = true;
    }
    // Caso 3: mensaje de no-stock explícito
    if (!outOfStock) {
      var noStock = $('.js-product-no-stock:not([style*="display: none"]), [data-store="out-of-stock"]:not([style*="display: none"])');
      if (noStock && noStock.offsetParent !== null) outOfStock = true;
    }

    return {
      productId: String(productId),
      variantId: variantId ? String(variantId) : null,
      productName: productName || null,
      variantName: variantName || null,
      outOfStock: outOfStock,
    };
  }

  // =====================================================
  // UI — Bloque "Avisarme" en detalle de producto
  // =====================================================
  function renderDetailBlock(ctx) {
    var form = $('form[data-store="product-form"], form.js-product-form, form[data-product-id]');
    if (!form) return;

    // Ya existe: actualizamos su contexto
    var existing = $('#bpm-sa-block');
    if (existing) {
      existing.setAttribute('data-product-id', ctx.productId);
      existing.setAttribute('data-variant-id', ctx.variantId || '');
      existing.setAttribute('data-product-name', ctx.productName || '');
      existing.setAttribute('data-variant-name', ctx.variantName || '');
      // key por producto+variante
      var key = ctx.productId + ':' + (ctx.variantId || 'null');
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

    // Insertar después del form de compra
    form.parentNode.insertBefore(box, form.nextSibling);

    // Si ya se envió en esta sesión, mostrar éxito directamente
    var key2 = ctx.productId + ':' + (ctx.variantId || 'null');
    if (alreadySent(key2)) {
      showSuccess(box);
      return;
    }

    $('#bpm-sa-submit', box).addEventListener('click', function () { submit(box); });
    $('#bpm-sa-phone', box).addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(box); }
    });
  }

  function showSuccess(box) {
    var row = $('.bpm-sa-row', box);
    if (row) row.style.display = 'none';
    var msg = $('#bpm-sa-msg', box);
    if (msg) {
      msg.className = 'bpm-sa-msg ok';
      msg.textContent = '✅ Listo, te vamos a avisar apenas ingrese stock.';
    }
  }

  function submit(box) {
    var phoneInput = $('#bpm-sa-phone', box);
    var btn = $('#bpm-sa-submit', box);
    var msg = $('#bpm-sa-msg', box);

    var phoneRaw = phoneInput.value.trim();
    var phone = normalizePhone(phoneRaw);

    if (!isValidPhone(phone)) {
      msg.className = 'bpm-sa-msg err';
      msg.textContent = 'Ingresá un teléfono válido (10-15 dígitos).';
      return;
    }

    btn.disabled = true;
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
        btn.textContent = 'Avisarme por WhatsApp';
        if (res.ok && res.body.success) {
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
        btn.textContent = 'Avisarme por WhatsApp';
        msg.className = 'bpm-sa-msg err';
        msg.textContent = 'Error de conexión. Intentá de nuevo.';
      });
  }

  // =====================================================
  // Listado de productos — badge "Sin stock — Avisarme"
  // =====================================================
  function decorateListing() {
    // Productos en listado con atributo sin-stock
    var candidates = $$('.js-product-item, .product-item, [data-store="product-item"]');
    candidates.forEach(function (el) {
      if (el.getAttribute('data-bpm-sa-marked') === '1') return;

      var buyBtn = $('[data-store="product-buy-button"], .js-addtocart', el);
      var label = $('.js-out-of-stock, [data-store="out-of-stock"]', el);
      var isOut = false;
      if (buyBtn) {
        var t = (buyBtn.textContent || '').toLowerCase();
        if (buyBtn.disabled || /sin stock|agotado|sold.?out|no disponible/.test(t)) isOut = true;
      }
      if (label && label.offsetParent !== null) isOut = true;

      if (!isOut) return;

      var badge = document.createElement('div');
      badge.className = 'bpm-sa-badge';
      badge.textContent = 'Sin stock — Avisarme';
      var title = $('.js-item-name, .product-item__name, h3, h2', el);
      (title || el).appendChild(badge);
      el.setAttribute('data-bpm-sa-marked', '1');
    });
  }

  // =====================================================
  // Observador: re-render cuando cambia variante o DOM del detalle
  // =====================================================
  function run() {
    injectStyles();

    // Detalle
    var ctx = findProductContext();
    if (ctx && ctx.outOfStock) {
      renderDetailBlock(ctx);
    } else {
      // Si ya existe el bloque pero el producto dejó de estar sin stock, lo ocultamos
      var existing = $('#bpm-sa-block');
      if (existing) existing.style.display = 'none';
    }

    // Listado
    decorateListing();
  }

  function init() {
    run();

    // Observa cambios (cambio de variante, navegación AJAX, etc.)
    var debounceId = null;
    var mo = new MutationObserver(function () {
      clearTimeout(debounceId);
      debounceId = setTimeout(run, 250);
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled', 'value'] });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
