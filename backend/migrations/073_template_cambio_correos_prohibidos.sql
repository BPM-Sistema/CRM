-- Migration 073: Plantilla cambio_correos_prohibidos
-- Aviso al cliente que eligió Correo Argentino / Andreani / OCA u otro carrier
-- prohibido, pidiendo que cambie a transporte/expreso y vuelva a completar datos.
-- Variable Botmaker: {1: nro pedido}.

INSERT INTO plantilla_tipos (key, nombre, descripcion, requiere_variante, plantilla_default) VALUES
  ('cambio_correos_prohibidos', 'Cambio de envío (correos prohibidos)', 'Pedirle al cliente que reemplace Correo Argentino / Andreani / OCA por transporte o expreso y vuelva a cargar datos de envío. Variable: nro pedido.', false, 'cambio_correos_prohibidos')
ON CONFLICT (key) DO NOTHING;

INSERT INTO integration_config (key, enabled, description, category) VALUES
  ('whatsapp_tpl_cambio_correos_prohibidos', true, 'Plantilla para pedir cambio de envío cuando el cliente eligió un carrier prohibido', 'whatsapp')
ON CONFLICT (key) DO NOTHING;
