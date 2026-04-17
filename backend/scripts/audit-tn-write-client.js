#!/usr/bin/env node
/**
 * Audit del wrapper tn-write en producción.
 *
 * Lee logs de Cloud Run para las últimas N horas y reporta:
 *   - total requests, éxitos, fallos
 *   - 429s (y si hubo retry exitoso después)
 *   - latencias por percentil
 *   - retries promedio por request
 *   - top contextos con más retries
 *
 * Requiere gcloud autenticado con permisos de logs.
 *
 * Uso:
 *   node backend/scripts/audit-tn-write-client.js [--hours 24] [--service crm-workers|petlove-backend|all]
 */

const { execSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const HOURS = parseInt(opt('hours', '24'), 10);
const SERVICE = opt('service', 'all');
const PROJECT = opt('project', 'tidal-cipher-486519-k0');
const ACCOUNT = opt('account', 'crm-deploy@tidal-cipher-486519-k0.iam.gserviceaccount.com');

const freshness = `${HOURS}h`;
const services = SERVICE === 'all' ? ['crm-workers', 'petlove-backend'] : [SERVICE];

function fetchLogs(service) {
  const filter = [
    'resource.type="cloud_run_revision"',
    `resource.labels.service_name="${service}"`,
    '(textPayload=~"\\\\[tn-write\\\\]" OR jsonPayload.msg=~"\\\\[tn-write\\\\]")',
  ].join(' AND ');
  const cmd = `gcloud --account=${ACCOUNT} --project=${PROJECT} logging read '${filter}' --limit=5000 --freshness=${freshness} --format='value(timestamp,textPayload,jsonPayload.msg)' --order=asc`;
  try {
    return execSync(cmd, { maxBuffer: 200 * 1024 * 1024 }).toString().split('\n').filter(Boolean);
  } catch (e) {
    console.error(`Error fetching logs for ${service}:`, e.message);
    return [];
  }
}

// Parse a log line like:
//   2026-04-17T15:49:52Z  [tn-write] [mark-paid#123] PUT /v1/123/orders/456 attempt=1 status=200 latency=145ms rate-remaining=38
const LINE_RX = /\[tn-write\]\s+(?:\[(?<ctx>[^\]]+)\]\s+)?(?<method>GET|PUT|POST|PATCH|DELETE)\s+(?<path>\S+)\s+(?:FAILED\s+)?attempt=(?<attempt>\d+)\s+status=(?<status>\S+)\s+latency=(?<latency>\d+)ms(?:\s+retriable=(?<retriable>\w+))?(?:\s+rate-remaining=(?<remaining>\d+))?/;

function parseLines(lines) {
  return lines
    .map((raw) => {
      const m = raw.match(LINE_RX);
      if (!m) return null;
      const ts = raw.split('\t')[0] || raw.split(' ')[0];
      const g = m.groups;
      const failed = /FAILED/.test(raw);
      return {
        ts,
        context: g.ctx || '',
        method: g.method,
        path: g.path,
        attempt: parseInt(g.attempt, 10),
        status: /^\d+$/.test(g.status) ? parseInt(g.status, 10) : g.status,
        latencyMs: parseInt(g.latency, 10),
        retriable: g.retriable,
        remaining: g.remaining ? parseInt(g.remaining, 10) : null,
        failed,
      };
    })
    .filter(Boolean);
}

function pct(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const i = Math.floor((p / 100) * sortedArr.length);
  return sortedArr[Math.min(i, sortedArr.length - 1)];
}

function groupByContext(events) {
  const byCtx = new Map();
  for (const e of events) {
    const k = e.context || e.path;
    if (!byCtx.has(k)) byCtx.set(k, []);
    byCtx.get(k).push(e);
  }
  return byCtx;
}

function analyze(service, events) {
  const byCtx = groupByContext(events);
  let totalRequests = 0;
  let requestsWithRetry = 0;
  let requests429 = 0;
  let requests5xx = 0;
  let finalFailures = 0;
  let retryRecoveries = 0;
  const latencies = [];
  const retryCounts = [];
  const topRetriesCtx = [];

  for (const [ctx, attempts] of byCtx) {
    attempts.sort((a, b) => a.attempt - b.attempt);
    const lastAttempt = attempts[attempts.length - 1];
    totalRequests += 1;
    const totalAttempts = attempts.length;
    retryCounts.push(totalAttempts - 1);
    if (totalAttempts > 1) {
      requestsWithRetry += 1;
      topRetriesCtx.push({ ctx, attempts: totalAttempts, finalStatus: lastAttempt.status });
    }
    for (const a of attempts) {
      if (a.status === 429) requests429 += 1;
      if (typeof a.status === 'number' && a.status >= 500 && a.status < 600) requests5xx += 1;
    }
    if (lastAttempt.failed) finalFailures += 1;
    else if (totalAttempts > 1) retryRecoveries += 1;
    // latencia del último attempt exitoso
    if (!lastAttempt.failed) latencies.push(lastAttempt.latencyMs);
  }

  latencies.sort((a, b) => a - b);
  topRetriesCtx.sort((a, b) => b.attempts - a.attempts);

  console.log(`\n╔════ ${service} (ventana ${HOURS}h) ════╗`);
  console.log(`  requests totales:        ${totalRequests}`);
  console.log(`  requests con ≥1 retry:   ${requestsWithRetry} (${totalRequests ? (100 * requestsWithRetry / totalRequests).toFixed(1) : 0}%)`);
  console.log(`  429 acumulados:          ${requests429}`);
  console.log(`  5xx acumulados:          ${requests5xx}`);
  console.log(`  recuperados por retry:   ${retryRecoveries}`);
  console.log(`  fallos definitivos:      ${finalFailures}`);
  console.log(`  latencia p50:            ${pct(latencies, 50)}ms`);
  console.log(`  latencia p95:            ${pct(latencies, 95)}ms`);
  console.log(`  latencia p99:            ${pct(latencies, 99)}ms`);
  if (topRetriesCtx.length) {
    console.log(`  top 10 contextos con más retries:`);
    for (const t of topRetriesCtx.slice(0, 10)) {
      console.log(`    - ${t.ctx}: ${t.attempts} intentos, final=${t.finalStatus}`);
    }
  }
}

function main() {
  console.log(`Audit tn-write client — últimas ${HOURS}h`);
  console.log(`Account: ${ACCOUNT}\nProject: ${PROJECT}\nServices: ${services.join(', ')}\n`);
  for (const svc of services) {
    const lines = fetchLogs(svc);
    const events = parseLines(lines);
    if (events.length === 0) {
      console.log(`\n${svc}: sin logs de [tn-write] en la ventana.`);
      continue;
    }
    analyze(svc, events);
  }
}

main();
