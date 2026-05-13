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

interface OrderProduct {
  id: number;
  product_id: number | null;
  name: string;
  variant: string | null;
  sku: string | null;
  quantity: number;
}

interface StockMissingItem {
  order_product_id: number;
  quantity_missing: number;
}

// Label de estado para mensajes de éxito post-transición ("✓ Eli → ARMADO").
// 2026-05-13: en_revision se muestra como "ARMADO" porque para el depo
// "armado" es la acción real que ejecutan; "en revisión" es el estado interno.
// El chip del estado actual del pedido sí muestra "EN REVISIÓN (ARMADO)" para
// dar contexto técnico — ver línea del chip más abajo.
const STATUS_LABEL: Record<string, string> = {
  hoja_impresa:          'HOJA IMPRESA',
  en_preparacion:        'EN PREPARACIÓN',
  en_revision:           'ARMADO',
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

// Texto del botón de cada transición disponible en el flow QR.
const BUTTON_LABEL: Record<string, string> = {
  en_preparacion:  'EN PREPARACIÓN',
  en_revision:     'ARMADO',
  pendiente_stock: 'PEND. STOCK',
  por_empaquetar:  'POR EMPAQUETAR',
  empaquetado:     'EMPAQUETADO',
};

// Override de color por destino. Por default todos los botones son violeta
// (bg-indigo-600). Estos overrides ayudan al depo a identificar acciones
// distintas a primera vista (2026-05-13).
const BUTTON_COLOR_OVERRIDE: Record<string, string> = {
  en_revision:     'bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-300',
  pendiente_stock: 'bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300',
};
const DEFAULT_BUTTON_COLOR = 'bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300';

/**
 * Limpia el nombre del producto sacando un precio que venga al final entre
 * paréntesis, ej: "Combo Blanquería (250.000)" → "Combo Blanquería".
 * Solo matchea números con separador de miles (3+ dígitos con . o ,) para
 * no confundirse con tamaños o packs legítimos ("(180)", "(Pack x10)").
 */
function cleanProductName(name: string): string {
  return name.replace(/\s*\(\d{1,3}(?:[.,]\d{3})+\)\s*$/, '').trim();
}

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

export function QrDeposito() {
  const { orderNumber } = useParams<{ orderNumber: string }>();
  const [order, setOrder] = useState<OrderData | null>(null);
  const [buttons, setButtons] = useState<ButtonDef[]>([]);
  const [products, setProducts] = useState<OrderProduct[]>([]);
  const [codigo, setCodigo] = useState('');
  const [bultos, setBultos] = useState<number>(1);
  const [errorCount, setErrorCount] = useState<number>(0);
  const [showBultosInput, setShowBultosInput] = useState(false);
  const [showStockModal, setShowStockModal] = useState(false);
  // Map order_product_id -> quantity_missing (0 = no tildado).
  const [stockMissing, setStockMissing] = useState<Record<number, number>>({});
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
      setProducts(data.products || []);
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
    // Pendiente stock: abrir modal en vez de ejecutar directo (Fase 2 PR 4.5).
    // Hay que elegir qué productos faltan antes de confirmar la transición.
    if (toStatus === 'pendiente_stock') {
      // Inicializa el map con todos los productos sin tildar (qty=0).
      const init: Record<number, number> = {};
      products.forEach(p => { init[p.id] = 0; });
      setStockMissing(init);
      setShowStockModal(true);
      return;
    }
    await executeTransition({
      to_status: toStatus,
      bultos: requiresBultos ? bultos : undefined,
      error_count: order?.estado_pedido === 'en_revision' && errorCount > 0 ? errorCount : undefined,
    });
  };

  const executeTransition = async (extra: { to_status: string; bultos?: number; stock_missing?: StockMissingItem[]; error_count?: number }) => {
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const body: Record<string, unknown> = { codigo, ...extra };
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
      setErrorCount(0);
      setShowBultosInput(false);
      setShowStockModal(false);
      setStockMissing({});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de red');
    } finally {
      setSubmitting(false);
    }
  };

  const confirmStockMissing = () => {
    const items: StockMissingItem[] = Object.entries(stockMissing)
      .filter(([, qty]) => qty > 0)
      .map(([id, qty]) => ({ order_product_id: Number(id), quantity_missing: qty }));
    if (items.length === 0) {
      setError('Seleccioná al menos un producto faltante');
      return;
    }
    executeTransition({
      to_status: 'pendiente_stock',
      stock_missing: items,
      error_count: order?.estado_pedido === 'en_revision' && errorCount > 0 ? errorCount : undefined,
    });
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

  // 2026-05-13: todos los botones de transición ahora son del mismo tamaño,
  // diferenciados solo por color (ver BUTTON_COLOR_OVERRIDE).
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
            {order.estado_pedido === 'en_revision'
              ? 'EN REVISIÓN (ARMADO)'
              : (STATUS_LABEL[order.estado_pedido] || order.estado_pedido)}
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

        {/* Errores de revisión (solo en en_revision; opcional) */}
        {order.estado_pedido === 'en_revision' && (
          <div className="bg-white rounded-2xl shadow-sm p-5">
            <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-2 text-center">
              Errores en el armado
            </label>
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setErrorCount(Math.max(0, errorCount - 1))}
                className="w-12 h-12 rounded-full bg-neutral-200 text-2xl font-bold disabled:opacity-40"
                disabled={submitting || errorCount <= 0}
              >−</button>
              <span className={`text-4xl font-bold w-16 text-center ${errorCount > 0 ? 'text-red-600' : 'text-neutral-400'}`}>{errorCount}</span>
              <button
                type="button"
                onClick={() => setErrorCount(Math.min(100, errorCount + 1))}
                className="w-12 h-12 rounded-full bg-neutral-200 text-2xl font-bold disabled:opacity-40"
                disabled={submitting || errorCount >= 100}
              >+</button>
            </div>
            <p className="text-xs text-neutral-400 text-center mt-2">
              Si no hubo errores, dejá en 0.
            </p>
          </div>
        )}

        {/* Botones de transición — todos del mismo tamaño/tipografía, distintos por color */}
        {buttons.length > 0 && !isEmpaquetado && (
          <div className="space-y-3">
            {buttons.map(btn => {
              const colorCls = BUTTON_COLOR_OVERRIDE[btn.to] || DEFAULT_BUTTON_COLOR;
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
                    className={`w-full py-5 ${colorCls} text-white text-xl font-bold rounded-2xl transition-colors`}
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
                <>
                  <button
                    type="button"
                    onClick={() => setShowBultosInput(true)}
                    disabled={submitting || codigo.length !== 4}
                    className="w-full py-4 bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors"
                  >
                    RECONFIGURAR BULTOS
                  </button>
                  {codigo.length !== 4 && (
                    <p className="text-xs text-neutral-400 text-center mt-2">
                      Ingresá tu código primero
                    </p>
                  )}
                </>
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

        {/* Estado terminal: no hay botones */}
        {buttons.length === 0 && (
          <div className="bg-white rounded-2xl shadow-sm p-6 text-center">
            <p className="text-neutral-500 text-sm">
              No hay acciones disponibles desde este estado.
            </p>
          </div>
        )}
      </div>

      {/* Modal: productos faltantes (Fase 2 PR 4.5) */}
      {showStockModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex flex-col">
          <div className="bg-white flex-1 overflow-y-auto p-4 space-y-3 max-w-md mx-auto w-full">
            <div className="flex items-center justify-between pb-2 border-b border-neutral-200">
              <h2 className="text-lg font-bold">Productos faltantes</h2>
              <button
                type="button"
                onClick={() => { setShowStockModal(false); setError(null); }}
                disabled={submitting}
                className="text-neutral-500 hover:text-neutral-900 text-2xl"
              >×</button>
            </div>
            <p className="text-sm text-neutral-600">
              Marcá los productos que faltan y cuántas unidades de cada uno.
            </p>
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 text-center">
                {error}
              </div>
            )}
            <div className="space-y-2">
              {products.map(p => {
                const qty = stockMissing[p.id] || 0;
                const tildado = qty > 0;
                return (
                  <div key={p.id} className={`rounded-xl p-3 border-2 ${tildado ? 'border-amber-400 bg-amber-50' : 'border-neutral-200 bg-white'}`}>
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={tildado}
                        onChange={e => setStockMissing(prev => ({
                          ...prev,
                          // Default 1 al tildar — el depo sube manualmente si faltan más
                          // (antes default era p.quantity y bajaba, menos intuitivo).
                          [p.id]: e.target.checked ? 1 : 0,
                        }))}
                        className="mt-1 w-5 h-5 accent-amber-500"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{cleanProductName(p.name)}</p>
                        {p.sku && <p className="text-xs text-neutral-500 font-mono">{p.sku}</p>}
                        <p className="text-xs text-neutral-500">Pedido: {p.quantity} {p.quantity === 1 ? 'unidad' : 'unidades'}</p>
                      </div>
                    </label>
                    {tildado && (
                      <div className="mt-3 flex items-center justify-center gap-3 pt-3 border-t border-amber-200">
                        <span className="text-xs text-neutral-600">Faltan:</span>
                        <button
                          type="button"
                          onClick={() => setStockMissing(prev => ({ ...prev, [p.id]: Math.max(1, qty - 1) }))}
                          disabled={qty <= 1}
                          className="w-9 h-9 rounded-full bg-neutral-200 text-lg font-bold disabled:opacity-40"
                        >−</button>
                        <span className="text-2xl font-bold w-12 text-center">{qty}</span>
                        <button
                          type="button"
                          onClick={() => setStockMissing(prev => ({ ...prev, [p.id]: Math.min(p.quantity, qty + 1) }))}
                          disabled={qty >= p.quantity}
                          className="w-9 h-9 rounded-full bg-neutral-200 text-lg font-bold disabled:opacity-40"
                        >+</button>
                        <span className="text-xs text-neutral-500">/ {p.quantity}</span>
                      </div>
                    )}
                  </div>
                );
              })}
              {products.length === 0 && (
                <p className="text-sm text-neutral-500 text-center py-6">
                  Este pedido no tiene productos cargados.
                </p>
              )}
            </div>
            <div className="sticky bottom-0 bg-white pt-3 border-t border-neutral-200 flex gap-2">
              <button
                type="button"
                onClick={() => { setShowStockModal(false); setError(null); }}
                disabled={submitting}
                className="flex-1 py-3 bg-neutral-200 text-neutral-700 rounded-xl"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmStockMissing}
                disabled={submitting}
                className="flex-1 py-3 bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300 text-white font-semibold rounded-xl"
              >
                {submitting ? 'Procesando…' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
