/**
 * Script para ejecutar todas las migraciones SQL
 * Ejecutar con: node migrations/run-migrations.js
 *
 * Descubre automáticamente todos los archivos .sql en el directorio
 * y los ejecuta en orden numérico (001, 002, 003...).
 * Todas las migraciones deben ser idempotentes (IF NOT EXISTS, ON CONFLICT DO NOTHING).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');

async function runMigrations() {
  console.log('Ejecutando migraciones...\n');

  try {
    // Descubrir todos los archivos .sql en orden
    const migrationsDir = __dirname;
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    console.log(`Encontradas ${files.length} migraciones:\n`);

    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');

      console.log(`  Ejecutando ${file}...`);
      try {
        await pool.query(sql);
        console.log(`  OK: ${file}`);
      } catch (err) {
        // Si el error es por algo que ya existe, continuar
        if (err.code === '42710' || err.code === '42P07') {
          console.log(`  SKIP (ya existe): ${file}`);
        } else {
          throw new Error(`Error en ${file}: ${err.message}`);
        }
      }
    }

    // Verificar estado final
    console.log('\n--- Verificación ---');

    const rolesResult = await pool.query('SELECT name FROM roles ORDER BY name');
    console.log('Roles:', rolesResult.rows.map(r => r.name).join(', '));

    const permissionsResult = await pool.query('SELECT COUNT(*) FROM permissions');
    console.log('Permisos totales:', permissionsResult.rows[0].count);

    // Verificar permisos de Waspy
    const waspyPerms = await pool.query(
      "SELECT key FROM permissions WHERE module IN ('inbox', 'templates', 'whatsapp') ORDER BY key"
    );
    if (waspyPerms.rowCount > 0) {
      console.log('Permisos Waspy:', waspyPerms.rows.map(p => p.key).join(', '));
    }

    // Verificar tabla customers
    const customersExists = await pool.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customers')"
    );
    console.log('Tabla customers:', customersExists.rows[0].exists ? 'OK' : 'NO EXISTE');

    // Verificar tabla conversation_orders
    const convOrdersExists = await pool.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'conversation_orders')"
    );
    console.log('Tabla conversation_orders:', convOrdersExists.rows[0].exists ? 'OK' : 'NO EXISTE');

    console.log('\nMigraciones completadas.');

  } catch (error) {
    console.error('Error en migraciones:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigrations();
