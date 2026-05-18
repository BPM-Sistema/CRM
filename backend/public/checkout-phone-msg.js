/**
 * BPM — Checkout Phone Message (Tiendanube)
 *
 * Inyecta un aviso debajo del input "Teléfono" del comprador en el
 * checkout, recordándole que use un número con WhatsApp.
 *
 * Registrado via Tiendanube Scripts API:
 *   POST /v1/{store_id}/scripts
 *   { "src": "https://api.bpmadministrador.com/checkout-phone-msg.js",
 *     "event": "onload", "where": "checkout" }
 *
 * Funciona en checkout clásico y Next:
 *   - Busca múltiples selectores del input de teléfono.
 *   - Usa MutationObserver porque Next es React y el DOM se monta async.
 *   - Idempotente: si el cartel ya existe, no lo duplica.
 */
(function () {
  'use strict';

  var MSG_ID = 'bpm-checkout-phone-msg';
  var STYLE_ID = 'bpm-checkout-phone-style';
  var MSG_HTML =
    'Importante: dejanos un número de <strong>WhatsApp</strong> activo. ' +
    'Todas las novedades de tu pedido (pago, preparación y envío) las mandamos por ahí.';

  var PHONE_SELECTORS = [
    'input[name="phone"]',
    'input[name="contact_phone"]',
    'input[name="billing_phone"]',
    'input#phone',
    'input[type="tel"]',
    'input[autocomplete="tel"]',
  ];

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '#' + MSG_ID + '{' +
        'margin:8px 0 14px;padding:12px 14px;' +
        'background:#f0fdf4;border-left:4px solid #25D366;' +
        'border-radius:8px;font-size:14px;line-height:1.45;' +
        'color:#14532d;font-family:inherit;' +
        'word-wrap:break-word;overflow-wrap:break-word;' +
        'box-sizing:border-box;max-width:100%;' +
      '}' +
      '#' + MSG_ID + ' strong{color:#075e54;font-weight:600;}' +
      '@media (max-width:480px){' +
        '#' + MSG_ID + '{font-size:14px;padding:10px 12px;margin:6px 0 12px;line-height:1.4;}' +
      '}';
    document.head.appendChild(style);
  }

  function findPhoneInput() {
    for (var i = 0; i < PHONE_SELECTORS.length; i++) {
      var el = document.querySelector(PHONE_SELECTORS[i]);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }

  function insertMessage(input) {
    if (document.getElementById(MSG_ID)) return true;
    injectStyles();
    var div = document.createElement('div');
    div.id = MSG_ID;
    div.innerHTML = MSG_HTML;

    // Buscar contenedor del field (label + input + helper) y poner abajo;
    // si no encontramos uno claro, lo insertamos directo después del input.
    var anchor = input.closest('.form-group, .field, .input-group, label') || input;
    if (anchor.parentNode) {
      anchor.parentNode.insertBefore(div, anchor.nextSibling);
      return true;
    }
    return false;
  }

  function tryInsert() {
    var input = findPhoneInput();
    if (input) return insertMessage(input);
    return false;
  }

  // Primer intento inmediato (checkout clásico suele estar listo en onload).
  if (tryInsert()) return;

  // Si no encontró, observar el DOM hasta que aparezca (Checkout Next / React).
  var observer = new MutationObserver(function () {
    if (tryInsert()) observer.disconnect();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Safety net: cortar el observer a los 30s para no consumir CPU eterno.
  setTimeout(function () { observer.disconnect(); }, 30000);
})();
