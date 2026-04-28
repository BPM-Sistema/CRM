import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Truck, Send, Loader2, CheckCircle2, ExternalLink, AlertTriangle } from 'lucide-react';
import {
  fetchPendingShippingDataList,
  authFetch,
  type PendingShippingDataOrder,
} from '../../services/api';
import { Modal } from './Modal';
import { Button } from './Button';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const TEMPLATE = 'aviso_datos_envio';
const MIN_AGE_HOURS = 12;
const MIN_AGE_MS = MIN_AGE_HOURS * 60 * 60 * 1000;

interface BulkResult {
  sent: number;
  failed: number;
  skipped: number;
  failedList: { orderNumber: string; error: string }[];
}

// Botón con badge que muestra cuántos pedidos están pendientes de datos de
// envío (tienen comprobante = ya se les pidió + aún no cargaron). Abre un
// modal con la lista y permite mandar un recordatorio masivo (plantilla
// `aviso_datos_envio`).
export function PendingShippingDataBadge() {
  const navigate = useNavigate();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [orders, setOrders] = useState<PendingShippingDataOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Por default ocultamos pedidos de las últimas 12hs: pueden no haber visto
  // todavía el mensaje original `datos__envio` que se les manda al subir el
  // comprobante, así que mandarles un recordatorio es prematuro.
  const [onlyOlder, setOnlyOlder] = useState(true);

  const loadCount = useCallback(async () => {
    try {
      const response = await authFetch(`${API_BASE_URL}/orders/pending-shipping-data-count`);
      if (!response.ok) return;
      const data = await response.json();
      setCount(data.count ?? 0);
    } catch {
      // silencioso
    }
  }, []);

  useEffect(() => {
    loadCount();
    const interval = setInterval(loadCount, 60000);
    return () => clearInterval(interval);
  }, [loadCount]);

  const isOlderThanCutoff = useCallback((o: PendingShippingDataOrder) => {
    if (!o.fecha_pedido) return true; // sin fecha → no podemos descartarlo, lo dejamos
    const t = new Date(o.fecha_pedido).getTime();
    if (Number.isNaN(t)) return true;
    return Date.now() - t >= MIN_AGE_MS;
  }, []);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchPendingShippingDataList();
      setOrders(list);
      // Por default: todos los que tienen teléfono y cumplen el filtro de 12hs.
      const eligible = list.filter(o => o.customer_phone && isOlderThanCutoff(o));
      setSelected(new Set(eligible.map(o => o.order_number)));
    } catch (err: any) {
      setError(err?.message || 'Error al cargar pedidos');
    } finally {
      setLoading(false);
    }
  }, [isOlderThanCutoff]);

  const handleOpen = () => {
    setOpen(true);
    setResult(null);
    loadOrders();
  };

  const handleClose = () => {
    setOpen(false);
    setResult(null);
    setError(null);
  };

  const toggleOrder = (orderNumber: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(orderNumber)) next.delete(orderNumber);
      else next.add(orderNumber);
      return next;
    });
  };

  const visibleOrders = onlyOlder ? orders.filter(isOlderThanCutoff) : orders;
  const hiddenByFilter = orders.length - visibleOrders.length;

  const toggleAll = () => {
    const eligible = visibleOrders.filter(o => o.customer_phone).map(o => o.order_number);
    const allOn = eligible.length > 0 && eligible.every(n => selected.has(n));
    if (allOn) {
      // Sacar solo los visibles, conservar los demás (por si el usuario destildó/cambió filtro).
      setSelected(prev => {
        const next = new Set(prev);
        eligible.forEach(n => next.delete(n));
        return next;
      });
    } else {
      setSelected(prev => {
        const next = new Set(prev);
        eligible.forEach(n => next.add(n));
        return next;
      });
    }
  };

  const handleToggleFilter = () => {
    setOnlyOlder(prev => {
      const nextOnlyOlder = !prev;
      // Al cambiar el filtro, ajustamos la selección para reflejar lo que es
      // visible: si activamos el filtro, sacamos los que ahora se ocultan.
      setSelected(currentSelected => {
        if (nextOnlyOlder) {
          const next = new Set<string>();
          orders.forEach(o => {
            if (currentSelected.has(o.order_number) && isOlderThanCutoff(o)) {
              next.add(o.order_number);
            }
          });
          return next;
        }
        return currentSelected;
      });
      return nextOnlyOlder;
    });
  };

  const handleSend = async () => {
    const orderNumbers = Array.from(selected);
    if (orderNumbers.length === 0) {
      setError('Seleccioná al menos un pedido');
      return;
    }
    setError(null);
    setSending(true);
    setResult(null);
    try {
      const response = await authFetch(`${API_BASE_URL}/whatsapp/bulk-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: TEMPLATE, orderNumbers }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Error al enviar');
      setResult({
        sent: data.sent ?? 0,
        failed: data.failed ?? 0,
        skipped: data.skipped ?? 0,
        failedList: data.results?.failed ?? [],
      });
      // Refrescamos count y lista por si algún pedido cambió de estado.
      loadCount();
      loadOrders();
    } catch (err: any) {
      setError(err?.message || 'Error al enviar');
    } finally {
      setSending(false);
    }
  };

  const handleViewFullList = () => {
    setOpen(false);
    navigate('/pedidos?shipping_data=pending');
  };

  const visibleEligible = visibleOrders.filter(o => o.customer_phone);
  const allVisibleSelected = visibleEligible.length > 0 && visibleEligible.every(o => selected.has(o.order_number));

  return (
    <>
      <button
        onClick={handleOpen}
        className="relative p-2 text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 rounded-lg transition-colors"
        title="Pedidos pendientes de datos de envío"
      >
        <Truck size={20} />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center text-xs font-semibold text-white bg-amber-500 rounded-full px-1">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      <Modal
        isOpen={open}
        onClose={handleClose}
        title="Pendientes de datos de envío"
        size="lg"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2 text-sm text-neutral-600 bg-amber-50 border border-amber-100 rounded-lg p-3">
            <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              Estos pedidos ya tienen comprobante cargado y se les envió la plantilla
              <span className="font-mono text-xs bg-amber-100 px-1 mx-1 rounded">datos__envio</span>
              al subirlo, pero aún no completaron el formulario. El recordatorio usa la plantilla
              <span className="font-mono text-xs bg-amber-100 px-1 mx-1 rounded">{TEMPLATE}</span>.
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12 text-neutral-500">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Cargando pedidos…
            </div>
          ) : orders.length === 0 ? (
            <div className="py-8 text-center text-neutral-500 text-sm">
              No hay pedidos pendientes de datos de envío.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 text-sm">
                <label className="inline-flex items-center gap-2 cursor-pointer select-none text-neutral-700">
                  <input
                    type="checkbox"
                    checked={onlyOlder}
                    onChange={handleToggleFilter}
                    className="h-4 w-4 text-green-600 rounded"
                    disabled={sending}
                  />
                  Solo pedidos de hace ≥ {MIN_AGE_HOURS}hs
                  {onlyOlder && hiddenByFilter > 0 && (
                    <span className="text-xs text-neutral-500">
                      ({hiddenByFilter} ocultos)
                    </span>
                  )}
                </label>
              </div>

              <div className="flex items-center justify-between text-sm">
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-green-700 hover:text-green-800 font-medium disabled:opacity-50"
                  disabled={visibleEligible.length === 0}
                >
                  {allVisibleSelected ? 'Deseleccionar todos' : `Seleccionar todos (${visibleEligible.length})`}
                </button>
                <span className="text-neutral-500">
                  {selected.size} seleccionados de {visibleOrders.length}
                </span>
              </div>

              <div className="border border-neutral-200 rounded-lg max-h-96 overflow-y-auto divide-y divide-neutral-100">
                {visibleOrders.length === 0 ? (
                  <div className="py-6 text-center text-neutral-500 text-sm">
                    Todos los pedidos pendientes son de hace menos de {MIN_AGE_HOURS}hs. Destildá el filtro para verlos.
                  </div>
                ) : visibleOrders.map(o => {
                  const noPhone = !o.customer_phone;
                  const checked = selected.has(o.order_number);
                  const avisoSent = !!o.aviso_sent_at;
                  return (
                    <label
                      key={o.order_number}
                      className={`flex items-start gap-3 px-3 py-2.5 text-sm cursor-pointer hover:bg-neutral-50 ${noPhone ? 'opacity-60' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={noPhone || sending}
                        onChange={() => toggleOrder(o.order_number)}
                        className="mt-0.5 h-4 w-4 text-green-600 rounded"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-neutral-900">#{o.order_number}</span>
                          <span className="text-neutral-700 truncate">{o.customer_name || '—'}</span>
                          {avisoSent && (
                            <span className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">
                              recordatorio enviado
                            </span>
                          )}
                          {noPhone && (
                            <span className="inline-flex items-center gap-1 text-xs bg-red-50 text-red-700 px-2 py-0.5 rounded-full">
                              sin teléfono
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-neutral-500 mt-0.5 truncate">
                          {o.shipping_type || '—'}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </>
          )}

          {error && (
            <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">
              {error}
            </div>
          )}

          {result && (
            <div className="border border-neutral-200 rounded-lg p-3 space-y-1 text-sm">
              <div className="flex items-center gap-2 text-green-700 font-medium">
                <CheckCircle2 className="h-4 w-4" />
                Enviados: {result.sent}
              </div>
              {result.failed > 0 && (
                <div className="text-red-700">
                  Fallidos: {result.failed}
                  {result.failedList.length > 0 && (
                    <ul className="mt-1 ml-4 list-disc text-xs text-red-600 max-h-32 overflow-y-auto">
                      {result.failedList.map((f, i) => (
                        <li key={i}>#{f.orderNumber}: {f.error}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {result.skipped > 0 && (
                <div className="text-amber-700">Omitidos: {result.skipped}</div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-neutral-100">
            <button
              type="button"
              onClick={handleViewFullList}
              className="text-sm text-neutral-600 hover:text-neutral-900 inline-flex items-center gap-1"
            >
              <ExternalLink size={14} /> Ver listado completo
            </button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={handleClose} disabled={sending}>
                Cerrar
              </Button>
              <Button
                onClick={handleSend}
                disabled={sending || selected.size === 0 || orders.length === 0}
                className="bg-green-600 hover:bg-green-700"
              >
                {sending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Enviando…
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4 mr-2" />
                    Enviar recordatorio ({selected.size})
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}
