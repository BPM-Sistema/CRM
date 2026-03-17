import { useState, useEffect, useCallback } from 'react';
import {
  Users,
  RefreshCw,
  Search,
  Download,
  ChevronLeft,
  ChevronRight,
  ArrowRight,
} from 'lucide-react';
import { Header } from '../components/layout';
import {
  fetchCustomerSyncStatus,
  fetchCustomerSegments,
  fetchCustomers,
  startCustomerFullSync,
  syncCustomerOrdersCount,
  recalculateCustomerSegments,
  Customer,
  CustomerSyncStatus,
} from '../services/api';
import { clsx } from 'clsx';

// Labels y descripciones de segmentos
const SEGMENT_LABELS: Record<string, string> = {
  campeones: 'Campeones',
  leales: 'Leales',
  recientes: 'Recientes',
  alto_potencial: 'Alto potencial',
  necesitan_incentivo: 'Necesitan incentivo',
  no_pueden_perder: 'No se pueden perder',
  en_riesgo: 'En riesgo',
  por_perder: 'Por perder',
  perdidos: 'Perdidos',
  sin_compras: 'Sin compras',
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

// Celda de la matriz
function MatrixCell({
  segment,
  count,
  total,
  colorClass,
  isSelected,
  onClick,
  className = '',
}: {
  segment: string;
  count: number;
  total: number;
  colorClass: string;
  isSelected: boolean;
  onClick: () => void;
  className?: string;
}) {
  const percentage = total > 0 ? ((count / total) * 100).toFixed(2) : '0';

  return (
    <button
      onClick={onClick}
      className={clsx(
        'p-4 rounded-xl border transition-all duration-200 text-left flex flex-col justify-center min-h-[100px]',
        'hover:shadow-lg hover:scale-[1.01]',
        colorClass,
        isSelected && 'ring-2 ring-neutral-900 ring-offset-2',
        className
      )}
    >
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-2xl font-bold">{percentage}%</span>
        <span className="text-sm opacity-70 flex items-center gap-1">
          <Users size={14} />
          {count.toLocaleString('es-AR')}
        </span>
      </div>
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white/60 rounded-full text-xs font-medium w-fit">
        <span className="w-1.5 h-1.5 rounded-full bg-current" />
        {SEGMENT_LABELS[segment]}
      </span>
    </button>
  );
}


// Fila de cliente
function CustomerRow({ customer }: { customer: Customer }) {
  const days = daysSince(customer.last_order_at);

  return (
    <tr className="hover:bg-neutral-50 transition-colors">
      <td className="px-4 py-3">
        <div>
          <div className="font-medium text-neutral-900">{customer.name || 'Sin nombre'}</div>
          <div className="text-sm text-neutral-500">{customer.email || '-'}</div>
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-neutral-600">{customer.phone || '-'}</td>
      <td className="px-4 py-3 text-center font-semibold">{customer.orders_count}</td>
      <td className="px-4 py-3 text-right font-medium">{formatCurrency(customer.total_spent)}</td>
      <td className="px-4 py-3">
        <div className="text-sm text-neutral-600">{formatDate(customer.last_order_at)}</div>
        {days !== null && <div className="text-xs text-neutral-400">hace {days} días</div>}
      </td>
      <td className="px-4 py-3">
        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-neutral-100 text-neutral-700">
          {SEGMENT_LABELS[customer.segment || ''] || customer.segment}
        </span>
      </td>
    </tr>
  );
}

export default function Customers() {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<CustomerSyncStatus | null>(null);
  const [segments, setSegments] = useState<{ counts: Record<string, number> } | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [totalCustomers, setTotalCustomers] = useState(0);
  const [page, setPage] = useState(1);
  const [selectedSegment, setSelectedSegment] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  const loadData = useCallback(async () => {
    try {
      const [statusData, segmentsData] = await Promise.all([
        fetchCustomerSyncStatus(),
        fetchCustomerSegments(),
      ]);
      setSyncStatus(statusData);
      setSegments(segmentsData);
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

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { loadCustomers(); }, [loadCustomers]);
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(searchInput); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await startCustomerFullSync();
      await syncCustomerOrdersCount();
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
    setSelectedSegment(selectedSegment === segment ? null : segment);
    setPage(1);
  };

  const totalPages = Math.ceil(totalCustomers / 25);

  // Total de compradores (excluyendo sin_compras)
  const totalBuyers = segments
    ? Object.entries(segments.counts)
        .filter(([seg]) => seg !== 'sin_compras' && seg !== 'null' && seg !== 'perdidos')
        .reduce((sum, [, count]) => sum + count, 0)
    : 0;

  const getCount = (seg: string) => segments?.counts[seg] || 0;

  return (
    <div className="min-h-screen bg-neutral-50">
      <Header
        title="Clientes"
        subtitle="Ciclo de vida de compradores"
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

      <div className="p-6 space-y-8">
        {/* Título */}
        <div>
          <h2 className="text-xl font-semibold text-neutral-900">Ciclo de vida de compradores</h2>
          <p className="text-sm text-neutral-500 mt-1">
            Segmenta a tus clientes según su frecuencia y cantidad de compras.
          </p>
        </div>

        {/* Matriz de segmentos estilo TN */}
        {segments && (
          <div>
            {/* Grid */}
            <div>
              <div className="grid grid-cols-[1fr_1fr_1fr_1.2fr] gap-3">
                {/* Fila 1: Alta frecuencia */}
                <MatrixCell
                  segment="campeones"
                  count={getCount('campeones')}
                  total={totalBuyers}
                  colorClass="bg-green-100 border-green-200 text-green-800"
                  isSelected={selectedSegment === 'campeones'}
                  onClick={() => handleSegmentClick('campeones')}
                />
                <MatrixCell
                  segment="alto_potencial"
                  count={getCount('alto_potencial')}
                  total={totalBuyers}
                  colorClass="bg-yellow-100 border-yellow-200 text-yellow-800"
                  isSelected={selectedSegment === 'alto_potencial'}
                  onClick={() => handleSegmentClick('alto_potencial')}
                />
                <MatrixCell
                  segment="no_pueden_perder"
                  count={getCount('no_pueden_perder')}
                  total={totalBuyers}
                  colorClass="bg-orange-100 border-orange-200 text-orange-800"
                  isSelected={selectedSegment === 'no_pueden_perder'}
                  onClick={() => handleSegmentClick('no_pueden_perder')}
                />
                <MatrixCell
                  segment="por_perder"
                  count={getCount('por_perder')}
                  total={totalBuyers}
                  colorClass="bg-red-200 border-red-300 text-red-800 row-span-3"
                  isSelected={selectedSegment === 'por_perder'}
                  onClick={() => handleSegmentClick('por_perder')}
                  className="row-span-3"
                />

                {/* Fila 2: Media frecuencia */}
                <MatrixCell
                  segment="leales"
                  count={getCount('leales')}
                  total={totalBuyers}
                  colorClass="bg-green-100 border-green-200 text-green-800"
                  isSelected={selectedSegment === 'leales'}
                  onClick={() => handleSegmentClick('leales')}
                />
                <MatrixCell
                  segment="necesitan_incentivo"
                  count={getCount('necesitan_incentivo')}
                  total={totalBuyers}
                  colorClass="bg-yellow-100 border-yellow-200 text-yellow-800 row-span-2"
                  isSelected={selectedSegment === 'necesitan_incentivo'}
                  onClick={() => handleSegmentClick('necesitan_incentivo')}
                  className="row-span-2"
                />
                <MatrixCell
                  segment="en_riesgo"
                  count={getCount('en_riesgo')}
                  total={totalBuyers}
                  colorClass="bg-orange-100 border-orange-200 text-orange-800 row-span-2"
                  isSelected={selectedSegment === 'en_riesgo'}
                  onClick={() => handleSegmentClick('en_riesgo')}
                  className="row-span-2"
                />

                {/* Fila 3: Baja frecuencia */}
                <MatrixCell
                  segment="recientes"
                  count={getCount('recientes')}
                  total={totalBuyers}
                  colorClass="bg-green-100 border-green-200 text-green-800"
                  isSelected={selectedSegment === 'recientes'}
                  onClick={() => handleSegmentClick('recientes')}
                />
              </div>

              {/* Eje X */}
              <div className="flex justify-between mt-3 text-[10px] text-neutral-400 px-1">
                <span>Compras recientes</span>
                <span className="flex items-center gap-1">Compras antiguas <ArrowRight size={10} /></span>
              </div>
            </div>
          </div>
        )}


        {/* Sin compras */}
        {segments && getCount('sin_compras') > 0 && (
          <div className="bg-neutral-100 rounded-xl border border-neutral-200 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Users size={20} className="text-neutral-400" />
                <div>
                  <span className="font-medium text-neutral-700">Sin compras</span>
                  <span className="text-neutral-500 ml-2">
                    {getCount('sin_compras').toLocaleString('es-AR')} contactos sin compras
                  </span>
                </div>
              </div>
              <button
                onClick={() => handleSegmentClick('sin_compras')}
                className={clsx(
                  "text-sm text-neutral-500 hover:text-neutral-900",
                  selectedSegment === 'sin_compras' && 'font-semibold text-neutral-900'
                )}
              >
                Ver lista →
              </button>
            </div>
          </div>
        )}

        {/* Tabla de clientes */}
        {(selectedSegment || search) && (
          <div className="bg-white rounded-xl border border-neutral-200 overflow-hidden">
            <div className="p-4 border-b border-neutral-200 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-neutral-900">
                {selectedSegment ? SEGMENT_LABELS[selectedSegment] : 'Resultados'}
                <span className="ml-2 text-sm font-normal text-neutral-500">
                  ({totalCustomers.toLocaleString('es-AR')})
                </span>
              </h2>
              <div className="flex items-center gap-3">
                {selectedSegment && (
                  <button onClick={() => setSelectedSegment(null)} className="text-sm text-neutral-500 hover:text-neutral-700">
                    Limpiar
                  </button>
                )}
                <div className="relative">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
                  <input
                    type="text"
                    placeholder="Buscar..."
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    className="pl-9 pr-4 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-900 w-56"
                  />
                </div>
              </div>
            </div>

            {loading ? (
              <div className="p-12 text-center">
                <RefreshCw size={32} className="mx-auto animate-spin text-neutral-400" />
              </div>
            ) : customers.length === 0 ? (
              <div className="p-12 text-center text-neutral-500">No se encontraron clientes</div>
            ) : (
              <>
                <table className="w-full">
                  <thead className="bg-neutral-50 border-b border-neutral-200">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase">Cliente</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase">Teléfono</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-neutral-500 uppercase">Compras</th>
                      <th className="px-4 py-3 text-right text-xs font-semibold text-neutral-500 uppercase">Total</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase">Última</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase">Segmento</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {customers.map((c) => <CustomerRow key={c.id} customer={c} />)}
                  </tbody>
                </table>

                {totalPages > 1 && (
                  <div className="px-4 py-3 border-t border-neutral-200 flex items-center justify-between">
                    <span className="text-sm text-neutral-500">Página {page} de {totalPages}</span>
                    <div className="flex gap-2">
                      <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="p-2 rounded-lg hover:bg-neutral-100 disabled:opacity-50"><ChevronLeft size={20} /></button>
                      <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="p-2 rounded-lg hover:bg-neutral-100 disabled:opacity-50"><ChevronRight size={20} /></button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Sync status */}
        {syncStatus && (
          <div className="text-xs text-neutral-400 text-center">
            Último sync: {syncStatus.lastSync ? new Date(syncStatus.lastSync).toLocaleString('es-AR') : 'Nunca'}
          </div>
        )}
      </div>
    </div>
  );
}
