/**
 * Sistema de notificaciones
 * Funciones helper para crear y gestionar notificaciones
 */

const pool = require('../db');

/**
 * Crear una notificación para un usuario específico
 */
async function crearNotificacion({ userId, tipo, titulo, descripcion, referenciaTipo, referenciaId }) {
  try {
    await pool.query(`
      INSERT INTO notifications (user_id, tipo, titulo, descripcion, referencia_tipo, referencia_id)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [userId, tipo, titulo, descripcion, referenciaTipo, referenciaId]);
  } catch (error) {
    console.error('❌ Error creando notificación:', error.message);
  }
}

/**
 * Notificar a todos los usuarios activos con un permiso específico
 * Útil para alertas que deben llegar a todos los operadores, admins, etc.
 */
async function notificarUsuariosConPermiso(permiso, { tipo, titulo, descripcion, referenciaTipo, referenciaId }) {
  try {
    // Buscar usuarios con el permiso (directo o por rol)
    const usersResult = await pool.query(`
      SELECT DISTINCT u.id
      FROM users u
      WHERE u.is_active = TRUE
      AND (
        -- Permiso directo del usuario
        EXISTS (
          SELECT 1 FROM user_permissions up
          JOIN permissions p ON up.permission_id = p.id
          WHERE up.user_id = u.id AND p.key = $1
        )
        OR
        -- Permiso por rol
        EXISTS (
          SELECT 1 FROM role_permissions rp
          JOIN permissions p ON rp.permission_id = p.id
          WHERE rp.role_id = u.role_id AND p.key = $1
        )
      )
    `, [permiso]);

    // Crear notificación para cada usuario
    for (const user of usersResult.rows) {
      await crearNotificacion({
        userId: user.id,
        tipo,
        titulo,
        descripcion,
        referenciaTipo,
        referenciaId
      });
    }

    console.log(`🔔 Notificación enviada a ${usersResult.rows.length} usuario(s): ${titulo}`);
  } catch (error) {
    console.error('❌ Error notificando usuarios:', error.message);
  }
}

/**
 * Obtener notificaciones de un usuario
 */
async function getNotificaciones(userId, limit = 50) {
  const result = await pool.query(`
    SELECT id, tipo, titulo, descripcion, referencia_tipo, referencia_id, leida, created_at
    FROM notifications
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [userId, limit]);

  return result.rows;
}

/**
 * Contar notificaciones no leídas
 */
async function contarNoLeidas(userId) {
  const result = await pool.query(`
    SELECT COUNT(*) as count
    FROM notifications
    WHERE user_id = $1 AND leida = FALSE
  `, [userId]);

  return parseInt(result.rows[0].count);
}

/**
 * Marcar notificación como leída
 */
async function marcarLeida(notificationId, userId) {
  await pool.query(`
    UPDATE notifications
    SET leida = TRUE
    WHERE id = $1 AND user_id = $2
  `, [notificationId, userId]);
}

/**
 * Marcar todas las notificaciones como leídas
 */
async function marcarTodasLeidas(userId) {
  await pool.query(`
    UPDATE notifications
    SET leida = TRUE
    WHERE user_id = $1 AND leida = FALSE
  `, [userId]);
}

module.exports = {
  crearNotificacion,
  notificarUsuariosConPermiso,
  getNotificaciones,
  contarNoLeidas,
  marcarLeida,
  marcarTodasLeidas
};
