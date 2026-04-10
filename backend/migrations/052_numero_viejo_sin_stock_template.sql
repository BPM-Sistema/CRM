-- Migration: Add numero_viejo_sin_stock template to catalog
-- Purpose: Template for notifying customers about out-of-stock products needing replacement

INSERT INTO plantilla_tipos (key, nombre, descripcion, requiere_variante, plantilla_default) VALUES
  ('numero_viejo_sin_stock', 'Producto sin Stock', 'Se envía para notificar al cliente que necesita un reemplazo por falta de stock.', false, 'numero_viejo_sin_stock')
ON CONFLICT (key) DO NOTHING;

-- Add RBAC permission for WhatsApp actions
INSERT INTO permissions (key, module)
VALUES ('whatsapp.send_bulk', 'whatsapp')
ON CONFLICT (key) DO NOTHING;

-- Grant to admin and operador roles
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name IN ('admin', 'operador')
  AND p.key = 'whatsapp.send_bulk'
ON CONFLICT DO NOTHING;
