import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, ShoppingCart, RefreshCw, Calendar } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../components/ui/Table';
import { fetchBoxOrders, fetchDailySummary, type LocalBoxOrder, type DailySummary } from '../../services/local-api';
import { AccessDenied } from '../../components/AccessDenied';

const PAYMENT_CONFIG: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' }> = {
  pendiente_pago: { label: 'Pendiente', variant: 'warning' },
  pagado_parcial: { label: 'Parcial', variant: 'info' },
  pagado_total: { label: 'Pagado', variant: 'success' },
};

const STATUS_CONFIG: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'cyan' | 'orange' }> = {
  borrador: { label: 'Borrador', variant: 'default' },
  impreso: { label: 'Impreso', variant: 'cyan' },
  pendiente_pago: { label: 'Pend. Pago', variant: 'warning' },
  pagado_parcial: { label: 'Parcial', variant: 'info' },
  pagado_total: { label: 'Pagado', variant: 'success' },
  cancelado: { label: 'Cancelado', variant: 'danger' },
};

export default function LocalCaja() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();

  const [orders, setOrders] = useState<LocalBoxOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ total: 0, totalPages: 1 });

  // Caja diaria
  const [showDaily, setShowDaily] = useState(false);
  const [dailyDate, setDailyDate] = useState(new Date().toISOString().split('T')[0]);
  const [dailySummary, setDailySummary] = useState<DailySummary | null>(null);
  const [_dailyOrders, setDailyOrders] = useState<LocalBoxOrder[]>([]);
  const [dailyLoading, setDailyLoading] = useState(false);

  if (!hasPermission('local.box.view')) return <AccessDenied />;

  const loadOrders = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchBoxOrders({ search: search || undefined, page });
      setOrders(data.orders);
      setPagination({ total: data.pagination.total, totalPages: data.pagination.totalPages });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar');
    } finally {
      setLoading(false);
    }
  };

  const loadDaily = async () => {
    setDailyLoading(true);
    try {
      const data = await fetchDailySummary(dailyDate);
      setDailySummary(data.summary);
      setDailyOrders(data.orders);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setDailyLoading(false);
    }
  };

  useEffect(() => { loadOrders(); }, [page]);
  useEffect(() => { if (showDaily) loadDaily(); }, [showDaily, dailyDate]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-neutral-900">Caja Local</h1>
          <p className="text-sm text-neutral-500 mt-0.5">Ventas del local con stock asignado</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant={showDaily ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setShowDaily(!showDaily)}
          >
            <Calendar size={14} /> Caja Diaria
          </Button>
          {hasPermission('local.box.create') && (
            <Button onClick={() => navigate('/local/caja/nueva')} size="sm">
              <Plus size={16} /> Nuevo Pedido
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-xl text-sm">{error}</div>
      )}

      {/* Caja diaria */}
      {showDaily && (
        <Card>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-neutral-900">Caja Diaria</h3>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={dailyDate}
                  onChange={(e) => setDailyDate(e.target.value)}
                  className="border border-neutral-300 rounded-lg px-3 py-1.5 text-sm"
                />
                <Button variant="ghost" size="sm" onClick={loadDaily}>
                  <RefreshCw size={14} />
                </Button>
              </div>
            </div>

            {dailyLoading ? (
              <div className="text-center py-4">
                <div className="w-4 h-4 border-2 border-sky-500 border-t-transparent rounded-full animate-spin mx-auto" />
              </div>
            ) : dailySummary && (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-sky-50 rounded-xl p-3">
                    <div className="text-xs text-sky-600 font-medium">Pedidos del día</div>
                    <div className="text-2xl font-bold text-sky-800 mt-1">{dailySummary.total_orders}</div>
                  </div>
                  <div className="bg-emerald-50 rounded-xl p-3">
                    <div className="text-xs text-emerald-600 font-medium">Total vendido</div>
                    <div className="text-2xl font-bold text-emerald-800 mt-1 font-mono">
                      ${Number(dailySummary.total_sold).toLocaleString('es-AR')}
                    </div>
                  </div>
                  <div className="bg-violet-50 rounded-xl p-3">
                    <div className="text-xs text-violet-600 font-medium">Total cobrado</div>
                    <div className="text-2xl font-bold text-violet-800 mt-1 font-mono">
                      ${Number(dailySummary.total_collected).toLocaleString('es-AR')}
                    </div>
                  </div>
                  <div className={`rounded-xl p-3 ${Number(dailySummary.pending_amount) > 0 ? 'bg-amber-50' : 'bg-neutral-50'}`}>
                    <div className={`text-xs font-medium ${Number(dailySummary.pending_amount) > 0 ? 'text-amber-600' : 'text-neutral-500'}`}>Pendiente</div>
                    <div className={`text-2xl font-bold mt-1 font-mono ${Number(dailySummary.pending_amount) > 0 ? 'text-amber-800' : 'text-neutral-600'}`}>
                      ${Number(dailySummary.pending_amount).toLocaleString('es-AR')}
                    </div>
                  </div>
                </div>

                <div className="text-xs text-neutral-500 flex gap-4">
                  <span>Pagados: {dailySummary.paid_orders}</span>
                  <span>Pendientes: {dailySummary.pending_orders}</span>
                  <span>Parciales: {dailySummary.partial_orders}</span>
                </div>
              </>
            )}
          </div>
        </Card>
      )}

      {/* Buscador */}
      <div className="flex gap-2">
        <div className="flex-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); loadOrders(); } }}
            placeholder="Buscar por número o notas..."
            leftIcon={<Search size={16} />}
          />
        </div>
        <Button variant="secondary" size="sm" onClick={() => { setPage(1); loadOrders(); }}>
          Buscar
        </Button>
        <Button variant="ghost" size="sm" onClick={loadOrders}>
          <RefreshCw size={14} />
        </Button>
      </div>

      {/* Tabla */}
      <Card padding="none">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Pago</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Pagado</TableHead>
              <TableHead>Items</TableHead>
              <TableHead>Fecha</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <tr>
                <td colSpan={8} className="text-center py-8 px-4">
                  <div className="flex items-center justify-center gap-2 text-neutral-500">
                    <div className="w-4 h-4 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                    Cargando...
                  </div>
                </td>
              </tr>
            ) : orders.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center py-8 px-4 text-neutral-500">
                  <ShoppingCart size={24} className="mx-auto mb-2 text-neutral-300" />
                  No hay pedidos de caja
                </td>
              </tr>
            ) : (
              orders.map((order) => {
                const statusCfg = STATUS_CONFIG[order.status] || { label: order.status, variant: 'default' as const };
                const payCfg = PAYMENT_CONFIG[order.payment_status] || { label: order.payment_status, variant: 'default' as const };
                return (
                  <TableRow key={order.id} isClickable onClick={() => navigate(`/local/caja/${order.id}`)}>
                    <TableCell>
                      <span className="font-mono font-bold text-sky-700">#{order.local_box_order_number}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusCfg.variant} size="sm">{statusCfg.label}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={payCfg.variant} size="sm">{payCfg.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="font-mono font-semibold">${Number(order.total_amount).toLocaleString('es-AR')}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="font-mono text-neutral-600">${Number(order.paid_amount).toLocaleString('es-AR')}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{order.items_count} items</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{new Date(order.created_at).toLocaleDateString('es-AR')}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); navigate(`/local/caja/${order.id}`); }}>
                        Ver
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-neutral-500">
            {pagination.total} pedidos — página {page} de {pagination.totalPages}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</Button>
            <Button variant="secondary" size="sm" disabled={page >= pagination.totalPages} onClick={() => setPage(page + 1)}>Siguiente</Button>
          </div>
        </div>
      )}
    </div>
  );
}
