/**
 * Verificación de consistencia de pedidos con TiendaNube
 * Simple, sólido, sin librerías extras
 */

const pool = require('../db');

/**
 * Compara productos del pedido en DB vs TiendaNube
 * @param {string} orderNumber - Número de pedido
 * @param {object} pedidoTN - Pedido completo de TiendaNube
 * @returns {object} { isConsistent, inconsistencies }
 */
async function verificarConsistencia(orderNumber, pedidoTN) {
  const inconsistencies = [];

  try {
    // 1. Obtener productos de nuestra DB
    const dbResult = await pool.query(`
      SELECT product_id, variant_id, name, quantity, price
      FROM order_products
      WHERE order_number = $1
    `, [orderNumber]);

    const productosDB = dbResult.rows;
    const productosTN = pedidoTN.products || [];

    // 2. Crear mapas para comparación (por product_id + variant_id)
    const mapDB = new Map();
    const mapTN = new Map();

    productosDB.forEach(p => {
      const key = `${p.product_id}_${p.variant_id || 'null'}`;
      mapDB.set(key, {
        product_id: p.product_id,
        variant_id: p.variant_id,
        name: p.name,
        quantity: Number(p.quantity),
        price: Number(p.price)
      });
    });

    productosTN.forEach(p => {
      const key = `${p.product_id}_${p.variant_id || 'null'}`;
      mapTN.set(key, {
        product_id: String(p.product_id),
        variant_id: p.variant_id ? String(p.variant_id) : null,
        name: p.name,
        quantity: Number(p.quantity),
        price: Number(p.price)
      });
    });

    // 3. Verificar productos faltantes en DB (están en TN pero no en DB)
    for (const [key, tn] of mapTN) {
      if (!mapDB.has(key)) {
        inconsistencies.push({
          type: 'product_missing',
          detail: {
            message: `Producto falta en DB`,
            product_id: tn.product_id,
            variant_id: tn.variant_id,
            name: tn.name,
            expected_quantity: tn.quantity
          }
        });
      }
    }

    // 4. Verificar productos extra en DB (están en DB pero no en TN)
    for (const [key, db] of mapDB) {
      if (!mapTN.has(key)) {
        inconsistencies.push({
          type: 'product_extra',
          detail: {
            message: `Producto extra en DB`,
            product_id: db.product_id,
            variant_id: db.variant_id,
            name: db.name,
            quantity_in_db: db.quantity
          }
        });
      }
    }

    // 5. Verificar diferencias de cantidad
    for (const [key, db] of mapDB) {
      const tn = mapTN.get(key);
      if (tn && db.quantity !== tn.quantity) {
        inconsistencies.push({
          type: 'quantity_mismatch',
          detail: {
            message: `Cantidad diferente`,
            product_id: db.product_id,
            variant_id: db.variant_id,
            name: db.name,
            quantity_db: db.quantity,
            quantity_tn: tn.quantity
          }
        });
      }
    }

    // 6. Verificar total de unidades
    const totalDB = productosDB.reduce((sum, p) => sum + Number(p.quantity), 0);
    const totalTN = productosTN.reduce((sum, p) => sum + Number(p.quantity), 0);

    if (totalDB !== totalTN) {
      inconsistencies.push({
        type: 'total_mismatch',
        detail: {
          message: `Total de unidades diferente`,
          total_db: totalDB,
          total_tn: totalTN,
          difference: totalTN - totalDB
        }
      });
    }

    // 7. Si hay inconsistencias, guardarlas en DB
    if (inconsistencies.length > 0) {
      // Marcar anteriores como resueltas (para no duplicar)
      await pool.query(`
        UPDATE order_inconsistencies
        SET resolved = TRUE, resolved_at = NOW()
        WHERE order_number = $1 AND resolved = FALSE
      `, [orderNumber]);

      // Insertar nuevas
      for (const inc of inconsistencies) {
        await pool.query(`
          INSERT INTO order_inconsistencies (order_number, type, detail)
          VALUES ($1, $2, $3)
        `, [orderNumber, inc.type, JSON.stringify(inc.detail)]);
      }

      console.log(`⚠️ Inconsistencia detectada en pedido #${orderNumber}:`, inconsistencies.length, 'problema(s)');
    }

    return {
      isConsistent: inconsistencies.length === 0,
      inconsistencies
    };

  } catch (error) {
    console.error(`❌ Error verificando consistencia #${orderNumber}:`, error.message);
    // No romper el flujo por errores de verificación
    return { isConsistent: true, inconsistencies: [], error: error.message };
  }
}

/**
 * Obtener inconsistencias activas de un pedido
 */
async function getInconsistencias(orderNumber) {
  const result = await pool.query(`
    SELECT id, type, detail, detected_at
    FROM order_inconsistencies
    WHERE order_number = $1 AND resolved = FALSE
    ORDER BY detected_at DESC
  `, [orderNumber]);

  return result.rows;
}

/**
 * Marcar inconsistencias como resueltas
 */
async function resolverInconsistencias(orderNumber) {
  await pool.query(`
    UPDATE order_inconsistencies
    SET resolved = TRUE, resolved_at = NOW()
    WHERE order_number = $1 AND resolved = FALSE
  `, [orderNumber]);
}

module.exports = {
  verificarConsistencia,
  getInconsistencias,
  resolverInconsistencias
};
