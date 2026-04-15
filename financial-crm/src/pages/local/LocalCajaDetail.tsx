import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Printer, DollarSign, Edit3, X, Trash2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import { Input } from '../../components/ui/Input';
import { ProductSearch } from '../../components/local/ProductSearch';
import { PrintableBoxOrder } from '../../components/local/PrintableBoxOrder';
import {
  fetchBoxOrderDetail, printBoxOrder, payBoxOrder, updateBoxOrder, cancelBoxOrder,
  type LocalBoxOrder, type LocalBoxOrderItem, type ProductSearchResult
} from '../../services/local-api';
import { AccessDenied } from '../../components/AccessDenied';

const PAYMENT_CONFIG: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' }> = {
  pendiente_pago: { label: 'Pendiente', variant: 'warning' },
  pagado_parcial: { label: 'Parcial', variant: 'info' },
  pagado_total: { label: 'Pagado', variant: 'success' },
};

const STATUS_CONFIG: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'cyan' | 'orange' }> = {
  borrador: { label: 'Borrador', variant: 'default' },
  impreso: { label: 'Impreso', variant: 'cyan' },
  pendiente_pago: { label: 'Pend. Pago', variant: 'warning' },
  pagado_parcial: { label: 'Parcial', variant: 'info' },
  pagado_total: { label: 'Pagado', variant: 'success' },
  cancelado: { label: 'Cancelado', variant: 'danger' },
};

interface EditItem {
  key: string;
  product_id: number;
  variant_id?: string;
  product_name: string;
  variant_name?: string;
  sku?: string;
  qty: number;
  unit_price: number;
}

export default function LocalCajaDetail() {
  const { id } = useParams<{ id: string }>();
  const { hasPermission } = useAuth();
  const navigate = useNavigate();

  const [order, setOrder] = useState<LocalBoxOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Pago
  const [showPayModal, setShowPayModal] = useState(false);
  const [payAmount, setPayAmount] = useState('');

  // Edición
  const [editMode, setEditMode] = useState(false);
  const [editItems, setEditItems] = useState<EditItem[]>([]);
  const [editNotes, setEditNotes] = useState('');

  // Impresión
  const [showPrint, setShowPrint] = useState(false);
  const [printData, setPrintData] = useState<{ order: LocalBoxOrder; items: LocalBoxOrderItem[] } | null>(null);
  const printRef = useRef<HTMLDivElement>(null);

  // Cancelar
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  if (!hasPermission('local.box.view')) return <AccessDenied />;

  const loadOrder = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await fetchBoxOrderDetail(id);
      setOrder(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadOrder(); }, [id]);

  const handlePrint = async () => {
    if (!id) return;
    setActionLoading('print');
    try {
      const data = await printBoxOrder(id);
      setPrintData(data);
      setShowPrint(true);
      await loadOrder();
      setTimeout(() => window.print(), 300);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setActionLoading(null);
    }
  };

  const handlePay = async () => {
    if (!id) return;
    const amount = parseFloat(payAmount);
    if (isNaN(amount) || amount <= 0) {
      setError('Monto inválido');
      return;
    }
    setActionLoading('pay');
    setError(null);
    try {
      await payBoxOrder(id, amount);
      setShowPayModal(false);
      setPayAmount('');
      await loadOrder();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setActionLoading(null);
    }
  };

  // Edición
  const startEdit = () => {
    if (!order?.items) return;
    setEditItems(order.items.map((i) => ({
      key: `${i.product_id}-${i.variant_id || 'null'}`,
      product_id: i.product_id,
      variant_id: i.variant_id || undefined,
      product_name: i.product_name_snapshot,
      variant_name: i.variant_name_snapshot || undefined,
      sku: i.sku_snapshot || undefined,
      qty: i.qty,
      unit_price: Number(i.unit_price),
    })));
    setEditNotes(order.notes || '');
    setEditMode(true);
  };

  const handleAddEditProduct = (product: ProductSearchResult) => {
    const key = `${product.product_id}-${product.variant_id || 'null'}`;
    const existing = editItems.find((i) => i.key === key);
    if (existing) {
      setEditItems(editItems.map((i) => i.key === key ? { ...i, qty: i.qty + 1 } : i));
    } else {
      setEditItems([...editItems, {
        key,
        product_id: product.product_id,
        variant_id: product.variant_id || undefined,
        product_name: product.product_name,
        variant_name: product.variant_name || undefined,
        sku: product.sku || undefined,
        qty: 1,
        unit_price: product.price || 0,
      }]);
    }
  };

  const handleSaveEdit = async () => {
    if (!id) return;
    setActionLoading('save-edit');
    setError(null);
    try {
      await updateBoxOrder(id, {
        items: editItems.map((i) => ({
          product_id: i.product_id,
          variant_id: i.variant_id,
          product_name: i.product_name,
          variant_name: i.variant_name,
          sku: i.sku,
          qty: i.qty,
          unit_price: i.unit_price,
        })),
        notes: editNotes,
      });
      setEditMode(false);
      await loadOrder();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="w-6 h-6 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!order) {
    return <div className="text-center py-16 text-neutral-500">Pedido no encontrado</div>;
  }

  const statusCfg = STATUS_CONFIG[order.status] || { label: order.status, variant: 'default' as const };
  const payCfg = PAYMENT_CONFIG[order.payment_status] || { label: order.payment_status, variant: 'default' as const };
  const remaining = Math.max(0, Number(order.total_amount) - Number(order.paid_amount));
  const canEdit = hasPermission('local.box.edit') && order.status !== 'cancelado';
  const canPrint = hasPermission('local.box.print');
  const canPay = hasPermission('local.box.pay') && order.payment_status !== 'pagado_total' && order.status !== 'cancelado';
  const canCancel = hasPermission('local.box.edit') && order.status !== 'cancelado';

  return (
    <div className="space-y-4">
      {showPrint && printData && (
        <div className="hidden print:block">
          <PrintableBoxOrder ref={printRef} order={printData.order} items={printData.items} />
        </div>
      )}

      <div className="print:hidden space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate('/local/caja')}>
            <ArrowLeft size={16} />
          </Button>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-neutral-900 font-mono">
                Caja #{order.local_box_order_number}
              </h1>
              <Badge variant={statusCfg.variant}>{statusCfg.label}</Badge>
              <Badge variant={payCfg.variant}>{payCfg.label}</Badge>
            </div>
            <p className="text-sm text-neutral-500 mt-0.5">
              Creado por {order.created_by_name} — {new Date(order.created_at).toLocaleDateString('es-AR')}
            </p>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 text-red-600 px-4 py-3 rounded-xl text-sm">{error}</div>
        )}

        {/* Acciones */}
        <div className="flex flex-wrap gap-2">
          {canEdit && !editMode && (
            <Button variant="secondary" size="sm" onClick={startEdit}>
              <Edit3 size={14} /> Editar
            </Button>
          )}
          {canPrint && (
            <Button variant="secondary" size="sm" onClick={handlePrint} isLoading={actionLoading === 'print'}>
              <Printer size={14} /> Imprimir
            </Button>
          )}
          {canPay && (
            <Button variant="success" size="sm" onClick={() => { setPayAmount(String(remaining.toFixed(2))); setShowPayModal(true); }}>
              <DollarSign size={14} /> Registrar Pago
            </Button>
          )}
          {canCancel && (
            <Button variant="danger" size="sm" onClick={() => setShowCancelConfirm(true)}>
              <X size={14} /> Cancelar
            </Button>
          )}
        </div>

        {/* Resumen financiero */}
        <div className="grid grid-cols-3 gap-3">
          <Card>
            <div className="text-xs text-neutral-500">Total</div>
            <div className="font-bold text-lg font-mono mt-0.5">${Number(order.total_amount).toLocaleString('es-AR')}</div>
          </Card>
          <Card>
            <div className="text-xs text-neutral-500">Pagado</div>
            <div className="font-bold text-lg font-mono text-emerald-700 mt-0.5">${Number(order.paid_amount).toLocaleString('es-AR')}</div>
          </Card>
          <Card>
            <div className="text-xs text-neutral-500">Pendiente</div>
            <div className={`font-bold text-lg font-mono mt-0.5 ${remaining > 0 ? 'text-amber-600' : 'text-neutral-400'}`}>
              ${remaining.toLocaleString('es-AR')}
            </div>
          </Card>
        </div>

        {order.notes && !editMode && (
          <Card>
            <div className="text-xs font-medium text-neutral-500 mb-1">Notas</div>
            <p className="text-sm text-neutral-700">{order.notes}</p>
          </Card>
        )}

        {/* Modo edición */}
        {editMode && (
          <Card>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-neutral-900">Editar Pedido</h3>
                <Button variant="ghost" size="sm" onClick={() => setEditMode(false)}>
                  <X size={14} /> Cancelar
                </Button>
              </div>

              <ProductSearch onSelect={handleAddEditProduct} />

              {editItems.length > 0 && (
                <div className="border border-neutral-200 rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-neutral-50 border-b border-neutral-200">
                      <tr>
                        <th className="px-4 py-2 text-left font-medium text-neutral-600">Producto</th>
                        <th className="px-4 py-2 text-center font-medium text-neutral-600 w-20">Qty</th>
                        <th className="px-4 py-2 text-right font-medium text-neutral-600 w-28">Precio</th>
                        <th className="px-4 py-2 text-right font-medium text-neutral-600 w-28">Total</th>
                        <th className="px-4 py-2 w-12"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {editItems.map((item) => (
                        <tr key={item.key} className="border-b border-neutral-100 last:border-0">
                          <td className="px-4 py-2 font-medium">
                            {item.product_name}
                            {item.variant_name && <span className="text-neutral-500 ml-1">— {item.variant_name}</span>}
                          </td>
                          <td className="px-4 py-2 text-center">
                            <input
                              type="number"
                              min={1}
                              value={item.qty}
                              onChange={(e) => setEditItems(editItems.map((i) => i.key === item.key ? { ...i, qty: parseInt(e.target.value) || 1 } : i))}
                              className="w-16 text-center border border-neutral-300 rounded-lg px-2 py-1 text-sm outline-none"
                            />
                          </td>
                          <td className="px-4 py-2 text-right">
                            <input
                              type="number"
                              min={0}
                              step={0.01}
                              value={item.unit_price}
                              onChange={(e) => setEditItems(editItems.map((i) => i.key === item.key ? { ...i, unit_price: parseFloat(e.target.value) || 0 } : i))}
                              className="w-24 text-right border border-neutral-300 rounded-lg px-2 py-1 text-sm font-mono outline-none"
                            />
                          </td>
                          <td className="px-4 py-2 text-right font-mono font-semibold">
                            ${(item.qty * item.unit_price).toLocaleString('es-AR')}
                          </td>
                          <td className="px-4 py-2 text-center">
                            <button onClick={() => setEditItems(editItems.filter((i) => i.key !== item.key))} className="text-red-400 hover:text-red-600">
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-neutral-50 border-t border-neutral-200">
                        <td colSpan={3} className="px-4 py-2 text-right font-semibold">TOTAL</td>
                        <td className="px-4 py-2 text-right font-mono font-bold">
                          ${editItems.reduce((s, i) => s + i.qty * i.unit_price, 0).toLocaleString('es-AR')}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">Notas</label>
                <textarea
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  rows={2}
                  className="w-full border border-neutral-300 rounded-xl px-4 py-2.5 text-sm outline-none resize-none"
                />
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setEditMode(false)}>Cancelar</Button>
                <Button onClick={handleSaveEdit} isLoading={actionLoading === 'save-edit'}>Guardar</Button>
              </div>
            </div>
          </Card>
        )}

        {/* Items (vista normal) */}
        {!editMode && order.items && (
          <Card padding="none">
            <div className="px-4 py-3 border-b border-neutral-200">
              <h3 className="font-semibold text-neutral-900">Ítems ({order.items.length})</h3>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 border-b border-neutral-200">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-neutral-600">Producto</th>
                  <th className="px-4 py-2 text-left font-medium text-neutral-600">Variante</th>
                  <th className="px-4 py-2 text-center font-medium text-neutral-600">Qty</th>
                  <th className="px-4 py-2 text-right font-medium text-neutral-600">Precio</th>
                  <th className="px-4 py-2 text-right font-medium text-neutral-600">Total</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => (
                  <tr key={item.id} className="border-b border-neutral-100 last:border-0">
                    <td className="px-4 py-2.5 font-medium">{item.product_name_snapshot}</td>
                    <td className="px-4 py-2.5 text-neutral-600">{item.variant_name_snapshot || '-'}</td>
                    <td className="px-4 py-2.5 text-center font-semibold">{item.qty}</td>
                    <td className="px-4 py-2.5 text-right font-mono">${Number(item.unit_price).toLocaleString('es-AR')}</td>
                    <td className="px-4 py-2.5 text-right font-mono font-semibold">${Number(item.line_total).toLocaleString('es-AR')}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-neutral-50 border-t border-neutral-200">
                  <td colSpan={4} className="px-4 py-2.5 text-right font-semibold">TOTAL</td>
                  <td className="px-4 py-2.5 text-right font-mono font-bold text-lg">${Number(order.total_amount).toLocaleString('es-AR')}</td>
                </tr>
              </tfoot>
            </table>
          </Card>
        )}

        {/* Logs */}
        {order.logs && order.logs.length > 0 && (
          <Card>
            <h3 className="font-semibold text-neutral-900 mb-3">Actividad</h3>
            <div className="space-y-1.5">
              {order.logs.map((log) => (
                <div key={log.id} className="flex items-center gap-2 text-xs text-neutral-600 py-1">
                  <span className="text-neutral-400 w-36 shrink-0">
                    {new Date(log.created_at).toLocaleString('es-AR')}
                  </span>
                  <span className="font-mono bg-neutral-100 px-1.5 py-0.5 rounded text-neutral-700">{log.action}</span>
                  <span className="text-neutral-500">por {log.username}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* Modal de pago */}
      <Modal isOpen={showPayModal} onClose={() => setShowPayModal(false)} title="Registrar Pago" size="sm">
        <div className="space-y-4">
          <div className="bg-neutral-50 rounded-xl p-3 text-sm">
            <div className="flex justify-between"><span>Total:</span><span className="font-mono font-bold">${Number(order.total_amount).toLocaleString('es-AR')}</span></div>
            <div className="flex justify-between"><span>Pagado:</span><span className="font-mono">${Number(order.paid_amount).toLocaleString('es-AR')}</span></div>
            <div className="flex justify-between font-bold border-t border-neutral-200 pt-1 mt-1"><span>Pendiente:</span><span className="font-mono">${remaining.toLocaleString('es-AR')}</span></div>
          </div>
          <Input
            label="Monto a pagar"
            type="number"
            step="0.01"
            value={payAmount}
            onChange={(e) => setPayAmount(e.target.value)}
            leftIcon={<DollarSign size={16} />}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowPayModal(false)}>Cancelar</Button>
            <Button variant="success" size="sm" onClick={handlePay} isLoading={actionLoading === 'pay'}>Registrar Pago</Button>
          </div>
        </div>
      </Modal>

      {/* Modal cancelar */}
      <Modal isOpen={showCancelConfirm} onClose={() => setShowCancelConfirm(false)} title="Cancelar Pedido" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-neutral-600">
            ¿Cancelar pedido #{order.local_box_order_number}? Se devolverá el stock al local.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowCancelConfirm(false)}>No</Button>
            <Button
              variant="danger"
              size="sm"
              isLoading={actionLoading === 'cancel'}
              onClick={async () => {
                setActionLoading('cancel');
                try {
                  await cancelBoxOrder(id!);
                  setShowCancelConfirm(false);
                  await loadOrder();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Error');
                } finally {
                  setActionLoading(null);
                }
              }}
            >
              Sí, cancelar
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
