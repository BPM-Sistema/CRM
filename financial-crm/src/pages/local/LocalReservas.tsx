import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Package, RefreshCw } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../../components/ui/Table';
import { fetchLocalOrders, type LocalOrder } from '../../services/local-api';
import { AccessDenied } from '../../components/AccessDenied';

const STATUS_CONFIG: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'cyan' | 'orange' }> = {
  reservado: { label: 'Reservado', variant: 'info' },
  impreso: { label: 'Impreso', variant: 'cyan' },
  armado: { label: 'Armado', variant: 'purple' },
  enviado: { label: 'Enviado', variant: 'orange' },
  en_control: { label: 'En Control', variant: 'warning' },
  con_diferencias: { label: 'Con Diferencias', variant: 'danger' },
  confirmado_local: { label: 'Confirmado', variant: 'success' },
  cancelado: { label: 'Cancelado', variant: 'default' },
};

const STATUS_TABS = ['all', 'reservado', 'impreso', 'armado', 'enviado', 'en_control', 'con_diferencias', 'confirmado_local'];

export default function LocalReservas() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();

  const [orders, setOrders] = useState<LocalOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ total: 0, totalPages: 1 });

  if (!hasPermission('local.orders.view')) return <AccessDenied />;

  const loadOrders = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchLocalOrders({
        status: activeTab,
        search: search || undefined,
        page,
      });
      setOrders(data.orders);
      setPagination({ total: data.pagination.total, totalPages: data.pagination.totalPages });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadOrders(); }, [activeTab, page]);

  const handleSearch = () => {
    setPage(1);
    loadOrders();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-neutral-900">Reservas</h1>
          <p className="text-sm text-neutral-500 mt-0.5">Pedidos internos depósito — local</p>
        </div>
        {hasPermission('local.orders.create') && (
          <Button onClick={() => navigate('/local/reservas/nueva')} size="sm">
            <Plus size={16} />
            Nueva Reserva
          </Button>
        )}
      </div>

      {/* Tabs de estado */}
      <div className="flex flex-wrap gap-1.5">
        {STATUS_TABS.map((tab) => {
          const config = STATUS_CONFIG[tab];
          return (
            <button
              key={tab}
              onClick={() => { setActiveTab(tab); setPage(1); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === tab
                  ? 'bg-sky-100 text-sky-700 ring-1 ring-sky-200'
                  : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
              }`}
            >
              {tab === 'all' ? 'Todas' : config?.label || tab}
            </button>
          );
        })}
      </div>

      {/* Buscador */}
      <div className="flex gap-2">
        <div className="flex-1">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Buscar por número o notas..."
            leftIcon={<Search size={16} />}
          />
        </div>
        <Button variant="secondary" size="sm" onClick={handleSearch}>
          Buscar
        </Button>
        <Button variant="ghost" size="sm" onClick={loadOrders}>
          <RefreshCw size={14} />
        </Button>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-xl text-sm">{error}</div>
      )}

      {/* Tabla */}
      <Card padding="none">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Items</TableHead>
              <TableHead>Creado por</TableHead>
              <TableHead>Fecha</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <tr>
                <td colSpan={6} className="text-center py-8 px-4">
                  <div className="flex items-center justify-center gap-2 text-neutral-500">
                    <div className="w-4 h-4 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
                    Cargando...
                  </div>
                </td>
              </tr>
            ) : orders.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-8 px-4 text-neutral-500">
                  <Package size={24} className="mx-auto mb-2 text-neutral-300" />
                  No hay reservas
                </td>
              </tr>
            ) : (
              orders.map((order) => {
                const config = STATUS_CONFIG[order.status] || { label: order.status, variant: 'default' as const };
                return (
                  <TableRow
                    key={order.id}
                    isClickable
                    onClick={() => navigate(`/local/reservas/${order.id}`)}
                  >
                    <TableCell>
                      <span className="font-mono font-bold text-sky-700">#{order.local_order_number}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={config.variant} size="sm">{config.label}</Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{order.items_count} items</span>
                      <span className="text-xs text-neutral-400 ml-1">({order.total_qty} uds)</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{order.created_by_name}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">{new Date(order.created_at).toLocaleDateString('es-AR')}</span>
                      <span className="text-xs text-neutral-400 ml-1">
                        {new Date(order.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); navigate(`/local/reservas/${order.id}`); }}>
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

      {/* Paginación */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-neutral-500">
            {pagination.total} reservas — página {page} de {pagination.totalPages}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Anterior
            </Button>
            <Button variant="secondary" size="sm" disabled={page >= pagination.totalPages} onClick={() => setPage(page + 1)}>
              Siguiente
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
