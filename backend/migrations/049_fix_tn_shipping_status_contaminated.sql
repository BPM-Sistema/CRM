-- Migration 049: Fix tn_shipping_status contaminated with carrier IDs
-- BUG: guardarPedidoCompleto stored pedido.shipping (carrier ID) as tn_shipping_status
-- when shipping_status was null. This migration cleans up those values.
--
-- Carrier IDs look like: api_XXXXX, table, draft, pickup-point, etc.
-- Valid shipping statuses are: unpacked, unshipped, shipped, delivered, packed, null

-- Set to NULL where tn_shipping_status contains a carrier ID instead of a real status
UPDATE orders_validated
SET tn_shipping_status = NULL
WHERE tn_shipping_status IS NOT NULL
  AND tn_shipping_status NOT IN ('unpacked', 'unshipped', 'shipped', 'delivered', 'packed');
