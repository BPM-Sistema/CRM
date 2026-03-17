(function() {
  var container = document.getElementById('bpm-leads-form-container');
  if (!container) {
    console.error('BPM: container #bpm-leads-form-container not found');
    return;
  }

  // Inyectar CSS
  var style = document.createElement('style');
  style.textContent = '\
    #bpm-leads-form-container * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }\
    #bpm-leads-form-container { max-width: 400px; margin: 0 auto; }\
    .bpm-form-group { margin-bottom: 16px; }\
    .bpm-form-group label { display: block; margin-bottom: 4px; font-size: 14px; color: #333; }\
    .bpm-form-group input[type="text"],\
    .bpm-form-group input[type="tel"] { width: 100%; padding: 12px; border: 1px solid #ccc; border-radius: 8px; font-size: 16px; }\
    .bpm-checkbox-group { margin-bottom: 20px; }\
    .bpm-checkbox-group label { display: flex; align-items: flex-start; gap: 8px; font-size: 14px; color: #333; cursor: pointer; }\
    .bpm-checkbox-group input[type="checkbox"] { margin-top: 3px; width: 18px; height: 18px; min-width: 18px; }\
    #bpm-error { display: none; background: #fee; color: #c00; padding: 12px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }\
    #bpm-submit { width: 100%; padding: 14px; background: #25D366; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; }\
    #bpm-submit:disabled { opacity: 0.7; cursor: not-allowed; }\
    #bpm-success { display: none; text-align: center; }\
    #bpm-success .bpm-icon { font-size: 48px; margin-bottom: 16px; }\
    #bpm-success h2 { color: #333; margin-bottom: 8px; }\
    #bpm-success p { color: #666; margin-bottom: 24px; font-size: 14px; }\
    #bpm-success .bpm-wa-btn { display: inline-block; padding: 14px 24px; background: #25D366; color: white; text-decoration: none; border-radius: 8px; font-size: 16px; font-weight: 600; }\
    #bpm-success .bpm-small { color: #999; margin-top: 16px; font-size: 12px; }\
  ';
  document.head.appendChild(style);

  // Inyectar HTML
  container.innerHTML = '\
    <div id="bpm-form-section">\
      <form id="bpm-leads-form">\
        <div class="bpm-form-group">\
          <label>Nombre *</label>\
          <input type="text" id="bpm-nombre" placeholder="Tu nombre" required>\
        </div>\
        <div class="bpm-form-group">\
          <label>Teléfono *</label>\
          <input type="tel" id="bpm-telefono" placeholder="Ej: 1123456789" required>\
        </div>\
        <div class="bpm-checkbox-group">\
          <label>\
            <input type="checkbox" id="bpm-consentimiento" required>\
            <span>Acepto recibir promociones y novedades por WhatsApp *</span>\
          </label>\
        </div>\
        <div id="bpm-error"></div>\
        <button type="submit" id="bpm-submit">Suscribirme</button>\
      </form>\
    </div>\
    <div id="bpm-success">\
      <div class="bpm-icon">✅</div>\
      <h2>¡Listo!</h2>\
      <p>Solo falta un paso: confirmá tu suscripción por WhatsApp</p>\
      <a class="bpm-wa-btn" href="https://wa.me/5491136914124?text=Hola!%20Quiero%20recibir%20promociones%20y%20novedades" target="_blank">Confirmar por WhatsApp</a>\
      <p class="bpm-small">Se abrirá WhatsApp con un mensaje listo para enviar</p>\
    </div>\
  ';

  // Lógica del form
  var form = document.getElementById('bpm-leads-form');
  var formSection = document.getElementById('bpm-form-section');
  var successSection = document.getElementById('bpm-success');
  var errorDiv = document.getElementById('bpm-error');
  var submitBtn = document.getElementById('bpm-submit');

  form.onsubmit = function(e) {
    e.preventDefault();
    errorDiv.style.display = 'none';

    var nombre = document.getElementById('bpm-nombre').value.trim();
    var telefono = document.getElementById('bpm-telefono').value.trim();
    var check = document.getElementById('bpm-consentimiento').checked;

    if (!nombre) { errorDiv.textContent = 'El nombre es obligatorio'; errorDiv.style.display = 'block'; return; }
    if (!telefono) { errorDiv.textContent = 'El teléfono es obligatorio'; errorDiv.style.display = 'block'; return; }
    if (!check) { errorDiv.textContent = 'Debes aceptar recibir mensajes'; errorDiv.style.display = 'block'; return; }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Enviando...';

    var xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.bpmadministrador.com/whatsapp-leads', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onreadystatechange = function() {
      if (xhr.readyState === 4) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Suscribirme';
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            var data = JSON.parse(xhr.responseText);
            if (data.success) {
              formSection.style.display = 'none';
              successSection.style.display = 'block';
            } else {
              errorDiv.textContent = data.error || 'Error. Intenta de nuevo.';
              errorDiv.style.display = 'block';
            }
          } catch(err) {
            errorDiv.textContent = 'Error procesando respuesta.';
            errorDiv.style.display = 'block';
          }
        } else {
          errorDiv.textContent = 'Error de conexión. Intenta de nuevo.';
          errorDiv.style.display = 'block';
        }
      }
    };
    xhr.send(JSON.stringify({ nombre: nombre, telefono: telefono, consentimiento: true }));
  };
})();
