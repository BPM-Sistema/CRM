-- =====================================================
-- Migración 043: Crear tabla pagos_efectivo (si no existe)
-- Pagos manuales/efectivo registrados por operadores
-- =====================================================

CREATE TABLE IF NOT EXISTS pagos_efectivo (
  id SERIAL PRIMARY KEY,
  order_number VARCHAR NOT NULL,
  monto NUMERIC NOT NULL,
  registrado_por VARCHAR DEFAULT 'sistema',
  notas TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  tipo TEXT DEFAULT 'efectivo'
);

CREATE INDEX IF NOT EXISTS idx_pagos_efectivo_order_number
  ON pagos_efectivo(order_number);
