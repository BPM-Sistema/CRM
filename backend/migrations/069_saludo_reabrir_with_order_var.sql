-- 069_saludo_reabrir_with_order_var.sql
-- La plantilla Meta "saludo_reabrir_sara" ahora incluye {{1}} = número de pedido.
-- Actualiza la descripción visible en el UI para reflejar la variable.

UPDATE plantilla_tipos
   SET descripcion = 'Mensaje de saludo para reabrir conversación con el cliente. Incluye número de pedido como variable.'
 WHERE key = 'abre_chat';
