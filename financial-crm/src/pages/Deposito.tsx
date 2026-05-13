/**
 * Panel del depósito (Fase 2 PR 7a).
 *
 * Muestra:
 *   - 5 métricas según rango de fecha + filtros aplicados.
 *   - Filtros: empleado (multi), transición (multi), fecha (rápidos + custom).
 *   - Tabla de transiciones paginada y ordenable.
 *
 * El listado se ordena descendente por fecha por default.
 * Click en pedido → navega al detalle. Click en empleado → filtra por él.
 */

import { useEffect, useMemo, useState, useCallback, type ReactNode } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { format, parseISO, subDays, startOfDay, endOfDay } from 'date-fns';
import { es } from 'date-fns/locale';
import { Users, AlertTriangle, Bug, AlertOctagon, ChevronDown, ChevronUp, Clock, CheckCircle2, Settings, Save, Check } from 'lucide-react';
import { Header } from '../components/layout';
import { useAuth } from '../contexts/AuthContext';
import {
  fetchTransitions,
  fetchMetrics,
  fetchEmployees,
  fetchStockIssues,
  fetchPedidosDemorados,
  fetchEstadoThresholds,
  updateEstadoThreshold,
  TransitionRow,
  EmployeeRow,
  DepositoFilters,
  DepositoMetrics,
  PedidoDemoradoRow,
  EstadoThresholdRow,
} from '../services/deposito-api';

const TRANSITIONS_OPTIONS: { value: string; label: string }[] = [
  { value: 'en_preparacion',  label: 'En Preparación'  },
  { value: 'en_revision',     label: 'En Revisión'     },
  { value: 'pendiente_stock', label: 'Pend. Stock'     },
  { value: 'por_empaquetar',  label: 'Por Empaquetar'  },
  { value: 'empaquetado',     label: 'Empaquetado'     },
  { value: 'pendiente_retiro',label: 'Pend. Retiro'    },
  { value: 'por_enviar',      label: 'Por Enviar'      },
  { value: 'pendiente_datos_envio', label: 'Pend. Datos Envío' },
  { value: 'en_calle',        label: 'En Calle'        },
  { value: 'enviado',         label: 'Enviado'         },
  { value: 'retirado',        label: 'Retirado'        },
];

const TRANSITION_LABELS: Record<string, string> =
  Object.fromEntries(TRANSITIONS_OPTIONS.map(t => [t.value, t.label]));

// Labels para el banner de demorados. Incluye hoja_impresa (que no es una
// transición del depo y por eso no está en TRANSITIONS_OPTIONS).
const ESTADO_DEPO_LABELS: Record<string, string> = {
  hoja_impresa:    'Hoja Impresa',
  en_preparacion:  'En Preparación',
  en_revision:     'En Revisión',
  pendiente_stock: 'Pend. Stock',
  por_empaquetar:  'Por Empaquetar',
  empaquetado:     'Empaquetado',
};

const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  qr:           { label: 'QR',      cls: 'bg-indigo-100 text-indigo-700' },
  oficina:      { label: 'Oficina', cls: 'bg-neutral-200 text-neutral-700' },
  trigger_auto: { label: 'Auto',    cls: 'bg-emerald-100 text-emerald-700' },
  webhook:      { label: 'TN',      cls: 'bg-sky-100 text-sky-700' },
  trigger_auto_pago: { label: 'Auto', cls: 'bg-emerald-100 text-emerald-700' },
};

const QUICK_DATE_OPTIONS = [
  { key: 'hoy',    label: 'Hoy' },
  { key: 'ayer',   label: 'Ayer' },
  { key: 'ult7',   label: 'Últ. 7 días' },
  { key: 'ult30',  label: 'Últ. 30 días' },
  { key: 'custom', label: 'Personalizado' },
] as const;

type QuickDate = typeof QUICK_DATE_OPTIONS[number]['key'];

function resolveQuickDate(quick: QuickDate): { fromDate?: string; toDate?: string } {
  const now = new Date();
  switch (quick) {
    case 'hoy':
      return { fromDate: startOfDay(now).toISOString(), toDate: endOfDay(now).toISOString() };
    case 'ayer': {
      const d = subDays(now, 1);
      return { fromDate: startOfDay(d).toISOString(), toDate: endOfDay(d).toISOString() };
    }
    case 'ult7':
      return { fromDate: startOfDay(subDays(now, 7)).toISOString(), toDate: endOfDay(now).toISOString() };
    case 'ult30':
      return { fromDate: startOfDay(subDays(now, 30)).toISOString(), toDate: endOfDay(now).toISOString() };
    default:
      return {};
  }
}

export function Deposito() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canView = hasPermission('deposito.ver_deposito');

  // Filtros.
  const [quickDate, setQuickDate] = useState<QuickDate>('hoy');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [employeeIds, setEmployeeIds] = useState<number[]>([]);
  const [transitions, setTransitions] = useState<string[]>([]);

  // Datos.
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [items, setItems] = useState<TransitionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [metrics, setMetrics] = useState<DepositoMetrics | null>(null);
  const [openIssuesCount, setOpenIssuesCount] = useState(0);
  const [demorados, setDemorados] = useState<PedidoDemoradoRow[]>([]);
  const [demoradosLoading, setDemoradosLoading] = useState(true);
  const [demoradosExpanded, setDemoradosExpanded] = useState(false);
  const [topesExpanded, setTopesExpanded] = useState(false);

  // Estado UI.
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [orderBy, setOrderBy] = useState<string>('created_at');
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('desc');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filtros consolidados para mandar al backend.
  const currentFilters = useMemo<DepositoFilters>(() => {
    const dateRange = quickDate === 'custom'
      ? { fromDate: customFrom ? new Date(customFrom).toISOString() : undefined,
          toDate:   customTo   ? endOfDay(new Date(customTo)).toISOString() : undefined }
      : resolveQuickDate(quickDate);
    return {
      employeeIds: employeeIds.length ? employeeIds : undefined,
      transitions: transitions.length ? transitions : undefined,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
    };
  }, [quickDate, customFrom, customTo, employeeIds, transitions]);

  // Wrappers de setter que también resetean page (evita doble fetch
  // que tendría un useEffect separado watcheando los filtros).
  const updateQuickDate = (q: QuickDate) => { setQuickDate(q); setPage(1); };
  const updateCustomFrom = (v: string) => { setCustomFrom(v); setPage(1); };
  const updateCustomTo = (v: string) => { setCustomTo(v); setPage(1); };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [transitionsRes, metricsRes] = await Promise.all([
        fetchTransitions(currentFilters, { page, limit: pageSize, orderBy, orderDir }),
        fetchMetrics(currentFilters),
      ]);
      setItems(transitionsRes.items);
      setTotal(transitionsRes.total);
      setPages(transitionsRes.pages);
      setMetrics(metricsRes.metrics);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar');
    } finally {
      setLoading(false);
    }
  }, [currentFilters, page, pageSize, orderBy, orderDir]);

  useEffect(() => {
    if (!canView) return;
    fetchEmployees().then(r => setEmployees(r.items)).catch(() => {});
    // Cargar count de issues abiertos para mostrar badge en el botón.
    fetchStockIssues({ status: 'open' }, { page: 1, limit: 1 })
      .then(r => setOpenIssuesCount(r.open_count))
      .catch(() => {});
    setDemoradosLoading(true);
    fetchPedidosDemorados()
      .then(r => setDemorados(r.items))
      .catch(() => {})
      .finally(() => setDemoradosLoading(false));
  }, [canView]);

  useEffect(() => {
    if (!canView) return;
    load();
  }, [canView, load]);

  if (!canView) {
    return (
      <>
        <Header title="Depósito" />
        <div className="p-6 text-center text-neutral-500">
          No tenés permiso para ver este panel.
        </div>
      </>
    );
  }

  const toggleInArray = <T extends string | number>(arr: T[], value: T, setter: (a: T[]) => void) => {
    setter(arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value]);
    setPage(1);
  };

  const toggleSort = (col: string) => {
    if (orderBy !== col) {
      setOrderBy(col);
      setOrderDir('desc');
    } else if (orderDir === 'desc') {
      setOrderDir('asc');
    } else {
      // tercer click: limpiar (vuelve a default created_at desc).
      setOrderBy('created_at');
      setOrderDir('desc');
    }
  };

  const sortIndicator = (col: string) => {
    if (orderBy !== col) return '';
    return orderDir === 'asc' ? ' ▲' : ' ▼';
  };

  const canManageEmployees = hasPermission('deposito.gestionar_empleados') || hasPermission('deposito.ver_codigos') || hasPermission('deposito.ver_actividades');
  const canManageTopes = hasPermission('deposito.gestionar_empleados');

  return (
    <>
      <Header
        title="Depósito"
        subtitle="Actividad del depósito y métricas"
      />

      <div className="p-4 space-y-4">
        {/* Banner pedidos demorados (siempre visible — verde si 0, rojo si hay) */}
        <DemoradosBanner
          items={demorados}
          loading={demoradosLoading}
          expanded={demoradosExpanded}
          onToggle={() => setDemoradosExpanded(v => !v)}
          onPedidoClick={n => navigate(`/orders/${n}`)}
        />

        {/* Tarjetas-acceso (alargadas, diferenciadas de las métricas) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          <AccesoCard
            to="/deposito/stock-issues"
            icon={<AlertTriangle size={22} />}
            label="Stock Pendientes"
            badge={openIssuesCount > 0 ? openIssuesCount : undefined}
            badgeClass="bg-amber-500"
          />
          <AccesoCard
            to="/deposito/errores"
            icon={<Bug size={22} />}
            label="Errores"
          />
          {canManageEmployees && (
            <AccesoCard
              to="/deposito/empleados"
              icon={<Users size={22} />}
              label="Empleados"
            />
          )}
          {canManageTopes && (
            <AccesoCard
              onClick={() => setTopesExpanded(v => !v)}
              icon={<Settings size={22} />}
              label="Topes del banner"
              active={topesExpanded}
            />
          )}
        </div>

        {/* Panel admin de topes (sólo si la tarjeta está expandida) */}
        {canManageTopes && topesExpanded && (
          <TopesPanel onClose={() => setTopesExpanded(false)} />
        )}

        {/* Métricas */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <MetricBox label="Empaquetados" value={metrics?.empaquetados ?? 0} />
          <MetricBox label="Total transiciones" value={metrics?.total_transiciones ?? 0} />
          <MetricBox label="Pasados a Pend. Stock" value={metrics?.pasados_pendiente_stock ?? 0} />
          <MetricBox label="Despachados" value={metrics?.despachados ?? 0} hint="(en_calle)" />
          <MetricBox
            label="Empleado más activo"
            value={metrics?.empleado_top?.nombre || '—'}
            hint={metrics?.empleado_top ? `${metrics.empleado_top.count} acciones` : ''}
            small
          />
        </div>

        {/* Filtros */}
        <div className="bg-white rounded-2xl shadow-sm p-4 space-y-4">
          {/* Fecha */}
          <div>
            <p className="text-xs uppercase tracking-wider text-neutral-500 mb-2">Fecha</p>
            <div className="flex flex-wrap gap-2">
              {QUICK_DATE_OPTIONS.map(opt => (
                <button
                  key={opt.key}
                  onClick={() => updateQuickDate(opt.key)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    quickDate === opt.key
                      ? 'bg-indigo-600 text-white'
                      : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {quickDate === 'custom' && (
              <div className="flex gap-2 items-center mt-2">
                <input
                  type="date"
                  value={customFrom}
                  onChange={e => updateCustomFrom(e.target.value)}
                  className="border border-neutral-300 rounded-lg px-2 py-1 text-sm"
                />
                <span className="text-neutral-500">a</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={e => updateCustomTo(e.target.value)}
                  className="border border-neutral-300 rounded-lg px-2 py-1 text-sm"
                />
              </div>
            )}
          </div>

          {/* Empleados */}
          <div>
            <p className="text-xs uppercase tracking-wider text-neutral-500 mb-2">
              Empleado {employeeIds.length > 0 && <span className="text-indigo-600">({employeeIds.length})</span>}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => { setEmployeeIds([]); setPage(1); }}
                className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                  employeeIds.length === 0
                    ? 'bg-indigo-600 text-white'
                    : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                }`}
              >
                TODOS
              </button>
              {employees.map(e => (
                <button
                  key={e.id}
                  onClick={() => toggleInArray(employeeIds, e.id, setEmployeeIds)}
                  className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    employeeIds.includes(e.id)
                      ? 'bg-indigo-600 text-white'
                      : `bg-neutral-100 text-neutral-700 hover:bg-neutral-200 ${!e.active && 'opacity-50 italic'}`
                  }`}
                >
                  {e.nombre}{!e.active && ' (inactivo)'}
                </button>
              ))}
              {employees.length === 0 && (
                <span className="text-sm text-neutral-400">Sin empleados cargados</span>
              )}
            </div>
          </div>

          {/* Transiciones */}
          <div>
            <p className="text-xs uppercase tracking-wider text-neutral-500 mb-2">
              Acción {transitions.length > 0 && <span className="text-indigo-600">({transitions.length})</span>}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => { setTransitions([]); setPage(1); }}
                className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                  transitions.length === 0
                    ? 'bg-indigo-600 text-white'
                    : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                }`}
              >
                TODAS
              </button>
              {TRANSITIONS_OPTIONS.map(t => (
                <button
                  key={t.value}
                  onClick={() => toggleInArray(transitions, t.value, setTransitions)}
                  className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    transitions.includes(t.value)
                      ? 'bg-indigo-600 text-white'
                      : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {(employeeIds.length || transitions.length || quickDate !== 'hoy') ? (
            <div className="pt-2 border-t border-neutral-100">
              <button
                onClick={() => {
                  setEmployeeIds([]);
                  setTransitions([]);
                  setQuickDate('hoy');
                  setCustomFrom('');
                  setCustomTo('');
                  setPage(1);
                }}
                className="text-sm text-neutral-500 hover:text-neutral-900"
              >
                Limpiar filtros
              </button>
            </div>
          ) : null}
        </div>

        {/* Tabla */}
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 border-b border-neutral-200">
                <tr>
                  <th
                    onClick={() => toggleSort('created_at')}
                    className="px-4 py-3 text-left font-semibold text-neutral-600 cursor-pointer hover:bg-neutral-100"
                  >
                    Fecha{sortIndicator('created_at')}
                  </th>
                  <th
                    onClick={() => toggleSort('employee_name')}
                    className="px-4 py-3 text-left font-semibold text-neutral-600 cursor-pointer hover:bg-neutral-100"
                  >
                    Empleado{sortIndicator('employee_name')}
                  </th>
                  <th
                    onClick={() => toggleSort('order_number')}
                    className="px-4 py-3 text-left font-semibold text-neutral-600 cursor-pointer hover:bg-neutral-100"
                  >
                    Pedido{sortIndicator('order_number')}
                  </th>
                  <th className="px-4 py-3 text-left font-semibold text-neutral-600">Acción</th>
                  <th className="px-4 py-3 text-left font-semibold text-neutral-600">Origen</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-neutral-400">Cargando…</td></tr>
                )}
                {error && !loading && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-red-600">{error}</td></tr>
                )}
                {!loading && !error && items.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-neutral-400">Sin transiciones para los filtros aplicados</td></tr>
                )}
                {!loading && items.map(row => {
                  const source = SOURCE_BADGE[row.source] || { label: row.source, cls: 'bg-neutral-200 text-neutral-700' };
                  return (
                    <tr key={row.id} className="border-b border-neutral-100 hover:bg-neutral-50">
                      <td className="px-4 py-2 text-neutral-700 whitespace-nowrap">
                        {format(parseISO(row.created_at), 'dd/MM HH:mm', { locale: es })}
                      </td>
                      <td className="px-4 py-2">
                        {row.employee_name ? (
                          <button
                            onClick={() => row.employee_id && setEmployeeIds([row.employee_id])}
                            className="text-indigo-600 hover:underline"
                          >
                            {row.employee_name}
                          </button>
                        ) : (
                          <span className="text-neutral-400 italic">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <button
                          onClick={() => navigate(`/orders/${row.order_number}`)}
                          className="text-indigo-600 hover:underline font-mono"
                        >
                          #{row.order_number}
                        </button>
                      </td>
                      <td className="px-4 py-2 text-neutral-700">
                        {row.from_status && <span className="text-neutral-400">{TRANSITION_LABELS[row.from_status] || row.from_status} → </span>}
                        <span className="font-medium">{TRANSITION_LABELS[row.to_status] || row.to_status}</span>
                      </td>
                      <td className="px-4 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${source.cls}`}>
                          {source.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Paginación */}
          {!loading && items.length > 0 && (
            <div className="px-4 py-3 bg-neutral-50 border-t border-neutral-200 flex items-center justify-between text-sm">
              <span className="text-neutral-500">
                {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} de {total}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1 rounded bg-white border border-neutral-300 disabled:opacity-40"
                >
                  ← Anterior
                </button>
                <span className="px-3 py-1 text-neutral-600">Página {page} / {pages}</span>
                <button
                  onClick={() => setPage(p => Math.min(pages, p + 1))}
                  disabled={page >= pages}
                  className="px-3 py-1 rounded bg-white border border-neutral-300 disabled:opacity-40"
                >
                  Siguiente →
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

interface MetricBoxProps {
  label: string;
  value: string | number;
  hint?: string;
  small?: boolean;
}

function MetricBox({ label, value, hint, small }: MetricBoxProps) {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-4">
      <p className="text-xs uppercase tracking-wider text-neutral-500">{label}</p>
      <p className={`mt-1 font-bold text-neutral-900 ${small ? 'text-lg' : 'text-3xl'}`}>{value}</p>
      {hint && <p className="text-xs text-neutral-400 mt-1">{hint}</p>}
    </div>
  );
}

// ─── Tarjeta-acceso ────────────────────────────────────────
// Layout horizontal (icono + label), bien diferenciada visualmente de las
// MetricBox (que son verticales con número grande). Va en una fila aparte
// arriba de las métricas.
interface AccesoCardProps {
  icon: ReactNode;
  label: string;
  badge?: number;
  badgeClass?: string;
  to?: string;
  onClick?: () => void;
  active?: boolean;
}

function AccesoCard({ to, onClick, icon, label, badge, badgeClass = 'bg-indigo-500', active }: AccesoCardProps) {
  const baseCls = `flex items-center gap-3 rounded-2xl shadow-sm px-4 py-3 transition-colors border ${
    active
      ? 'bg-indigo-50 border-indigo-200'
      : 'bg-white border-transparent hover:bg-neutral-50 hover:border-neutral-200'
  }`;

  const content = (
    <>
      <span className={`flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center ${
        active ? 'bg-indigo-100 text-indigo-700' : 'bg-neutral-100 text-neutral-700'
      }`}>
        {icon}
      </span>
      <span className={`flex-1 font-semibold text-left ${active ? 'text-indigo-900' : 'text-neutral-800'}`}>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className={`inline-flex items-center justify-center min-w-[1.5rem] h-6 px-2 rounded-full text-white text-xs font-bold ${badgeClass}`}>
          {badge}
        </span>
      )}
    </>
  );

  if (to) {
    return <Link to={to} className={baseCls}>{content}</Link>;
  }
  return (
    <button type="button" onClick={onClick} className={baseCls}>
      {content}
    </button>
  );
}

// ─── Banner pedidos demorados ──────────────────────────────
// Siempre visible. Tres variantes: cargando (neutral), 0 demorados (verde
// sin toggle), N demorados (rojo con toggle a tabla embebida).
interface DemoradosBannerProps {
  items: PedidoDemoradoRow[];
  loading: boolean;
  expanded: boolean;
  onToggle: () => void;
  onPedidoClick: (orderNumber: string) => void;
}

function DemoradosBanner({ items, loading, expanded, onToggle, onPedidoClick }: DemoradosBannerProps) {
  const count = items.length;

  if (loading) {
    return (
      <div className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 flex items-center gap-3">
        <Clock size={22} className="flex-shrink-0 text-neutral-400 animate-pulse" />
        <span className="text-neutral-500">Chequeando pedidos demorados…</span>
      </div>
    );
  }

  if (count === 0) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 flex items-center gap-3">
        <CheckCircle2 size={22} className="flex-shrink-0 text-emerald-600" />
        <span className="font-semibold text-emerald-800">
          Sin pedidos demorados en el depósito
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-red-200 bg-red-50 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-red-100/60 transition-colors"
      >
        <AlertOctagon size={22} className="flex-shrink-0 text-red-600" />
        <span className="flex-1 text-left font-semibold text-red-800">
          {count} {count === 1 ? 'pedido demorado' : 'pedidos demorados'} en el depósito
        </span>
        <span className="flex items-center gap-1 text-sm text-red-700">
          {expanded ? 'Ocultar' : 'Ver'}
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-red-200 bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-red-50/50 border-b border-red-100">
              <tr>
                <th className="px-4 py-2 text-left font-semibold text-neutral-600">Pedido</th>
                <th className="px-4 py-2 text-left font-semibold text-neutral-600">Cliente</th>
                <th className="px-4 py-2 text-left font-semibold text-neutral-600">Estado</th>
                <th className="px-4 py-2 text-right font-semibold text-neutral-600">Tiempo</th>
                <th className="px-4 py-2 text-right font-semibold text-neutral-600">Tope</th>
              </tr>
            </thead>
            <tbody>
              {items.map(row => {
                const exceso = row.horas_habiles - row.threshold_horas;
                return (
                  <tr key={row.order_number} className="border-b border-neutral-100 hover:bg-neutral-50">
                    <td className="px-4 py-2">
                      <button
                        onClick={() => onPedidoClick(row.order_number)}
                        className="text-indigo-600 hover:underline font-mono"
                      >
                        #{row.order_number}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-neutral-700">
                      {row.customer_name || <span className="text-neutral-400 italic">—</span>}
                    </td>
                    <td className="px-4 py-2 text-neutral-700">
                      {ESTADO_DEPO_LABELS[row.estado_pedido] || row.estado_pedido}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <span className="inline-flex items-center gap-1 text-red-700 font-semibold">
                        <Clock size={14} />
                        {formatHoras(row.horas_habiles)}
                      </span>
                      <span className="ml-1 text-xs text-red-500">(+{formatHoras(exceso)})</span>
                    </td>
                    <td className="px-4 py-2 text-right text-neutral-500">
                      {formatHoras(row.threshold_horas)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatHoras(h: number): string {
  if (h >= 24) {
    const dias = Math.floor(h / 24);
    const resto = Math.round(h - dias * 24);
    return resto === 0 ? `${dias}d` : `${dias}d ${resto}h`;
  }
  return `${Math.round(h * 10) / 10}h`;
}

// ─── Panel admin de topes ──────────────────────────────────
// Sección colapsable que muestran/editan los thresholds en horas hábiles por
// estado depo. Solo visible con permiso deposito.gestionar_empleados.
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface TopesPanelProps {
  onClose: () => void;
}

function TopesPanel({ onClose }: TopesPanelProps) {
  const [rows, setRows] = useState<EstadoThresholdRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Valores en edición (input). Permiten detectar "cambió" vs server.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});

  useEffect(() => {
    setLoading(true);
    fetchEstadoThresholds()
      .then(r => {
        setRows(r.rows);
        setDrafts(Object.fromEntries(r.rows.map(row => [row.estado, String(row.horas_limite)])));
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Error al cargar topes'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (estado: string) => {
    const draft = drafts[estado];
    const horas = Number(draft);
    if (!Number.isFinite(horas) || horas <= 0) {
      setSaveStates(s => ({ ...s, [estado]: 'error' }));
      return;
    }
    setSaveStates(s => ({ ...s, [estado]: 'saving' }));
    try {
      const { row } = await updateEstadoThreshold(estado, horas);
      setRows(rs => rs.map(r => (r.estado === estado ? row : r)));
      setDrafts(d => ({ ...d, [estado]: String(row.horas_limite) }));
      setSaveStates(s => ({ ...s, [estado]: 'saved' }));
      setTimeout(() => {
        setSaveStates(s => ({ ...s, [estado]: 'idle' }));
      }, 2000);
    } catch {
      setSaveStates(s => ({ ...s, [estado]: 'error' }));
    }
  };

  const hasChanged = (estado: string) => {
    const row = rows.find(r => r.estado === estado);
    if (!row) return false;
    return drafts[estado] !== String(row.horas_limite);
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-100">
        <div>
          <h3 className="font-semibold text-neutral-800">Topes del banner</h3>
          <p className="text-xs text-neutral-500">Horas hábiles por estado antes de marcarlo demorado. Excluye sáb/dom + vie 18 → lun 9.</p>
        </div>
        <button onClick={onClose} className="text-sm text-neutral-500 hover:text-neutral-900">Cerrar</button>
      </div>

      {loading && (
        <div className="px-4 py-6 text-center text-neutral-400">Cargando…</div>
      )}
      {error && !loading && (
        <div className="px-4 py-6 text-center text-red-600">{error}</div>
      )}

      {!loading && !error && (
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 border-b border-neutral-200">
            <tr>
              <th className="px-4 py-2 text-left font-semibold text-neutral-600">Estado</th>
              <th className="px-4 py-2 text-left font-semibold text-neutral-600">Horas hábiles</th>
              <th className="px-4 py-2 text-left font-semibold text-neutral-600"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const state = saveStates[row.estado] || 'idle';
              const changed = hasChanged(row.estado);
              return (
                <tr key={row.estado} className="border-b border-neutral-100">
                  <td className="px-4 py-2 text-neutral-800">
                    {ESTADO_DEPO_LABELS[row.estado] || row.estado}
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="number"
                      min={1}
                      step="0.5"
                      value={drafts[row.estado] ?? ''}
                      onChange={e => setDrafts(d => ({ ...d, [row.estado]: e.target.value }))}
                      className="w-24 border border-neutral-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                    <span className="ml-1 text-neutral-500 text-sm">hs</span>
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => handleSave(row.estado)}
                      disabled={!changed || state === 'saving'}
                      className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        state === 'saved'
                          ? 'bg-emerald-100 text-emerald-700'
                          : state === 'error'
                          ? 'bg-red-100 text-red-700'
                          : changed
                          ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                          : 'bg-neutral-100 text-neutral-400 cursor-not-allowed'
                      }`}
                    >
                      {state === 'saving' ? (
                        <>Guardando…</>
                      ) : state === 'saved' ? (
                        <><Check size={14} /> Guardado</>
                      ) : state === 'error' ? (
                        <>Error, reintentar</>
                      ) : (
                        <><Save size={14} /> Guardar</>
                      )}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
