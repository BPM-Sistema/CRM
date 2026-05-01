-- Migration 077: Plantilla pendiente_3hs
-- Recordatorio para clientes que crearon pedido y no cargaron comprobante
-- a las 3hs de la creación (ajustado a horario laboral L-V 9-18 ART, sin feriados).
-- Variables Botmaker: {1: nombre, 2: nro pedido}.
-- Botón URL "CARGAR COMPROBANTE" usa {{2}} (igual que pedido_creado).

INSERT INTO plantilla_tipos (key, nombre, descripcion, requiere_variante, plantilla_default) VALUES
  ('pendiente_3hs', 'Recordatorio Pendiente (3hs)', 'Recordatorio para clientes con pedido sin comprobante a las 3hs de la creación. Solo se manda en horario laboral (L-V 9-18 ART). Variables: nombre, nro pedido.', false, 'pendiente_3hs')
ON CONFLICT (key) DO NOTHING;

INSERT INTO integration_config (key, enabled, description, category) VALUES
  ('whatsapp_tpl_pendiente_3hs', true, 'Recordatorio a las 3hs (horario laboral) si el cliente no cargó comprobante', 'whatsapp')
ON CONFLICT (key) DO NOTHING;
