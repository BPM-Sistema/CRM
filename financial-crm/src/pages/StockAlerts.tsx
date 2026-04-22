import { useEffect, useMemo, useState } from 'react';
import { Bell, RefreshCw, Search, XCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { authFetch } from '../services/api';
import { AccessDenied } from '../components/AccessDenied';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

interface StockAlert {
  id: number;
  product_id: string;
  variant_id: string | null;
  product_name: string | null;
  variant_name: string | null;
  phone: string;
  source: string;
  status: 'pending' | 'notified' | 'cancelled';
  created_at: string;
  notified_at: string | null;
  cancelled_at: string | null;
}

interface Stats {
  total: number;
  byStatus: { pending: number; notified: number; cancelled: number };
  topProducts: { product_id: string; product_name: string; count: number }[];
  topVariants: { product_id: string; variant_id: string; product_name: string; variant_name: string; count: number }[];
  byDay: { day: string; count: number }[];
}

type StatusFilter = '' | 'pending' | 'notified' | 'cancelled';

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatDay(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

function statusVariant(s: StockAlert['status']) {
  if (s === 'pending') return 'warning' as const;
  if (s === 'notified') return 'success' as const;
  return 'default' as const;
}

function statusLabel(s: StockAlert['status']) {
  if (s === 'pending') return 'Pendiente';
  if (s === 'notified') return 'Avisado';
  return 'Cancelado';
}

export default function StockAlerts() {
  const { hasPermission } = useAuth();

  const [items, setItems] = useState<StockAlert[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // filtros
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const canManage = hasPermission('stock_alerts.manage');

  if (!hasPermission('stock_alerts.view')) return <AccessDenied />;

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (status) params.set('status', status);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      params.set('limit', '300');

      const [listRes, statsRes] = await Promise.all([
        authFetch(`${API_BASE_URL}/stock-alerts?${params.toString()}`),
        authFetch(`${API_BASE_URL}/stock-alerts/stats`),
      ]);

      if (!listRes.ok) throw new Error(`Error cargando alertas (${listRes.status})`);
      if (!statsRes.ok) throw new Error(`Error cargando stats (${statsRes.status})`);

      const listJson = await listRes.json();
      const statsJson = await statsRes.json();

      setItems(listJson.items || []);
      setStats({
        total: statsJson.total || 0,
        byStatus: statsJson.byStatus || { pending: 0, notified: 0, cancelled: 0 },
        topProducts: statsJson.topProducts || [],
        topVariants: statsJson.topVariants || [],
        byDay: statsJson.byDay || [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [status, from, to]);

  const cancelAlert = async (id: number) => {
    if (!confirm('¿Cancelar esta alerta?')) return;
    try {
      const res = await authFetch(`${API_BASE_URL}/stock-alerts/${id}/cancel`, { method: 'PATCH' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Error al cancelar');
      }
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error');
    }
  };

  const maxDayCount = useMemo(() => {
    if (!stats || stats.byDay.length === 0) return 1;
    return Math.max(...stats.byDay.map((d) => d.count));
  }, [stats]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-neutral-900 flex items-center gap-2">
            <Bell size={20} /> Stock Alerts
          </h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            Clientes que pidieron aviso por WhatsApp cuando vuelva el stock.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={load}>
          <RefreshCw size={14} /> Actualizar
        </Button>
      </div>

      {/* Estadísticas */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card padding="sm">
            <div className="text-xs text-neutral-500 uppercase tracking-wider">Total</div>
            <div className="text-2xl font-bold mt-1">{stats.total}</div>
          </Card>
          <Card padding="sm">
            <div className="text-xs text-neutral-500 uppercase tracking-wider">Pendientes</div>
            <div className="text-2xl font-bold mt-1 text-amber-700">{stats.byStatus.pending}</div>
          </Card>
          <Card padding="sm">
            <div className="text-xs text-neutral-500 uppercase tracking-wider">Avisados</div>
            <div className="text-2xl font-bold mt-1 text-emerald-700">{stats.byStatus.notified}</div>
          </Card>
          <Card padding="sm">
            <div className="text-xs text-neutral-500 uppercase tracking-wider">Cancelados</div>
            <div className="text-2xl font-bold mt-1 text-neutral-500">{stats.byStatus.cancelled}</div>
          </Card>
        </div>
      )}

      {/* Top productos / variantes / por día */}
      {stats && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card padding="md">
            <h3 className="text-sm font-semibold text-neutral-800 mb-3">Top productos pedidos</h3>
            {stats.topProducts.length === 0 ? (
              <p className="text-xs text-neutral-400">Sin datos</p>
            ) : (
              <ul className="space-y-2">
                {stats.topProducts.map((p) => (
                  <li key={p.product_id} className="flex items-center justify-between text-sm gap-2">
                    <span className="truncate text-neutral-700" title={p.product_name}>{p.product_name}</span>
                    <Badge variant="warning" size="sm">{p.count}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card padding="md">
            <h3 className="text-sm font-semibold text-neutral-800 mb-3">Top variantes pedidas</h3>
            {stats.topVariants.length === 0 ? (
              <p className="text-xs text-neutral-400">Sin datos</p>
            ) : (
              <ul className="space-y-2">
                {stats.topVariants.map((v) => (
                  <li key={`${v.product_id}-${v.variant_id}`} className="flex items-center justify-between text-sm gap-2">
                    <span className="truncate text-neutral-700" title={`${v.product_name} — ${v.variant_name}`}>
                      <span className="font-medium">{v.product_name}</span>
                      {v.variant_name && <span className="text-neutral-500"> · {v.variant_name}</span>}
                    </span>
                    <Badge variant="warning" size="sm">{v.count}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card padding="md">
            <h3 className="text-sm font-semibold text-neutral-800 mb-3">Alertas por día (30d)</h3>
            {stats.byDay.length === 0 ? (
              <p className="text-xs text-neutral-400">Sin datos</p>
            ) : (
              <div className="space-y-1.5">
                {stats.byDay.map((d) => (
                  <div key={d.day} className="flex items-center gap-2 text-xs">
                    <span className="w-12 text-neutral-500 tabular-nums">{formatDay(d.day)}</span>
                    <div className="flex-1 h-2 bg-neutral-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-sky-500 rounded-full"
                        style={{ width: `${(d.count / maxDayCount) * 100}%` }}
                      />
                    </div>
                    <span className="w-8 text-right text-neutral-700 font-medium tabular-nums">{d.count}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Filtros */}
      <Card padding="sm">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') load();
              }}
              placeholder="Buscar por producto, variante o teléfono..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-400"
            />
          </div>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            className="px-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-400"
          >
            <option value="">Todos los estados</option>
            <option value="pending">Pendiente</option>
            <option value="notified">Avisado</option>
            <option value="cancelled">Cancelado</option>
          </select>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="px-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-400"
          />
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="px-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-400"
          />
          <Button variant="secondary" size="sm" onClick={load}>Buscar</Button>
        </div>
      </Card>

      {/* Tabla */}
      <Card padding="none">
        {loading ? (
          <div className="p-8 text-center text-sm text-neutral-500">Cargando...</div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-red-600">{error}</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-sm text-neutral-500">No hay alertas</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 border-b border-neutral-200">
                <tr className="text-left">
                  <th className="px-4 py-2.5 font-medium text-neutral-600">Producto</th>
                  <th className="px-4 py-2.5 font-medium text-neutral-600">Variante</th>
                  <th className="px-4 py-2.5 font-medium text-neutral-600">Teléfono</th>
                  <th className="px-4 py-2.5 font-medium text-neutral-600">Fecha</th>
                  <th className="px-4 py-2.5 font-medium text-neutral-600">Estado</th>
                  {canManage && <th className="px-4 py-2.5 font-medium text-neutral-600"></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {items.map((it) => (
                  <tr key={it.id} className="hover:bg-neutral-50">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-neutral-900 truncate max-w-[280px]" title={it.product_name || it.product_id}>
                        {it.product_name || it.product_id}
                      </div>
                      <div className="text-xs text-neutral-400">ID: {it.product_id}</div>
                    </td>
                    <td className="px-4 py-2.5 text-neutral-700">
                      {it.variant_name || <span className="text-neutral-400">—</span>}
                      {it.variant_id && <div className="text-xs text-neutral-400">ID: {it.variant_id}</div>}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-neutral-800">{it.phone}</td>
                    <td className="px-4 py-2.5 text-neutral-600 whitespace-nowrap">{formatDate(it.created_at)}</td>
                    <td className="px-4 py-2.5">
                      <Badge variant={statusVariant(it.status)} size="sm">{statusLabel(it.status)}</Badge>
                    </td>
                    {canManage && (
                      <td className="px-4 py-2.5 text-right">
                        {it.status === 'pending' && (
                          <button
                            onClick={() => cancelAlert(it.id)}
                            className="text-neutral-400 hover:text-red-600 transition-colors"
                            title="Cancelar alerta"
                          >
                            <XCircle size={16} />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
