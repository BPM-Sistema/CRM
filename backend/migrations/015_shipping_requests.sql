-- =====================================================
-- SHIPPING REQUESTS
-- Datos de envío complementarios para órdenes con
-- método "Transporte a elección"
-- =====================================================

CREATE TABLE IF NOT EXISTS shipping_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number TEXT NOT NULL,
  empresa_envio TEXT NOT NULL CHECK (empresa_envio IN ('VIA_CARGO', 'OTRO')),
  empresa_envio_otro TEXT,
  destino_tipo TEXT NOT NULL CHECK (destino_tipo IN ('SUCURSAL', 'DOMICILIO')),
  direccion_entrega TEXT NOT NULL,
  nombre_apellido TEXT NOT NULL,
  dni TEXT NOT NULL,
  email TEXT NOT NULL,
  codigo_postal TEXT NOT NULL,
  provincia TEXT NOT NULL,
  localidad TEXT NOT NULL,
  telefono TEXT NOT NULL,
  comentarios TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Constraint: si empresa_envio = 'OTRO', empresa_envio_otro NO puede ser NULL
  CONSTRAINT chk_empresa_otro CHECK (
    empresa_envio != 'OTRO' OR empresa_envio_otro IS NOT NULL
  )
);

-- Índice para buscar por número de pedido
CREATE INDEX IF NOT EXISTS idx_shipping_requests_order ON shipping_requests(order_number);

-- Índice para ordenar por fecha de creación
CREATE INDEX IF NOT EXISTS idx_shipping_requests_created ON shipping_requests(created_at DESC);
