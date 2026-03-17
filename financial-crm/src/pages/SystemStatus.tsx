import { useState, useEffect, useCallback } from 'react';
import { Header } from '../components/layout';
import { AccessDenied } from '../components/AccessDenied';
import {
  RefreshCw,
  AlertCircle,
  Activity,
  CheckCircle2,
  XOctagon,
  AlertTriangle,
  Database,
  Server,
  Wifi,
  Cloud,
  Eye,
  ShoppingCart,
  MessageSquare,
  Clock,
  Cpu,
  HardDrive,
  RotateCcw,
  ChevronDown,
  ChevronUp,
  Zap,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// ─── Types ──────────────────────────────────────────────

interface ServiceStatus {
  name: string;
  status: 'healthy' | 'degraded' | 'down';
  latency_ms: number;
  error?: string;
}

interface QueueDepth {
  waiting: number;
  active: number;
  failed: number;
}

interface QueueDetail {
  available: boolean;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  recent_failures: Array<{
    id: string;
    name: string;
    error: string;
    failed_at: string | null;
    attempts: number;
  }>;
  error?: string;
}

interface BreakerState {
  state: 'closed' | 'open' | 'halfOpen';
  stats: {
    successes: number;
    failures: number;
    timeouts: number;
    rejects: number;
  };
}

interface Incident {
  type: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  timestamp: string;
}

interface OverviewData {
  overall_status: 'healthy' | 'degraded' | 'down';
  timestamp: string;
  services: ServiceStatus[];
  queue_depths: Record<string, QueueDepth>;
  recent_errors_count: number;
  active_workers: number;
  last_sync: Record<string, { value: string; updated_at: string }> | null;
  circuit_breakers: Record<string, BreakerState>;
  pool_stats: { totalCount: number; idleCount: number; waitingCount: number };
  system: {
    uptime_seconds: number;
    memory: { rss_mb: number; heap_used_mb: number; heap_total_mb: number };
    node_version: string;
  };
}

// ─── Helpers ────────────────────────────────────────────

async function authFetch(url: string) {
  const token = localStorage.getItem('token');
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function authPost(url: string) {
  const token = localStorage.getItem('token');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const SERVICE_ICONS: Record<string, typeof Database> = {
  Database: Database,
  Redis: Server,
  TiendaNube: ShoppingCart,
  Botmaker: MessageSquare,
  'Google Vision': Eye,
  'Supabase Storage': Cloud,
};

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'hace un momento';
  if (mins < 60) return `hace ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.floor(hours / 24);
  return `hace ${days}d`;
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'healthy' || status === 'closed'
      ? 'bg-green-500'
      : status === 'degraded' || status === 'halfOpen'
        ? 'bg-yellow-500'
        : 'bg-red-500';
  return (
    <span className={`inline-block w-2.5 h-2.5 rounded-full ${color}`} />
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    healthy: 'bg-green-100 text-green-800',
    closed: 'bg-green-100 text-green-800',
    degraded: 'bg-yellow-100 text-yellow-800',
    halfOpen: 'bg-yellow-100 text-yellow-800',
    down: 'bg-red-100 text-red-800',
    open: 'bg-red-100 text-red-800',
  };
  const labels: Record<string, string> = {
    healthy: 'OK',
    closed: 'CLOSED',
    degraded: 'DEGRADADO',
    halfOpen: 'HALF-OPEN',
    down: 'CAIDO',
    open: 'OPEN',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || 'bg-gray-100 text-gray-800'}`}>
      {labels[status] || status}
    </span>
  );
}

// ─── Component ──────────────────────────────────────────

export default function SystemStatus() {
  const { hasPermission } = useAuth();
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [queueDetails, setQueueDetails] = useState<Record<string, QueueDetail>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [showIncidents, setShowIncidents] = useState(true);
  const [showQueues, setShowQueues] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const canView = hasPermission('integrations.view');
  const canUpdate = hasPermission('integrations.update');

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [overviewData, incidentsData, queuesData] = await Promise.all([
        authFetch(`${API_BASE_URL}/admin/status/overview`),
        authFetch(`${API_BASE_URL}/admin/status/incidents`).catch(() => ({ incidents: [] })),
        authFetch(`${API_BASE_URL}/admin/status/queues`).catch(() => ({ queues: {} })),
      ]);
      setOverview(overviewData);
      setIncidents(incidentsData.incidents || []);
      setQueueDetails(queuesData.queues || {});
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando estado del sistema');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canView) return;
    loadAll();
    const interval = setInterval(loadAll, 30000);
    return () => clearInterval(interval);
  }, [canView, loadAll]);

  const handleRetry = async (queueName: string) => {
    setRetrying(queueName);
    try {
      await authPost(`${API_BASE_URL}/admin/status/retry-failed/${queueName}`);
      await loadAll();
    } catch (err) {
      console.error('Error retrying:', err);
    } finally {
      setRetrying(null);
    }
  };

  if (!canView) {
    return <AccessDenied />;
  }

  return (
    <>
      <Header title="Estado del Sistema" />

      <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-6">
        {/* Top bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {overview && (
              <>
                <StatusDot status={overview.overall_status} />
                <span className="text-lg font-semibold text-neutral-900">
                  Sistema {overview.overall_status === 'healthy' ? 'Operativo' : overview.overall_status === 'degraded' ? 'Degradado' : 'Con Problemas'}
                </span>
                <StatusBadge status={overview.overall_status} />
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-neutral-500">
              Actualizado {formatTimeAgo(lastRefresh.toISOString())}
            </span>
            <button
              onClick={() => { setLoading(true); loadAll(); }}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white border border-neutral-300 rounded-lg hover:bg-neutral-50 disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Actualizar
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
            <AlertCircle size={20} className="text-red-600 shrink-0" />
            <p className="text-red-800 text-sm">{error}</p>
          </div>
        )}

        {/* Service Health Cards */}
        {overview && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {overview.services.map((svc) => {
              const Icon = SERVICE_ICONS[svc.name] || Wifi;
              return (
                <div
                  key={svc.name}
                  className={`bg-white rounded-xl border p-4 ${
                    svc.status === 'healthy'
                      ? 'border-green-200'
                      : svc.status === 'degraded'
                        ? 'border-yellow-200'
                        : 'border-red-200'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <Icon size={18} className="text-neutral-600" />
                    <StatusDot status={svc.status} />
                  </div>
                  <p className="text-sm font-medium text-neutral-900 truncate">{svc.name}</p>
                  <p className="text-xs text-neutral-500 mt-1">
                    {svc.status === 'healthy'
                      ? `${svc.latency_ms}ms`
                      : svc.error || 'Error'}
                  </p>
                </div>
              );
            })}
          </div>
        )}

        {/* System Info + Circuit Breakers Row */}
        {overview && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* System Info */}
            <div className="bg-white rounded-xl border border-neutral-200 p-5">
              <div className="flex items-center gap-2 mb-4">
                <Cpu size={18} className="text-neutral-600" />
                <h3 className="font-semibold text-neutral-900">Sistema</h3>
              </div>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-neutral-500">Uptime</span>
                  <span className="font-medium">{formatUptime(overview.system.uptime_seconds)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">Node.js</span>
                  <span className="font-medium">{overview.system.node_version}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">Memoria RSS</span>
                  <span className="font-medium">{overview.system.memory.rss_mb} MB</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">Heap usado</span>
                  <span className="font-medium">
                    {overview.system.memory.heap_used_mb} / {overview.system.memory.heap_total_mb} MB
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">Errores (1h)</span>
                  <span className={`font-medium ${overview.recent_errors_count > 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {overview.recent_errors_count}
                  </span>
                </div>
              </div>
            </div>

            {/* DB Pool Stats */}
            <div className="bg-white rounded-xl border border-neutral-200 p-5">
              <div className="flex items-center gap-2 mb-4">
                <HardDrive size={18} className="text-neutral-600" />
                <h3 className="font-semibold text-neutral-900">Pool de Base de Datos</h3>
              </div>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-neutral-500">Conexiones totales</span>
                  <span className="font-medium">{overview.pool_stats.totalCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">Idle</span>
                  <span className="font-medium">{overview.pool_stats.idleCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">En espera</span>
                  <span className={`font-medium ${overview.pool_stats.waitingCount > 0 ? 'text-yellow-600' : ''}`}>
                    {overview.pool_stats.waitingCount}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">Workers activos</span>
                  <span className="font-medium">{overview.active_workers}</span>
                </div>
                {overview.last_sync && Object.entries(overview.last_sync).map(([key, val]) => (
                  <div key={key} className="flex justify-between">
                    <span className="text-neutral-500 truncate mr-2">
                      {key === 'last_order_sync' ? 'Ultimo sync pedidos' : 'Ultimo sync imagenes'}
                    </span>
                    <span className="text-xs text-neutral-600">{formatTimeAgo(val.updated_at)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Circuit Breakers */}
            <div className="bg-white rounded-xl border border-neutral-200 p-5">
              <div className="flex items-center gap-2 mb-4">
                <Zap size={18} className="text-neutral-600" />
                <h3 className="font-semibold text-neutral-900">Circuit Breakers</h3>
              </div>
              <div className="space-y-3">
                {Object.entries(overview.circuit_breakers).map(([name, breaker]) => (
                  <div key={name} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <StatusDot status={breaker.state} />
                      <span className="text-neutral-700 capitalize">{name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={breaker.state} />
                      <span className="text-xs text-neutral-400">
                        {breaker.stats.successes}ok {breaker.stats.failures}err
                      </span>
                    </div>
                  </div>
                ))}
                {Object.keys(overview.circuit_breakers).length === 0 && (
                  <p className="text-sm text-neutral-500">Sin circuit breakers registrados</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Queue Status */}
        <div className="bg-white rounded-xl border border-neutral-200">
          <button
            onClick={() => setShowQueues(!showQueues)}
            className="w-full flex items-center justify-between p-5 text-left"
          >
            <div className="flex items-center gap-2">
              <Activity size={18} className="text-neutral-600" />
              <h3 className="font-semibold text-neutral-900">Colas de Trabajo</h3>
              {overview && (
                <span className="text-xs text-neutral-500">
                  ({Object.keys(overview.queue_depths).length} colas)
                </span>
              )}
            </div>
            {showQueues ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>

          {showQueues && (
            <div className="px-5 pb-5">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-neutral-500 border-b border-neutral-100">
                      <th className="pb-2 font-medium">Cola</th>
                      <th className="pb-2 font-medium text-center">Esperando</th>
                      <th className="pb-2 font-medium text-center">Activos</th>
                      <th className="pb-2 font-medium text-center">Completados</th>
                      <th className="pb-2 font-medium text-center">Fallidos</th>
                      <th className="pb-2 font-medium text-center">Retrasados</th>
                      <th className="pb-2 font-medium text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-50">
                    {Object.entries(queueDetails).map(([name, q]) => (
                      <tr key={name} className="hover:bg-neutral-50">
                        <td className="py-2.5 font-medium text-neutral-900">{name}</td>
                        <td className="py-2.5 text-center">
                          <span className={`inline-flex items-center justify-center min-w-[28px] px-1.5 py-0.5 rounded-full text-xs font-medium ${q.waiting > 0 ? 'bg-blue-100 text-blue-800' : 'bg-neutral-100 text-neutral-600'}`}>
                            {q.waiting}
                          </span>
                        </td>
                        <td className="py-2.5 text-center">
                          <span className={`inline-flex items-center justify-center min-w-[28px] px-1.5 py-0.5 rounded-full text-xs font-medium ${q.active > 0 ? 'bg-green-100 text-green-800' : 'bg-neutral-100 text-neutral-600'}`}>
                            {q.active}
                          </span>
                        </td>
                        <td className="py-2.5 text-center">
                          <span className="inline-flex items-center justify-center min-w-[28px] px-1.5 py-0.5 rounded-full text-xs font-medium bg-neutral-100 text-neutral-600">
                            {q.completed}
                          </span>
                        </td>
                        <td className="py-2.5 text-center">
                          <span className={`inline-flex items-center justify-center min-w-[28px] px-1.5 py-0.5 rounded-full text-xs font-medium ${q.failed > 0 ? 'bg-red-100 text-red-800' : 'bg-neutral-100 text-neutral-600'}`}>
                            {q.failed}
                          </span>
                        </td>
                        <td className="py-2.5 text-center">
                          <span className={`inline-flex items-center justify-center min-w-[28px] px-1.5 py-0.5 rounded-full text-xs font-medium ${q.delayed > 0 ? 'bg-yellow-100 text-yellow-800' : 'bg-neutral-100 text-neutral-600'}`}>
                            {q.delayed}
                          </span>
                        </td>
                        <td className="py-2.5 text-right">
                          {q.failed > 0 && canUpdate && (
                            <button
                              onClick={() => handleRetry(name)}
                              disabled={retrying === name}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-red-50 text-red-700 rounded-md hover:bg-red-100 disabled:opacity-50"
                            >
                              <RotateCcw size={12} className={retrying === name ? 'animate-spin' : ''} />
                              Reintentar
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Recent failures */}
              {Object.entries(queueDetails).some(([, q]) => q.recent_failures.length > 0) && (
                <div className="mt-4 pt-4 border-t border-neutral-100">
                  <h4 className="text-sm font-medium text-neutral-700 mb-2">Errores recientes en colas</h4>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {Object.entries(queueDetails).flatMap(([qName, q]) =>
                      q.recent_failures.map((f) => (
                        <div key={`${qName}-${f.id}`} className="flex items-start gap-2 text-xs bg-red-50 rounded-lg p-2">
                          <XOctagon size={14} className="text-red-500 shrink-0 mt-0.5" />
                          <div className="min-w-0 flex-1">
                            <span className="font-medium text-red-800">[{qName}]</span>{' '}
                            <span className="text-red-700">{f.error}</span>
                            <div className="text-red-400 mt-0.5">
                              Job {f.id} - {f.attempts} intentos
                              {f.failed_at && ` - ${formatTimeAgo(f.failed_at)}`}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Recent Incidents */}
        <div className="bg-white rounded-xl border border-neutral-200">
          <button
            onClick={() => setShowIncidents(!showIncidents)}
            className="w-full flex items-center justify-between p-5 text-left"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle size={18} className="text-neutral-600" />
              <h3 className="font-semibold text-neutral-900">Incidentes Recientes</h3>
              {incidents.length > 0 && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                  {incidents.length}
                </span>
              )}
            </div>
            {showIncidents ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>

          {showIncidents && (
            <div className="px-5 pb-5">
              {incidents.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-neutral-500 py-4">
                  <CheckCircle2 size={16} className="text-green-500" />
                  Sin incidentes recientes
                </div>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {incidents.map((inc, i) => {
                    const Icon = inc.severity === 'error' ? XOctagon : inc.severity === 'warning' ? AlertTriangle : AlertCircle;
                    const colors = inc.severity === 'error'
                      ? 'bg-red-50 border-red-100'
                      : inc.severity === 'warning'
                        ? 'bg-yellow-50 border-yellow-100'
                        : 'bg-blue-50 border-blue-100';
                    const iconColor = inc.severity === 'error'
                      ? 'text-red-500'
                      : inc.severity === 'warning'
                        ? 'text-yellow-500'
                        : 'text-blue-500';
                    const typeLabels: Record<string, string> = {
                      webhook_failure: 'Webhook',
                      whatsapp_failure: 'WhatsApp',
                      sync_failure: 'Sync',
                      stuck_comprobante: 'Comprobante',
                      order_inconsistency: 'Inconsistencia',
                    };

                    return (
                      <div key={i} className={`flex items-start gap-3 p-3 rounded-lg border ${colors}`}>
                        <Icon size={16} className={`${iconColor} shrink-0 mt-0.5`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-xs font-medium text-neutral-600 uppercase">
                              {typeLabels[inc.type] || inc.type}
                            </span>
                            <span className="text-xs text-neutral-400">
                              {formatTimeAgo(inc.timestamp)}
                            </span>
                          </div>
                          <p className="text-sm text-neutral-800 break-words">{inc.message}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Auto-refresh indicator */}
        <div className="flex items-center justify-center gap-2 text-xs text-neutral-400 pb-4">
          <Clock size={12} />
          Se actualiza automaticamente cada 30 segundos
        </div>
      </div>
    </>
  );
}
