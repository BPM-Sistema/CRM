/**
 * Script para ejecutar migraciones RBAC
 * Ejecutar con: node migrations/run-migrations.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');

async function runMigrations() {
  console.log('🚀 Ejecutando migraciones RBAC...\n');

  try {
    // 1. Crear tablas
    console.log('📦 Creando tablas...');
    const tablesSql = fs.readFileSync(
      path.join(__dirname, '001_rbac_tables.sql'),
      'utf8'
    );
    await pool.query(tablesSql);
    console.log('✅ Tablas creadas\n');

    // 2. Seeds
    console.log('🌱 Insertando seeds...');
    const seedsSql = fs.readFileSync(
      path.join(__dirname, '002_rbac_seeds.sql'),
      'utf8'
    );
    await pool.query(seedsSql);
    console.log('✅ Seeds insertados\n');

    // 3. Verificar
    const rolesResult = await pool.query('SELECT name FROM roles ORDER BY name');
    console.log('📋 Roles creados:', rolesResult.rows.map(r => r.name).join(', '));

    const permissionsResult = await pool.query('SELECT COUNT(*) FROM permissions');
    console.log('🔑 Permisos creados:', permissionsResult.rows[0].count);

    const usersResult = await pool.query('SELECT email FROM users');
    console.log('👤 Usuarios:', usersResult.rows.map(u => u.email).join(', '));

    console.log('\n✅ Migraciones completadas exitosamente!');

  } catch (error) {
    console.error('❌ Error en migraciones:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigrations();
