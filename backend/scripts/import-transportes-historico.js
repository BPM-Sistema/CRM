#!/usr/bin/env node
/**
 * import-transportes-historico.js
 *
 * Importa el CSV del Google Sheet "datos de envio (Respuestas)" a la tabla
 * shipping_requests_historico para alimentar el ranking de transportes por provincia.
 *
 * Uso:
 *   node scripts/import-transportes-historico.js <ruta_csv>
 *   node scripts/import-transportes-historico.js <ruta_csv> --truncate
 *
 * --truncate borra los registros previos con fuente='google_sheets_2026' antes de insertar.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const FUENTE = 'google_sheets_2026';

// Parser CSV minimalista que respeta comillas dobles y comas internas.
function parseCSV(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* ignorar */ }
      else { field += ch; }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// "8/1/2026 18:33:11" → Date (d/m/yyyy HH:mm:ss)
function parseMarcaTemporal(s) {
  if (!s) return null;
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, d, mo, y, h, mi, se] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
  return isNaN(dt.getTime()) ? null : dt;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Uso: node scripts/import-transportes-historico.js <ruta_csv> [--truncate]');
    process.exit(1);
  }
  const truncate = process.argv.includes('--truncate');

  const abs = path.resolve(csvPath);
  if (!fs.existsSync(abs)) {
    console.error(`❌ Archivo no encontrado: ${abs}`);
    process.exit(1);
  }

  const text = fs.readFileSync(abs, 'utf8');
  const rows = parseCSV(text);
  if (rows.length < 2) {
    console.error('❌ CSV vacío o sin cabecera');
    process.exit(1);
  }

  const header = rows[0].map(h => h.trim());
  console.log('📋 Columnas detectadas:', header);

  // Buscar índices por nombre (tolerante)
  const idxOf = (needle) => header.findIndex(h =>
    h.toLowerCase().replace(/\s+/g, ' ').includes(needle.toLowerCase())
  );
  const iMarca = idxOf('marca temporal');
  const iNro = idxOf('nro de pedido');
  const iEmpresa = idxOf('empresa de envios');
  const iProvincia = idxOf('provincia');
  const iLocalidad = idxOf('localidad');

  if (iEmpresa < 0 || iProvincia < 0) {
    console.error('❌ No se encontraron columnas obligatorias (empresa/provincia)');
    process.exit(1);
  }

  const dataRows = rows.slice(1).filter(r => r.some(c => (c || '').trim() !== ''));
  console.log(`📥 Filas de datos: ${dataRows.length}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (truncate) {
      const del = await client.query(
        'DELETE FROM shipping_requests_historico WHERE fuente = $1',
        [FUENTE]
      );
      console.log(`🗑️  Registros previos eliminados (${FUENTE}): ${del.rowCount}`);
    }

    let insertados = 0;
    let saltados = 0;
    for (const r of dataRows) {
      const empresa = (r[iEmpresa] || '').trim();
      const provincia = (r[iProvincia] || '').trim();

      // Saltar filas basura (sin empresa o sin provincia)
      if (!empresa || !provincia) { saltados++; continue; }

      const nro = iNro >= 0 ? (r[iNro] || '').trim() : null;
      const loc = iLocalidad >= 0 ? (r[iLocalidad] || '').trim() : null;
      const marca = iMarca >= 0 ? parseMarcaTemporal(r[iMarca]) : null;

      await client.query(
        `INSERT INTO shipping_requests_historico
           (order_number, empresa_envio_raw, provincia, localidad, created_at, fuente)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [nro || null, empresa, provincia, loc || null, marca, FUENTE]
      );
      insertados++;
    }

    await client.query('COMMIT');
    console.log(`✅ Insertados: ${insertados}  |  Saltados (sin empresa/provincia): ${saltados}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
