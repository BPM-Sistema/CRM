-- Migration 081: Permission payment_reminders.view
-- Habilita el panel /admin/payment-reminders en el sidebar de BPM.
-- Se asigna al rol admin. Para Melu (usuario individual) usar user_permissions:
--   INSERT INTO user_permissions (user_id, permission_id)
--   SELECT u.id, p.id FROM users u, permissions p
--   WHERE u.email = '<email_melu>' AND p.key = 'payment_reminders.view'
--   ON CONFLICT DO NOTHING;

INSERT INTO permissions (key, module) VALUES
  ('payment_reminders.view', 'payment_reminders')
ON CONFLICT (key) DO NOTHING;

-- Asignar al rol admin
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'admin' AND p.key = 'payment_reminders.view'
ON CONFLICT DO NOTHING;
