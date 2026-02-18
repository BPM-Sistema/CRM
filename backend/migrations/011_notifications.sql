-- =====================================================
-- SISTEMA DE NOTIFICACIONES
-- =====================================================

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  tipo VARCHAR(50) NOT NULL,           -- 'inconsistencia', 'pago_pendiente', etc.
  titulo VARCHAR(255) NOT NULL,
  descripcion TEXT,
  referencia_tipo VARCHAR(50),         -- 'order', 'comprobante', etc.
  referencia_id VARCHAR(100),          -- order_number, comprobante_id, etc.
  leida BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indices para consultas rapidas
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, leida) WHERE leida = FALSE;
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);

COMMENT ON TABLE notifications IS 'Notificaciones del sistema para alertar usuarios de eventos importantes';
COMMENT ON COLUMN notifications.tipo IS 'Tipo de notificacion: inconsistencia, pago_pendiente, pedido_nuevo, etc.';
COMMENT ON COLUMN notifications.referencia_tipo IS 'Tipo de recurso relacionado: order, comprobante, etc.';
COMMENT ON COLUMN notifications.referencia_id IS 'ID del recurso para navegacion directa';
