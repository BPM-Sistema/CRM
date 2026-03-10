-- Add Waspy/inbox permissions
INSERT INTO permissions (id, key, module) VALUES
  (gen_random_uuid(), 'inbox.view', 'inbox'),
  (gen_random_uuid(), 'inbox.send', 'inbox'),
  (gen_random_uuid(), 'inbox.assign', 'inbox'),
  (gen_random_uuid(), 'templates.view', 'templates'),
  (gen_random_uuid(), 'templates.send', 'templates'),
  (gen_random_uuid(), 'whatsapp.connect', 'whatsapp')
ON CONFLICT (key) DO NOTHING;

-- Grant all inbox permissions to admin role
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'admin'
AND p.module IN ('inbox', 'templates', 'whatsapp')
ON CONFLICT DO NOTHING;
