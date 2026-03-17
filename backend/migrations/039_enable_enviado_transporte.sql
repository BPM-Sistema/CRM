-- =====================================================
-- Migración 039: Habilitar plantilla enviado_transporte
-- Ahora se envía automáticamente al confirmar remito
-- =====================================================

UPDATE integration_config
SET enabled = true,
    description = 'Notificar al cliente que su pedido fue enviado por transporte (con imagen del remito)'
WHERE key = 'whatsapp_tpl_enviado_transporte';
