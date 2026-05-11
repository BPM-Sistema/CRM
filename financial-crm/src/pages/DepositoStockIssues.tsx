/**
 * Stock Issues del depósito (Fase 2 PR 7c).
 *
 * Listado de problemas de stock reportados por el depo desde el QR
 * (PR 4.5: al pasar un pedido a pendiente_stock, se selecciona qué
 * productos faltan y cantidad). Los issues se cierran auto cuando el
 * pedido sale de pendiente_stock, o manualmente desde acá.
 */

import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { format, parseISO, formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import { ArrowLeft } from 'lucide-react';
import { Header } from '../components/layout';
import { useAuth } from '../contexts/AuthContext';
import {
  fetchStockIssues,
  resolveStockIssue,
  StockIssue,
  StockIssuesFilters,
} from '../services/deposito-api';

type StatusFilter = 'open' | 'resolved' | 'all';

export function DepositoStockIssues() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canView = hasPermission('deposito.ver_deposito');

  const [items, setItems] = useState<StockIssue[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [orderNumberFilter, setOrderNumberFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const filters: StockIssuesFilters = { status: statusFilter };
      if (orderNumberFilter.trim()) filters.orderNumber = orderNumberFilter.trim();
      const r = await fetchStockIssues(filters, { page, limit: pageSize });
      setItems(r.items);
      setTotal(r.total);
      setOpenCount(r.open_count);
      setPages(r.pages);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, orderNumberFilter, page, pageSize]);

  useEffect(() => { if (canView) load(); }, [canView, load]);

  const updateStatusFilter = (v: StatusFilter) => { setStatusFilter(v); setPage(1); };
  const updateOrderFilter = (v: string) => { setOrderNumberFilter(v); setPage(1); };

  const handleResolve = async (id: number) => {
    setResolvingId(id);
    try {
      await resolveStockIssue(id);
      await load();
      setConfirmId(null);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Error al resolver');
    } finally {
      setResolvingId(null);
    }
  };

  if (!canView) {
    return (
      <>
        <Header title="Stock Pendientes" />
        <div className="p-6 text-center text-neutral-500">
          No tenés permiso para ver este panel.
        </div>
      </>
    );
  }

  return (
    <>
      <Header
        title="Stock Pendientes"
        subtitle={`${openCount} ${openCount === 1 ? 'issue abierto' : 'issues abiertos'}`}
        actions={
          <Link
            to="/deposito"
            className="flex items-center gap-2 px-3 py-2 text-sm text-neutral-600 hover:text-neutral-900"
          >
            <ArrowLeft size={16} /> Volver al panel
          </Link>
        }
      />

      <div className="p-4 space-y-4">
        {/* Filtros */}
        <div className="bg-white rounded-2xl shadow-sm p-4 space-y-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-neutral-500 mb-2">Estado</p>
            <div className="flex gap-2">
              {(['open', 'resolved', 'all'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => updateStatusFilter(s)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    statusFilter === s
                      ? 'bg-indigo-600 text-white'
                      : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
                  }`}
                >
                  {s === 'open' ? 'Abiertos' : s === 'resolved' ? 'Resueltos' : 'Todos'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-neutral-500 mb-2">Pedido</p>
            <input
              type="text"
              value={orderNumberFilter}
              onChange={e => updateOrderFilter(e.target.value)}
              placeholder="Nº de pedido"
              className="w-full sm:w-48 border border-neutral-300 rounded-lg px-3 py-1.5 text-sm"
            />
          </div>
        </div>

        {/* Tabla */}
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 border-b border-neutral-200">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-neutral-600">Fecha</th>
                  <th className="px-4 py-3 text-left font-semibold text-neutral-600">Pedido</th>
                  <th className="px-4 py-3 text-left font-semibold text-neutral-600">Producto</th>
                  <th className="px-4 py-3 text-center font-semibold text-neutral-600">Faltan</th>
                  <th className="px-4 py-3 text-left font-semibold text-neutral-600">Reportado por</th>
                  <th className="px-4 py-3 text-left font-semibold text-neutral-600">Estado</th>
                  <th className="px-4 py-3 text-right font-semibold text-neutral-600">Acción</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-neutral-400">Cargando…</td></tr>
                )}
                {!loading && error && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-red-600">{error}</td></tr>
                )}
                {!loading && !error && items.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-neutral-400">
                    Sin {statusFilter === 'open' ? 'issues abiertos' : statusFilter === 'resolved' ? 'issues resueltos' : 'issues'} para los filtros.
                  </td></tr>
                )}
                {!loading && items.map(it => {
                  const isOpen = it.resolved_at === null;
                  const resolvedAuto = !isOpen && it.resolved_by_user_id === null;
                  return (
                    <tr key={it.id} className="border-b border-neutral-100 hover:bg-neutral-50">
                      <td className="px-4 py-2 text-neutral-700 whitespace-nowrap">
                        <span title={format(parseISO(it.created_at), 'dd/MM/yyyy HH:mm', { locale: es })}>
                          {format(parseISO(it.created_at), 'dd/MM HH:mm', { locale: es })}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        <button
                          onClick={() => navigate(`/orders/${it.order_number}`)}
                          className="text-indigo-600 hover:underline font-mono"
                        >
                          #{it.order_number}
                        </button>
                      </td>
                      <td className="px-4 py-2">
                        <p className="font-medium">{it.product_name}</p>
                        <div className="text-xs text-neutral-500 flex gap-2">
                          {it.variant && <span>{it.variant}</span>}
                          {it.sku && <span className="font-mono">{it.sku}</span>}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-center font-mono font-semibold">{it.quantity_missing}</td>
                      <td className="px-4 py-2 text-neutral-700">
                        {it.reported_by_nombre || <span className="text-neutral-400 italic">—</span>}
                      </td>
                      <td className="px-4 py-2">
                        {isOpen ? (
                          <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                            Abierto
                          </span>
                        ) : (
                          <span title={it.resolved_at ? `Resuelto ${formatDistanceToNow(parseISO(it.resolved_at), { addSuffix: true, locale: es })}${it.resolved_by_user_name ? ` por ${it.resolved_by_user_name}` : ''}` : ''}>
                            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${resolvedAuto ? 'bg-emerald-100 text-emerald-700' : 'bg-neutral-200 text-neutral-700'}`}>
                              {resolvedAuto ? 'Auto-resuelto' : `Resuelto · ${it.resolved_by_user_name || 'admin'}`}
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {isOpen && (
                          <button
                            onClick={() => setConfirmId(it.id)}
                            disabled={resolvingId === it.id}
                            className="px-3 py-1 text-xs bg-emerald-100 hover:bg-emerald-200 text-emerald-800 rounded disabled:opacity-50"
                          >
                            Resolver
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

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

      {/* Modal confirmar resolver */}
      {confirmId !== null && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-5 space-y-4">
            <h2 className="text-lg font-bold">¿Marcar como resuelto?</h2>
            <p className="text-sm text-neutral-700">
              El issue va a quedar marcado como resuelto por vos. El pedido no se modifica (el cambio
              de estado se hace desde el QR o desde el detalle).
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmId(null)}
                disabled={resolvingId !== null}
                className="flex-1 py-2 bg-neutral-200 rounded-lg"
              >
                Cancelar
              </button>
              <button
                onClick={() => handleResolve(confirmId)}
                disabled={resolvingId !== null}
                className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-300 text-white font-semibold rounded-lg"
              >
                {resolvingId !== null ? 'Resolviendo…' : 'Resolver'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
