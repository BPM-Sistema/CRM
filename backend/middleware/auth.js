/**
 * Middleware de autenticación y permisos RBAC
 */

const pool = require('../db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'finops-secret-key-change-in-production';

/**
 * Middleware para verificar autenticación
 * Extrae el token JWT del header Authorization
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token de autenticación requerido' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    // Cargar usuario con rol y permisos
    const userResult = await pool.query(`
      SELECT
        u.id,
        u.name,
        u.email,
        u.role_id,
        u.is_active,
        r.name as role_name
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      WHERE u.id = $1 AND u.is_active = true
    `, [decoded.userId]);

    if (userResult.rowCount === 0) {
      return res.status(401).json({ error: 'Usuario no encontrado o desactivado' });
    }

    // Cargar permisos directos del usuario
    const permissionsResult = await pool.query(`
      SELECT p.key
      FROM permissions p
      JOIN user_permissions up ON p.id = up.permission_id
      WHERE up.user_id = $1
    `, [decoded.userId]);

    req.user = {
      ...userResult.rows[0],
      permissions: permissionsResult.rows.map(p => p.key)
    };

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }
    console.error('Error en authenticate:', error);
    return res.status(500).json({ error: 'Error de autenticación' });
  }
}

/**
 * Middleware para verificar permiso específico
 * Uso: requirePermission('orders.view')
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    if (!req.user.permissions.includes(permission)) {
      return res.status(403).json({
        error: 'No tienes permiso para realizar esta acción',
        required: permission
      });
    }

    next();
  };
}

/**
 * Middleware para verificar múltiples permisos (cualquiera de ellos)
 * Uso: requireAnyPermission(['orders.view', 'orders.print'])
 */
function requireAnyPermission(permissions) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    const hasAny = permissions.some(p => req.user.permissions.includes(p));

    if (!hasAny) {
      return res.status(403).json({
        error: 'No tienes permiso para realizar esta acción',
        required: permissions
      });
    }

    next();
  };
}

/**
 * Generar token JWT para usuario
 */
function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '24h' });
}

/**
 * Middleware opcional de autenticación (no bloquea si no hay token)
 */
async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const userResult = await pool.query(`
      SELECT u.id, u.name, u.email, u.role_id, u.is_active, r.name as role_name
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      WHERE u.id = $1 AND u.is_active = true
    `, [decoded.userId]);

    if (userResult.rowCount > 0) {
      const permissionsResult = await pool.query(`
        SELECT p.key
        FROM permissions p
        JOIN user_permissions up ON p.id = up.permission_id
        WHERE up.user_id = $1
      `, [userResult.rows[0].id]);

      req.user = {
        ...userResult.rows[0],
        permissions: permissionsResult.rows.map(p => p.key)
      };
    }

    next();
  } catch (error) {
    // Continuar sin autenticación si el token es inválido
    next();
  }
}

module.exports = {
  authenticate,
  requirePermission,
  requireAnyPermission,
  generateToken,
  optionalAuth,
  JWT_SECRET
};
