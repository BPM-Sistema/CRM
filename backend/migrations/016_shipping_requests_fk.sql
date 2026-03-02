-- =====================================================
-- FK: shipping_requests → orders_validated
-- Garantiza integridad referencial a nivel de base de datos
-- =====================================================

-- Agregar FK con ON DELETE CASCADE
-- Si se borra un pedido, se borran sus datos de envío asociados
ALTER TABLE shipping_requests
ADD CONSTRAINT fk_shipping_requests_order
FOREIGN KEY (order_number)
REFERENCES orders_validated(order_number)
ON DELETE CASCADE;

-- Nota: Si preferís que NO se pueda borrar un pedido que tiene
-- datos de envío, cambiá ON DELETE CASCADE por ON DELETE RESTRICT
