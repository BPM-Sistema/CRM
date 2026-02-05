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
        u.role_id,
        r.name as role_name,
        u.is_active,
        u.created_at
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
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
        u.role_id,
        r.name as role_name,
        u.is_active,
        u.created_at
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
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
    const { name, email, password, role_id } = req.body;

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

    // Verificar que el rol existe
    if (role_id) {
      const roleExists = await pool.query('SELECT id FROM roles WHERE id = $1', [role_id]);
      if (roleExists.rowCount === 0) {
        return res.status(400).json({ error: 'Rol no válido' });
      }
    }

    // Crear usuario
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(`
      INSERT INTO users (name, email, password_hash, role_id, is_active)
      VALUES ($1, $2, $3, $4, true)
      RETURNING id, name, email, role_id, is_active, created_at
    `, [name, email.toLowerCase(), passwordHash, role_id || null]);

    // Obtener rol
    let role_name = null;
    if (role_id) {
      const roleResult = await pool.query('SELECT name FROM roles WHERE id = $1', [role_id]);
      role_name = roleResult.rows[0]?.name;
    }

    res.status(201).json({
      ok: true,
      user: {
        ...result.rows[0],
        role_name
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
      RETURNING id, name, email, role_id, is_active, created_at
    `, values);

    // Obtener rol
    const roleResult = await pool.query(`
      SELECT r.name as role_name
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      WHERE u.id = $1
    `, [id]);

    res.json({
      ok: true,
      user: {
        ...result.rows[0],
        role_name: roleResult.rows[0]?.role_name
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
      RETURNING id, name, email, role_id, is_active, created_at
    `, [is_active, id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json({
      ok: true,
      user: result.rows[0]
    });

  } catch (error) {
    console.error('Error en PATCH /users/:id/disable:', error);
    res.status(500).json({ error: 'Error al actualizar estado del usuario' });
  }
});

/**
 * PATCH /users/:id/role
 * Cambiar el rol de un usuario
 */
router.patch('/:id/role', requirePermission('users.assign_role'), async (req, res) => {
  try {
    const { id } = req.params;
    const { role_id } = req.body;

    // Verificar que el rol existe
    if (role_id) {
      const roleExists = await pool.query('SELECT id FROM roles WHERE id = $1', [role_id]);
      if (roleExists.rowCount === 0) {
        return res.status(400).json({ error: 'Rol no válido' });
      }
    }

    const result = await pool.query(`
      UPDATE users
      SET role_id = $1
      WHERE id = $2
      RETURNING id, name, email, role_id, is_active, created_at
    `, [role_id, id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // Obtener nombre del rol
    let role_name = null;
    if (role_id) {
      const roleResult = await pool.query('SELECT name FROM roles WHERE id = $1', [role_id]);
      role_name = roleResult.rows[0]?.name;
    }

    res.json({
      ok: true,
      user: {
        ...result.rows[0],
        role_name
      }
    });

  } catch (error) {
    console.error('Error en PATCH /users/:id/role:', error);
    res.status(500).json({ error: 'Error al asignar rol' });
  }
});

module.exports = router;
