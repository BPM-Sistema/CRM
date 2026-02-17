/**
 * Rutas de gestión de financieras
 */

const express = require('express');
const pool = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Todas las rutas requieren autenticación
router.use(authenticate);

/**
 * GET /financieras
 * Listar todas las financieras
 */
router.get('/', requirePermission('financieras.view'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        nombre,
        titular_principal,
        celular,
        palabras_clave,
        activa,
        created_at,
        cbu,
        porcentaje,
        alias,
        is_default
      FROM financieras
      ORDER BY is_default DESC, id ASC
    `);

    res.json({
      ok: true,
      financieras: result.rows
    });

  } catch (error) {
    console.error('Error en GET /financieras:', error);
    res.status(500).json({ error: 'Error al obtener financieras' });
  }
});

/**
 * GET /financieras/:id
 * Obtener una financiera
 */
router.get('/:id', requirePermission('financieras.view'), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT
        id,
        nombre,
        titular_principal,
        celular,
        palabras_clave,
        activa,
        created_at,
        cbu,
        porcentaje,
        alias,
        is_default
      FROM financieras
      WHERE id = $1
    `, [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Financiera no encontrada' });
    }

    res.json({
      ok: true,
      financiera: result.rows[0]
    });

  } catch (error) {
    console.error('Error en GET /financieras/:id:', error);
    res.status(500).json({ error: 'Error al obtener financiera' });
  }
});

/**
 * POST /financieras
 * Crear una nueva financiera
 */
router.post('/', requirePermission('financieras.create'), async (req, res) => {
  try {
    const { nombre, titular_principal, celular, palabras_clave, cbu, porcentaje, alias } = req.body;

    // Validaciones
    if (!nombre) {
      return res.status(400).json({ error: 'El nombre es requerido' });
    }

    // Contar financieras existentes
    const countResult = await pool.query('SELECT COUNT(*) as count FROM financieras');
    const count = parseInt(countResult.rows[0].count, 10);

    // Si es la primera financiera, marcarla como default
    const isDefault = count === 0;

    // Formatear palabras_clave como JSON para PostgreSQL jsonb
    const palabrasJson = Array.isArray(palabras_clave) && palabras_clave.length > 0
      ? JSON.stringify(palabras_clave)
      : null;

    const result = await pool.query(`
      INSERT INTO financieras (nombre, titular_principal, celular, palabras_clave, activa, cbu, porcentaje, alias, is_default)
      VALUES ($1, $2, $3, $4::jsonb, true, $5, $6, $7, $8)
      RETURNING id, nombre, titular_principal, celular, palabras_clave, activa, created_at, cbu, porcentaje, alias, is_default
    `, [
      nombre,
      titular_principal || null,
      celular || null,
      palabrasJson,
      cbu || null,
      porcentaje || null,
      alias || null,
      isDefault
    ]);

    console.log(`🏦 Financiera creada: ${nombre}${isDefault ? ' (default)' : ''}`);

    res.status(201).json({
      ok: true,
      financiera: result.rows[0]
    });

  } catch (error) {
    console.error('Error en POST /financieras:', error);
    res.status(500).json({ error: 'Error al crear financiera' });
  }
});

/**
 * PUT /financieras/:id
 * Actualizar una financiera
 */
router.put('/:id', requirePermission('financieras.update'), async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, titular_principal, celular, palabras_clave, cbu, porcentaje, alias } = req.body;

    // Verificar que existe
    const exists = await pool.query('SELECT id FROM financieras WHERE id = $1', [id]);
    if (exists.rowCount === 0) {
      return res.status(404).json({ error: 'Financiera no encontrada' });
    }

    // Validaciones
    if (!nombre) {
      return res.status(400).json({ error: 'El nombre es requerido' });
    }

    // Formatear palabras_clave como JSON para PostgreSQL jsonb
    const palabrasJson = Array.isArray(palabras_clave) && palabras_clave.length > 0
      ? JSON.stringify(palabras_clave)
      : null;

    const result = await pool.query(`
      UPDATE financieras
      SET nombre = $1,
          titular_principal = $2,
          celular = $3,
          palabras_clave = $4::jsonb,
          cbu = $5,
          porcentaje = $6,
          alias = $7
      WHERE id = $8
      RETURNING id, nombre, titular_principal, celular, palabras_clave, activa, created_at, cbu, porcentaje, alias, is_default
    `, [
      nombre,
      titular_principal || null,
      celular || null,
      palabrasJson,
      cbu || null,
      porcentaje || null,
      alias || null,
      id
    ]);

    console.log(`🏦 Financiera actualizada: ${nombre}`);

    res.json({
      ok: true,
      financiera: result.rows[0]
    });

  } catch (error) {
    console.error('Error en PUT /financieras/:id:', error);
    res.status(500).json({ error: 'Error al actualizar financiera' });
  }
});

/**
 * DELETE /financieras/:id
 * Eliminar una financiera
 */
router.delete('/:id', requirePermission('financieras.delete'), async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que existe
    const exists = await pool.query('SELECT id, nombre, is_default FROM financieras WHERE id = $1', [id]);
    if (exists.rowCount === 0) {
      return res.status(404).json({ error: 'Financiera no encontrada' });
    }

    const wasDefault = exists.rows[0].is_default;

    // Eliminar
    await pool.query('DELETE FROM financieras WHERE id = $1', [id]);

    console.log(`🗑️ Financiera eliminada: ${exists.rows[0].nombre}`);

    // Si era default, asignar default a otra financiera (la primera que quede)
    if (wasDefault) {
      const remaining = await pool.query('SELECT id FROM financieras ORDER BY created_at ASC LIMIT 1');
      if (remaining.rowCount > 0) {
        await pool.query('UPDATE financieras SET is_default = true WHERE id = $1', [remaining.rows[0].id]);
        console.log(`🏦 Nueva financiera default asignada automáticamente`);
      }
    }

    res.json({
      ok: true,
      message: 'Financiera eliminada correctamente'
    });

  } catch (error) {
    console.error('Error en DELETE /financieras/:id:', error);
    res.status(500).json({ error: 'Error al eliminar financiera' });
  }
});

/**
 * PATCH /financieras/:id/activar
 * Activar/desactivar una financiera
 */
router.patch('/:id/activar', requirePermission('financieras.update'), async (req, res) => {
  try {
    const { id } = req.params;
    const { activa } = req.body;

    const result = await pool.query(`
      UPDATE financieras
      SET activa = $1
      WHERE id = $2
      RETURNING id, nombre, titular_principal, celular, palabras_clave, activa, created_at, cbu, porcentaje, alias, is_default
    `, [activa, id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Financiera no encontrada' });
    }

    console.log(`🏦 Financiera ${activa ? 'activada' : 'desactivada'}: ${result.rows[0].nombre}`);

    res.json({
      ok: true,
      financiera: result.rows[0]
    });

  } catch (error) {
    console.error('Error en PATCH /financieras/:id/activar:', error);
    res.status(500).json({ error: 'Error al cambiar estado de financiera' });
  }
});

/**
 * PATCH /financieras/:id/default
 * Marcar una financiera como predeterminada
 */
router.patch('/:id/default', requirePermission('financieras.set_default'), async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que existe
    const exists = await pool.query('SELECT id, nombre FROM financieras WHERE id = $1', [id]);
    if (exists.rowCount === 0) {
      return res.status(404).json({ error: 'Financiera no encontrada' });
    }

    // Quitar default de todas
    await pool.query('UPDATE financieras SET is_default = false');

    // Marcar esta como default
    const result = await pool.query(`
      UPDATE financieras
      SET is_default = true
      WHERE id = $1
      RETURNING id, nombre, titular_principal, celular, palabras_clave, activa, created_at, cbu, porcentaje, alias, is_default
    `, [id]);

    console.log(`⭐ Financiera marcada como default: ${result.rows[0].nombre}`);

    res.json({
      ok: true,
      financiera: result.rows[0]
    });

  } catch (error) {
    console.error('Error en PATCH /financieras/:id/default:', error);
    res.status(500).json({ error: 'Error al marcar financiera como predeterminada' });
  }
});

module.exports = router;
