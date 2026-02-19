-- =====================================================
-- FINANCIERAS: Agregar columna datos_transferencia
-- =====================================================
-- Esta columna guarda el bloque completo de datos bancarios
-- preformateado para enviar en plantillas de WhatsApp.
--
-- Ejemplo de contenido:
-- 🏦 Banco: Santander
-- 👤 Titular: Diego Nicolas Solís
-- 🆔 CUIT: 20-28673374-4
-- 💳 Cuenta: 210-030064/3
-- 🔑 Alias: JUNIO.RECLAMO.ROCA
-- CBU: 0720210288000003006436

ALTER TABLE financieras
ADD COLUMN IF NOT EXISTS datos_transferencia TEXT;
