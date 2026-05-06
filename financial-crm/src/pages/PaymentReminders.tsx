import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, ExternalLink, MessageSquare, RefreshCw, Search, Send, Ban, Clock } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { AccessDenied } from '../components/AccessDenied';
import { fetchBotmakerChat } from '../services/api';
import {
  fetchReminders,
  fetchReminderStats,
  fetchReminderHistory,
  reprogramarReminder,
  applyReminderAction,
  type ReminderRow,
  type ReminderStep,
  type ReminderStats,
  type RemindersHistoryResponse
} from '../services/payment-reminders';

type StatusFilter = 'any' | 'programado' | 'enviado' | 'descartado' | 'sin_programar';
type StepFilter = 'any' | '3hs' | '10hs';

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function formatMoney(v: string | number | null) {
  if (v == null) return '—';
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (isNaN(n)) return '—';
  return `$${n.toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;
}

function InboundCell({ row }: { row: ReminderRow }) {
  const count = row.inbound_count || 0;
  const last = row.last_inbound || [];
  if (count === 0) return <span className="text-neutral-300 text-xs">—</span>;
  return (
    <div className="relative group inline-block">
      <Badge variant="success" size="sm">
        💬 {count}
      </Badge>
      <div className="hidden group-hover:block absolute z-50 left-0 top-full mt-1 w-80 max-w-[80vw] bg-white border border-neutral-200 rounded-lg shadow-xl p-2 text-xs">
        <div className="font-semibold text-neutral-700 mb-1">
          Últimas respuestas {last.length < count ? `(${last.length} de ${count})` : ''}
        </div>
        <div className="space-y-1.5 max-h-72 overflow-y-auto">
          {last.map((m, idx) => (
            <div key={idx} className="border-l-2 border-green-400 pl-2 py-0.5">
              {m.from_name && <div className="text-neutral-500">{m.from_name}</div>}
              {m.message_text && (
                <div className="text-neutral-800 whitespace-pre-wrap break-words">{m.message_text}</div>
              )}
              {m.url_clicked && (
                <div className="text-blue-600 break-all">Clickeó: {m.url_clicked}</div>
              )}
              {m.button_id && !m.message_text && !m.url_clicked && (
                <div className="text-neutral-700">Botón: {m.button_id}</div>
              )}
              <div className="text-neutral-400 text-[10px] mt-0.5">{formatDate(m.received_at)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ActionCell({ row, onApplied }: { row: ReminderRow; onApplied: () => void }) {
  const [busy, setBusy] = useState(false);
  const [showWaitInput, setShowWaitInput] = useState(false);
  const [note, setNote] = useState('');

  // Si ya se aplicó alguna acción, mostrar resultado (chip) y nada más.
  if (row.payment_reminder_action_at) {
    if (row.payment_reminder_action_type === 'cancel') {
      return <Badge variant="danger" size="sm">❌ Cancelado</Badge>;
    }
    if (row.payment_reminder_action_type === 'wait') {
      return (
        <div className="text-xs">
          <Badge variant="warning" size="sm">⏳ Esperando</Badge>
          {row.payment_reminder_note && (
            <div className="text-neutral-700 mt-0.5 italic max-w-[200px]" title={row.payment_reminder_note}>
              "{row.payment_reminder_note.length > 40 ? row.payment_reminder_note.slice(0, 40) + '…' : row.payment_reminder_note}"
            </div>
          )}
        </div>
      );
    }
  }

  // Solo mostrar botones si el cliente clickeó CARGAR COMPROBANTE.
  if (!row.has_url_click) return <span className="text-neutral-300 text-xs">—</span>;

  const onCancel = async () => {
    if (!confirm(`¿Cancelar pedido #${row.order_number}? Se cancela en TiendaNube y los productos vuelven al stock. Esta acción no se puede deshacer.`)) return;
    setBusy(true);
    try {
      const r = await applyReminderAction(row.order_number, 'cancel');
      if (!r.ok) {
        alert(`Error: ${r.error}`);
        return;
      }
      alert('Pedido cancelado en TiendaNube y CRM. Stock devuelto.');
      onApplied();
    } catch (err) {
      alert(`Error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onWait = async () => {
    const cleaned = note.trim();
    if (cleaned.length < 3) {
      alert('La nota debe tener al menos 3 caracteres');
      return;
    }
    setBusy(true);
    try {
      const r = await applyReminderAction(row.order_number, 'wait', cleaned);
      if (!r.ok) {
        alert(`Error: ${r.error}`);
        return;
      }
      setShowWaitInput(false);
      setNote('');
      onApplied();
    } catch (err) {
      alert(`Error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (showWaitInput) {
    return (
      <div className="flex flex-col gap-1 min-w-[220px]">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="ej: dice que va a pagar"
          rows={2}
          className="text-xs border border-neutral-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-neutral-400"
          autoFocus
        />
        <div className="flex gap-1">
          <Button size="sm" variant="primary" onClick={onWait} disabled={busy}>
            Guardar
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setShowWaitInput(false); setNote(''); }} disabled={busy}>
            Cancelar
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={onCancel}
        disabled={busy || row.has_comprobante}
        title={row.has_comprobante ? 'Tiene comprobante cargado, no se puede cancelar desde acá' : 'Cancelar el pedido en CRM y TiendaNube (devuelve stock)'}
        className={`text-xs px-2 py-1 rounded inline-flex items-center gap-1 ${
          row.has_comprobante
            ? 'bg-neutral-100 text-neutral-400 cursor-not-allowed'
            : 'bg-red-50 text-red-700 hover:bg-red-100'
        }`}
      >
        <Ban size={12} /> Cancelar
      </button>
      <button
        onClick={() => setShowWaitInput(true)}
        disabled={busy}
        title="Dejar nota para localizar después"
        className="text-xs px-2 py-1 rounded inline-flex items-center gap-1 bg-amber-50 text-amber-700 hover:bg-amber-100"
      >
        <Clock size={12} /> Esperar
      </button>
    </div>
  );
}

function StepCell({
  row,
  step
}: {
  row: ReminderRow;
  step: ReminderStep;
}) {
  const sendAt = row[`${step.key}_send_at`] as string | null;
  const sentAt = row[`${step.key}_sent_at`] as string | null;
  const error = row[`${step.key}_error`] as string | null;
  const waStatus = row[`${step.key}_wa_status`] as string | null;
  const waError = row[`${step.key}_wa_error`] as string | null;

  if (!sendAt && !sentAt && !error) {
    return <Badge variant="default" size="sm">Sin programar</Badge>;
  }
  if (sentAt) {
    let waVariant: 'success' | 'warning' | 'danger' | 'default' = 'success';
    if (waStatus === 'failed' || waStatus === 'error' || waError) waVariant = 'danger';
    else if (waStatus === 'pending') waVariant = 'warning';
    return (
      <div className="flex flex-col gap-1">
        <Badge variant="success" size="sm">Enviado {formatDate(sentAt)}</Badge>
        {waStatus && (
          <Badge variant={waVariant} size="sm">WA: {waStatus}</Badge>
        )}
      </div>
    );
  }
  if (error && !sentAt) {
    const motivo = error.includes('discarded') ? 'Descartado' : 'Error';
    return (
      <div className="flex flex-col gap-1">
        <Badge variant="default" size="sm">{motivo}</Badge>
        <span className="text-[10px] text-neutral-500 max-w-[200px] truncate" title={error}>{error}</span>
      </div>
    );
  }
  return <Badge variant="warning" size="sm">⏳ {formatDate(sendAt)}</Badge>;
}

export default function PaymentReminders() {
  const { hasPermission } = useAuth();
  const [orders, setOrders] = useState<ReminderRow[]>([]);
  const [steps, setSteps] = useState<ReminderStep[]>([]);
  const [stats, setStats] = useState<Record<string, ReminderStats>>({});
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [stepFilter, setStepFilter] = useState<StepFilter>('any');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('any');

  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [history, setHistory] = useState<RemindersHistoryResponse | null>(null);

  const canView = hasPermission('payment_reminders.view');

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetchReminders({
        page,
        limit: 50,
        search: search || undefined,
        step: stepFilter === 'any' ? undefined : stepFilter,
        status: statusFilter
      });
      setOrders(r.orders);
      setSteps(r.steps);
      setTotalPages(r.pagination.totalPages);
      setTotal(r.pagination.total);
    } catch (err) {
      console.error(err);
      alert('Error cargando recordatorios');
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const r = await fetchReminderStats();
      setStats(r.stats);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    if (!canView) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, stepFilter, statusFilter]);

  useEffect(() => {
    if (!canView) return;
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    load();
  };

  const openHistory = async (orderNumber: string) => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistory(null);
    try {
      const r = await fetchReminderHistory(orderNumber);
      setHistory(r);
    } catch (err) {
      console.error(err);
      alert('Error cargando historial');
    } finally {
      setHistoryLoading(false);
    }
  };

  const openInbox = async (phone: string | null | undefined) => {
    if (!phone) return alert('Sin teléfono');
    try {
      const { url } = await fetchBotmakerChat(phone);
      if (url) window.open(url, '_blank');
      else alert('No se encontró chat en Botmaker para este número');
    } catch {
      alert('Error al buscar chat en Botmaker');
    }
  };

  const onReprogramar = async (scheduledId: number) => {
    if (!confirm('¿Reprogramar este recordatorio? Se va a encolar de nuevo para próximo horario laboral.')) return;
    try {
      const r = await reprogramarReminder(scheduledId);
      if (!r.ok) {
        alert(`Error: ${r.error}`);
        return;
      }
      alert(`Reprogramado para ${formatDate(r.scheduled?.send_at || null)}`);
      if (history) {
        const refreshed = await fetchReminderHistory(history.order.order_number);
        setHistory(refreshed);
      }
      load();
    } catch (err) {
      alert(`Error: ${(err as Error).message}`);
    }
  };

  const totalsByStep = useMemo(() => {
    return steps.map(s => ({ step: s, st: stats[s.key] }));
  }, [steps, stats]);

  if (!canView) return <AccessDenied />;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Bell size={20} className="text-neutral-700" />
          <h1 className="text-xl font-semibold">Recordatorios de Pago</h1>
        </div>
        <Button variant="ghost" size="sm" onClick={() => { load(); loadStats(); }}>
          <RefreshCw size={14} className="mr-1" /> Refrescar
        </Button>
      </div>

      {/* Stats por paso */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {totalsByStep.map(({ step, st }) => (
          <Card key={step.key} padding="sm">
            <div className="text-xs text-neutral-500">{step.label}</div>
            {st ? (
              <div className="mt-1 space-y-0.5 text-sm">
                <div>⏳ Programados: <b>{st.programados}</b></div>
                <div>📤 Enviados hoy: <b>{st.enviados_hoy}</b></div>
                <div>🚫 Descartados: <b>{st.descartados}</b></div>
                {Number(st.vencidos_sin_enviar) > 0 && (
                  <div className="text-amber-600">⚠️ Vencidos: <b>{st.vencidos_sin_enviar}</b></div>
                )}
              </div>
            ) : (
              <div className="text-xs text-neutral-400 mt-1">—</div>
            )}
          </Card>
        ))}
      </div>

      {/* Filtros */}
      <Card padding="sm">
        <form onSubmit={onSearch} className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              placeholder="Buscar por nro pedido, nombre o teléfono..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-7 pr-3 py-1.5 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-neutral-400"
            />
          </div>
          <select
            value={stepFilter}
            onChange={(e) => { setStepFilter(e.target.value as StepFilter); setPage(1); }}
            className="px-2 py-1.5 text-sm border border-neutral-200 rounded-lg"
          >
            <option value="any">Todos los pasos</option>
            <option value="3hs">Solo 3hs</option>
            <option value="10hs">Solo 10hs</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value as StatusFilter); setPage(1); }}
            className="px-2 py-1.5 text-sm border border-neutral-200 rounded-lg"
          >
            <option value="any">Cualquier estado</option>
            <option value="programado">Programado</option>
            <option value="enviado">Enviado</option>
            <option value="descartado">Descartado</option>
            <option value="sin_programar">Sin programar</option>
          </select>
          <Button type="submit" size="sm">Buscar</Button>
        </form>
      </Card>

      {/* Tabla */}
      <Card padding="none">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-neutral-600 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-2">Pedido</th>
                <th className="text-left px-3 py-2">Cliente</th>
                <th className="text-left px-3 py-2">Teléfono</th>
                <th className="text-right px-3 py-2">Monto</th>
                <th className="text-left px-3 py-2">Creado</th>
                {steps.map(s => (
                  <th key={s.key} className="text-left px-3 py-2">{s.label}</th>
                ))}
                <th className="text-left px-3 py-2">Respuestas</th>
                <th className="text-left px-3 py-2">Acción Melu</th>
                <th className="text-right px-3 py-2">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {loading && (
                <tr><td colSpan={8 + steps.length} className="px-3 py-8 text-center text-neutral-400">Cargando…</td></tr>
              )}
              {!loading && orders.length === 0 && (
                <tr><td colSpan={8 + steps.length} className="px-3 py-8 text-center text-neutral-400">Sin resultados.</td></tr>
              )}
              {!loading && orders.map(row => (
                <tr key={row.order_number} className="hover:bg-neutral-50">
                  <td className="px-3 py-2 font-mono">
                    <Link to={`/orders/${row.order_number}`} className="text-neutral-900 hover:underline">
                      #{row.order_number}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{row.customer_name || '—'}</td>
                  <td className="px-3 py-2">
                    {row.customer_phone ? (
                      <button
                        onClick={() => openInbox(row.customer_phone)}
                        className="text-green-600 hover:text-green-800 inline-flex items-center gap-1"
                        title="Abrir inbox en Botmaker"
                      >
                        <MessageSquare size={12} /> {row.customer_phone}
                      </button>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">{formatMoney(row.monto_tiendanube)}</td>
                  <td className="px-3 py-2 text-neutral-600">{formatDate(row.created_at)}</td>
                  {steps.map(s => (
                    <td key={s.key} className="px-3 py-2"><StepCell row={row} step={s} /></td>
                  ))}
                  <td className="px-3 py-2"><InboundCell row={row} /></td>
                  <td className="px-3 py-2"><ActionCell row={row} onApplied={load} /></td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="ghost" onClick={() => openHistory(row.order_number)}>
                      Historial
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Paginación */}
        <div className="flex items-center justify-between px-3 py-2 border-t border-neutral-100 text-sm">
          <div className="text-neutral-500">
            {total} pedido{total === 1 ? '' : 's'} — página {page} de {totalPages}
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" disabled={page <= 1 || loading} onClick={() => setPage(p => Math.max(1, p - 1))}>Anterior</Button>
            <Button size="sm" variant="ghost" disabled={page >= totalPages || loading} onClick={() => setPage(p => p + 1)}>Siguiente</Button>
          </div>
        </div>
      </Card>

      {/* Modal historial */}
      <Modal isOpen={historyOpen} onClose={() => setHistoryOpen(false)} title="Historial WhatsApp del pedido" size="lg">
        {historyLoading && <div className="text-center py-8 text-neutral-400">Cargando…</div>}
        {!historyLoading && history && (
          <div className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <div className="font-mono text-sm">
                  <Link to={`/orders/${history.order.order_number}`} className="text-neutral-900 hover:underline">
                    #{history.order.order_number}
                  </Link>
                  {' — '}
                  <span className="text-neutral-700">{history.order.customer_name || 'Sin nombre'}</span>
                </div>
                <div className="text-xs text-neutral-500 mt-0.5">
                  Creado {formatDate(history.order.created_at)} · {formatMoney(history.order.monto_tiendanube)}
                </div>
              </div>
              {history.order.customer_phone && (
                <Button size="sm" variant="ghost" onClick={() => openInbox(history.order.customer_phone)}>
                  <ExternalLink size={12} className="mr-1" /> Abrir inbox
                </Button>
              )}
            </div>

            {/* Programados (scheduled_whatsapp) */}
            <div>
              <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Recordatorios programados</div>
              {history.scheduled.length === 0 && <div className="text-sm text-neutral-400">Sin programaciones.</div>}
              <div className="space-y-1">
                {history.scheduled.map(s => {
                  const isDescartado = !!s.error && !s.sent_at;
                  return (
                    <div key={s.id} className="flex items-center justify-between gap-2 px-2 py-1.5 bg-neutral-50 rounded text-sm">
                      <div className="flex-1 min-w-0">
                        <span className="font-mono text-xs">{s.plantilla}</span>
                        <span className="ml-2 text-neutral-500">programado: {formatDate(s.send_at)}</span>
                        {s.sent_at && <span className="ml-2 text-green-600">enviado: {formatDate(s.sent_at)}</span>}
                        {s.error && <div className="text-xs text-amber-600 truncate" title={s.error}>{s.error}</div>}
                      </div>
                      {isDescartado && (
                        <Button size="sm" variant="primary" onClick={() => onReprogramar(s.id)}>
                          <Send size={12} className="mr-1" /> Reprogramar
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Timeline conversación: mensajes enviados (BPM) + respuestas del cliente, ordenado cronológicamente */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">Conversación</div>
                {history.inbound.length > 0 && (
                  <Badge variant="success" size="sm">
                    {history.inbound.length} respuesta{history.inbound.length === 1 ? '' : 's'} del cliente
                  </Badge>
                )}
              </div>
              {history.messages.length === 0 && history.inbound.length === 0 && (
                <div className="text-sm text-neutral-400">Sin mensajes registrados.</div>
              )}
              <div className="space-y-1">
                {(() => {
                  type Item =
                    | { kind: 'out'; ts: string; data: typeof history.messages[number] }
                    | { kind: 'in'; ts: string; data: typeof history.inbound[number] };
                  const merged: Item[] = [
                    ...history.messages.map(m => ({ kind: 'out' as const, ts: m.created_at, data: m })),
                    ...history.inbound.map(i => ({ kind: 'in' as const, ts: i.received_at, data: i }))
                  ].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

                  return merged.map((item, idx) => {
                    if (item.kind === 'out') {
                      const m = item.data;
                      let waVariant: 'success' | 'warning' | 'danger' | 'default' = 'default';
                      if (m.status === 'delivered' || m.status === 'read' || m.status === 'sent') waVariant = 'success';
                      else if (m.status === 'failed' || m.status === 'error') waVariant = 'danger';
                      else if (m.status === 'pending') waVariant = 'warning';
                      return (
                        <div key={`out-${m.id}`} className="px-2 py-1.5 bg-blue-50 border-l-2 border-blue-300 rounded-r text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-xs text-blue-700">↗ BPM · {m.template_key || m.template}</span>
                            <Badge variant={waVariant} size="sm">{m.status}</Badge>
                          </div>
                          <div className="text-xs text-neutral-500 mt-0.5">
                            {formatDate(m.created_at)}
                            {m.status_updated_at && m.status_updated_at !== m.created_at && (
                              <span className="ml-2">· {m.status === 'read' ? 'leído' : m.status} {formatDate(m.status_updated_at)}</span>
                            )}
                          </div>
                          {m.error_message && <div className="text-xs text-red-600 mt-0.5">{m.error_message}</div>}
                        </div>
                      );
                    }
                    const i = item.data;
                    return (
                      <div key={`in-${i.id}-${idx}`} className="px-2 py-1.5 bg-green-50 border-l-2 border-green-400 rounded-r text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs text-green-700">↙ Cliente</span>
                          <span className="text-xs text-neutral-500">{i.message_type}</span>
                        </div>
                        {i.message_text && (
                          <div className="text-sm text-neutral-800 mt-0.5 whitespace-pre-wrap break-words">{i.message_text}</div>
                        )}
                        {i.button_id && (
                          <div className="text-xs text-neutral-700 mt-0.5">Botón: <span className="font-mono">{i.button_id}</span></div>
                        )}
                        {i.url_clicked && (
                          <div className="text-xs text-neutral-700 mt-0.5">Clickeó: <a href={i.url_clicked} target="_blank" rel="noreferrer" className="text-blue-600 underline break-all">{i.url_clicked}</a></div>
                        )}
                        <div className="text-xs text-neutral-500 mt-0.5">{formatDate(i.received_at)}</div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
