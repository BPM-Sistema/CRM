-- Migration 070: Plantilla retiros_local
-- Avisar a clientes de retiro en local que su pedido ya está listo para retirar.
-- Variables Botmaker: {1: nombre, 2: nro pedido} (estándar de bulk-send).

INSERT INTO plantilla_tipos (key, nombre, descripcion, requiere_variante, plantilla_default) VALUES
  ('retiros_local', 'Retiros en Local', 'Avisar al cliente que su pedido ya está listo para retirar en el local. Variables: nombre, nro pedido.', false, 'retiros_local')
ON CONFLICT (key) DO NOTHING;

INSERT INTO integration_config (key, enabled, description, category) VALUES
  ('whatsapp_tpl_retiros_local', true, 'Plantilla para avisar pedidos listos para retirar en local', 'whatsapp')
ON CONFLICT (key) DO NOTHING;
