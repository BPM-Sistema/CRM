/**
 * Rutas de gestión de usuarios
 */

const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Todas las rutas requieren autenticación
router.use(authenticate);

/**
 * GET /users
 * Listar todos los usuarios
 */
router.get('/', requirePermission('users.view'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.name,
        u.email,
        u.is_active,
        u.created_at,
        COALESCE(
          ARRAY(
            SELECT p.key FROM permissions p
            JOIN user_permissions up ON p.id = up.permission_id
            WHERE up.user_id = u.id
          ),
          '{}'::text[]
        ) as permissions
      FROM users u
      ORDER BY u.created_at DESC
    `);

    res.json({
      ok: true,
      users: result.rows
    });

  } catch (error) {
    console.error('Error en GET /users:', error);
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

/**
 * GET /users/:id
 * Obtener un usuario
 */
router.get('/:id', requirePermission('users.view'), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT
        u.id,
        u.name,
        u.email,
        u.is_active,
        u.created_at,
        COALESCE(
          ARRAY(
            SELECT p.key FROM permissions p
            JOIN user_permissions up ON p.id = up.permission_id
            WHERE up.user_id = u.id
          ),
          '{}'::text[]
        ) as permissions
      FROM users u
      WHERE u.id = $1
    `, [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({
      ok: true,
      user: result.rows[0]
    });

  } catch (error) {
    console.error('Error en GET /users/:id:', error);
    res.status(500).json({ error: 'Error al obtener usuario' });
  }
});

/**
 * POST /users
 * Crear un nuevo usuario
 */
router.post('/', requirePermission('users.create'), async (req, res) => {
  try {
    const { name, email, password, permissions } = req.body;

    // Validaciones
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    // Verificar email único
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (existingUser.rowCount > 0) {
      return res.status(409).json({ error: 'Ya existe un usuario con ese email' });
    }

    // Validar que los permisos existen
    if (permissions && permissions.length > 0) {
      const validPerms = await pool.query(
        'SELECT key FROM permissions WHERE key = ANY($1)',
        [permissions]
      );
      if (validPerms.rowCount !== permissions.length) {
        return res.status(400).json({ error: 'Algunos permisos no son válidos' });
      }
    }

    // Crear usuario
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(`
      INSERT INTO users (name, email, password_hash, is_active)
      VALUES ($1, $2, $3, true)
      RETURNING id, name, email, is_active, created_at
    `, [name, email.toLowerCase(), passwordHash]);

    const userId = result.rows[0].id;

    // Insertar permisos
    if (permissions && permissions.length > 0) {
      await pool.query(`
        INSERT INTO user_permissions (user_id, permission_id)
        SELECT $1, id FROM permissions WHERE key = ANY($2)
      `, [userId, permissions]);
    }

    res.status(201).json({
      ok: true,
      user: {
        ...result.rows[0],
        permissions: permissions || []
      }
    });

  } catch (error) {
    console.error('Error en POST /users:', error);
    res.status(500).json({ error: 'Error al crear usuario' });
  }
});

/**
 * PATCH /users/:id
 * Editar un usuario (nombre, email)
 */
router.patch('/:id', requirePermission('users.edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email } = req.body;

    // Verificar que el usuario existe
    const userExists = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
    if (userExists.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Verificar email único si se está cambiando
    if (email) {
      const existingEmail = await pool.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [email.toLowerCase(), id]
      );
      if (existingEmail.rowCount > 0) {
        return res.status(409).json({ error: 'Ya existe un usuario con ese email' });
      }
    }

    // Construir query dinámicamente
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (name) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }

    if (email) {
      updates.push(`email = $${paramIndex++}`);
      values.push(email.toLowerCase());
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nada que actualizar' });
    }

    values.push(id);

    const result = await pool.query(`
      UPDATE users
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING id, name, email, is_active, created_at
    `, values);

    // Obtener permisos del usuario
    const permissionsResult = await pool.query(`
      SELECT p.key FROM permissions p
      JOIN user_permissions up ON p.id = up.permission_id
      WHERE up.user_id = $1
    `, [id]);

    res.json({
      ok: true,
      user: {
        ...result.rows[0],
        permissions: permissionsResult.rows.map(p => p.key)
      }
    });

  } catch (error) {
    console.error('Error en PATCH /users/:id:', error);
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
});

/**
 * PATCH /users/:id/disable
 * Activar/desactivar un usuario
 */
router.patch('/:id/disable', requirePermission('users.disable'), async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    // No permitir desactivarse a sí mismo
    if (id === req.user.id && is_active === false) {
      return res.status(400).json({ error: 'No podés desactivarte a vos mismo' });
    }

    const result = await pool.query(`
      UPDATE users
      SET is_active = $1
      WHERE id = $2
      RETURNING id, name, email, is_active, created_at
    `, [is_active, id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Obtener permisos del usuario
    const permissionsResult = await pool.query(`
      SELECT p.key FROM permissions p
      JOIN user_permissions up ON p.id = up.permission_id
      WHERE up.user_id = $1
    `, [id]);

    res.json({
      ok: true,
      user: {
        ...result.rows[0],
        permissions: permissionsResult.rows.map(p => p.key)
      }
    });

  } catch (error) {
    console.error('Error en PATCH /users/:id/disable:', error);
    res.status(500).json({ error: 'Error al actualizar estado del usuario' });
  }
});

/**
 * PATCH /users/:id/permissions
 * Actualizar permisos de un usuario
 */
router.patch('/:id/permissions', requirePermission('users.assign_role'), async (req, res) => {
  try {
    const { id } = req.params;
    const { permissions } = req.body;

    // Verificar que el usuario existe
    const userExists = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
    if (userExists.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Validar que los permisos existen
    if (permissions && permissions.length > 0) {
      const validPerms = await pool.query(
        'SELECT key FROM permissions WHERE key = ANY($1)',
        [permissions]
      );
      if (validPerms.rowCount !== permissions.length) {
        return res.status(400).json({ error: 'Algunos permisos no son válidos' });
      }
    }

    // Eliminar permisos actuales
    await pool.query('DELETE FROM user_permissions WHERE user_id = $1', [id]);

    // Insertar nuevos permisos
    if (permissions && permissions.length > 0) {
      await pool.query(`
        INSERT INTO user_permissions (user_id, permission_id)
        SELECT $1, id FROM permissions WHERE key = ANY($2)
      `, [id, permissions]);
    }

    // Obtener usuario actualizado
    const result = await pool.query(`
      SELECT id, name, email, is_active, created_at FROM users WHERE id = $1
    `, [id]);

    res.json({
      ok: true,
      user: {
        ...result.rows[0],
        permissions: permissions || []
      }
    });

  } catch (error) {
    console.error('Error en PATCH /users/:id/permissions:', error);
    res.status(500).json({ error: 'Error al actualizar permisos' });
  }
});

/**
 * DELETE /users/:id
 * Eliminar un usuario
 */
router.delete('/:id', requirePermission('users.disable'), async (req, res) => {
  try {
    const { id } = req.params;

    // No permitir eliminarse a sí mismo
    if (id === req.user.id) {
      return res.status(400).json({ error: 'No podés eliminarte a vos mismo' });
    }

    // Verificar que el usuario existe
    const userExists = await pool.query('SELECT id, email FROM users WHERE id = $1', [id]);
    if (userExists.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Eliminar permisos del usuario primero (por FK)
    await pool.query('DELETE FROM user_permissions WHERE user_id = $1', [id]);

    // Eliminar el usuario
    await pool.query('DELETE FROM users WHERE id = $1', [id]);

    console.log(`🗑️ Usuario eliminado: ${userExists.rows[0].email}`);

    res.json({
      ok: true,
      message: 'Usuario eliminado correctamente'
    });

  } catch (error) {
    console.error('Error en DELETE /users/:id:', error);
    res.status(500).json({ error: 'Error al eliminar usuario' });
  }
});

module.exports = router;
