/**
 * Página del QR del depósito (Fase 2 PR 4).
 *
 * URL: /q/:orderNumber — pública, sin auth ni Layout.
 *
 * Layout fijo:
 *   Pedido #XXXXX  -  ESTADO_ACTUAL
 *   [ CÓDIGO 4 dígitos ]
 *   [ CANT BULTOS ]    ← solo si requiresBultos
 *   [ BOTONES según estado ]
 *
 * El código se valida AL clickear, no antes. Cualquiera con el QR puede
 * ver el estado actual (read-only).
 */

import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';

interface ButtonDef {
  to: string;
  requiresBultos: boolean;
  selfTransition: boolean;
}

interface OrderData {
  order_number: string;
  estado_pedido: string;
  customer_name: string | null;
  bultos: number;
}

const STATUS_LABEL: Record<string, string> = {
  hoja_impresa:          'HOJA IMPRESA',
  en_preparacion:        'EN PREPARACIÓN',
  en_revision:           'EN REVISIÓN',
  pendiente_stock:       'PEND. STOCK',
  por_empaquetar:        'POR EMPAQUETAR',
  empaquetado:           'EMPAQUETADO',
  pendiente_datos_envio: 'PEND. DATOS ENVÍO',
  pendiente_retiro:      'PEND. RETIRO',
  por_enviar:            'POR ENVIAR',
  en_calle:              'EN CALLE',
  enviado:               'ENVIADO',
  retirado:              'RETIRADO',
  cancelado:             'CANCELADO',
  pendiente_pago:        'PEND. PAGO',
  a_imprimir:            'A IMPRIMIR',
};

const BUTTON_LABEL: Record<string, string> = {
  en_preparacion:  'EN PREPARACIÓN',
  en_revision:     'EN REVISIÓN',
  pendiente_stock: 'PEND. STOCK',
  por_empaquetar:  'POR EMPAQUETAR',
  empaquetado:     'EMPAQUETADO',
};

// Botones secundarios (chiquitos abajo). El resto son principales (grandes).
const SECONDARY_BUTTONS = new Set(['pendiente_stock']);

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

export function QrDeposito() {
  const { orderNumber } = useParams<{ orderNumber: string }>();
  const [order, setOrder] = useState<OrderData | null>(null);
  const [buttons, setButtons] = useState<ButtonDef[]>([]);
  const [codigo, setCodigo] = useState('');
  const [bultos, setBultos] = useState<number>(1);
  const [showBultosInput, setShowBultosInput] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = async () => {
    if (!orderNumber) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE_URL}/q/${orderNumber}`);
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || 'Error al cargar pedido');
        return;
      }
      setOrder(data.order);
      setButtons(data.buttons || []);
      setBultos(data.order.bultos || 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [orderNumber]);

  const handleTransition = async (toStatus: string, requiresBultos: boolean) => {
    if (!codigo || codigo.length !== 4) {
      setError('Ingresá tu código de 4 dígitos primero');
      return;
    }
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const body: Record<string, unknown> = { codigo, to_status: toStatus };
      if (requiresBultos) body.bultos = bultos;
      const r = await fetch(`${API_BASE_URL}/q/${orderNumber}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || 'Error al ejecutar');
        return;
      }
      setSuccess(`✓ ${data.empleado} → ${STATUS_LABEL[data.estado_final] || data.estado_final}`);
      setCodigo('');
      setShowBultosInput(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center p-6">
        <p className="text-neutral-500">Cargando…</p>
      </div>
    );
  }
  if (error && !order) {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center p-6">
        <div className="text-center">
          <p className="text-red-600 font-medium text-lg">{error}</p>
          <p className="text-neutral-500 text-sm mt-2">Pedido #{orderNumber}</p>
        </div>
      </div>
    );
  }
  if (!order) return null;

  const primary = buttons.filter(b => !SECONDARY_BUTTONS.has(b.to));
  const secondary = buttons.filter(b => SECONDARY_BUTTONS.has(b.to));
  const isEmpaquetado = order.estado_pedido === 'empaquetado';

  return (
    <div className="min-h-screen bg-neutral-50 p-4">
      <div className="max-w-md mx-auto space-y-4">
        {/* Header */}
        <div className="bg-white rounded-2xl shadow-sm p-5 text-center">
          <p className="text-xs uppercase tracking-wider text-neutral-500">Pedido</p>
          <p className="text-3xl font-bold text-neutral-900 mt-1">#{order.order_number}</p>
          {order.customer_name && (
            <p className="text-sm text-neutral-600 mt-1">{order.customer_name}</p>
          )}
          <div className="mt-3 inline-block px-4 py-1.5 bg-indigo-100 text-indigo-800 rounded-full text-sm font-semibold">
            {STATUS_LABEL[order.estado_pedido] || order.estado_pedido}
          </div>
          {order.bultos > 0 && (
            <p className="text-xs text-neutral-500 mt-2">
              {order.bultos} {order.bultos === 1 ? 'bulto' : 'bultos'}
            </p>
          )}
        </div>

        {/* Código */}
        <div className="bg-white rounded-2xl shadow-sm p-5">
          <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-2">
            Tu código
          </label>
          <input
            type="tel"
            inputMode="numeric"
            pattern="[0-9]{4}"
            maxLength={4}
            value={codigo}
            onChange={e => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="••••"
            className="w-full text-center text-3xl tracking-widest font-mono py-3 border-2 border-neutral-300 rounded-xl focus:border-indigo-500 focus:outline-none"
            autoComplete="off"
          />
        </div>

        {/* Error / success */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 text-center">
            {error}
          </div>
        )}
        {success && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-sm text-emerald-700 text-center font-medium">
            {success}
          </div>
        )}

        {/* Botones principales */}
        {primary.length > 0 && !isEmpaquetado && (
          <div className="space-y-3">
            {primary.map(btn => {
              return (
                <div key={btn.to} className="bg-white rounded-2xl shadow-sm p-5 space-y-3">
                  {btn.requiresBultos && (
                    <div>
                      <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-2">
                        Cantidad de bultos
                      </label>
                      <div className="flex items-center justify-center gap-3">
                        <button
                          type="button"
                          onClick={() => setBultos(Math.max(1, bultos - 1))}
                          className="w-12 h-12 rounded-full bg-neutral-200 text-2xl font-bold disabled:opacity-40"
                          disabled={submitting || bultos <= 1}
                        >−</button>
                        <span className="text-4xl font-bold w-16 text-center">{bultos}</span>
                        <button
                          type="button"
                          onClick={() => setBultos(Math.min(10, bultos + 1))}
                          className="w-12 h-12 rounded-full bg-neutral-200 text-2xl font-bold disabled:opacity-40"
                          disabled={submitting || bultos >= 10}
                        >+</button>
                      </div>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => handleTransition(btn.to, btn.requiresBultos)}
                    disabled={submitting || codigo.length !== 4}
                    className="w-full py-5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white text-xl font-bold rounded-2xl transition-colors"
                  >
                    {submitting ? 'Procesando…' : BUTTON_LABEL[btn.to] || btn.to.toUpperCase()}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Empaquetado: reconfigurar + reimprimir */}
        {isEmpaquetado && (
          <div className="space-y-3">
            {/* Reconfigurar bultos */}
            <div className="bg-white rounded-2xl shadow-sm p-5 space-y-3">
              {!showBultosInput ? (
                <button
                  type="button"
                  onClick={() => setShowBultosInput(true)}
                  disabled={submitting}
                  className="w-full py-4 bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300 text-white font-semibold rounded-xl transition-colors"
                >
                  RECONFIGURAR BULTOS
                </button>
              ) : (
                <>
                  <label className="block text-xs uppercase tracking-wider text-neutral-500 text-center">
                    Nueva cantidad de bultos
                  </label>
                  <div className="flex items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={() => setBultos(Math.max(1, bultos - 1))}
                      className="w-12 h-12 rounded-full bg-neutral-200 text-2xl font-bold disabled:opacity-40"
                      disabled={submitting || bultos <= 1}
                    >−</button>
                    <span className="text-4xl font-bold w-16 text-center">{bultos}</span>
                    <button
                      type="button"
                      onClick={() => setBultos(Math.min(10, bultos + 1))}
                      className="w-12 h-12 rounded-full bg-neutral-200 text-2xl font-bold disabled:opacity-40"
                      disabled={submitting || bultos >= 10}
                    >+</button>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => { setShowBultosInput(false); setBultos(order.bultos); }}
                      disabled={submitting}
                      className="flex-1 py-3 bg-neutral-200 text-neutral-700 rounded-xl"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={() => handleTransition('empaquetado', true)}
                      disabled={submitting || codigo.length !== 4 || bultos === order.bultos}
                      className="flex-1 py-3 bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300 text-white font-semibold rounded-xl"
                    >
                      Guardar
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Reimprimir — placeholder hasta PR 6 (impresora) */}
            <div className="bg-white rounded-2xl shadow-sm p-5">
              <button
                type="button"
                disabled
                className="w-full py-4 bg-neutral-200 text-neutral-400 font-semibold rounded-xl cursor-not-allowed"
              >
                REIMPRIMIR ETIQUETA DE BULTO
              </button>
              <p className="text-xs text-neutral-400 text-center mt-2">
                Disponible cuando esté la impresora barcode
              </p>
            </div>
          </div>
        )}

        {/* Botones secundarios (chiquitos abajo) */}
        {secondary.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm p-4">
            {secondary.map(btn => (
              <button
                key={btn.to}
                type="button"
                onClick={() => handleTransition(btn.to, btn.requiresBultos)}
                disabled={submitting || codigo.length !== 4}
                className="w-full py-2 text-sm text-amber-700 hover:text-amber-900 hover:bg-amber-50 rounded-lg disabled:opacity-50"
              >
                Pasar a {BUTTON_LABEL[btn.to] || btn.to}
              </button>
            ))}
          </div>
        )}

        {/* Estado terminal: no hay botones */}
        {buttons.length === 0 && (
          <div className="bg-white rounded-2xl shadow-sm p-6 text-center">
            <p className="text-neutral-500 text-sm">
              No hay acciones disponibles desde este estado.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
