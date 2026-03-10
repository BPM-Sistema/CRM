import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  RefreshCw,
  AlertCircle,
  Banknote,
  Check,
  CheckCircle,
  Loader2,
  FileText,
  Phone,
  Mail,
  Printer,
  Truck,
  MapPin,
  UserCheck,
  Package,
  ShoppingBag,
  Download,
  Image,
  MessageCircle,
} from 'lucide-react';
import { getEventConfig, formatEventLabel } from '../utils/eventConfig';
import { Header } from '../components/layout';
import { Button, Card, PaymentStatusBadge, OrderStatusBadge, Modal, Input } from '../components/ui';
import { PrintableOrder } from '../components/orders';
import {
  fetchOrderDetail,
  fetchOrderPrintData,
  registerCashPayment,
  updateOrderStatus,
  resyncOrder,
  fetchShippingRequest,
  fetchRemitoByOrder,
  getShippingLabelUrl,
  ApiOrderDetail,
  ApiOrderPrintData,
  ShippingRequest,
  Remito,
  mapEstadoPago,
  mapEstadoPedido,
  OrderStatus,
  getTotalUnits,
} from '../services/api';
import { formatDistanceToNow, format } from 'date-fns';
import { es } from 'date-fns/locale';
import { useAuth } from '../contexts/AuthContext';

export function RealOrderDetail() {
  const { orderNumber } = useParams<{ orderNumber: string }>();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();

  const [data, setData] = useState<ApiOrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Estado para pago en efectivo
  const [isCashModalOpen, setIsCashModalOpen] = useState(false);
  const [cashAmount, setCashAmount] = useState('');
  const [isSubmittingCash, setIsSubmittingCash] = useState(false);
  const [cashError, setCashError] = useState<string | null>(null);
  const [cashSuccess, setCashSuccess] = useState<string | null>(null);

  // Estado para actualizar estado del pedido
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);

  // Estado para impresión
  const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);
  const [printData, setPrintData] = useState<ApiOrderPrintData | null>(null);
  const [isLoadingPrint, setIsLoadingPrint] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  // Estado para resync
  const [isResyncing, setIsResyncing] = useState(false);

  // Estado para datos de envío (shipping label)
  const [shippingRequest, setShippingRequest] = useState<ShippingRequest | null>(null);
  const [bultos, setBultos] = useState(1);

  // Estado para remito asociado
  const [remito, setRemito] = useState<Remito | null>(null);
  const [showRemitoModal, setShowRemitoModal] = useState(false);

  const loadOrder = async () => {
    if (!orderNumber) return;

    setLoading(true);
    setError(null);
    try {
      const [orderData, shippingData, remitoData] = await Promise.all([
        fetchOrderDetail(orderNumber),
        fetchShippingRequest(orderNumber),
        fetchRemitoByOrder(orderNumber),
      ]);
      setData(orderData);
      setShippingRequest(shippingData);
      setRemito(remitoData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar pedido');
    } finally {
      setLoading(false);
    }
  };

  const handleResync = async () => {
    if (!orderNumber || isResyncing) return;

    setIsResyncing(true);
    setError(null);
    try {
      await resyncOrder(orderNumber);
      await loadOrder();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al sincronizar');
    } finally {
      setIsResyncing(false);
    }
  };

  useEffect(() => {
    loadOrder();
  }, [orderNumber]);

  const formatCurrency = (amount: number | null) => {
    if (amount === null) return '-';
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
    }).format(amount);
  };

  const handleCashPayment = async () => {
    if (!orderNumber || !cashAmount || Number(cashAmount) <= 0) {
      setCashError('Ingresá un monto válido');
      return;
    }

    setIsSubmittingCash(true);
    setCashError(null);
    setCashSuccess(null);

    try {
      await registerCashPayment(orderNumber, Number(cashAmount));
      setCashSuccess(`Pago de ${formatCurrency(Number(cashAmount))} registrado correctamente`);
      setCashAmount('');

      setTimeout(() => {
        setIsCashModalOpen(false);
        setCashSuccess(null);
        loadOrder();
      }, 2000);

    } catch (error) {
      setCashError(error instanceof Error ? error.message : 'Error al registrar pago');
    } finally {
      setIsSubmittingCash(false);
    }
  };

  const handleUpdateOrderStatus = async (newStatus: OrderStatus) => {
    if (!orderNumber) return;

    setIsUpdatingStatus(true);
    try {
      await updateOrderStatus(orderNumber, newStatus);
      await loadOrder();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Error al actualizar estado');
    } finally {
      setIsUpdatingStatus(false);
    }
  };

  // Manejar impresión de pedido
  const handlePrintOrder = async () => {
    if (!orderNumber) return;

    setIsLoadingPrint(true);
    try {
      const data = await fetchOrderPrintData(orderNumber);
      setPrintData(data);
      setIsPrintModalOpen(true);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Error al obtener datos de impresión');
    } finally {
      setIsLoadingPrint(false);
    }
  };

  // Confirmar impresión - abre en nueva pestaña
  const handleConfirmPrint = async () => {
    // 1. Abrir nueva pestaña primero
    const printWindow = window.open(`/orders/print?orders=${orderNumber}`, '_blank');

    // 2. Verificar si se abrió (puede estar bloqueado)
    if (!printWindow) {
      alert('Permite las ventanas emergentes para imprimir');
      return;
    }

    // 3. Actualizar estado si corresponde
    if (data?.order.estado_pedido === 'a_imprimir' && orderNumber) {
      try {
        await updateOrderStatus(orderNumber, 'hoja_impresa');
      } catch (error) {
        console.error('Error al actualizar estado:', error);
      }
    }

    // 4. Cerrar modal y recargar datos
    setIsPrintModalOpen(false);
    setPrintData(null);
    loadOrder();
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <RefreshCw size={32} className="animate-spin text-neutral-400" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="text-center py-8 px-12">
          <AlertCircle size={48} className="mx-auto text-red-400 mb-4" />
          <h3 className="text-lg font-semibold text-neutral-900 mb-2">
            {error || 'Pedido no encontrado'}
          </h3>
          <div className="flex gap-3 justify-center mt-4">
            <Button variant="secondary" onClick={() => navigate('/orders')}>
              Volver
            </Button>
            <Button onClick={loadOrder}>Reintentar</Button>
          </div>
        </Card>
      </div>
    );
  }

  const { order, comprobantes, pagos_efectivo, logs, productos, has_inconsistency, inconsistencies } = data;
  const saldoPendiente = (order.monto_tiendanube || 0) - (order.total_pagado || 0);
  const paymentStatus = mapEstadoPago(order.estado_pago);
  const orderStatus = mapEstadoPedido(order.estado_pedido);
  const totalPagos = comprobantes.length + pagos_efectivo.length;

  // Lógica de permisos (RBAC + reglas de negocio)
  const canRegisterPayment = hasPermission('orders.create_cash_payment') && saldoPendiente > 0 && paymentStatus !== 'rechazado';

  // Lógica de impresión:
  // - Pedidos normales: solo necesitan comprobante válido
  // - Pedidos con "Expreso a elección" o "Via Cargo": también necesitan datos de envío
  const hasValidPayment = ['a_confirmar', 'parcial', 'total'].includes(paymentStatus);
  const shippingTypeLower = (order.shipping_type || '').toLowerCase();
  // Detectar tipos de envío que requieren formulario /envio (igual que backend)
  const requiresShippingData =
    (shippingTypeLower.includes('expreso') && shippingTypeLower.includes('elec')) ||
    shippingTypeLower.includes('via cargo') ||
    shippingTypeLower.includes('viacargo');
  const canPrint = hasValidPayment && (!requiresShippingData || shippingRequest !== null);

  const canShip = paymentStatus === 'total';

  return (
    <div className="min-h-screen">
      <Header
        title={
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/orders')}
              className="p-1 -ml-1 text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 rounded-lg transition-colors"
            >
              <ArrowLeft size={20} />
            </button>
            <span>Pedido #{order.order_number}</span>
          </div>
        }
        subtitle={`Creado ${formatDistanceToNow(new Date(order.created_at), { addSuffix: true, locale: es })}`}
        actions={
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<RefreshCw size={14} className={isResyncing ? 'animate-spin' : ''} />}
            onClick={handleResync}
            disabled={isResyncing}
          >
            {isResyncing ? 'Sincronizando...' : 'Actualizar'}
          </Button>
        }
      />

      <div className="p-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Columna izquierda */}
          <div className="lg:col-span-2 space-y-6">
            {/* Resumen del pedido */}
            <Card>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-semibold text-neutral-900">Resumen del Pedido</h3>
                <div className="flex gap-2">
                  <PaymentStatusBadge status={paymentStatus} />
                  <OrderStatusBadge status={orderStatus} />
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 bg-neutral-50 rounded-xl">
                  <p className="text-xs text-neutral-500 uppercase tracking-wider">Total</p>
                  <p className="text-lg font-semibold text-neutral-900 mt-1">
                    {formatCurrency(order.monto_tiendanube)}
                  </p>
                </div>
                <div className="p-4 bg-neutral-50 rounded-xl">
                  <p className="text-xs text-neutral-500 uppercase tracking-wider">Pagado</p>
                  <p className="text-lg font-semibold text-emerald-600 mt-1">
                    {formatCurrency(order.total_pagado)}
                  </p>
                </div>
                <div className="p-4 bg-neutral-50 rounded-xl">
                  <p className="text-xs text-neutral-500 uppercase tracking-wider">Saldo</p>
                  <p className={`text-lg font-semibold mt-1 ${saldoPendiente > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                    {formatCurrency(order.saldo)}
                  </p>
                </div>
                <div className="p-4 bg-neutral-50 rounded-xl">
                  <p className="text-xs text-neutral-500 uppercase tracking-wider">Pagos</p>
                  <p className="text-lg font-semibold text-neutral-900 mt-1">
                    {totalPagos}
                  </p>
                </div>
              </div>
            </Card>

            {/* Alerta de inconsistencia con TiendaNube */}
            {has_inconsistency && inconsistencies.length > 0 && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-xl">
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-red-500 flex-shrink-0 mt-0.5" size={20} />
                  <div className="flex-1">
                    <h4 className="font-semibold text-red-800">
                      Inconsistencia detectada con TiendaNube
                    </h4>
                    <p className="text-sm text-red-700 mt-1">
                      Los productos de este pedido no coinciden con los datos de TiendaNube:
                    </p>
                    <ul className="mt-2 space-y-1 text-sm text-red-700">
                      {inconsistencies.map((inc) => (
                        <li key={inc.id} className="flex items-start gap-2">
                          <span className="text-red-400">•</span>
                          <span>
                            {inc.type === 'product_missing' && `Producto faltante: ${inc.detail.name || 'ID: ' + inc.detail.product_id}`}
                            {inc.type === 'product_extra' && `Producto extra en DB: ${inc.detail.name || 'ID: ' + inc.detail.product_id}`}
                            {inc.type === 'quantity_mismatch' && `Cantidad incorrecta en "${inc.detail.name}": DB tiene ${inc.detail.quantity_db}, TN tiene ${inc.detail.quantity_tn}`}
                            {inc.type === 'total_mismatch' && `Total de unidades: DB tiene ${inc.detail.total_db}, TN tiene ${inc.detail.total_tn}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {/* Productos */}
            {productos && productos.length > 0 && (
              <Card>
                <h3 className="text-base font-semibold text-neutral-900 mb-4">
                  <div className="flex items-center gap-2">
                    <ShoppingBag size={18} />
                    Productos ({getTotalUnits(productos)} unidades)
                  </div>
                </h3>
                <div className="space-y-2">
                  {productos.map((producto) => (
                    <div
                      key={producto.id}
                      className="flex items-center justify-between p-3 bg-neutral-50 rounded-xl"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-neutral-900 truncate">
                          {producto.name}
                        </p>
                        {producto.variant && (
                          <p className="text-xs text-neutral-500">
                            {producto.variant}
                          </p>
                        )}
                        {producto.sku && (
                          <p className="text-xs text-neutral-400 font-mono">
                            SKU: {producto.sku}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-4 ml-4">
                        <div className="text-center">
                          <p className="text-xs text-neutral-500">Cantidad</p>
                          <p className="font-semibold text-neutral-900">{producto.quantity}</p>
                        </div>
                        <div className="text-right min-w-[80px]">
                          <p className="text-xs text-neutral-500">Subtotal</p>
                          <p className="font-semibold text-neutral-900">
                            {formatCurrency(producto.total)}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Pagos */}
            <Card>
              <h3 className="text-base font-semibold text-neutral-900 mb-4">
                Pagos ({totalPagos})
              </h3>
              {totalPagos === 0 ? (
                <div className="text-center py-8 text-neutral-500">
                  No hay pagos registrados
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Comprobantes (Transferencias) */}
                  {comprobantes.length > 0 && (
                    <>
                      <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
                        Transferencias ({comprobantes.length})
                      </p>
                      {comprobantes.map((comp) => (
                        <div
                          key={`comp-${comp.id}`}
                          className="flex items-center justify-between p-4 bg-neutral-50 rounded-xl cursor-pointer hover:bg-neutral-100 transition-colors"
                          onClick={() => navigate(`/receipts/${comp.id}`)}
                        >
                          <div className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-blue-100">
                              <FileText size={20} className="text-blue-600" />
                            </div>
                            <div>
                              <p className="font-medium text-neutral-900">
                                {formatCurrency(comp.monto)}
                              </p>
                              <p className="text-xs text-neutral-500">
                                Transferencia · {comp.estado}
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-sm text-neutral-500">
                              {format(new Date(comp.created_at), 'dd/MM/yyyy HH:mm', { locale: es })}
                            </p>
                            {comp.registrado_por && (
                              <p className="text-xs text-neutral-400">
                                por {comp.registrado_por}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                    </>
                  )}

                  {/* Pagos en Efectivo */}
                  {pagos_efectivo.length > 0 && (
                    <>
                      <p className={`text-xs font-medium text-neutral-500 uppercase tracking-wider ${comprobantes.length > 0 ? 'mt-4' : ''}`}>
                        Pagos en Efectivo ({pagos_efectivo.length})
                      </p>
                      {pagos_efectivo.map((pago) => (
                        <div
                          key={`efectivo-${pago.id}`}
                          className="flex items-center justify-between p-4 bg-neutral-50 rounded-xl"
                        >
                          <div className="flex items-center gap-3">
                            <div className="p-2 rounded-lg bg-green-100">
                              <Banknote size={20} className="text-green-600" />
                            </div>
                            <div>
                              <p className="font-medium text-neutral-900">
                                {formatCurrency(pago.monto)}
                              </p>
                              <p className="text-xs text-neutral-500">
                                Efectivo · confirmado
                              </p>
                              {pago.notas && (
                                <p className="text-xs text-neutral-400 mt-0.5">
                                  {pago.notas}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-sm text-neutral-500">
                              {format(new Date(pago.created_at), 'dd/MM/yyyy HH:mm', { locale: es })}
                            </p>
                            {pago.registrado_por && (
                              <p className="text-xs text-neutral-400">
                                por {pago.registrado_por}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </Card>

            {/* Historial */}
            <Card>
              <h3 className="text-base font-semibold text-neutral-900 mb-4">
                Historial ({logs.length})
              </h3>
              {logs.length === 0 ? (
                <div className="text-center py-8 text-neutral-500">
                  No hay actividad registrada
                </div>
              ) : (
                <div className="space-y-3">
                  {logs.map((log) => {
                    const eventConfig = getEventConfig(log.accion);
                    return (
                      <div key={log.id} className="flex items-start gap-3">
                        <div className={`w-8 h-8 ${eventConfig.color} rounded-full flex items-center justify-center text-base`}>
                          {eventConfig.emoji}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-neutral-900 whitespace-pre-line">{formatEventLabel(log.accion)}</p>
                          <p className="text-xs text-neutral-500">
                            {format(new Date(log.created_at), 'dd/MM/yyyy HH:mm', { locale: es })} · {log.origen}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>

          {/* Columna derecha */}
          <div className="space-y-6">
            {/* Cliente */}
            <Card>
              <h3 className="text-base font-semibold text-neutral-900 mb-4">Cliente</h3>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center text-white font-medium">
                    {order.customer_name ? order.customer_name.split(' ').map((n: string) => n[0]).join('').slice(0, 2) : '??'}
                  </div>
                  <div>
                    <div className="font-medium text-neutral-900">{order.customer_name || 'Sin nombre'}</div>
                    <div className="text-sm text-neutral-500">Cliente</div>
                  </div>
                </div>
                {(order.customer_email || order.customer_phone) && (
                  <div className="space-y-2 pt-2">
                    {order.customer_email && (
                      <a
                        href={`mailto:${order.customer_email}`}
                        className="flex items-center gap-2 text-sm text-neutral-600 hover:text-neutral-900"
                      >
                        <Mail size={14} />
                        {order.customer_email}
                      </a>
                    )}
                    {order.customer_phone && (
                      <a
                        href={`tel:${order.customer_phone}`}
                        className="flex items-center gap-2 text-sm text-neutral-600 hover:text-neutral-900"
                      >
                        <Phone size={14} />
                        {order.customer_phone}
                      </a>
                    )}
                  </div>
                )}
              </div>
            </Card>

            {/* WhatsApp */}
            {order.customer_phone && hasPermission('inbox.view') && (
              <Card>
                <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-3">
                  WhatsApp
                </h3>
                <div className="space-y-2">
                  <Button
                    variant="primary"
                    className="w-full"
                    leftIcon={<MessageCircle size={16} />}
                    onClick={() => navigate(`/inbox?phone=${encodeURIComponent(order.customer_phone!)}`)}
                  >
                    Abrir Inbox
                  </Button>
                </div>
              </Card>
            )}

            {/* Acciones de pago */}
            {canRegisterPayment && (
              <Card>
                <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-3">
                  Registrar Pago
                </h3>
                <div className="space-y-3">
                  <p className="text-sm text-neutral-600">
                    Saldo pendiente: <span className="font-semibold text-red-600">{formatCurrency(saldoPendiente)}</span>
                  </p>
                  <Button
                    variant="primary"
                    className="w-full"
                    size="lg"
                    leftIcon={<Banknote size={18} />}
                    onClick={() => {
                      setCashAmount('');
                      setCashError(null);
                      setCashSuccess(null);
                      setIsCashModalOpen(true);
                    }}
                  >
                    Registrar Pago en Efectivo
                  </Button>
                </div>
              </Card>
            )}

            {/* Estado del Pedido - Acciones */}
            <Card>
              <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-3">Estado del Pedido</h3>
              <div className="space-y-3">
                {/* Pendiente de pago */}
                {orderStatus === 'pendiente_pago' && (
                  <>
                    {canPrint ? (
                      <Button
                        variant="primary"
                        className="w-full"
                        size="lg"
                        leftIcon={isLoadingPrint ? <Loader2 size={18} className="animate-spin" /> : <Printer size={18} />}
                        onClick={handlePrintOrder}
                        disabled={isLoadingPrint}
                      >
                        {isLoadingPrint ? 'Cargando...' : 'Imprimir Hoja de Pedido'}
                      </Button>
                    ) : (
                      <div className="p-4 bg-amber-50 rounded-xl text-center">
                        <p className="text-sm text-amber-700">
                          {!hasValidPayment
                            ? 'Esperando comprobante de pago para poder imprimir.'
                            : 'Esperando datos de envío para poder imprimir (Expreso a elección / Via Cargo).'}
                        </p>
                      </div>
                    )}
                  </>
                )}

                {/* A imprimir */}
                {orderStatus === 'a_imprimir' && (
                  <>
                    {canPrint ? (
                      <Button
                        variant="primary"
                        className="w-full"
                        size="lg"
                        leftIcon={isLoadingPrint ? <Loader2 size={16} className="animate-spin" /> : <Printer size={16} />}
                        onClick={handlePrintOrder}
                        disabled={isLoadingPrint}
                      >
                        {order.printed_at ? 'Re-imprimir Hoja' : 'Imprimir Hoja'}
                      </Button>
                    ) : (
                      <div className="p-4 bg-amber-50 rounded-xl text-center">
                        <p className="text-sm text-amber-700">
                          Esperando datos de envío para poder imprimir (Expreso a elección / Via Cargo).
                        </p>
                      </div>
                    )}
                  </>
                )}

                {/* Etiqueta impresa */}
                {orderStatus === 'hoja_impresa' && (
                  <>
                    <Button
                      variant="secondary"
                      className="w-full mb-2"
                      leftIcon={isLoadingPrint ? <Loader2 size={16} className="animate-spin" /> : <Printer size={16} />}
                      onClick={handlePrintOrder}
                      disabled={isLoadingPrint}
                    >
                      Re-imprimir Hoja
                    </Button>
                    <Button
                      variant="primary"
                      className="w-full"
                      size="lg"
                      leftIcon={<Package size={18} />}
                      onClick={() => handleUpdateOrderStatus('armado')}
                      disabled={isUpdatingStatus}
                    >
                      {isUpdatingStatus ? 'Procesando...' : 'Marcar como Armado'}
                    </Button>
                  </>
                )}

                {/* Armado */}
                {orderStatus === 'armado' && (
                  <>
                    <Button
                      variant="secondary"
                      className="w-full mb-3"
                      leftIcon={isLoadingPrint ? <Loader2 size={16} className="animate-spin" /> : <Printer size={16} />}
                      onClick={handlePrintOrder}
                      disabled={isLoadingPrint}
                    >
                      Re-imprimir Hoja
                    </Button>
                    {!canShip && (
                      <div className="p-3 bg-amber-50 rounded-xl text-center mb-3">
                        <p className="text-xs text-amber-700">
                          Para enviar/retirar, el pago debe estar confirmado como "Total"
                        </p>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <Button
                        variant="primary"
                        className="w-full"
                        leftIcon={<UserCheck size={16} />}
                        onClick={() => handleUpdateOrderStatus('retirado')}
                        disabled={isUpdatingStatus || !canShip}
                      >
                        Retirado
                      </Button>
                      <Button
                        variant="primary"
                        className="w-full"
                        leftIcon={<Truck size={16} />}
                        onClick={() => handleUpdateOrderStatus('en_calle')}
                        disabled={isUpdatingStatus || !canShip}
                      >
                        En Calle
                      </Button>
                    </div>
                  </>
                )}

                {/* En Calle - siguiente paso es Enviado */}
                {orderStatus === 'en_calle' && (
                  <Button
                    variant="primary"
                    className="w-full"
                    size="lg"
                    leftIcon={<MapPin size={18} />}
                    onClick={() => handleUpdateOrderStatus('enviado')}
                    disabled={isUpdatingStatus || !canShip}
                  >
                    {isUpdatingStatus ? 'Procesando...' : 'Marcar Enviado'}
                  </Button>
                )}

                {/* Estados finales */}
                {(orderStatus === 'enviado' || orderStatus === 'retirado') && (
                  <div className="p-4 bg-emerald-50 rounded-xl text-center">
                    <Check size={24} className="mx-auto text-emerald-600 mb-2" />
                    <p className="text-sm font-medium text-emerald-700">
                      {orderStatus === 'retirado' ? 'Pedido retirado por el cliente' : 'Pedido enviado al cliente'}
                    </p>
                  </div>
                )}
              </div>
            </Card>

            {/* Etiqueta de Envío (solo si hay shipping_request) */}
            {shippingRequest && (
              <Card>
                <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-3">
                  Etiqueta de Envío
                </h3>
                <div className="space-y-4">
                  <div className="p-3 bg-neutral-50 rounded-lg text-sm">
                    <div className="flex justify-between mb-1">
                      <span className="text-neutral-500">Empresa:</span>
                      <span className="font-medium">
                        {shippingRequest.empresa_envio === 'VIA_CARGO'
                          ? 'Vía Cargo'
                          : shippingRequest.empresa_envio_otro}
                      </span>
                    </div>
                    <div className="flex justify-between mb-1">
                      <span className="text-neutral-500">Destino:</span>
                      <span className="font-medium">
                        {shippingRequest.destino_tipo === 'SUCURSAL' ? 'Sucursal' : 'Domicilio'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Destinatario:</span>
                      <span className="font-medium">{shippingRequest.nombre_apellido}</span>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-2">
                      Cantidad de bultos
                    </label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setBultos(Math.max(1, bultos - 1))}
                        className="w-10 h-10 rounded-lg bg-neutral-100 hover:bg-neutral-200 flex items-center justify-center text-lg font-medium transition-colors"
                      >
                        −
                      </button>
                      <input
                        type="number"
                        min="1"
                        max="10"
                        value={bultos}
                        onChange={(e) => setBultos(Math.min(10, Math.max(1, parseInt(e.target.value) || 1)))}
                        className="w-16 h-10 text-center border border-neutral-300 rounded-lg text-lg font-medium"
                      />
                      <button
                        type="button"
                        onClick={() => setBultos(Math.min(10, bultos + 1))}
                        className="w-10 h-10 rounded-lg bg-neutral-100 hover:bg-neutral-200 flex items-center justify-center text-lg font-medium transition-colors"
                      >
                        +
                      </button>
                    </div>
                    <p className="text-xs text-neutral-500 mt-1">Máximo 10 bultos</p>
                  </div>

                  {/* Estado de impresión */}
                  {shippingRequest.label_printed_at && (
                    <div className="p-3 bg-emerald-50 rounded-lg text-sm border border-emerald-100">
                      <div className="flex items-center gap-2 text-emerald-700">
                        <CheckCircle size={16} />
                        <span className="font-medium">
                          Etiqueta impresa ({shippingRequest.label_bultos} {shippingRequest.label_bultos === 1 ? 'hoja' : 'hojas'})
                        </span>
                      </div>
                      <p className="text-xs text-emerald-600 mt-1">
                        Última impresión: {formatDistanceToNow(new Date(shippingRequest.label_printed_at), { addSuffix: true, locale: es })}
                      </p>
                    </div>
                  )}

                  <a
                    href={getShippingLabelUrl(order.order_number, bultos)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 w-full py-3 px-4 bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-xl transition-colors"
                    onClick={() => {
                      // Recargar datos después de unos segundos para actualizar el estado de impresión
                      setTimeout(loadOrder, 2000);
                    }}
                  >
                    <Download size={18} />
                    {shippingRequest.label_printed_at ? 'Re-imprimir Hoja' : 'Descargar Hoja para Expreso'}
                  </a>
                </div>
              </Card>
            )}

            {/* Remito asociado */}
            {remito && (
              <Card>
                <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-3">
                  Remito de Envío
                </h3>
                <div className="space-y-3">
                  <div className="p-3 bg-emerald-50 rounded-lg text-sm border border-emerald-100">
                    <div className="flex items-center gap-2 text-emerald-700 mb-1">
                      <CheckCircle size={16} />
                      <span className="font-medium">Remito confirmado</span>
                    </div>
                    {remito.detected_name && (
                      <p className="text-xs text-emerald-600">
                        Nombre detectado: {remito.detected_name}
                      </p>
                    )}
                    {remito.confirmed_at && (
                      <p className="text-xs text-emerald-600 mt-1">
                        Confirmado: {formatDistanceToNow(new Date(remito.confirmed_at), { addSuffix: true, locale: es })}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="secondary"
                    className="w-full"
                    onClick={() => setShowRemitoModal(true)}
                  >
                    <Image size={16} className="mr-2" />
                    Ver remito
                  </Button>
                </div>
              </Card>
            )}

            {/* Info adicional */}
            <Card>
              <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-3">
                Información
              </h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-neutral-500">Número de pedido</span>
                  <span className="font-mono font-medium">#{order.order_number}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">Moneda</span>
                  <span className="font-medium">{order.currency}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-neutral-500">Fecha de creación</span>
                  <span className="font-medium">
                    {format(new Date(order.created_at), 'dd/MM/yyyy', { locale: es })}
                  </span>
                </div>
                {order.printed_at && (
                  <div className="flex justify-between">
                    <span className="text-neutral-500">Impreso</span>
                    <span className="font-medium">
                      {format(new Date(order.printed_at), 'dd/MM/yyyy HH:mm', { locale: es })}
                    </span>
                  </div>
                )}
                {order.shipped_at && (
                  <div className="flex justify-between">
                    <span className="text-neutral-500">Enviado</span>
                    <span className="font-medium">
                      {format(new Date(order.shipped_at), 'dd/MM/yyyy HH:mm', { locale: es })}
                    </span>
                  </div>
                )}
              </div>

              {/* Botón de resync solo para admins */}
              {hasPermission('users.view') && (
                <div className="mt-4 pt-4 border-t border-neutral-100">
                  <button
                    onClick={handleResync}
                    disabled={isResyncing}
                    className="w-full text-xs text-neutral-400 hover:text-neutral-600 py-2 transition-colors disabled:opacity-50"
                  >
                    {isResyncing ? 'Sincronizando...' : '↻ Forzar resync desde TiendaNube'}
                  </button>
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>

      {/* Modal de Pago en Efectivo */}
      <Modal
        isOpen={isCashModalOpen}
        onClose={() => !isSubmittingCash && setIsCashModalOpen(false)}
        title="Registrar Pago en Efectivo"
        size="sm"
      >
        <div className="space-y-4">
          {cashSuccess ? (
            <div className="p-4 bg-emerald-50 rounded-xl text-center">
              <Check size={32} className="mx-auto text-emerald-600 mb-2" />
              <p className="text-sm font-medium text-emerald-700">{cashSuccess}</p>
            </div>
          ) : (
            <>
              <div className="p-3 bg-neutral-50 rounded-lg">
                <div className="flex justify-between text-sm">
                  <span className="text-neutral-500">Pedido:</span>
                  <span className="font-medium">#{order.order_number}</span>
                </div>
                <div className="flex justify-between text-sm mt-1">
                  <span className="text-neutral-500">Total a pagar:</span>
                  <span className="font-medium">{formatCurrency(order.monto_tiendanube)}</span>
                </div>
                <div className="flex justify-between text-sm mt-1">
                  <span className="text-neutral-500">Ya pagado:</span>
                  <span className="font-medium">{formatCurrency(order.total_pagado)}</span>
                </div>
                <div className="flex justify-between text-sm mt-1 pt-1 border-t border-neutral-200">
                  <span className="text-neutral-500">Saldo pendiente:</span>
                  <span className="font-semibold text-red-600">
                    {formatCurrency(saldoPendiente)}
                  </span>
                </div>
              </div>

              <Input
                label="Monto recibido en efectivo"
                type="number"
                value={cashAmount}
                onChange={(e) => {
                  setCashAmount(e.target.value);
                  setCashError(null);
                }}
                placeholder="Ej: 15000"
                disabled={isSubmittingCash}
              />

              {saldoPendiente > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  onClick={() => setCashAmount(Math.round(saldoPendiente).toString())}
                  disabled={isSubmittingCash}
                >
                  Pagar total ({formatCurrency(saldoPendiente)})
                </Button>
              )}

              {cashError && (
                <div className="p-3 bg-red-50 rounded-lg">
                  <p className="text-sm text-red-700">{cashError}</p>
                </div>
              )}

              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={() => setIsCashModalOpen(false)}
                  disabled={isSubmittingCash}
                >
                  Cancelar
                </Button>
                <Button
                  className="flex-1"
                  onClick={handleCashPayment}
                  disabled={isSubmittingCash || !cashAmount}
                  leftIcon={isSubmittingCash ? <Loader2 size={16} className="animate-spin" /> : <Banknote size={16} />}
                >
                  {isSubmittingCash ? 'Registrando...' : 'Registrar Pago'}
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* Modal de Impresión */}
      {isPrintModalOpen && printData && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 overflow-auto">
          <div className="bg-white rounded-2xl shadow-xl max-w-4xl w-full max-h-[95vh] overflow-auto">
            {/* Header del modal */}
            <div className="sticky top-0 bg-white border-b border-neutral-200 p-4 flex items-center justify-between z-10">
              <h2 className="text-lg font-semibold">Vista Previa de Impresión</h2>
              <div className="flex items-center gap-3">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setIsPrintModalOpen(false);
                    setPrintData(null);
                  }}
                >
                  Cancelar
                </Button>
                <Button
                  variant="primary"
                  leftIcon={<Printer size={16} />}
                  onClick={handleConfirmPrint}
                >
                  Imprimir y Confirmar
                </Button>
              </div>
            </div>

            {/* Contenido imprimible */}
            <div className="p-4">
              <PrintableOrder ref={printRef} data={printData} />
            </div>
          </div>
        </div>
      )}

      {/* Modal de Remito */}
      {showRemitoModal && remito && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowRemitoModal(false)}>
          <div
            className="bg-white rounded-2xl shadow-xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="p-4 border-b border-neutral-200 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Remito de Envío</h2>
              <button
                onClick={() => setShowRemitoModal(false)}
                className="p-2 hover:bg-neutral-100 rounded-lg"
              >
                <ArrowLeft size={20} />
              </button>
            </div>
            {/* Content */}
            <div className="flex-1 overflow-auto p-4">
              {remito.file_url && (
                <img
                  src={remito.file_url}
                  alt="Remito"
                  className="w-full h-auto max-h-[70vh] object-contain rounded-lg"
                />
              )}
              <div className="mt-4 space-y-2 text-sm">
                {remito.detected_name && (
                  <p><span className="text-neutral-500">Nombre detectado:</span> {remito.detected_name}</p>
                )}
                {remito.detected_address && (
                  <p><span className="text-neutral-500">Dirección:</span> {remito.detected_address}</p>
                )}
                {remito.detected_city && (
                  <p><span className="text-neutral-500">Ciudad:</span> {remito.detected_city}</p>
                )}
              </div>
            </div>
            {/* Footer */}
            <div className="p-4 border-t border-neutral-200 flex justify-end">
              <Button variant="secondary" onClick={() => setShowRemitoModal(false)}>
                Cerrar
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
