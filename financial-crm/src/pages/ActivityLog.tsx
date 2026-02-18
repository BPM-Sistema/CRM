import { useState, useEffect, useCallback } from 'react';
import { Header } from '../components/layout';
import {
  RefreshCw,
  AlertCircle,
  Activity,
  Search,
  Filter,
  ChevronLeft,
  ChevronRight,
  User,
  Calendar,
  Package,
  FileCheck,
  FileX,
  Banknote,
  Printer,
  Truck,
  Clock,
  XCircle,
} from 'lucide-react';
import {
  fetchActivityLog,
  ActivityLog as ActivityLogType,
  ActivityLogFilters,
} from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';

const ACCION_CONFIG: Record<string, { label: string; icon: typeof Activity; color: string }> = {
  'comprobante_confirmado': { label: 'Comprobante confirmado', icon: FileCheck, color: 'text-green-600 bg-green-50' },
  'comprobante_rechazado': { label: 'Comprobante rechazado', icon: FileX, color: 'text-red-600 bg-red-50' },
  'pago_efectivo_registrado': { label: 'Pago efectivo', icon: Banknote, color: 'text-amber-600 bg-amber-50' },
  'hoja_impresa': { label: 'Hoja impresa', icon: Printer, color: 'text-blue-600 bg-blue-50' },
  'pedido_armado': { label: 'Pedido armado', icon: Package, color: 'text-purple-600 bg-purple-50' },
  'pedido_retirado': { label: 'Pedido retirado', icon: Truck, color: 'text-teal-600 bg-teal-50' },
  'pedido_en_calle': { label: 'Pedido en calle', icon: Truck, color: 'text-cyan-600 bg-cyan-50' },
  'pedido_enviado': { label: 'Pedido enviado', icon: Truck, color: 'text-indigo-600 bg-indigo-50' },
  'pedido_cancelado': { label: 'Pedido cancelado', icon: XCircle, color: 'text-red-600 bg-red-50' },
  'upload': { label: 'Comprobante subido', icon: Activity, color: 'text-gray-600 bg-gray-50' },
  'whatsapp_cliente_enviado': { label: 'WhatsApp enviado', icon: Activity, color: 'text-green-600 bg-green-50' },
};

function getAccionConfig(accion: string) {
  // Buscar match exacto o parcial
  for (const [key, config] of Object.entries(ACCION_CONFIG)) {
    if (accion.startsWith(key)) {
      return config;
    }
  }
  return { label: accion, icon: Activity, color: 'text-gray-600 bg-gray-50' };
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function ActivityLog() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();

  const [logs, setLogs] = useState<ActivityLogType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Paginación
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 50;

  // Filtros
  const [filters, setFilters] = useState<ActivityLogFilters>({});
  const [availableUsers, setAvailableUsers] = useState<Array<{ user_id: string; name: string }>>([]);
  const [availableAcciones, setAvailableAcciones] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  // Inputs temporales de filtros
  const [filterUserId, setFilterUserId] = useState('');
  const [filterAccion, setFilterAccion] = useState('');
  const [filterOrderNumber, setFilterOrderNumber] = useState('');
  const [filterFechaDesde, setFilterFechaDesde] = useState('');
  const [filterFechaHasta, setFilterFechaHasta] = useState('');

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const data = await fetchActivityLog(page, limit, filters);

      setLogs(data.logs);
      setTotal(data.total);
      setTotalPages(data.totalPages);
      setAvailableUsers(data.filters.users);
      setAvailableAcciones(data.filters.acciones);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar datos');
    } finally {
      setLoading(false);
    }
  }, [page, filters]);

  useEffect(() => {
    if (!hasPermission('activity.view')) {
      navigate('/');
      return;
    }
    loadData();
  }, [loadData, hasPermission, navigate]);

  const applyFilters = () => {
    setFilters({
      user_id: filterUserId || undefined,
      accion: filterAccion || undefined,
      order_number: filterOrderNumber || undefined,
      fecha_desde: filterFechaDesde || undefined,
      fecha_hasta: filterFechaHasta || undefined,
    });
    setPage(1);
  };

  const clearFilters = () => {
    setFilterUserId('');
    setFilterAccion('');
    setFilterOrderNumber('');
    setFilterFechaDesde('');
    setFilterFechaHasta('');
    setFilters({});
    setPage(1);
  };

  const hasActiveFilters = Object.values(filters).some(v => v);

  if (!hasPermission('activity.view')) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title="Historial de Actividad"
        subtitle={`${total} eventos registrados`}
        actions={
          <div className="flex gap-2">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg border transition-colors ${
                showFilters || hasActiveFilters
                  ? 'bg-violet-50 border-violet-200 text-violet-700'
                  : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Filter className="w-4 h-4" />
              Filtros
              {hasActiveFilters && (
                <span className="w-2 h-2 bg-violet-500 rounded-full" />
              )}
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
        {/* Filtros */}
        {showFilters && (
          <div className="bg-white rounded-xl border border-gray-200 p-4 mb-6">
            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
              {/* Usuario */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <User className="w-4 h-4 inline mr-1" />
                  Usuario
                </label>
                <select
                  value={filterUserId}
                  onChange={(e) => setFilterUserId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                >
                  <option value="">Todos</option>
                  {availableUsers.map((u) => (
                    <option key={u.user_id} value={u.user_id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Acción */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <Activity className="w-4 h-4 inline mr-1" />
                  Acción
                </label>
                <select
                  value={filterAccion}
                  onChange={(e) => setFilterAccion(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                >
                  <option value="">Todas</option>
                  {availableAcciones.map((a) => (
                    <option key={a} value={a}>
                      {getAccionConfig(a).label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Pedido */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <Package className="w-4 h-4 inline mr-1" />
                  Pedido
                </label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    value={filterOrderNumber}
                    onChange={(e) => setFilterOrderNumber(e.target.value)}
                    placeholder="Buscar..."
                    className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                  />
                </div>
              </div>

              {/* Fecha desde */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <Calendar className="w-4 h-4 inline mr-1" />
                  Desde
                </label>
                <input
                  type="date"
                  value={filterFechaDesde}
                  onChange={(e) => setFilterFechaDesde(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                />
              </div>

              {/* Fecha hasta */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <Calendar className="w-4 h-4 inline mr-1" />
                  Hasta
                </label>
                <input
                  type="date"
                  value={filterFechaHasta}
                  onChange={(e) => setFilterFechaHasta(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={clearFilters}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
              >
                Limpiar
              </button>
              <button
                onClick={applyFilters}
                className="px-4 py-2 bg-violet-600 text-white text-sm rounded-lg hover:bg-violet-700 transition-colors"
              >
                Aplicar filtros
              </button>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6 flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
            <p className="text-red-700">{error}</p>
          </div>
        )}

        {/* Tabla */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Fecha
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Acción
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Pedido
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Usuario
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Origen
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center">
                      <RefreshCw className="w-6 h-6 text-gray-400 animate-spin mx-auto mb-2" />
                      <p className="text-gray-500">Cargando...</p>
                    </td>
                  </tr>
                ) : logs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center">
                      <Activity className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                      <p className="text-gray-500">No hay eventos registrados</p>
                    </td>
                  </tr>
                ) : (
                  logs.map((log) => {
                    const config = getAccionConfig(log.accion);
                    const Icon = config.icon;

                    return (
                      <tr key={log.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 text-sm text-gray-600">
                            <Clock className="w-4 h-4 text-gray-400" />
                            {formatDate(log.created_at)}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-sm ${config.color}`}>
                            <Icon className="w-4 h-4" />
                            {config.label}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          {log.order_number ? (
                            <button
                              onClick={() => navigate(`/orders/${log.order_number}`)}
                              className="text-sm font-medium text-violet-600 hover:text-violet-700 hover:underline"
                            >
                              #{log.order_number}
                            </button>
                          ) : (
                            <span className="text-sm text-gray-400">-</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-sm">
                            <p className="font-medium text-gray-900">
                              {log.user_name || log.username || '-'}
                            </p>
                            {log.user_email && (
                              <p className="text-gray-500 text-xs">{log.user_email}</p>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-sm text-gray-600 capitalize">{log.origen}</span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Paginación */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-gray-50">
              <p className="text-sm text-gray-600">
                Página {page} de {totalPages} ({total} eventos)
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Anterior
                </button>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Siguiente
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
