import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Printer, Package, Truck, ClipboardCheck, Check, X, Edit3, Trash2, RotateCcw } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Modal } from '../../components/ui/Modal';
import { ProductSearch } from '../../components/local/ProductSearch';
import { PrintableLocalOrder } from '../../components/local/PrintableLocalOrder';
import {
  fetchLocalOrderDetail, printLocalOrder, packLocalOrder, shipLocalOrder,
  startControlLocalOrder, controlLocalOrder, confirmLocalOrder, cancelLocalOrder,
  updateLocalOrder,
  type LocalOrder, type LocalOrderItem, type ProductSearchResult
} from '../../services/local-api';
import { AccessDenied } from '../../components/AccessDenied';

const STATUS_CONFIG: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'cyan' | 'orange' }> = {
  reservado: { label: 'Reservado', variant: 'info' },
  impreso: { label: 'Impreso', variant: 'cyan' },
  armado: { label: 'Armado', variant: 'purple' },
  enviado: { label: 'Enviado', variant: 'orange' },
  en_control: { label: 'En Control', variant: 'warning' },
  con_diferencias: { label: 'Con Diferencias', variant: 'danger' },
  confirmado_local: { label: 'Confirmado', variant: 'success' },
  cancelado: { label: 'Cancelado', variant: 'default' },
};

interface EditItem {
  key: string;
  product_id: number;
  variant_id?: string;
  product_name: string;
  variant_name?: string;
  sku?: string;
  qty: number;
}

export default function LocalReservaDetail() {
  const { id } = useParams<{ id: string }>();
  const { hasPermission } = useAuth();
  const navigate = useNavigate();

  const [order, setOrder] = useState<LocalOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Control ciego
  const [controlMode, setControlMode] = useState(false);
  const [controlValues, setControlValues] = useState<Record<string, string>>({});
  const [controlResults, setControlResults] = useState<Record<string, 'ok' | 'error' | 'pendiente'>>({});
  const [controlSubmitted, setControlSubmitted] = useState(false);

  // Edición
  const [editMode, setEditMode] = useState(false);
  const [editItems, setEditItems] = useState<EditItem[]>([]);
  const [editNotes, setEditNotes] = useState('');

  // Impresión
  const [showPrint, setShowPrint] = useState(false);
  const [printData, setPrintData] = useState<{ order: LocalOrder; items: LocalOrderItem[]; version: number } | null>(null);
  const printRef = useRef<HTMLDivElement>(null);

  // Confirmación de cancelación
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  if (!hasPermission('local.orders.view')) return <AccessDenied />;

  const loadOrder = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await fetchLocalOrderDetail(id);
      setOrder(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadOrder(); }, [id]);

  const handleAction = async (action: string, fn: () => Promise<void>) => {
    setActionLoading(action);
    setError(null);
    try {
      await fn();
      await loadOrder();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setActionLoading(null);
    }
  };

  const handlePrint = async () => {
    if (!id) return;
    setActionLoading('print');
    try {
      const data = await printLocalOrder(id);
      setPrintData(data);
      setShowPrint(true);
      await loadOrder();
      setTimeout(() => window.print(), 300);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al imprimir');
    } finally {
      setActionLoading(null);
    }
  };

  // === Control ciego ===
  const handleStartControl = async () => {
    if (!id) return;
    await handleAction('start-control', async () => {
      await startControlLocalOrder(id);
      setControlMode(true);
      setControlValues({});
      setControlResults({});
      setControlSubmitted(false);
    });
  };

  const handleSubmitControl = async () => {
    if (!id || !order?.items) return;
    setActionLoading('control');
    setError(null);
    try {
      const items = order.items.map((item) => ({
        item_id: item.id,
        received_qty: parseInt(controlValues[item.id] || '0'),
      }));
      const result = await controlLocalOrder(id, items);

      const newResults: Record<string, 'ok' | 'error' | 'pendiente'> = {};
      for (const item of result.items) {
        newResults[item.item_id] = item.control_status as 'ok' | 'error';
      }
      setControlResults(newResults);
      setControlSubmitted(true);
      await loadOrder();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error en control');
    } finally {
      setActionLoading(null);
    }
  };

  const handleConfirm = () => {
    if (!id) return;
    handleAction('confirm', () => confirmLocalOrder(id));
  };

  // === Edición ===
  const startEdit = () => {
    if (!order?.items) return;
    setEditItems(order.items.map((i) => ({
      key: `${i.product_id}-${i.variant_id || 'null'}`,
      product_id: i.product_id,
      variant_id: i.variant_id || undefined,
      product_name: i.product_name_snapshot,
      variant_name: i.variant_name_snapshot || undefined,
      sku: i.sku_snapshot || undefined,
      qty: i.reserved_qty,
    })));
    setEditNotes(order.notes_internal || '');
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
      }]);
    }
  };

  const handleSaveEdit = async () => {
    if (!id) return;
    setActionLoading('save-edit');
    setError(null);
    try {
      await updateLocalOrder(id, {
        items: editItems.map((i) => ({
          product_id: i.product_id,
          variant_id: i.variant_id,
          product_name: i.product_name,
          variant_name: i.variant_name,
          sku: i.sku,
          qty: i.qty,
        })),
        notes_internal: editNotes,
      });
      setEditMode(false);
      await loadOrder();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar');
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
    return (
      <div className="text-center py-16 text-neutral-500">Reserva no encontrada</div>
    );
  }

  const statusConfig = STATUS_CONFIG[order.status] || { label: order.status, variant: 'default' as const };
  const canEdit = hasPermission('local.orders.edit') && !['enviado', 'en_control', 'con_diferencias', 'confirmado_local', 'cancelado'].includes(order.status);
  const canPrint = hasPermission('local.orders.print');
  const canPack = hasPermission('local.orders.pack') && ['impreso'].includes(order.status);
  const canShip = hasPermission('local.orders.ship') && order.status === 'armado';
  const canControl = hasPermission('local.orders.control') && ['enviado', 'con_diferencias'].includes(order.status);
  const canConfirmOrder = hasPermission('local.orders.confirm') && order.status === 'en_control';
  const canCancel = hasPermission('local.orders.cancel') && !['confirmado_local', 'cancelado'].includes(order.status);
  const allControlOk = order.items?.every((i) => i.control_status === 'ok') || false;

  return (
    <div className="space-y-4">
      {/* Print view (hidden, triggered by window.print) */}
      {showPrint && printData && (
        <div className="hidden print:block">
          <PrintableLocalOrder ref={printRef} order={printData.order} items={printData.items} version={printData.version} />
        </div>
      )}

      <div className="print:hidden space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate('/local/reservas')}>
            <ArrowLeft size={16} />
          </Button>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-neutral-900 font-mono">
                Reserva #{order.local_order_number}
              </h1>
              <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
            </div>
            <p className="text-sm text-neutral-500 mt-0.5">
              Creada por {order.created_by_name} — {new Date(order.created_at).toLocaleDateString('es-AR')}
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
              <Printer size={14} /> {order.print_count > 0 ? 'Reimprimir' : 'Imprimir'}
            </Button>
          )}
          {canPack && (
            <Button variant="secondary" size="sm" onClick={() => handleAction('pack', () => packLocalOrder(id!))} isLoading={actionLoading === 'pack'}>
              <Package size={14} /> Marcar Armado
            </Button>
          )}
          {canShip && (
            <Button size="sm" onClick={() => handleAction('ship', () => shipLocalOrder(id!))} isLoading={actionLoading === 'ship'}>
              <Truck size={14} /> Marcar Enviado
            </Button>
          )}
          {canControl && !controlMode && (
            <Button size="sm" onClick={handleStartControl} isLoading={actionLoading === 'start-control'}>
              <ClipboardCheck size={14} /> Iniciar Control
            </Button>
          )}
          {canConfirmOrder && allControlOk && (
            <Button variant="success" size="sm" onClick={handleConfirm} isLoading={actionLoading === 'confirm'}>
              <Check size={14} /> Confirmar Recepción
            </Button>
          )}
          {canCancel && (
            <Button variant="danger" size="sm" onClick={() => setShowCancelConfirm(true)}>
              <X size={14} /> Cancelar
            </Button>
          )}
        </div>

        {/* Info del pedido */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Impresiones', value: order.print_count || '0' },
            { label: 'Impreso', value: order.printed_at ? new Date(order.printed_at).toLocaleDateString('es-AR') : '-' },
            { label: 'Armado', value: order.packed_at ? new Date(order.packed_at).toLocaleDateString('es-AR') : '-' },
            { label: 'Enviado', value: order.shipped_at ? new Date(order.shipped_at).toLocaleDateString('es-AR') : '-' },
          ].map((info) => (
            <Card key={info.label}>
              <div className="text-xs text-neutral-500">{info.label}</div>
              <div className="font-semibold text-neutral-900 mt-0.5">{info.value}</div>
            </Card>
          ))}
        </div>

        {order.notes_internal && !editMode && (
          <Card>
            <div className="text-xs font-medium text-neutral-500 mb-1">Notas internas</div>
            <p className="text-sm text-neutral-700">{order.notes_internal}</p>
          </Card>
        )}

        {/* === MODO EDICIÓN === */}
        {editMode && (
          <Card>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-neutral-900">Editar Reserva</h3>
                <Button variant="ghost" size="sm" onClick={() => setEditMode(false)}>
                  <X size={14} /> Cancelar edición
                </Button>
              </div>

              <ProductSearch onSelect={handleAddEditProduct} />

              {editItems.length > 0 && (
                <div className="border border-neutral-200 rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-neutral-50 border-b border-neutral-200">
                      <tr>
                        <th className="px-4 py-2 text-left font-medium text-neutral-600">Producto</th>
                        <th className="px-4 py-2 text-left font-medium text-neutral-600">Variante</th>
                        <th className="px-4 py-2 text-center font-medium text-neutral-600 w-28">Qty</th>
                        <th className="px-4 py-2 w-12"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {editItems.map((item) => (
                        <tr key={item.key} className="border-b border-neutral-100 last:border-0">
                          <td className="px-4 py-2 font-medium">{item.product_name}</td>
                          <td className="px-4 py-2 text-neutral-600">{item.variant_name || '-'}</td>
                          <td className="px-4 py-2 text-center">
                            <input
                              type="number"
                              min={1}
                              value={item.qty}
                              onChange={(e) => setEditItems(editItems.map((i) => i.key === item.key ? { ...i, qty: parseInt(e.target.value) || 1 } : i))}
                              className="w-20 text-center border border-neutral-300 rounded-lg px-2 py-1 text-sm focus:ring-2 focus:ring-sky-200 focus:border-sky-400 outline-none"
                            />
                          </td>
                          <td className="px-4 py-2 text-center">
                            <button onClick={() => setEditItems(editItems.filter((i) => i.key !== item.key))} className="text-red-400 hover:text-red-600">
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">Notas internas</label>
                <textarea
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  rows={2}
                  className="w-full border border-neutral-300 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-sky-200 focus:border-sky-400 outline-none resize-none"
                />
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setEditMode(false)}>Cancelar</Button>
                <Button onClick={handleSaveEdit} isLoading={actionLoading === 'save-edit'}>Guardar Cambios</Button>
              </div>
            </div>
          </Card>
        )}

        {/* === CONTROL CIEGO === */}
        {controlMode && order.items && (
          <Card>
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold text-neutral-900">Control de Recepción</h3>
                <p className="text-sm text-neutral-500 mt-0.5">
                  Ingresá la cantidad recibida para cada ítem. No se muestra la cantidad esperada.
                </p>
              </div>

              <div className="border border-neutral-200 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-neutral-50 border-b border-neutral-200">
                    <tr>
                      <th className="px-4 py-2.5 text-left font-medium text-neutral-600">Producto</th>
                      <th className="px-4 py-2.5 text-left font-medium text-neutral-600">Variante</th>
                      <th className="px-4 py-2.5 text-center font-medium text-neutral-600 w-32">Cantidad Recibida</th>
                      <th className="px-4 py-2.5 text-center font-medium text-neutral-600 w-24">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.items.map((item) => {
                      const status = controlResults[item.id] || item.control_status;
                      return (
                        <tr key={item.id} className={`border-b border-neutral-100 last:border-0 ${
                          status === 'ok' ? 'bg-emerald-50' : status === 'error' ? 'bg-red-50' : ''
                        }`}>
                          <td className="px-4 py-2.5 font-medium text-neutral-900">{item.product_name_snapshot}</td>
                          <td className="px-4 py-2.5 text-neutral-600">{item.variant_name_snapshot || '-'}</td>
                          <td className="px-4 py-2.5 text-center">
                            <input
                              type="number"
                              min={0}
                              value={controlValues[item.id] || ''}
                              onChange={(e) => setControlValues({ ...controlValues, [item.id]: e.target.value })}
                              disabled={controlSubmitted && status === 'ok'}
                              placeholder="0"
                              className="w-24 text-center border border-neutral-300 rounded-lg px-2 py-1.5 text-sm font-medium focus:ring-2 focus:ring-sky-200 focus:border-sky-400 outline-none disabled:bg-neutral-100"
                            />
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            {status === 'ok' && (
                              <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                                <Check size={16} /> OK
                              </span>
                            )}
                            {status === 'error' && (
                              <span className="inline-flex items-center gap-1 text-red-600 font-semibold">
                                <X size={16} /> ERROR
                              </span>
                            )}
                            {status === 'pendiente' && (
                              <span className="text-neutral-400">-</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {controlSubmitted && !allControlOk && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
                  Hay diferencias en el control. Revisá los ítems marcados en rojo.
                </div>
              )}

              {controlSubmitted && allControlOk && (
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 px-4 py-3 rounded-xl text-sm">
                  Todo el control coincide. Podés confirmar la recepción.
                </div>
              )}

              <div className="flex justify-end gap-2">
                {!controlSubmitted && (
                  <Button onClick={handleSubmitControl} isLoading={actionLoading === 'control'}>
                    <ClipboardCheck size={14} /> Enviar Control
                  </Button>
                )}
                {controlSubmitted && !allControlOk && (
                  <Button variant="secondary" onClick={() => { setControlSubmitted(false); setControlValues({}); setControlResults({}); }}>
                    <RotateCcw size={14} /> Reintentar Control
                  </Button>
                )}
                {controlSubmitted && allControlOk && canConfirmOrder && (
                  <Button variant="success" onClick={handleConfirm} isLoading={actionLoading === 'confirm'}>
                    <Check size={14} /> Confirmar Recepción
                  </Button>
                )}
              </div>
            </div>
          </Card>
        )}

        {/* Items (vista normal) */}
        {!editMode && !controlMode && order.items && (
          <Card padding="none">
            <div className="px-4 py-3 border-b border-neutral-200">
              <h3 className="font-semibold text-neutral-900">Ítems ({order.items.length})</h3>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 border-b border-neutral-200">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-neutral-600">Producto</th>
                  <th className="px-4 py-2 text-left font-medium text-neutral-600">Variante</th>
                  <th className="px-4 py-2 text-left font-medium text-neutral-600">SKU</th>
                  <th className="px-4 py-2 text-center font-medium text-neutral-600">Reservado</th>
                  {order.status !== 'reservado' && (
                    <th className="px-4 py-2 text-center font-medium text-neutral-600">Enviado</th>
                  )}
                  {order.received_at && (
                    <>
                      <th className="px-4 py-2 text-center font-medium text-neutral-600">Recibido</th>
                      <th className="px-4 py-2 text-center font-medium text-neutral-600">Control</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => (
                  <tr key={item.id} className={`border-b border-neutral-100 last:border-0 ${
                    item.control_status === 'ok' ? 'bg-emerald-50' : item.control_status === 'error' ? 'bg-red-50' : ''
                  }`}>
                    <td className="px-4 py-2.5 font-medium text-neutral-900">{item.product_name_snapshot}</td>
                    <td className="px-4 py-2.5 text-neutral-600">{item.variant_name_snapshot || '-'}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-neutral-500">{item.sku_snapshot || '-'}</td>
                    <td className="px-4 py-2.5 text-center font-semibold">{item.reserved_qty}</td>
                    {order.status !== 'reservado' && (
                      <td className="px-4 py-2.5 text-center font-semibold">{item.sent_qty ?? '-'}</td>
                    )}
                    {order.received_at && (
                      <>
                        <td className="px-4 py-2.5 text-center font-semibold">{item.received_qty ?? '-'}</td>
                        <td className="px-4 py-2.5 text-center">
                          {item.control_status === 'ok' && <Badge variant="success" size="sm">OK</Badge>}
                          {item.control_status === 'error' && <Badge variant="danger" size="sm">Error</Badge>}
                          {item.control_status === 'pendiente' && <Badge variant="default" size="sm">Pendiente</Badge>}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {/* Historial de impresiones */}
        {order.prints && order.prints.length > 0 && (
          <Card>
            <h3 className="font-semibold text-neutral-900 mb-3">Historial de Impresiones</h3>
            <div className="space-y-2">
              {order.prints.map((print) => (
                <div key={print.id} className="flex items-center justify-between text-sm bg-neutral-50 px-3 py-2 rounded-lg">
                  <div>
                    <span className="font-medium">Versión #{print.print_version}</span>
                    <span className="text-neutral-500 ml-2">por {print.printed_by_name}</span>
                  </div>
                  <span className="text-neutral-500">{new Date(print.printed_at).toLocaleString('es-AR')}</span>
                </div>
              ))}
            </div>
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

      {/* Modal confirmar cancelación */}
      <Modal isOpen={showCancelConfirm} onClose={() => setShowCancelConfirm(false)} title="Cancelar Reserva" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-neutral-600">
            ¿Estás seguro de cancelar la reserva #{order.local_order_number}? Esta acción no se puede deshacer.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowCancelConfirm(false)}>No, volver</Button>
            <Button
              variant="danger"
              size="sm"
              isLoading={actionLoading === 'cancel'}
              onClick={async () => {
                await handleAction('cancel', () => cancelLocalOrder(id!));
                setShowCancelConfirm(false);
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
