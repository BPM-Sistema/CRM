import { Fragment, useEffect, useMemo, useState } from 'react';
import { Bell, Activity, ChevronDown, ChevronRight, MessageSquare, RefreshCw, Save, Search, XCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { authFetch } from '../services/api';
import { AccessDenied } from '../components/AccessDenied';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

type StatusFilter = '' | 'pending' | 'notified' | 'cancelled';
type Tab = 'all' | 'customer' | 'product';

interface Stats {
  total: number;
  uniqueCustomers: number;
  wantsNews: number;
  byStatus: { pending: number; notified: number; cancelled: number };
  topProducts: { product_id: string; product_name: string; count: number }[];
  byDay: { day: string; count: number }[];
}

interface FlatItem {
  id: number;
  product_id: string;
  variant_id: string | null;
  product_name: string | null;
  variant_name: string | null;
  phone: string;
  first_name: string | null;
  wants_news: boolean;
  source: string;
  status: 'pending' | 'notified' | 'cancelled';
  created_at: string;
  notified_at: string | null;
  cancelled_at: string | null;
}

interface CustomerGroup {
  phone: string;
  first_name: string | null;
  request_count: number;
  distinct_products: number;
  last_created_at: string;
  first_created_at: string;
  wants_news: boolean;
  alerts: {
    id: number;
    product_id: string;
    product_name: string | null;
    variant_id: string | null;
    variant_name: string | null;
    created_at: string;
    status: string;
  }[];
}

interface ProductGroup {
  product_id: string;
  variant_id: string | null;
  product_name: string;
  variant_name: string;
  people_count: number;
  total_alerts: number;
  wants_news_count: number;
  first_created_at: string;
  last_created_at: string;
}

interface Facets {
  products: { product_id: string; product_name: string; count: number }[];
  variants: { product_id: string; variant_id: string; product_name: string; variant_name: string; count: number }[];
}

function formatDate(iso: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function formatDay(iso: string) {
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
}

function statusVariant(s: FlatItem['status']) {
  if (s === 'pending') return 'warning' as const;
  if (s === 'notified') return 'success' as const;
  return 'default' as const;
}
function statusLabel(s: FlatItem['status']) {
  if (s === 'pending') return 'Pendiente';
  if (s === 'notified') return 'Avisado';
  return 'Cancelado';
}

export default function StockAlerts() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('stock_alerts.manage');
  if (!hasPermission('stock_alerts.view')) return <AccessDenied />;

  const [tab, setTab] = useState<Tab>('all');
  const [stats, setStats] = useState<Stats | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [flatItems, setFlatItems] = useState<FlatItem[]>([]);
  const [customers, setCustomers] = useState<CustomerGroup[]>([]);
  const [products, setProducts] = useState<ProductGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPhone, setExpandedPhone] = useState<string | null>(null);

  // Última corrida del dispatcher
  const [lastRun, setLastRun] = useState<null | {
    id: number; started_at: string; finished_at: string | null;
    trigger_source: string | null; dry_run: boolean;
    pairs_checked: number; fetched: number; fetch_errors: number;
    dispatched_products: number; alerts_sent: number; alerts_send_errors: number;
    skipped_no_template: boolean; updated_state: number; error_message: string | null;
  }>(null);

  // Configuración de plantillas
  const [stockAlertTemplate, setStockAlertTemplate] = useState('');
  const [novedadesTemplate, setNovedadesTemplate] = useState('');
  const [availableTemplates, setAvailableTemplates] = useState<string[]>([]);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configMsg, setConfigMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Filtros
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [productId, setProductId] = useState('');
  const [variantId, setVariantId] = useState('');
  const [wantsNews, setWantsNews] = useState(false);
  const [minRequests, setMinRequests] = useState('1');

  const qp = useMemo(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (status) p.set('status', status);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (productId) p.set('product_id', productId);
    if (variantId) p.set('variant_id', variantId);
    if (wantsNews) p.set('wants_news', 'true');
    const n = parseInt(minRequests, 10);
    if (Number.isInteger(n) && n > 1) p.set('min_requests', String(n));
    p.set('limit', '300');
    return p.toString();
  }, [q, status, from, to, productId, variantId, wantsNews, minRequests]);

  const loadConfig = async () => {
    try {
      const res = await authFetch(`${API_BASE_URL}/stock-alerts/config`);
      if (!res.ok) return;
      const j = await res.json();
      setStockAlertTemplate(j.stockAlertTemplate || '');
      setNovedadesTemplate(j.novedadesTemplate || '');
      setAvailableTemplates(j.availableTemplates || []);
    } catch (e) { /* silent */ }
  };

  const loadLastRun = async () => {
    try {
      const res = await authFetch(`${API_BASE_URL}/stock-alerts/last-run`);
      if (!res.ok) return;
      const j = await res.json();
      setLastRun(j.run || null);
    } catch (e) { /* silent */ }
  };

  const saveConfig = async () => {
    setSavingConfig(true);
    setConfigMsg(null);
    try {
      const res = await authFetch(`${API_BASE_URL}/stock-alerts/config`, {
        method: 'PUT',
        body: JSON.stringify({ stockAlertTemplate, novedadesTemplate }),
      });
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || 'Error al guardar');
      setConfigMsg({ kind: 'ok', text: 'Guardado' });
      setTimeout(() => setConfigMsg(null), 3000);
      loadConfig();
    } catch (err) {
      setConfigMsg({ kind: 'err', text: err instanceof Error ? err.message : 'Error' });
    } finally {
      setSavingConfig(false);
    }
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const urls = [
        `${API_BASE_URL}/stock-alerts/stats`,
        `${API_BASE_URL}/stock-alerts/facets`,
        tab === 'all' ? `${API_BASE_URL}/stock-alerts?${qp}` : null,
        tab === 'customer' ? `${API_BASE_URL}/stock-alerts/by-customer?${qp}` : null,
        tab === 'product' ? `${API_BASE_URL}/stock-alerts/by-product?${qp}` : null,
      ].filter(Boolean) as string[];

      const results = await Promise.all(urls.map((u) => authFetch(u)));
      for (const r of results) {
        if (!r.ok) throw new Error(`HTTP ${r.status} — ${r.url}`);
      }
      const [statsJson, facetsJson, tabJson] = await Promise.all(results.map((r) => r.json()));

      setStats({
        total: statsJson.total || 0,
        uniqueCustomers: statsJson.uniqueCustomers || 0,
        wantsNews: statsJson.wantsNews || 0,
        byStatus: statsJson.byStatus || { pending: 0, notified: 0, cancelled: 0 },
        topProducts: statsJson.topProducts || [],
        byDay: statsJson.byDay || [],
      });
      setFacets({
        products: facetsJson.products || [],
        variants: facetsJson.variants || [],
      });

      if (tab === 'all') setFlatItems(tabJson.items || []);
      if (tab === 'customer') setCustomers(tabJson.items || []);
      if (tab === 'product') setProducts(tabJson.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, status, from, to, productId, variantId, wantsNews, minRequests]);

  useEffect(() => {
    loadConfig();
    loadLastRun();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Variantes del producto seleccionado (si hay)
  const filteredVariants = useMemo(() => {
    if (!facets) return [];
    if (!productId) return facets.variants;
    return facets.variants.filter((v) => v.product_id === productId);
  }, [facets, productId]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-neutral-900 flex items-center gap-2">
            <Bell size={20} /> Stock Alerts
          </h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            Clientes que pidieron aviso cuando reingrese un producto.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={load}>
          <RefreshCw size={14} /> Actualizar
        </Button>
      </div>

      {/* KPIs */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
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
          <Card padding="sm">
            <div className="text-xs text-neutral-500 uppercase tracking-wider">Clientes únicos</div>
            <div className="text-2xl font-bold mt-1">{stats.uniqueCustomers}</div>
          </Card>
          <Card padding="sm">
            <div className="text-xs text-neutral-500 uppercase tracking-wider">Quieren novedades</div>
            <div className="text-2xl font-bold mt-1 text-blue-700">{stats.wantsNews}</div>
          </Card>
        </div>
      )}

      {/* Top productos + serie diaria */}
      {stats && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card padding="md">
            <h3 className="text-sm font-semibold text-neutral-800 mb-3">Top productos pedidos (personas únicas)</h3>
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
            <h3 className="text-sm font-semibold text-neutral-800 mb-3">Alertas por día (30d)</h3>
            {stats.byDay.length === 0 ? (
              <p className="text-xs text-neutral-400">Sin datos</p>
            ) : (
              <div className="space-y-1.5">
                {stats.byDay.map((d) => (
                  <div key={d.day} className="flex items-center gap-2 text-xs">
                    <span className="w-12 text-neutral-500 tabular-nums">{formatDay(d.day)}</span>
                    <div className="flex-1 h-2 bg-neutral-100 rounded-full overflow-hidden">
                      <div className="h-full bg-sky-500 rounded-full" style={{ width: `${(d.count / maxDayCount) * 100}%` }} />
                    </div>
                    <span className="w-8 text-right text-neutral-700 font-medium tabular-nums">{d.count}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Última corrida del dispatcher */}
      <Card padding="md">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Activity size={16} className="text-neutral-600" />
            <h3 className="text-sm font-semibold text-neutral-800">Última corrida del dispatcher</h3>
          </div>
          <Button variant="ghost" size="sm" onClick={loadLastRun}>
            <RefreshCw size={14} />
          </Button>
        </div>
        {!lastRun ? (
          <p className="text-xs text-neutral-500">Aún no se ejecutó ninguna corrida. El scheduler automático está pausado hasta configurar la plantilla HSM en Botmaker.</p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
            <div>
              <div className="text-neutral-500">Cuándo</div>
              <div className="font-medium mt-0.5">{formatDate(lastRun.started_at)}</div>
              <div className="text-neutral-400 text-[11px]">
                {lastRun.trigger_source || '—'}{lastRun.dry_run ? ' · DRY RUN' : ''}
              </div>
            </div>
            <div>
              <div className="text-neutral-500">Pares revisados</div>
              <div className="font-medium mt-0.5 tabular-nums">{lastRun.pairs_checked}</div>
              <div className="text-neutral-400 text-[11px]">{lastRun.fetched} fetched · {lastRun.fetch_errors} errs</div>
            </div>
            <div>
              <div className="text-neutral-500">Reingresos detectados</div>
              <div className="font-medium mt-0.5 tabular-nums">{lastRun.dispatched_products}</div>
            </div>
            <div>
              <div className="text-neutral-500">WhatsApps encolados</div>
              <div className="font-medium mt-0.5 tabular-nums text-emerald-700">{lastRun.alerts_sent}</div>
              {lastRun.alerts_send_errors > 0 && (
                <div className="text-red-600 text-[11px]">{lastRun.alerts_send_errors} errores</div>
              )}
            </div>
            <div>
              <div className="text-neutral-500">Plantilla</div>
              <div className={`font-medium mt-0.5 ${lastRun.skipped_no_template ? 'text-amber-700' : 'text-emerald-700'}`}>
                {lastRun.skipped_no_template ? 'Sin configurar' : 'OK'}
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Configuración de plantillas HSM */}
      {canManage && (
        <Card padding="md">
          <div className="flex items-center gap-2 mb-3">
            <MessageSquare size={16} className="text-neutral-600" />
            <h3 className="text-sm font-semibold text-neutral-800">Configuración de plantillas WhatsApp</h3>
          </div>
          <p className="text-xs text-neutral-500 mb-3">
            Escribí el nombre HSM exacto tal como está en Botmaker. Si lo dejás vacío, el disparo automático no envía.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-neutral-600 block mb-1">Plantilla Stock Alerts (reingreso)</label>
              <input
                type="text"
                list="bpm-sa-available-templates"
                value={stockAlertTemplate}
                onChange={(e) => setStockAlertTemplate(e.target.value)}
                placeholder="ej: stock_alert_reingreso_v1"
                className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-400 font-mono"
              />
            </div>
            <div>
              <label className="text-xs text-neutral-600 block mb-1">Plantilla Novedades (solo config)</label>
              <input
                type="text"
                list="bpm-sa-available-templates"
                value={novedadesTemplate}
                onChange={(e) => setNovedadesTemplate(e.target.value)}
                placeholder="ej: novedades_ingresos_v1"
                className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-400 font-mono"
              />
            </div>
          </div>
          <datalist id="bpm-sa-available-templates">
            {availableTemplates.map((t) => <option key={t} value={t} />)}
          </datalist>
          <div className="flex items-center gap-3 mt-3">
            <Button variant="primary" size="sm" onClick={saveConfig} isLoading={savingConfig}>
              <Save size={14} /> Guardar
            </Button>
            {configMsg && (
              <span className={configMsg.kind === 'ok' ? 'text-xs text-emerald-700' : 'text-xs text-red-600'}>
                {configMsg.text}
              </span>
            )}
          </div>
          <div className="mt-3 text-xs text-neutral-500 leading-relaxed border-t border-neutral-100 pt-3">
            <strong className="text-neutral-700">Variables stock alerts</strong> — 1: nombre · 2: producto · 3: variante (opcional) · 4: link producto
          </div>
        </Card>
      )}

      {/* Tabs */}
      <div className="inline-flex gap-1 bg-white border border-neutral-200 rounded-xl p-1">
        {[
          { k: 'all' as const, label: 'Todas' },
          { k: 'customer' as const, label: 'Por cliente' },
          { k: 'product' as const, label: 'Por producto / variante' },
        ].map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === t.k ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filtros */}
      <Card padding="sm">
        <div className="flex flex-col lg:flex-row gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') load(); }}
              placeholder="Buscar producto, variante, teléfono o nombre..."
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

          <select
            value={productId}
            onChange={(e) => { setProductId(e.target.value); setVariantId(''); }}
            className="px-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-400 max-w-[260px]"
          >
            <option value="">Todos los productos</option>
            {facets?.products.map((p) => (
              <option key={p.product_id} value={p.product_id}>
                {p.product_name} ({p.count})
              </option>
            ))}
          </select>

          <select
            value={variantId}
            onChange={(e) => setVariantId(e.target.value)}
            className="px-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-400 max-w-[260px]"
          >
            <option value="">Todas las variantes</option>
            {filteredVariants.map((v) => (
              <option key={`${v.product_id}-${v.variant_id}`} value={v.variant_id}>
                {v.variant_name || `#${v.variant_id}`} {productId ? '' : `· ${v.product_name}`} ({v.count})
              </option>
            ))}
          </select>

          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="px-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-400" />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="px-3 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-400" />

          <label className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-neutral-200 rounded-lg cursor-pointer">
            <input type="checkbox" checked={wantsNews} onChange={(e) => setWantsNews(e.target.checked)} />
            Solo quiere novedades
          </label>

          <label className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-neutral-200 rounded-lg">
            Mín. solicitudes
            <input
              type="number" min={1}
              value={minRequests}
              onChange={(e) => setMinRequests(e.target.value)}
              className="w-16 px-2 py-0.5 border border-neutral-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-neutral-400"
            />
          </label>

          <Button variant="secondary" size="sm" onClick={load}>Buscar</Button>
        </div>
      </Card>

      {/* Contenido según tab */}
      {loading ? (
        <Card padding="md"><div className="text-center text-sm text-neutral-500 py-4">Cargando...</div></Card>
      ) : error ? (
        <Card padding="md"><div className="text-center text-sm text-red-600 py-4">{error}</div></Card>
      ) : tab === 'all' ? (
        <FlatTable items={flatItems} canManage={canManage} onCancel={cancelAlert} />
      ) : tab === 'customer' ? (
        <CustomerTable items={customers} expanded={expandedPhone} onToggle={setExpandedPhone} />
      ) : (
        <ProductTable items={products} />
      )}
    </div>
  );
}

/* ============ Subcomponentes ============ */

function FlatTable({ items, canManage, onCancel }: {
  items: FlatItem[]; canManage: boolean; onCancel: (id: number) => void;
}) {
  if (items.length === 0) {
    return <Card padding="md"><div className="text-center text-sm text-neutral-500 py-4">No hay alertas</div></Card>;
  }
  return (
    <Card padding="none">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 border-b border-neutral-200">
            <tr className="text-left">
              <th className="px-4 py-2.5 font-medium text-neutral-600">Nombre</th>
              <th className="px-4 py-2.5 font-medium text-neutral-600">Producto</th>
              <th className="px-4 py-2.5 font-medium text-neutral-600">Variante</th>
              <th className="px-4 py-2.5 font-medium text-neutral-600">Teléfono</th>
              <th className="px-4 py-2.5 font-medium text-neutral-600">Fecha</th>
              <th className="px-4 py-2.5 font-medium text-neutral-600">Novedades</th>
              <th className="px-4 py-2.5 font-medium text-neutral-600">Estado</th>
              {canManage && <th className="px-4 py-2.5 font-medium text-neutral-600"></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {items.map((it) => (
              <tr key={it.id} className="hover:bg-neutral-50">
                <td className="px-4 py-2.5 text-neutral-800">{it.first_name || <span className="text-neutral-400">—</span>}</td>
                <td className="px-4 py-2.5">
                  <div className="font-medium text-neutral-900 truncate max-w-[260px]" title={it.product_name || it.product_id}>
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
                  {it.wants_news ? <Badge variant="info" size="sm">✓ sí</Badge> : <span className="text-neutral-400 text-xs">no</span>}
                </td>
                <td className="px-4 py-2.5">
                  <Badge variant={statusVariant(it.status)} size="sm">{statusLabel(it.status)}</Badge>
                </td>
                {canManage && (
                  <td className="px-4 py-2.5 text-right">
                    {it.status === 'pending' && (
                      <button
                        onClick={() => onCancel(it.id)}
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
    </Card>
  );
}

function CustomerTable({ items, expanded, onToggle }: {
  items: CustomerGroup[]; expanded: string | null; onToggle: (phone: string | null) => void;
}) {
  if (items.length === 0) {
    return <Card padding="md"><div className="text-center text-sm text-neutral-500 py-4">No hay clientes</div></Card>;
  }
  return (
    <Card padding="none">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 border-b border-neutral-200">
            <tr className="text-left">
              <th className="px-4 py-2.5 font-medium text-neutral-600 w-8"></th>
              <th className="px-4 py-2.5 font-medium text-neutral-600">Nombre</th>
              <th className="px-4 py-2.5 font-medium text-neutral-600">Teléfono</th>
              <th className="px-4 py-2.5 font-medium text-neutral-600 text-right"># Solicitudes</th>
              <th className="px-4 py-2.5 font-medium text-neutral-600 text-right">Productos únicos</th>
              <th className="px-4 py-2.5 font-medium text-neutral-600">Última</th>
              <th className="px-4 py-2.5 font-medium text-neutral-600">Novedades</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {items.map((c) => {
              const isOpen = expanded === c.phone;
              return (
                <Fragment key={c.phone}>
                  <tr className="hover:bg-neutral-50 cursor-pointer" onClick={() => onToggle(isOpen ? null : c.phone)}>
                    <td className="px-4 py-2.5 text-neutral-400">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                    <td className="px-4 py-2.5 text-neutral-800">{c.first_name || <span className="text-neutral-400">—</span>}</td>
                    <td className="px-4 py-2.5 font-mono text-neutral-800">{c.phone}</td>
                    <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{c.request_count}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-neutral-700">{c.distinct_products}</td>
                    <td className="px-4 py-2.5 text-neutral-600 whitespace-nowrap">{formatDate(c.last_created_at)}</td>
                    <td className="px-4 py-2.5">
                      {c.wants_news ? <Badge variant="info" size="sm">✓ sí</Badge> : <span className="text-neutral-400 text-xs">no</span>}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-neutral-50/60">
                      <td colSpan={7} className="px-4 py-3">
                        <ul className="text-xs text-neutral-700 space-y-1 pl-6">
                          {c.alerts.map((a) => (
                            <li key={a.id}>
                              <span className="font-medium">{a.product_name || a.product_id}</span>
                              {a.variant_name && <span className="text-neutral-500"> · {a.variant_name}</span>}
                              <span className="text-neutral-400"> · {formatDate(a.created_at)}</span>
                              <span className="text-neutral-400"> · {a.status}</span>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ProductTable({ items }: { items: ProductGroup[] }) {
  if (items.length === 0) {
    return <Card padding="md"><div className="text-center text-sm text-neutral-500 py-4">No hay productos</div></Card>;
  }
  return (
    <Card padding="none">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 border-b border-neutral-200">
            <tr className="text-left">
              <th className="px-4 py-2.5 font-medium text-neutral-600">Producto</th>
              <th className="px-4 py-2.5 font-medium text-neutral-600">Variante</th>
              <th className="px-4 py-2.5 font-medium text-neutral-600 text-right"># Personas</th>
              <th className="px-4 py-2.5 font-medium text-neutral-600 text-right">Quieren novedades</th>
              <th className="px-4 py-2.5 font-medium text-neutral-600">Primera</th>
              <th className="px-4 py-2.5 font-medium text-neutral-600">Última</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {items.map((p) => (
              <tr key={`${p.product_id}-${p.variant_id || 'null'}`} className="hover:bg-neutral-50">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-neutral-900 truncate max-w-[300px]" title={p.product_name}>{p.product_name}</div>
                  <div className="text-xs text-neutral-400">ID: {p.product_id}</div>
                </td>
                <td className="px-4 py-2.5 text-neutral-700">
                  {p.variant_name || <span className="text-neutral-400">—</span>}
                  {p.variant_id && <div className="text-xs text-neutral-400">ID: {p.variant_id}</div>}
                </td>
                <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{p.people_count}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-blue-700">{p.wants_news_count}</td>
                <td className="px-4 py-2.5 text-neutral-600 whitespace-nowrap">{formatDate(p.first_created_at)}</td>
                <td className="px-4 py-2.5 text-neutral-600 whitespace-nowrap">{formatDate(p.last_created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
