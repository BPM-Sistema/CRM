/**
 * Auditoría de pedidos: Excel vs BPM vs Tiendanube
 * Rango: 2026-03-24 al 2026-03-31
 *
 * Uso: node scripts/audit-orders.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');
const axios = require('axios');

// ============ CONFIG ============
const CSV_PATH = '/Users/netaneldabbah/Downloads/CONTROL PEDIDOS BLANQUERIA X MAYOR.xlsx - Hoja1.csv';
const DATE_FROM = '2026-03-24';
const DATE_TO = '2026-03-31';

const TIENDANUBE_STORE_ID = process.env.TIENDANUBE_STORE_ID;
const TIENDANUBE_TOKEN = process.env.TIENDANUBE_ACCESS_TOKEN;

// ============ PARSERS ============

/**
 * Parsea fecha tipo "24-mar" a Date (asume 2026)
 */
function parseExcelDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;

  const months = {
    'ene': 0, 'feb': 1, 'mar': 2, 'abr': 3, 'may': 4, 'jun': 5,
    'jul': 6, 'ago': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dic': 11
  };

  const match = dateStr.trim().match(/^(\d{1,2})-([a-z]{3})$/i);
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const monthStr = match[2].toLowerCase();
  const month = months[monthStr];

  if (month === undefined || day < 1 || day > 31) return null;

  return new Date(2026, month, day);
}

/**
 * Parsea monto tipo " $  1.011.413 " a number
 */
function parseExcelMonto(montoStr) {
  if (!montoStr || typeof montoStr !== 'string') return 0;

  // Quitar $, espacios, y puntos de miles
  const cleaned = montoStr.replace(/[$\s.]/g, '').replace(',', '.');
  const num = parseFloat(cleaned);

  return isNaN(num) ? 0 : num;
}

/**
 * Extrae order_number del código Excel (M4517 → 4517)
 */
function parseExcelOrderNumber(code) {
  if (!code || typeof code !== 'string') return null;

  const trimmed = code.trim();

  // Si empieza con M seguido de números
  const match = trimmed.match(/^M?(\d+)$/i);
  if (match) return match[1];

  // Si es solo números
  if (/^\d+$/.test(trimmed)) return trimmed;

  return null; // Dato sucio (ej: "PEDIDO MAL ENVIADO")
}

/**
 * Parsea una línea CSV (maneja comas dentro de campos)
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());

  return result;
}

// ============ DATA SOURCES ============

/**
 * Lee y parsea el CSV del Excel
 * Estrategia: Identifica pedidos con pagos en el rango, luego suma TODOS sus pagos (incluyendo anteriores)
 */
function loadExcelData() {
  console.log('\n📊 CARGANDO EXCEL...');

  const content = fs.readFileSync(CSV_PATH, 'utf-8');
  const lines = content.split('\n');
  const dataLines = lines.slice(1); // Skip header

  const fromDate = new Date(DATE_FROM);
  const toDate = new Date(DATE_TO);
  toDate.setHours(23, 59, 59);

  // PASO 1: Cargar TODOS los pagos del Excel (sin filtro de fecha)
  const allPayments = new Map(); // order_number -> [{fecha, monto, cuenta, enviado}]
  let skippedRows = 0;

  for (const line of dataLines) {
    if (!line.trim()) continue;

    const cols = parseCSVLine(line);
    const fecha = parseExcelDate(cols[1]);
    const orderNumber = parseExcelOrderNumber(cols[2]);
    const monto = parseExcelMonto(cols[3]);
    const cuenta = cols[5] || '';
    const enviado = cols[10] || '';

    if (!orderNumber) {
      if (cols[2] && cols[2].trim() && !cols[2].match(/^\d+$/)) {
        skippedRows++;
      }
      continue;
    }

    if (!allPayments.has(orderNumber)) {
      allPayments.set(orderNumber, []);
    }
    allPayments.get(orderNumber).push({ fecha, monto, cuenta, enviado });
  }

  console.log(`  📂 ${allPayments.size} pedidos únicos en todo el Excel`);

  // PASO 2: Identificar pedidos que tienen AL MENOS UN pago en el rango
  const ordersInRange = new Set();
  for (const [orderNumber, payments] of allPayments) {
    for (const p of payments) {
      if (p.fecha && p.fecha >= fromDate && p.fecha <= toDate) {
        ordersInRange.add(orderNumber);
        break;
      }
    }
  }

  console.log(`  📅 ${ordersInRange.size} pedidos con pagos en rango ${DATE_FROM} a ${DATE_TO}`);

  // PASO 3: Para esos pedidos, sumar TODOS sus pagos (incluyendo anteriores)
  const byOrder = new Map();
  let pagosAnterioresIncluidos = 0;

  for (const orderNumber of ordersInRange) {
    const payments = allPayments.get(orderNumber);
    let montoTotal = 0;
    let cuenta = '';
    let fechaMasReciente = null;
    let pagosAnteriores = 0;

    for (const p of payments) {
      montoTotal += p.monto;

      // Contar pagos anteriores al rango
      if (p.fecha && p.fecha < fromDate) {
        pagosAnteriores++;
      }

      // Tomar cuenta del pago principal (no "2do pago")
      if (!p.enviado.includes('2do pago') && p.cuenta) {
        cuenta = p.cuenta;
      }

      // Fecha más reciente
      if (p.fecha && (!fechaMasReciente || p.fecha > fechaMasReciente)) {
        fechaMasReciente = p.fecha;
      }
    }

    if (pagosAnteriores > 0) {
      pagosAnterioresIncluidos++;
    }

    byOrder.set(orderNumber, {
      order_number: orderNumber,
      fecha: fechaMasReciente,
      monto_total: montoTotal,
      pagos: payments,
      cuenta: cuenta,
      pagos_anteriores: pagosAnteriores
    });
  }

  console.log(`  ✅ ${byOrder.size} pedidos a comparar`);
  console.log(`  ⚠️  ${skippedRows} filas con código inválido (ignoradas)`);
  console.log(`  🔄 ${pagosAnterioresIncluidos} pedidos incluyen pagos de fechas anteriores`);

  return byOrder;
}

/**
 * Obtiene pedidos de BPM (PostgreSQL) - por order_numbers específicos
 */
async function loadBPMData(orderNumbersToFind) {
  console.log('\n🗄️  CARGANDO BPM (PostgreSQL)...');
  console.log(`  🔍 Buscando ${orderNumbersToFind.length} pedidos...`);

  if (orderNumbersToFind.length === 0) {
    return new Map();
  }

  const query = `
    SELECT
      order_number,
      monto_tiendanube,
      total_pagado,
      saldo,
      estado_pago,
      estado_pedido,
      created_at,
      customer_name
    FROM orders_validated
    WHERE order_number = ANY($1)
    ORDER BY order_number
  `;

  const result = await pool.query(query, [orderNumbersToFind]);

  const byOrder = new Map();
  for (const row of result.rows) {
    const orderNumber = row.order_number.replace(/^#/, '');
    byOrder.set(orderNumber, {
      order_number: orderNumber,
      monto: parseFloat(row.monto_tiendanube) || 0,
      total_pagado: parseFloat(row.total_pagado) || 0,
      saldo: parseFloat(row.saldo) || 0,
      estado_pago: row.estado_pago,
      estado_pedido: row.estado_pedido,
      fecha: row.created_at,
      customer_name: row.customer_name
    });
  }

  console.log(`  ✅ ${byOrder.size} encontrados en BPM`);
  console.log(`  ❌ ${orderNumbersToFind.length - byOrder.size} no encontrados en BPM`);

  return byOrder;
}

/**
 * Obtiene pedidos de Tiendanube API - busca por order_numbers específicos
 */
async function loadTiendanubeData(orderNumbersToFind) {
  console.log('\n🛒 CARGANDO TIENDANUBE API...');
  console.log(`  🔍 Buscando ${orderNumbersToFind.length} pedidos específicos...`);

  const byOrder = new Map();
  let found = 0;
  let notFound = 0;
  let errors = 0;

  // Procesar en batches de 10 para no saturar la API
  const batchSize = 10;
  const batches = [];
  for (let i = 0; i < orderNumbersToFind.length; i += batchSize) {
    batches.push(orderNumbersToFind.slice(i, i + batchSize));
  }

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];

    // Procesar batch en paralelo
    const promises = batch.map(async (orderNumber) => {
      const url = `https://api.tiendanube.com/v1/${TIENDANUBE_STORE_ID}/orders`;

      try {
        const response = await axios.get(url, {
          headers: {
            'Authentication': `bearer ${TIENDANUBE_TOKEN}`,
            'User-Agent': 'bpm-audit'
          },
          params: {
            q: orderNumber,
            per_page: 5
          }
        });

        const orders = response.data;

        // Buscar el pedido exacto
        const exactMatch = orders.find(o => String(o.number) === orderNumber);

        if (exactMatch) {
          return {
            order_number: orderNumber,
            tn_id: exactMatch.id,
            monto: parseFloat(exactMatch.total) || 0,
            currency: exactMatch.currency,
            payment_status: exactMatch.payment_status,
            shipping_status: exactMatch.shipping_status,
            status: exactMatch.status,
            fecha: new Date(exactMatch.created_at),
            paid_at: exactMatch.paid_at ? new Date(exactMatch.paid_at) : null,
            customer_name: exactMatch.customer?.name || ''
          };
        } else {
          return { order_number: orderNumber, not_found: true };
        }

      } catch (error) {
        return { order_number: orderNumber, error: error.message };
      }
    });

    const results = await Promise.all(promises);

    for (const result of results) {
      if (result.error) {
        errors++;
      } else if (result.not_found) {
        notFound++;
      } else {
        found++;
        byOrder.set(result.order_number, result);
      }
    }

    // Progress
    if ((batchIdx + 1) % 10 === 0 || batchIdx === batches.length - 1) {
      console.log(`  📄 Procesados ${Math.min((batchIdx + 1) * batchSize, orderNumbersToFind.length)}/${orderNumbersToFind.length}`);
    }

    // Rate limiting entre batches
    if (batchIdx < batches.length - 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`  ✅ ${found} encontrados en TN`);
  console.log(`  ❌ ${notFound} no encontrados en TN`);
  if (errors > 0) console.log(`  ⚠️  ${errors} errores`);

  return byOrder;
}

// ============ COMPARACIÓN ============

function compareData(excel, bpm, tiendanube) {
  console.log('\n🔍 COMPARANDO DATOS...\n');

  const results = {
    // A) Comparación de MONTOS
    montos: {
      ok: [],              // Montos coinciden en las 3 fuentes
      diferencias: [],     // Montos no coinciden
    },
    // B) Comparación de ESTADOS
    estados: {
      ok: [],              // Excel pagado = BPM pagado
      excel_pagado_bpm_no: [], // Excel dice pagado, BPM no
      excel_pagado_bpm_parcial: [], // Excel dice pagado, BPM parcial
    },
    // Faltantes
    faltantes: {
      no_en_bpm: [],       // Están en Excel pero no en BPM
      no_en_tn: [],        // Están en Excel pero no en TN
    },
    resumen: {}
  };

  // Solo comparamos los pedidos del Excel (es la fuente principal)
  for (const [orderNumber, excelData] of excel) {
    const bpmData = bpm.get(orderNumber);
    const tnData = tiendanube.get(orderNumber);

    // Verificar presencia
    if (!bpmData) {
      results.faltantes.no_en_bpm.push({
        order_number: orderNumber,
        monto_excel: excelData.monto_total,
        cuenta: excelData.cuenta,
        fecha: excelData.fecha
      });
      continue;
    }

    if (!tnData) {
      results.faltantes.no_en_tn.push({
        order_number: orderNumber,
        monto_excel: excelData.monto_total,
        cuenta: excelData.cuenta
      });
      continue;
    }

    // A) COMPARACIÓN DE MONTOS
    const montoExcel = excelData.monto_total;
    const montoBPM = bpmData.monto;
    const montoTN = tnData.monto;
    const pagadoBPM = bpmData.total_pagado;

    // El Excel registra lo PAGADO, no el total del pedido
    // Comparar Excel vs total_pagado de BPM
    const diffExcelVsPagado = Math.abs(montoExcel - pagadoBPM);
    const diffExcelVsTN = Math.abs(montoExcel - montoTN);
    const diffBPMvsTN = Math.abs(montoBPM - montoTN);

    // Tolerancia de $100 para redondeos
    const montosOk = diffExcelVsPagado <= 100 && diffBPMvsTN <= 1;

    if (montosOk) {
      results.montos.ok.push({
        order_number: orderNumber,
        monto_excel: montoExcel,
        monto_pagado_bpm: pagadoBPM,
        monto_tn: montoTN
      });
    } else {
      results.montos.diferencias.push({
        order_number: orderNumber,
        excel: { monto: montoExcel, cuenta: excelData.cuenta },
        bpm: { monto_total: montoBPM, total_pagado: pagadoBPM, saldo: bpmData.saldo, estado: bpmData.estado_pago },
        tn: { monto: montoTN, status: tnData.payment_status },
        diff: {
          excel_vs_pagado_bpm: montoExcel - pagadoBPM,
          excel_vs_total_tn: montoExcel - montoTN,
          bpm_vs_tn: montoBPM - montoTN
        }
      });
    }

    // B) COMPARACIÓN DE ESTADOS
    // El Excel implica que está pagado (está en la planilla de control)
    const estadoBPM = bpmData.estado_pago;
    const esPagadoBPM = ['confirmado_total', 'a_favor'].includes(estadoBPM);
    const esParcialBPM = estadoBPM === 'confirmado_parcial';

    if (esPagadoBPM) {
      results.estados.ok.push({
        order_number: orderNumber,
        estado_bpm: estadoBPM,
        monto_excel: montoExcel,
        pagado_bpm: pagadoBPM
      });
    } else if (esParcialBPM) {
      results.estados.excel_pagado_bpm_parcial.push({
        order_number: orderNumber,
        estado_bpm: estadoBPM,
        monto_excel: montoExcel,
        pagado_bpm: pagadoBPM,
        saldo_bpm: bpmData.saldo,
        diferencia: montoExcel - pagadoBPM
      });
    } else {
      results.estados.excel_pagado_bpm_no.push({
        order_number: orderNumber,
        estado_bpm: estadoBPM,
        monto_excel: montoExcel,
        pagado_bpm: pagadoBPM,
        saldo_bpm: bpmData.saldo
      });
    }
  }

  // Resumen
  results.resumen = {
    total_excel: excel.size,
    encontrados_bpm: excel.size - results.faltantes.no_en_bpm.length,
    encontrados_tn: excel.size - results.faltantes.no_en_tn.length,
    montos_ok: results.montos.ok.length,
    montos_diff: results.montos.diferencias.length,
    estados_ok: results.estados.ok.length,
    estados_parcial: results.estados.excel_pagado_bpm_parcial.length,
    estados_no_pagado: results.estados.excel_pagado_bpm_no.length
  };

  return results;
}

// ============ REPORTE ============

function printReport(results) {
  const r = results.resumen;

  console.log('\n' + '='.repeat(70));
  console.log('📋 REPORTE DE AUDITORÍA');
  console.log('='.repeat(70));
  console.log(`Rango Excel: ${DATE_FROM} al ${DATE_TO}`);
  console.log(`Total pedidos en Excel: ${r.total_excel}`);
  console.log('='.repeat(70));

  // RESUMEN GENERAL
  console.log('\n📊 RESUMEN:');
  console.log(`   Encontrados en BPM: ${r.encontrados_bpm}/${r.total_excel}`);
  console.log(`   Encontrados en TN:  ${r.encontrados_tn}/${r.total_excel}`);

  // A) MONTOS
  console.log('\n' + '-'.repeat(70));
  console.log('💰 A) COMPARACIÓN DE MONTOS (Excel vs BPM pagado vs TN):');
  console.log('-'.repeat(70));
  console.log(`   ✅ Coinciden: ${r.montos_ok}`);
  console.log(`   ⚠️  Diferencias: ${r.montos_diff}`);

  if (results.montos.diferencias.length > 0) {
    console.log('\n   Detalle de diferencias:');
    for (const diff of results.montos.diferencias.slice(0, 15)) {
      const diffVal = diff.diff.excel_vs_pagado_bpm;
      const diffSign = diffVal > 0 ? '+' : '';
      console.log(`   #${diff.order_number}: Excel $${diff.excel.monto.toLocaleString()} | BPM pagado $${diff.bpm.total_pagado.toLocaleString()} | Diff: ${diffSign}${diffVal.toLocaleString()} (${diff.excel.cuenta})`);
    }
    if (results.montos.diferencias.length > 15) {
      console.log(`   ... y ${results.montos.diferencias.length - 15} más`);
    }
  }

  // B) ESTADOS
  console.log('\n' + '-'.repeat(70));
  console.log('📋 B) COMPARACIÓN DE ESTADOS (¿Excel pagado = BPM pagado?):');
  console.log('-'.repeat(70));
  console.log(`   ✅ Pagado en ambos: ${r.estados_ok}`);
  console.log(`   ⚠️  Excel pagado, BPM parcial: ${r.estados_parcial}`);
  console.log(`   ❌ Excel pagado, BPM NO pagado: ${r.estados_no_pagado}`);

  if (results.estados.excel_pagado_bpm_no.length > 0) {
    console.log('\n   ❌ Pedidos en Excel pero NO pagados en BPM:');
    for (const item of results.estados.excel_pagado_bpm_no.slice(0, 10)) {
      console.log(`   #${item.order_number}: Excel $${item.monto_excel.toLocaleString()} | BPM estado: ${item.estado_bpm} | pagado: $${item.pagado_bpm.toLocaleString()}`);
    }
    if (results.estados.excel_pagado_bpm_no.length > 10) {
      console.log(`   ... y ${results.estados.excel_pagado_bpm_no.length - 10} más`);
    }
  }

  if (results.estados.excel_pagado_bpm_parcial.length > 0) {
    console.log('\n   ⚠️  Pedidos en Excel pero PARCIALES en BPM:');
    for (const item of results.estados.excel_pagado_bpm_parcial.slice(0, 10)) {
      console.log(`   #${item.order_number}: Excel $${item.monto_excel.toLocaleString()} | BPM pagado $${item.pagado_bpm.toLocaleString()} | saldo $${item.saldo_bpm.toLocaleString()}`);
    }
    if (results.estados.excel_pagado_bpm_parcial.length > 10) {
      console.log(`   ... y ${results.estados.excel_pagado_bpm_parcial.length - 10} más`);
    }
  }

  // FALTANTES
  if (results.faltantes.no_en_bpm.length > 0) {
    console.log('\n' + '-'.repeat(70));
    console.log('❌ NO ENCONTRADOS EN BPM:');
    console.log('-'.repeat(70));
    for (const item of results.faltantes.no_en_bpm.slice(0, 15)) {
      console.log(`   #${item.order_number} - $${item.monto_excel.toLocaleString()} (${item.cuenta})`);
    }
    if (results.faltantes.no_en_bpm.length > 15) {
      console.log(`   ... y ${results.faltantes.no_en_bpm.length - 15} más`);
    }
  }

  console.log('\n' + '='.repeat(70));
}

function saveReport(results) {
  const outputPath = path.join(__dirname, `audit-report-${DATE_FROM}-to-${DATE_TO}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 Reporte guardado en: ${outputPath}`);
}

// ============ MAIN ============

async function main() {
  console.log('🔎 AUDITORÍA DE PEDIDOS');
  console.log(`   Rango Excel: ${DATE_FROM} al ${DATE_TO}`);
  console.log(`   Fuentes: Excel, BPM (PostgreSQL), Tiendanube API`);
  console.log(`   Comparaciones: A) Montos  B) Estados`);

  try {
    // 1. Cargar Excel (fuente principal)
    const excel = loadExcelData();
    const orderNumbers = [...excel.keys()];

    // 2. Buscar esos pedidos en BPM
    const bpm = await loadBPMData(orderNumbers);

    // 3. Buscar esos pedidos en TN
    const tiendanube = await loadTiendanubeData(orderNumbers);

    // 4. Comparar
    const results = compareData(excel, bpm, tiendanube);

    // 5. Reportar
    printReport(results);
    saveReport(results);

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
  } finally {
    await pool.end();
  }
}

main();
