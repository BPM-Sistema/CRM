const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);

// GET /system-alerts — listar alertas con filtros
router.get('/', requirePermission('system_alerts.view'), async (req, res) => {
  try {
    const { status, level, category, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (status) { conditions.push(`status = $${paramIdx++}`); params.push(status); }
    if (level) { conditions.push(`level = $${paramIdx++}`); params.push(level); }
    if (category) { conditions.push(`category = $${paramIdx++}`); params.push(category); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [countRes, alertsRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total FROM system_alerts ${where}`, params),
      pool.query(`
        SELECT sa.*, u_ack.name as acknowledged_by_name, u_res.name as resolved_by_name
        FROM system_alerts sa
        LEFT JOIN users u_ack ON sa.acknowledged_by = u_ack.id
        LEFT JOIN users u_res ON sa.resolved_by = u_res.id
        ${where}
        ORDER BY sa.created_at DESC
        LIMIT $${paramIdx++} OFFSET $${paramIdx}
      `, [...params, Math.min(parseInt(limit) || 50, 200), parseInt(offset) || 0])
    ]);

    res.json({
      total: parseInt(countRes.rows[0].total),
      alerts: alertsRes.rows
    });
  } catch (error) {
    console.error('[SystemAlerts] Error listing:', error.message);
    res.status(500).json({ error: 'Error listing alerts' });
  }
});

// GET /system-alerts/summary — conteos por status y level
router.get('/summary', requirePermission('system_alerts.view'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'open') as open_count,
        COUNT(*) FILTER (WHERE status = 'open' AND level = 'critical') as critical_open,
        COUNT(*) FILTER (WHERE status = 'open' AND level = 'warning') as warning_open,
        COUNT(*) FILTER (WHERE status = 'acknowledged') as acknowledged_count,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as last_24h
      FROM system_alerts
    `);
    res.json(result.rows[0]);
  } catch (error) {
    console.error('[SystemAlerts] Error getting summary:', error.message);
    res.status(500).json({ error: 'Error getting summary' });
  }
});

// PATCH /system-alerts/:id/acknowledge — marcar como reconocido
router.patch('/:id/acknowledge', requirePermission('system_alerts.manage'), async (req, res) => {
  try {
    const result = await pool.query(`
      UPDATE system_alerts
      SET status = 'acknowledged', acknowledged_by = $1, acknowledged_at = NOW()
      WHERE id = $2 AND status = 'open'
      RETURNING *
    `, [req.user.id, req.params.id]);

    if (result.rowCount === 0) return res.status(404).json({ error: 'Alert not found or already processed' });
    res.json({ ok: true, alert: result.rows[0] });
  } catch (error) {
    console.error('[SystemAlerts] Error acknowledging:', error.message);
    res.status(500).json({ error: 'Error acknowledging alert' });
  }
});

// PATCH /system-alerts/:id/resolve — marcar como resuelto
router.patch('/:id/resolve', requirePermission('system_alerts.manage'), async (req, res) => {
  try {
    const result = await pool.query(`
      UPDATE system_alerts
      SET status = 'resolved', resolved_by = $1, resolved_at = NOW()
      WHERE id = $2 AND status IN ('open', 'acknowledged')
      RETURNING *
    `, [req.user.id, req.params.id]);

    if (result.rowCount === 0) return res.status(404).json({ error: 'Alert not found or already resolved' });
    res.json({ ok: true, alert: result.rows[0] });
  } catch (error) {
    console.error('[SystemAlerts] Error resolving:', error.message);
    res.status(500).json({ error: 'Error resolving alert' });
  }
});

// POST /system-alerts/resolve-all — resolver todas las abiertas
router.post('/resolve-all', requirePermission('system_alerts.manage'), async (req, res) => {
  try {
    const result = await pool.query(`
      UPDATE system_alerts
      SET status = 'resolved', resolved_by = $1, resolved_at = NOW()
      WHERE status IN ('open', 'acknowledged')
    `, [req.user.id]);
    res.json({ ok: true, resolved: result.rowCount });
  } catch (error) {
    console.error('[SystemAlerts] Error resolving all:', error.message);
    res.status(500).json({ error: 'Error resolving alerts' });
  }
});

module.exports = router;
