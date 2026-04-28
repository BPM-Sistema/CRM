-- Migration 071: Plantilla aviso_datos_envio
-- Recordatorio para clientes a los que ya se les mandó `datos__envio` al subir
-- el comprobante pero todavía no cargaron el formulario.
-- Variables Botmaker: {1: nombre, 2: nro pedido} (mismas que datos__envio).
-- El botón "Cargar datos de envío" se arma del lado de Botmaker con la variable {2}.

INSERT INTO plantilla_tipos (key, nombre, descripcion, requiere_variante, plantilla_default) VALUES
  ('aviso_datos_envio', 'Recordatorio Datos de Envío', 'Recordatorio para clientes con comprobante cargado que aún no completaron el formulario de datos de envío. Variables: nombre, nro pedido.', false, 'aviso_datos_envio')
ON CONFLICT (key) DO NOTHING;

INSERT INTO integration_config (key, enabled, description, category) VALUES
  ('whatsapp_tpl_aviso_datos_envio', true, 'Plantilla de recordatorio para que el cliente cargue datos de envío', 'whatsapp')
ON CONFLICT (key) DO NOTHING;
