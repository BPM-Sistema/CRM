import { useState, useEffect, useRef, useCallback } from 'react';
import { useReactToPrint } from 'react-to-print';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  RefreshCw,
  AlertCircle,
  Banknote,
  Check,
  Loader2,
  FileText,
  Clock,
  Phone,
  Mail,
  Printer,
  Truck,
  MapPin,
  UserCheck,
  Package,
  MessageSquare,
  ShoppingBag,
} from 'lucide-react';
import { Header } from '../components/layout';
import { Button, Card, PaymentStatusBadge, OrderStatusBadge, Modal, Input } from '../components/ui';
import { PrintableOrder } from '../components/orders';
import {
  fetchOrderDetail,
  fetchOrderPrintData,
  registerCashPayment,
  updateOrderStatus,
  ApiOrderDetail,
  ApiOrderPrintData,
  mapEstadoPago,
  mapEstadoPedido,
  OrderStatus,
} from '../services/api';
import { formatDistanceToNow, format } from 'date-fns';
import { es } from 'date-fns/locale';

export function RealOrderDetail() {
  const { orderNumber } = useParams<{ orderNumber: string }>();
  const navigate = useNavigate();

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

  const loadOrder = async () => {
    if (!orderNumber) return;

    setLoading(true);
    setError(null);
    try {
      const orderData = await fetchOrderDetail(orderNumber);
      setData(orderData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar pedido');
    } finally {
      setLoading(false);
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

  // Hook de react-to-print
  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: `Pedido-${orderNumber}`,
    onAfterPrint: useCallback(async () => {
      if (!orderNumber) return;
      try {
        await updateOrderStatus(orderNumber, 'a_imprimir');
        setIsPrintModalOpen(false);
        setPrintData(null);
        await loadOrder();
      } catch (error) {
        console.error('Error al actualizar estado:', error);
      }
    }, [orderNumber]),
  });

  // Confirmar impresión
  const handleConfirmPrint = () => {
    handlePrint();
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

  const { order, comprobantes, pagos_efectivo, logs, productos } = data;
  const saldoPendiente = (order.monto_tiendanube || 0) - (order.total_pagado || 0);
  const paymentStatus = mapEstadoPago(order.estado_pago);
  const orderStatus = mapEstadoPedido(order.estado_pedido);
  const totalPagos = comprobantes.length + pagos_efectivo.length;

  // Lógica de permisos
  const canRegisterPayment = saldoPendiente > 0 && paymentStatus !== 'rechazado';
  const canPrint = ['a_confirmar', 'parcial', 'total'].includes(paymentStatus);
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
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<MessageSquare size={14} />}
            >
              WhatsApp
            </Button>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<RefreshCw size={14} className={loading ? 'animate-spin' : ''} />}
              onClick={loadOrder}
            >
              Actualizar
            </Button>
          </div>
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

            {/* Productos */}
            {productos && productos.length > 0 && (
              <Card>
                <h3 className="text-base font-semibold text-neutral-900 mb-4">
                  <div className="flex items-center gap-2">
                    <ShoppingBag size={18} />
                    Productos ({productos.length})
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
                  {logs.map((log) => (
                    <div key={log.id} className="flex items-start gap-3">
                      <div className="p-1.5 bg-neutral-100 rounded-full mt-0.5">
                        <Clock size={14} className="text-neutral-500" />
                      </div>
                      <div>
                        <p className="text-sm text-neutral-900">{log.accion}</p>
                        <p className="text-xs text-neutral-500">
                          {format(new Date(log.created_at), 'dd/MM/yyyy HH:mm', { locale: es })} · {log.origen}
                        </p>
                      </div>
                    </div>
                  ))}
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
                          Esperando comprobante de pago para poder imprimir.
                        </p>
                      </div>
                    )}
                  </>
                )}

                {/* A imprimir */}
                {orderStatus === 'a_imprimir' && (
                  <>
                    <Button
                      variant="secondary"
                      className="w-full mb-2"
                      leftIcon={isLoadingPrint ? <Loader2 size={16} className="animate-spin" /> : <Printer size={16} />}
                      onClick={handlePrintOrder}
                      disabled={isLoadingPrint}
                    >
                      {order.printed_at ? 'Re-imprimir Hoja' : 'Imprimir Hoja'}
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
                    {!canShip && (
                      <div className="p-3 bg-amber-50 rounded-xl text-center mb-3">
                        <p className="text-xs text-amber-700">
                          Para enviar, el pago debe estar confirmado como "Total"
                        </p>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <Button
                        variant="primary"
                        className="w-full"
                        leftIcon={<UserCheck size={16} />}
                        onClick={() => handleUpdateOrderStatus('retirado')}
                        disabled={isUpdatingStatus}
                      >
                        Retirado
                      </Button>
                      <Button
                        variant="primary"
                        className="w-full"
                        leftIcon={<Truck size={16} />}
                        onClick={() => handleUpdateOrderStatus('enviado')}
                        disabled={isUpdatingStatus || !canShip}
                      >
                        Enviado
                      </Button>
                    </div>
                  </>
                )}

                {/* Enviado */}
                {orderStatus === 'enviado' && (
                  <Button
                    variant="primary"
                    className="w-full"
                    size="lg"
                    leftIcon={<MapPin size={18} />}
                    onClick={() => handleUpdateOrderStatus('en_calle')}
                    disabled={isUpdatingStatus || !canShip}
                  >
                    {isUpdatingStatus ? 'Procesando...' : 'Marcar En Calle'}
                  </Button>
                )}

                {/* Estados finales */}
                {(orderStatus === 'en_calle' || orderStatus === 'retirado') && (
                  <div className="p-4 bg-emerald-50 rounded-xl text-center">
                    <Check size={24} className="mx-auto text-emerald-600 mb-2" />
                    <p className="text-sm font-medium text-emerald-700">
                      {orderStatus === 'retirado' ? 'Pedido retirado por el cliente' : 'Pedido en camino al cliente'}
                    </p>
                  </div>
                )}
              </div>
            </Card>

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
    </div>
  );
}
