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

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { format, parseISO, subDays, startOfDay, endOfDay } from 'date-fns';
import { es } from 'date-fns/locale';
import { Users, AlertTriangle, Bug } from 'lucide-react';
import { Header } from '../components/layout';
import { useAuth } from '../contexts/AuthContext';
import {
  fetchTransitions,
  fetchMetrics,
  fetchEmployees,
  fetchStockIssues,
  TransitionRow,
  EmployeeRow,
  DepositoFilters,
  DepositoMetrics,
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

  return (
    <>
      <Header
        title="Depósito"
        subtitle="Actividad del depo y métricas"
        actions={
          <div className="flex items-center gap-2">
            <Link
              to="/deposito/stock-issues"
              className="relative flex items-center gap-2 px-3 py-2 text-sm bg-neutral-100 hover:bg-neutral-200 rounded-lg"
            >
              <AlertTriangle size={16} /> Stock Pendientes
              {openIssuesCount > 0 && (
                <span className="ml-1 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-amber-500 text-white text-xs font-bold">
                  {openIssuesCount}
                </span>
              )}
            </Link>
            <Link
              to="/deposito/errores"
              className="flex items-center gap-2 px-3 py-2 text-sm bg-neutral-100 hover:bg-neutral-200 rounded-lg"
            >
              <Bug size={16} /> Errores
            </Link>
            {canManageEmployees && (
              <Link
                to="/deposito/empleados"
                className="flex items-center gap-2 px-3 py-2 text-sm bg-neutral-100 hover:bg-neutral-200 rounded-lg"
              >
                <Users size={16} /> Empleados
              </Link>
            )}
          </div>
        }
      />

      <div className="p-4 space-y-4">
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
