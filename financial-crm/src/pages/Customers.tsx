import { useState, useEffect, useCallback } from 'react';
import {
  Users,
  RefreshCw,
  Search,
  Download,
  Trophy,
  Heart,
  Sparkles,
  TrendingDown,
  AlertTriangle,
  Gift,
  Crown,
  Flame,
  UserX,
  UserMinus,
  ChevronLeft,
  ChevronRight,
  Clock,
  DollarSign,
  ShoppingBag,
  Calendar,
} from 'lucide-react';
import { Header } from '../components/layout';
import {
  fetchCustomerSyncStatus,
  fetchCustomerSegments,
  fetchCustomers,
  fetchCustomerMetrics,
  startCustomerFullSync,
  syncCustomerOrdersCount,
  recalculateCustomerMetrics,
  recalculateCustomerSegments,
  Customer,
  SegmentDefinition,
  CustomerSyncStatus,
  CustomerMetrics,
} from '../services/api';
import { clsx } from 'clsx';

// Configuración visual de segmentos - EXACTO de Tiendanube
const SEGMENT_CONFIG: Record<string, {
  icon: React.ReactNode;
  color: string;
  bgColor: string;
  borderColor: string;
}> = {
  // Compras recientes (< 45 días)
  campeones: {
    icon: <Trophy size={20} />,
    color: 'text-amber-600',
    bgColor: 'bg-amber-50',
    borderColor: 'border-amber-200',
  },
  leales: {
    icon: <Heart size={20} />,
    color: 'text-rose-600',
    bgColor: 'bg-rose-50',
    borderColor: 'border-rose-200',
  },
  recientes: {
    icon: <Sparkles size={20} />,
    color: 'text-emerald-600',
    bgColor: 'bg-emerald-50',
    borderColor: 'border-emerald-200',
  },
  // Compras medias (45-90 días)
  alto_potencial: {
    icon: <Crown size={20} />,
    color: 'text-violet-600',
    bgColor: 'bg-violet-50',
    borderColor: 'border-violet-200',
  },
  necesitan_incentivo: {
    icon: <Gift size={20} />,
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
  },
  // Compras antiguas (90-180 días)
  no_pueden_perder: {
    icon: <Flame size={20} />,
    color: 'text-orange-600',
    bgColor: 'bg-orange-50',
    borderColor: 'border-orange-200',
  },
  en_riesgo: {
    icon: <AlertTriangle size={20} />,
    color: 'text-yellow-600',
    bgColor: 'bg-yellow-50',
    borderColor: 'border-yellow-200',
  },
  // Muy antiguas (180-365 días)
  por_perder: {
    icon: <TrendingDown size={20} />,
    color: 'text-red-500',
    bgColor: 'bg-red-50',
    borderColor: 'border-red-200',
  },
  // Perdidos (> 365 días)
  perdidos: {
    icon: <UserX size={20} />,
    color: 'text-red-700',
    bgColor: 'bg-red-100',
    borderColor: 'border-red-300',
  },
  // Sin compras
  sin_compras: {
    icon: <UserMinus size={20} />,
    color: 'text-neutral-500',
    bgColor: 'bg-neutral-50',
    borderColor: 'border-neutral-200',
  },
};

const getSegmentConfig = (segment: string) => {
  return SEGMENT_CONFIG[segment] || {
    icon: <Users size={20} />,
    color: 'text-neutral-600',
    bgColor: 'bg-neutral-50',
    borderColor: 'border-neutral-200',
  };
};

function formatCurrency(amount: number | null): string {
  if (amount === null || amount === undefined) return '-';
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('es-AR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

// Componente de tarjeta de segmento
function SegmentCard({
  segment,
  definition,
  count,
  isSelected,
  onClick,
}: {
  segment: string;
  definition: SegmentDefinition;
  count: number;
  isSelected: boolean;
  onClick: () => void;
}) {
  const config = getSegmentConfig(segment);

  return (
    <button
      onClick={onClick}
      className={clsx(
        'p-4 rounded-xl border-2 transition-all duration-200 text-left w-full',
        'hover:shadow-md hover:scale-[1.02]',
        isSelected
          ? `${config.bgColor} ${config.borderColor} shadow-md`
          : 'bg-white border-neutral-200 hover:border-neutral-300'
      )}
    >
      <div className="flex items-center gap-3 mb-2">
        <div className={clsx('p-2 rounded-lg', config.bgColor, config.color)}>
          {config.icon}
        </div>
        <div>
          <h3 className="font-semibold text-neutral-900">{definition.label}</h3>
          <p className="text-xs text-neutral-500">{definition.description}</p>
        </div>
      </div>
      <div className={clsx('text-2xl font-bold', config.color)}>
        {count.toLocaleString('es-AR')}
      </div>
    </button>
  );
}

// Componente de fila de cliente
function CustomerRow({ customer }: { customer: Customer }) {
  const segmentConfig = getSegmentConfig(customer.segment || '');
  const days = daysSince(customer.last_order_at);

  return (
    <tr className="hover:bg-neutral-50 transition-colors">
      <td className="px-4 py-3">
        <div>
          <div className="font-medium text-neutral-900">
            {customer.name || 'Sin nombre'}
          </div>
          <div className="text-sm text-neutral-500">{customer.email || '-'}</div>
        </div>
      </td>
      <td className="px-4 py-3">
        <span className="text-sm text-neutral-600">{customer.phone || '-'}</span>
      </td>
      <td className="px-4 py-3 text-center">
        <span className="font-semibold text-neutral-900">{customer.orders_count}</span>
      </td>
      <td className="px-4 py-3 text-right">
        <span className="font-medium text-neutral-900">
          {formatCurrency(customer.total_spent)}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="text-sm">
          <div className="text-neutral-600">{formatDate(customer.last_order_at)}</div>
          {days !== null && (
            <div className="text-xs text-neutral-400">hace {days} días</div>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        {customer.segment && (
          <span
            className={clsx(
              'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
              segmentConfig.bgColor,
              segmentConfig.color
            )}
          >
            {segmentConfig.icon}
            {SEGMENT_CONFIG[customer.segment]
              ? customer.segment.replace('_', ' ')
              : customer.segment}
          </span>
        )}
      </td>
    </tr>
  );
}

export default function Customers() {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<CustomerSyncStatus | null>(null);
  const [segments, setSegments] = useState<{
    counts: Record<string, number>;
    definitions: SegmentDefinition[];
  } | null>(null);
  const [metrics, setMetrics] = useState<CustomerMetrics | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [totalCustomers, setTotalCustomers] = useState(0);
  const [page, setPage] = useState(1);
  const [selectedSegment, setSelectedSegment] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  const loadData = useCallback(async () => {
    try {
      const [statusData, segmentsData, metricsData] = await Promise.all([
        fetchCustomerSyncStatus(),
        fetchCustomerSegments(),
        fetchCustomerMetrics(),
      ]);
      setSyncStatus(statusData);
      setSegments(segmentsData);
      setMetrics(metricsData);
    } catch (error) {
      console.error('Error loading data:', error);
    }
  }, []);

  const loadCustomers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchCustomers(page, 25, selectedSegment || undefined, search || undefined);
      setCustomers(data.customers);
      setTotalCustomers(data.total);
    } catch (error) {
      console.error('Error loading customers:', error);
    } finally {
      setLoading(false);
    }
  }, [page, selectedSegment, search]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    loadCustomers();
  }, [loadCustomers]);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      // 1. Sync clientes desde TN
      await startCustomerFullSync();
      // 2. Sync orders_count (obtiene compras reales) - esto toma tiempo
      await syncCustomerOrdersCount();
      // 3. Recalcular segmentos
      await recalculateCustomerSegments();
      await loadData();
      await loadCustomers();
    } catch (error) {
      console.error('Error syncing:', error);
    } finally {
      setSyncing(false);
    }
  };

  const handleRecalculate = async () => {
    setSyncing(true);
    try {
      await recalculateCustomerMetrics();
      await recalculateCustomerSegments();
      await loadData();
      await loadCustomers();
    } catch (error) {
      console.error('Error recalculating:', error);
    } finally {
      setSyncing(false);
    }
  };

  const handleSegmentClick = (segment: string) => {
    if (selectedSegment === segment) {
      setSelectedSegment(null);
    } else {
      setSelectedSegment(segment);
    }
    setPage(1);
  };

  const totalPages = Math.ceil(totalCustomers / 25);

  return (
    <div className="min-h-screen">
      <Header
        title="Clientes"
        subtitle="Segmentación y análisis RFM"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={handleRecalculate}
              disabled={syncing}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded-lg transition-colors"
            >
              <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
              Recalcular
            </button>
            <button
              onClick={handleSync}
              disabled={syncing}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-neutral-900 hover:bg-neutral-800 rounded-lg transition-colors disabled:opacity-50"
            >
              <Download size={16} />
              {syncing ? 'Sincronizando...' : 'Sync desde TN'}
            </button>
          </div>
        }
      />

      <div className="p-6 space-y-6">
        {/* Métricas globales */}
        {metrics && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl border border-neutral-200 p-4">
              <div className="flex items-center gap-2 text-neutral-500 mb-1">
                <Users size={16} />
                <span className="text-sm">Total Clientes</span>
              </div>
              <div className="text-2xl font-bold text-neutral-900">
                {metrics.total_customers?.toLocaleString('es-AR') || 0}
              </div>
            </div>
            <div className="bg-white rounded-xl border border-neutral-200 p-4">
              <div className="flex items-center gap-2 text-neutral-500 mb-1">
                <ShoppingBag size={16} />
                <span className="text-sm">Prom. Compras</span>
              </div>
              <div className="text-2xl font-bold text-neutral-900">
                {Number(metrics.avg_orders_per_customer || 0).toFixed(1)}
              </div>
            </div>
            <div className="bg-white rounded-xl border border-neutral-200 p-4">
              <div className="flex items-center gap-2 text-neutral-500 mb-1">
                <DollarSign size={16} />
                <span className="text-sm">Ticket Promedio</span>
              </div>
              <div className="text-2xl font-bold text-neutral-900">
                {formatCurrency(metrics.avg_total_spent || 0)}
              </div>
            </div>
            <div className="bg-white rounded-xl border border-neutral-200 p-4">
              <div className="flex items-center gap-2 text-neutral-500 mb-1">
                <Calendar size={16} />
                <span className="text-sm">Días sin comprar</span>
              </div>
              <div className="text-2xl font-bold text-neutral-900">
                {Math.round(metrics.avg_days_since_last_order || 0)}
              </div>
            </div>
          </div>
        )}

        {/* Estado del sync */}
        {syncStatus && (
          <div className="bg-neutral-50 rounded-xl border border-neutral-200 p-4 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 text-sm text-neutral-600">
                <Clock size={16} />
                <span>
                  Último sync:{' '}
                  {syncStatus.lastSync
                    ? new Date(syncStatus.lastSync).toLocaleString('es-AR')
                    : 'Nunca'}
                </span>
              </div>
              <div className="h-4 w-px bg-neutral-300" />
              <div className="text-sm text-neutral-600">
                <span className="font-medium">{syncStatus.synced}</span> sincronizados
              </div>
              <div className="h-4 w-px bg-neutral-300" />
              <div className="text-sm text-neutral-600">
                <span className="font-medium">{syncStatus.segmented}</span> segmentados
              </div>
            </div>
          </div>
        )}

        {/* Grid de segmentos */}
        {segments && (
          <div>
            <h2 className="text-lg font-semibold text-neutral-900 mb-4">Segmentos</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
              {segments.definitions.map((def) => (
                <SegmentCard
                  key={def.segment}
                  segment={def.segment}
                  definition={def}
                  count={segments.counts[def.segment] || 0}
                  isSelected={selectedSegment === def.segment}
                  onClick={() => handleSegmentClick(def.segment)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Tabla de clientes */}
        <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
          <div className="p-4 border-b border-neutral-200 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-neutral-900">
              {selectedSegment
                ? `Clientes: ${selectedSegment.replace('_', ' ')}`
                : 'Todos los clientes'}
              <span className="ml-2 text-sm font-normal text-neutral-500">
                ({totalCustomers.toLocaleString('es-AR')})
              </span>
            </h2>
            <div className="flex items-center gap-3">
              {selectedSegment && (
                <button
                  onClick={() => setSelectedSegment(null)}
                  className="text-sm text-neutral-500 hover:text-neutral-700"
                >
                  Limpiar filtro
                </button>
              )}
              <div className="relative">
                <Search
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
                />
                <input
                  type="text"
                  placeholder="Buscar cliente..."
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="pl-9 pr-4 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent w-64"
                />
              </div>
            </div>
          </div>

          {loading ? (
            <div className="p-12 text-center">
              <RefreshCw size={32} className="mx-auto animate-spin text-neutral-400" />
            </div>
          ) : customers.length === 0 ? (
            <div className="p-12 text-center text-neutral-500">
              No se encontraron clientes
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-neutral-50 border-b border-neutral-200">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                        Cliente
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                        Teléfono
                      </th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                        Compras
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                        Total Gastado
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                        Última Compra
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                        Segmento
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {customers.map((customer) => (
                      <CustomerRow key={customer.id} customer={customer} />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Paginación */}
              {totalPages > 1 && (
                <div className="px-4 py-3 border-t border-neutral-200 flex items-center justify-between">
                  <div className="text-sm text-neutral-500">
                    Página {page} de {totalPages}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="p-2 rounded-lg hover:bg-neutral-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft size={20} />
                    </button>
                    <button
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={page === totalPages}
                      className="p-2 rounded-lg hover:bg-neutral-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ChevronRight size={20} />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
