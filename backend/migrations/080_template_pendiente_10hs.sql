-- Migration 080: Plantilla pendiente_10hs
-- Segundo recordatorio para clientes que crearon pedido y no cargaron comprobante.
-- Se programa a +10h de la creación (3h del primer recordatorio + 7h adicionales),
-- ajustado a horario laboral L-V 9-18 ART.
-- Variable Botmaker: {{1}} en el botón URL = nro pedido. Body sin variables.

INSERT INTO plantilla_tipos (key, nombre, descripcion, requiere_variante, plantilla_default) VALUES
  ('pendiente_10hs', 'Recordatorio Pendiente (10hs)', 'Segundo recordatorio para clientes con pedido sin comprobante. Programado a +10hs de la creación (7hs después del pendiente_3hs). Horario laboral L-V 9-18 ART. Variable: nro pedido (botón URL).', false, 'pendiente_10hs')
ON CONFLICT (key) DO NOTHING;

INSERT INTO integration_config (key, enabled, description, category) VALUES
  ('whatsapp_tpl_pendiente_10hs', true, 'Segundo recordatorio (10hs desde creación) si el cliente no cargó comprobante', 'whatsapp')
ON CONFLICT (key) DO NOTHING;
