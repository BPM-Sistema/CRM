/**
 * Rutas de gestión de roles y permisos
 */

const express = require('express');
const pool = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Todas las rutas requieren autenticación
router.use(authenticate);

/**
 * GET /roles
 * Listar todos los roles con sus permisos
 */
router.get('/', requirePermission('users.view'), async (req, res) => {
  try {
    // Obtener roles
    const rolesResult = await pool.query(`
      SELECT id, name, created_at
      FROM roles
      ORDER BY name
    `);

    // Obtener permisos por rol
    const rolesWithPermissions = await Promise.all(
      rolesResult.rows.map(async (role) => {
        const permissionsResult = await pool.query(`
          SELECT p.id, p.key, p.module
          FROM permissions p
          JOIN role_permissions rp ON p.id = rp.permission_id
          WHERE rp.role_id = $1
          ORDER BY p.module, p.key
        `, [role.id]);

        return {
          ...role,
          permissions: permissionsResult.rows
        };
      })
    );

    res.json({
      ok: true,
      roles: rolesWithPermissions
    });

  } catch (error) {
    console.error('Error en GET /roles:', error);
    res.status(500).json({ error: 'Error al obtener roles' });
  }
});

/**
 * GET /permissions
 * Listar todos los permisos agrupados por módulo
 */
router.get('/permissions', requirePermission('users.view'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, key, module
      FROM permissions
      ORDER BY module, key
    `);

    // Agrupar por módulo
    const grouped = result.rows.reduce((acc, perm) => {
      if (!acc[perm.module]) {
        acc[perm.module] = [];
      }
      acc[perm.module].push(perm);
      return acc;
    }, {});

    res.json({
      ok: true,
      permissions: result.rows,
      grouped
    });

  } catch (error) {
    console.error('Error en GET /permissions:', error);
    res.status(500).json({ error: 'Error al obtener permisos' });
  }
});

/**
 * GET /roles/:id
 * Obtener un rol con sus permisos
 */
router.get('/:id', requirePermission('users.view'), async (req, res) => {
  try {
    const { id } = req.params;

    const roleResult = await pool.query(`
      SELECT id, name, created_at
      FROM roles
      WHERE id = $1
    `, [id]);

    if (roleResult.rowCount === 0) {
      return res.status(404).json({ error: 'Rol no encontrado' });
    }

    const permissionsResult = await pool.query(`
      SELECT p.id, p.key, p.module
      FROM permissions p
      JOIN role_permissions rp ON p.id = rp.permission_id
      WHERE rp.role_id = $1
      ORDER BY p.module, p.key
    `, [id]);

    res.json({
      ok: true,
      role: {
        ...roleResult.rows[0],
        permissions: permissionsResult.rows
      }
    });

  } catch (error) {
    console.error('Error en GET /roles/:id:', error);
    res.status(500).json({ error: 'Error al obtener rol' });
  }
});

/**
 * PATCH /roles/:id/permissions
 * Actualizar permisos de un rol
 */
router.patch('/:id/permissions', requirePermission('users.assign_role'), async (req, res) => {
  try {
    const { id } = req.params;
    const { permissions } = req.body; // Array de permission keys

    if (!Array.isArray(permissions)) {
      return res.status(400).json({ error: 'permissions debe ser un array' });
    }

    // Verificar que el rol existe
    const roleExists = await pool.query('SELECT id, name FROM roles WHERE id = $1', [id]);
    if (roleExists.rowCount === 0) {
      return res.status(404).json({ error: 'Rol no encontrado' });
    }

    // No permitir editar permisos del rol admin si no sos admin
    if (roleExists.rows[0].name === 'admin' && req.user.role_name !== 'admin') {
      return res.status(403).json({ error: 'Solo un admin puede editar el rol admin' });
    }

    // Obtener IDs de permisos desde las keys
    const permissionIds = [];
    if (permissions.length > 0) {
      const permResult = await pool.query(`
        SELECT id, key FROM permissions WHERE key = ANY($1)
      `, [permissions]);

      permissionIds.push(...permResult.rows.map(p => p.id));
    }

    // Transacción: eliminar permisos actuales e insertar nuevos
    await pool.query('BEGIN');

    try {
      // Eliminar permisos actuales
      await pool.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);

      // Insertar nuevos permisos
      if (permissionIds.length > 0) {
        const insertValues = permissionIds.map((permId, i) => `($1, $${i + 2})`).join(', ');
        await pool.query(
          `INSERT INTO role_permissions (role_id, permission_id) VALUES ${insertValues}`,
          [id, ...permissionIds]
        );
      }

      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }

    // Obtener rol actualizado
    const updatedPermissions = await pool.query(`
      SELECT p.id, p.key, p.module
      FROM permissions p
      JOIN role_permissions rp ON p.id = rp.permission_id
      WHERE rp.role_id = $1
      ORDER BY p.module, p.key
    `, [id]);

    res.json({
      ok: true,
      role: {
        ...roleExists.rows[0],
        permissions: updatedPermissions.rows
      }
    });

  } catch (error) {
    console.error('Error en PATCH /roles/:id/permissions:', error);
    res.status(500).json({ error: 'Error al actualizar permisos' });
  }
});

module.exports = router;
