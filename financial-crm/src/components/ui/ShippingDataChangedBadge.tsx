import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Printer, AlertTriangle, Loader2, ExternalLink } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import {
  fetchShippingDataChangedCount,
  fetchShippingDataChangedList,
  type ShippingDataChangedOrder,
} from '../../services/api';
import { Modal } from './Modal';
import { Button } from './Button';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// Boton con badge que muestra cuantos pedidos tienen datos de envio
// modificados despues de imprimir la etiqueta. La etiqueta fisica que se
// imprimio quedo desactualizada → la operadora reimprime, y queda registrado
// como reprint normal (suma a reprints_count, log en la tabla `logs`).
export function ShippingDataChangedBadge() {
  const navigate = useNavigate();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [orders, setOrders] = useState<ShippingDataChangedOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bultos, setBultos] = useState<Record<string, number>>({});
  const [printing, setPrinting] = useState(false);

  const loadCount = useCallback(async () => {
    try {
      const n = await fetchShippingDataChangedCount();
      setCount(n);
    } catch {
      // silencioso
    }
  }, []);

  useEffect(() => {
    loadCount();
    const interval = setInterval(loadCount, 60000);
    return () => clearInterval(interval);
  }, [loadCount]);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchShippingDataChangedList();
      setOrders(list);
      // Por default: todos seleccionados con 1 bulto.
      setSelected(new Set(list.map(o => o.order_number)));
      const initialBultos: Record<string, number> = {};
      list.forEach(o => { initialBultos[o.order_number] = 1; });
      setBultos(initialBultos);
    } catch {
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleOpen = () => {
    setOpen(true);
    loadOrders();
  };

  const handleClose = () => {
    setOpen(false);
  };

  const handleGoToOrder = (orderNumber: string) => {
    setOpen(false);
    navigate(`/pedidos/${orderNumber}`);
  };

  const toggleOrder = (orderNumber: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(orderNumber)) next.delete(orderNumber);
      else next.add(orderNumber);
      return next;
    });
  };

  const updateBultos = (orderNumber: string, value: number) => {
    setBultos(prev => ({
      ...prev,
      [orderNumber]: Math.max(1, Math.min(10, value))
    }));
  };

  const toggleAll = () => {
    if (selected.size === orders.length) setSelected(new Set());
    else setSelected(new Set(orders.map(o => o.order_number)));
  };

  // Reimprimir batch desde el modal: usa el mismo endpoint que el flujo
  // regular, pero con reprint=true para skipear el guard de "ya impresa"
  // sobre los pedidos con datos cambiados. Suma a reprints_count y queda
  // registrado en logs (etiqueta_impresa_N_bultos).
  const handlePrint = async () => {
    if (selected.size === 0) return;
    setPrinting(true);
    const token = localStorage.getItem('auth_token');
    try {
      const ordersList = Array.from(selected).map(orderNumber => ({
        orderNumber,
        bultos: bultos[orderNumber] || 1
      }));

      const response = await fetch(`${API_BASE_URL}/orders/shipping-labels-batch`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ orders: ordersList, reprint: true })
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: response.statusText }));
        alert(err.error || 'Error al generar etiquetas');
        return;
      }

      const generated = parseInt(response.headers.get('X-Labels-Generated') || '0', 10);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, '_blank');

      alert(`✅ ${generated} etiqueta(s) reimpresas. Quedan registradas como reimpresión.`);

      setOpen(false);
      // Refrescar count y lista para que desaparezcan los recién impresos.
      await loadCount();
    } catch (err) {
      console.error('Error reprint:', err);
      alert('Error al generar etiquetas');
    } finally {
      setPrinting(false);
    }
  };

  if (count === 0) return null;

  return (
    <>
      <button
        onClick={handleOpen}
        className="relative p-2 text-amber-600 hover:text-amber-700 hover:bg-amber-50 rounded-lg transition-colors"
        title={`${count} pedido(s) con datos modificados después de imprimir — requieren reimpresión manual`}
      >
        <Printer size={20} />
        <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center text-xs font-bold text-white bg-amber-500 rounded-full px-1">
          !
        </span>
      </button>

      <Modal
        isOpen={open}
        onClose={handleClose}
        title="Datos modificados después de imprimir"
        size="lg"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2 text-sm text-neutral-600 bg-amber-50 border border-amber-200 rounded-lg p-3">
            <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              Estos pedidos tienen la etiqueta impresa pero el cliente modificó los datos
              después. Reimprimí (suma como reimpresión y queda registrado en los logs) o
              entrá al detalle de cada pedido.
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12 text-neutral-500">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Cargando pedidos…
            </div>
          ) : orders.length === 0 ? (
            <div className="py-8 text-center text-neutral-500 text-sm">
              No hay pedidos con datos modificados post-impresión.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between text-sm">
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-amber-700 hover:text-amber-800 font-medium"
                >
                  {selected.size === orders.length ? 'Deseleccionar todos' : `Seleccionar todos (${orders.length})`}
                </button>
                <span className="text-neutral-500">
                  {selected.size} seleccionados
                </span>
              </div>

              <div className="border border-neutral-200 rounded-lg max-h-80 overflow-y-auto divide-y divide-neutral-100">
                {orders.map(o => {
                  const checked = selected.has(o.order_number);
                  return (
                    <div
                      key={o.order_number}
                      className="flex items-start gap-3 px-3 py-2.5 text-sm hover:bg-amber-50/50"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleOrder(o.order_number)}
                        disabled={printing}
                        className="mt-1 h-4 w-4 text-amber-600 rounded"
                      />
                      <button
                        type="button"
                        onClick={() => handleGoToOrder(o.order_number)}
                        className="flex-1 min-w-0 text-left"
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-neutral-900">#{o.order_number}</span>
                          <span className="text-neutral-700 truncate">{o.customer_name || '—'}</span>
                          {o.reprints_count > 0 && (
                            <span className="inline-flex items-center text-xs bg-neutral-100 text-neutral-600 px-2 py-0.5 rounded-full">
                              {o.reprints_count} reimpresión{o.reprints_count === 1 ? '' : 'es'}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-neutral-500 mt-0.5">
                          Modificada {formatDistanceToNow(new Date(o.data_updated_at), { addSuffix: true, locale: es })}
                          {' · '}
                          impresa {formatDistanceToNow(new Date(o.label_printed_at), { addSuffix: true, locale: es })}
                        </div>
                        <div className="text-xs text-neutral-400 mt-0.5 truncate">
                          {o.shipping_type || '—'}
                        </div>
                      </button>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => updateBultos(o.order_number, (bultos[o.order_number] || 1) - 1)}
                          disabled={printing || (bultos[o.order_number] || 1) <= 1}
                          className="w-7 h-7 rounded bg-neutral-100 hover:bg-neutral-200 disabled:opacity-40 flex items-center justify-center text-sm"
                        >
                          −
                        </button>
                        <input
                          type="number"
                          min="1"
                          max="10"
                          value={bultos[o.order_number] || 1}
                          onChange={(e) => updateBultos(o.order_number, parseInt(e.target.value) || 1)}
                          disabled={printing}
                          className="w-10 h-7 text-center border border-neutral-300 rounded text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => updateBultos(o.order_number, (bultos[o.order_number] || 1) + 1)}
                          disabled={printing || (bultos[o.order_number] || 1) >= 10}
                          className="w-7 h-7 rounded bg-neutral-100 hover:bg-neutral-200 disabled:opacity-40 flex items-center justify-center text-sm"
                        >
                          +
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleGoToOrder(o.order_number)}
                        className="p-1 text-neutral-400 hover:text-neutral-700"
                        title="Ir al detalle"
                      >
                        <ExternalLink size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-neutral-100">
            <Button variant="secondary" onClick={handleClose} disabled={printing}>
              Cerrar
            </Button>
            <Button
              onClick={handlePrint}
              disabled={printing || selected.size === 0 || orders.length === 0}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {printing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Generando…
                </>
              ) : (
                <>
                  <Printer className="h-4 w-4 mr-2" />
                  Reimprimir {selected.size} etiqueta{selected.size === 1 ? '' : 's'}
                </>
              )}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
