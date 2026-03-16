import { useState, useEffect, useCallback } from 'react';
import { Header } from '../components/layout';
import {
  RefreshCw,
  AlertCircle,
  Clock,
  CheckCircle2,
  ImageIcon,
  ArrowRightLeft,
  SkipForward,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  History,
  Timer,
  Play,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { authFetch } from '../services/api';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

interface ProductItem {
  product_id: number;
  winning_variant_id: number | null;
  winning_image_id: number | null;
  previous_first_image_id: number | null;
  changed: boolean;
  reason: string;
  error_message?: string | null;
}

interface ChangedProduct {
  product_id: number;
  winning_variant_id: number;
  winning_image_id: number;
  previous_first_image_id: number;
  reason: string;
}

interface RunError {
  product_id: number | null;
  message: string;
}

interface RunData {
  run_id: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number;
  status: 'success' | 'partial' | 'failed' | 'running';
  dry_run: boolean;
  trigger_source: string;
  products_scanned: number;
  products_changed: number;
  products_skipped: number;
  errors_count: number;
  changed_products: ChangedProduct[];
  errors: RunError[];
  items?: ProductItem[];
}

type RunSummary = Omit<RunData, 'items'>;

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function timeAgo(dateString: string): string {
  const diffMs = Date.now() - new Date(dateString).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'hace menos de 1 min';
  if (diffMin < 60) return `hace ${diffMin} min`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `hace ${diffHrs}h ${diffMin % 60}min`;
  return `hace ${Math.floor(diffHrs / 24)} dias`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    success: 'bg-green-100 text-green-700',
    partial: 'bg-amber-100 text-amber-700',
    failed: 'bg-red-100 text-red-700',
    running: 'bg-blue-100 text-blue-700',
  };
  const icons: Record<string, React.ReactNode> = {
    success: <CheckCircle2 className="w-3 h-3" />,
    partial: <AlertTriangle className="w-3 h-3" />,
    failed: <AlertCircle className="w-3 h-3" />,
    running: <RefreshCw className="w-3 h-3 animate-spin" />,
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${styles[status] || 'bg-gray-100 text-gray-600'}`}>
      {icons[status]}
      {status}
    </span>
  );
}

export default function ImageSyncStatus() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();

  const [lastRun, setLastRun] = useState<RunData | null>(null);
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'changed' | 'errors'>('all');
  const [showHistory, setShowHistory] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunData | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [triggering, setTriggering] = useState(false);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [statusRes, historyRes] = await Promise.all([
        authFetch(`${API_BASE_URL}/sync/image-sync-status`),
        authFetch(`${API_BASE_URL}/sync/image-sync-runs?limit=20`),
      ]);

      const statusData = await statusRes.json();
      const historyData = await historyRes.json();

      if (!statusRes.ok) throw new Error(statusData.error || 'Error al cargar status');

      setLastRun(statusData.lastRun);
      setHistory(historyData.runs || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar datos');
    } finally {
      setLoading(false);
    }
  }, []);

  const triggerSync = useCallback(async () => {
    try {
      setTriggering(true);
      const res = await authFetch(`${API_BASE_URL}/sync/image-sync-trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error');
      // Esperar unos segundos y recargar para ver resultado
      setTimeout(() => {
        loadData();
        setTriggering(false);
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al ejecutar sync');
      setTriggering(false);
    }
  }, [loadData]);

  const loadRunDetail = useCallback(async (runId: string) => {
    if (selectedRunId === runId) {
      setSelectedRunId(null);
      setSelectedRun(null);
      return;
    }
    try {
      setLoadingDetail(true);
      setSelectedRunId(runId);
      const res = await authFetch(`${API_BASE_URL}/sync/image-sync-runs/${runId}`);
      const data = await res.json();
      setSelectedRun(data.run);
    } catch {
      setSelectedRun(null);
    } finally {
      setLoadingDetail(false);
    }
  }, [selectedRunId]);

  useEffect(() => {
    if (!hasPermission('activity.view')) {
      navigate('/');
      return;
    }
    loadData();
  }, [loadData, hasPermission, navigate]);

  if (!hasPermission('activity.view')) return null;

  // Datos activos: si hay un detalle seleccionado, mostrar ese; sino el último
  const activeRun = selectedRun || lastRun;
  const activeItems = activeRun?.items || [];

  const filteredItems = activeItems.filter((item) => {
    if (filter === 'changed') return item.changed;
    if (filter === 'errors') return item.reason === 'error';
    return true;
  });

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title="Sync de Imagenes"
        subtitle="Reordena la imagen principal de cada producto segun stock de variantes"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={triggerSync}
              disabled={triggering || loading}
              className="flex items-center gap-2 px-4 py-2 bg-neutral-900 text-white rounded-lg hover:bg-neutral-800 transition-colors disabled:opacity-50"
            >
              {triggering ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              {triggering ? 'Ejecutando...' : 'Ejecutar ahora'}
            </button>
            <button
              onClick={loadData}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Actualizar
            </button>
          </div>
        }
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6 flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
            <p className="text-red-700">{error}</p>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="w-6 h-6 text-gray-400 animate-spin" />
          </div>
        ) : !lastRun ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <Clock className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-900 font-medium">Sin ejecuciones todavia</p>
            <p className="text-gray-500 text-sm mt-1">
              El sync corre automaticamente cada 1 hora.
              La primera ejecucion ocurre 60 segundos despues de iniciar el server.
            </p>
          </div>
        ) : (
          <>
            {/* Metricas de la corrida activa */}
            <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-6">
              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-center gap-2 text-gray-500 text-xs font-medium mb-1">
                  <Clock className="w-3.5 h-3.5" />
                  Ultima ejecucion
                </div>
                <p className="text-sm font-semibold text-gray-900">{timeAgo(lastRun.started_at)}</p>
                <p className="text-xs text-gray-500 mt-0.5">{formatDate(lastRun.started_at)}</p>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-center gap-2 text-gray-500 text-xs font-medium mb-1">
                  <Timer className="w-3.5 h-3.5" />
                  Duracion
                </div>
                <p className="text-lg font-bold text-gray-900">{formatDuration(lastRun.duration_ms)}</p>
                <StatusBadge status={lastRun.status} />
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-center gap-2 text-gray-500 text-xs font-medium mb-1">
                  <ImageIcon className="w-3.5 h-3.5" />
                  Escaneados
                </div>
                <p className="text-2xl font-bold text-gray-900">{lastRun.products_scanned}</p>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-center gap-2 text-green-600 text-xs font-medium mb-1">
                  <ArrowRightLeft className="w-3.5 h-3.5" />
                  Cambiados
                </div>
                <p className="text-2xl font-bold text-green-600">{lastRun.products_changed}</p>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-center gap-2 text-gray-500 text-xs font-medium mb-1">
                  <SkipForward className="w-3.5 h-3.5" />
                  Saltados
                </div>
                <p className="text-2xl font-bold text-gray-900">{lastRun.products_skipped}</p>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-center gap-2 text-red-500 text-xs font-medium mb-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  Errores
                </div>
                <p className={`text-2xl font-bold ${lastRun.errors_count > 0 ? 'text-red-600' : 'text-gray-900'}`}>
                  {lastRun.errors_count}
                </p>
              </div>
            </div>

            {lastRun.dry_run && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 flex items-center gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
                <p className="text-amber-700 text-sm font-medium">DRY RUN - no se aplicaron cambios reales.</p>
              </div>
            )}

            {/* Productos editados */}
            {lastRun.changed_products.length > 0 && (
              <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-6">
                <h3 className="font-medium text-green-800 mb-2 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" />
                  Productos editados ({lastRun.changed_products.length})
                </h3>
                <div className="space-y-1">
                  {lastRun.changed_products.map((p) => (
                    <div key={p.product_id} className="flex items-center gap-3 text-sm text-green-700">
                      <span className="font-mono font-medium">#{p.product_id}</span>
                      <span className="text-green-500">&rarr;</span>
                      <span>
                        Imagen <span className="font-mono">{p.winning_image_id}</span> a posicion 1
                        {p.previous_first_image_id && (
                          <span className="text-green-600/70"> (antes: {p.previous_first_image_id})</span>
                        )}
                      </span>
                      <span className="text-green-600/50 text-xs">variante #{p.winning_variant_id}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Errores */}
            {lastRun.errors.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
                <h3 className="font-medium text-red-800 mb-2 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" />
                  Errores ({lastRun.errors.length})
                </h3>
                <div className="space-y-1">
                  {lastRun.errors.map((e, i) => (
                    <div key={i} className="text-sm text-red-700">
                      {e.product_id && <span className="font-mono font-medium">#{e.product_id}: </span>}
                      {e.message}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Historial de corridas */}
            {history.length > 1 && (
              <div className="mb-6">
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-gray-900 mb-3"
                >
                  {showHistory ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  <History className="w-4 h-4" />
                  Historial de corridas ({history.length})
                </button>

                {showHistory && (
                  <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                    <table className="w-full">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Fecha</th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Estado</th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Trigger</th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Escaneados</th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Cambiados</th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Errores</th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase">Duracion</th>
                          <th className="px-4 py-2.5"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {history.map((run) => (
                          <tr
                            key={run.run_id}
                            className={`hover:bg-gray-50 cursor-pointer ${selectedRunId === run.run_id ? 'bg-violet-50' : ''}`}
                            onClick={() => loadRunDetail(run.run_id)}
                          >
                            <td className="px-4 py-2.5 text-sm text-gray-900">{formatDate(run.started_at)}</td>
                            <td className="px-4 py-2.5"><StatusBadge status={run.status} /></td>
                            <td className="px-4 py-2.5 text-sm text-gray-600">{run.trigger_source}</td>
                            <td className="px-4 py-2.5 text-sm text-gray-900 font-mono">{run.products_scanned}</td>
                            <td className="px-4 py-2.5 text-sm font-mono text-green-600">{run.products_changed}</td>
                            <td className="px-4 py-2.5 text-sm font-mono text-red-600">{run.errors_count}</td>
                            <td className="px-4 py-2.5 text-sm text-gray-500">{formatDuration(run.duration_ms)}</td>
                            <td className="px-4 py-2.5">
                              {loadingDetail && selectedRunId === run.run_id ? (
                                <RefreshCw className="w-3.5 h-3.5 text-gray-400 animate-spin" />
                              ) : (
                                <ChevronRight className={`w-3.5 h-3.5 text-gray-400 transition-transform ${selectedRunId === run.run_id ? 'rotate-90' : ''}`} />
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Detalle de corrida seleccionada */}
            {selectedRun && (
              <div className="bg-violet-50 border border-violet-200 rounded-xl p-4 mb-6">
                <h3 className="font-medium text-violet-800 mb-1 text-sm">
                  Detalle de corrida: {selectedRun.run_id}
                </h3>
                <p className="text-xs text-violet-600 mb-3">
                  {formatDate(selectedRun.started_at)} &middot; {formatDuration(selectedRun.duration_ms)} &middot; {selectedRun.trigger_source}
                </p>

                {selectedRun.changed_products.length > 0 && (
                  <div className="space-y-1 mb-3">
                    {selectedRun.changed_products.map((p) => (
                      <div key={p.product_id} className="flex items-center gap-3 text-sm text-violet-700">
                        <span className="font-mono font-medium">#{p.product_id}</span>
                        <span>&rarr;</span>
                        <span>img {p.winning_image_id} (antes: {p.previous_first_image_id})</span>
                        <span className="text-violet-500/60 text-xs">var #{p.winning_variant_id}</span>
                      </div>
                    ))}
                  </div>
                )}

                {selectedRun.errors.length > 0 && (
                  <div className="space-y-1">
                    {selectedRun.errors.map((e, i) => (
                      <div key={i} className="text-sm text-red-700">
                        {e.product_id && <span className="font-mono">#{e.product_id}: </span>}{e.message}
                      </div>
                    ))}
                  </div>
                )}

                {selectedRun.changed_products.length === 0 && selectedRun.errors.length === 0 && (
                  <p className="text-sm text-violet-600">Sin cambios ni errores en esta corrida.</p>
                )}
              </div>
            )}

            {/* Tabla de items (solo si la corrida activa tiene items) */}
            {activeItems.length > 0 && (
              <>
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-sm text-gray-500">Filtrar:</span>
                  {(['all', 'changed', 'errors'] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      className={`px-3 py-1 text-xs font-medium rounded-full transition-colors ${
                        filter === f
                          ? 'bg-neutral-900 text-white'
                          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      {f === 'all' ? 'Todos' : f === 'changed' ? 'Cambiados' : 'Errores'}
                    </button>
                  ))}
                  <span className="text-xs text-gray-400 ml-2">{filteredItems.length} de {activeItems.length}</span>
                </div>

                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Producto</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Variante</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Imagen</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Estado</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Razon</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {filteredItems.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="px-4 py-12 text-center text-gray-500 text-sm">
                              No hay registros con este filtro
                            </td>
                          </tr>
                        ) : (
                          filteredItems.map((item) => (
                            <tr key={item.product_id} className="hover:bg-gray-50">
                              <td className="px-4 py-3 text-sm font-mono font-medium text-gray-900">#{item.product_id}</td>
                              <td className="px-4 py-3 text-sm text-gray-600">
                                {item.winning_variant_id ? `#${item.winning_variant_id}` : '-'}
                              </td>
                              <td className="px-4 py-3 text-sm">
                                {item.winning_image_id ? (
                                  <span className="text-gray-900">
                                    {item.winning_image_id}
                                    {item.previous_first_image_id && item.changed && (
                                      <span className="text-gray-400 ml-1">(era {item.previous_first_image_id})</span>
                                    )}
                                  </span>
                                ) : <span className="text-gray-400">-</span>}
                              </td>
                              <td className="px-4 py-3">
                                {item.changed ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700">
                                    <CheckCircle2 className="w-3 h-3" />Cambiado
                                  </span>
                                ) : item.reason === 'error' ? (
                                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-700">
                                    <AlertCircle className="w-3 h-3" />Error
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                                    <SkipForward className="w-3 h-3" />Saltado
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-600">
                                {item.error_message || item.reason}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
