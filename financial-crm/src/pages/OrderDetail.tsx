import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  X,
  AlertTriangle,
  Edit,
  ExternalLink,
  Phone,
  Mail,
  ZoomIn,
  Copy,
  MessageSquare,
  Printer,
  Truck,
  MapPin,
  UserCheck,
  RotateCcw,
  Banknote,
  Loader2,
} from 'lucide-react';
import { Header } from '../components/layout';
import { Button, Card, PaymentStatusBadge, OrderStatusBadge, Modal, Input } from '../components/ui';
import { OrderTimeline } from '../components/orders';
import { ReceiptViewer } from '../components/receipts';
import { getOrderById, mockActivityLog } from '../data/mockData';
import { Receipt } from '../types';
import { clsx } from 'clsx';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';

export function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const order = getOrderById(id || '');

  const [selectedReceipt, setSelectedReceipt] = useState<Receipt | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editedAmount, setEditedAmount] = useState('');

  // Estado para pago en efectivo
  const [isCashModalOpen, setIsCashModalOpen] = useState(false);
  const [cashAmount, setCashAmount] = useState('');
  const [isSubmittingCash, setIsSubmittingCash] = useState(false);
  const [cashError, setCashError] = useState<string | null>(null);
  const [cashSuccess, setCashSuccess] = useState<string | null>(null);

  if (!order) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-neutral-900">Pedido no encontrado</h2>
          <p className="text-neutral-500 mt-2">El pedido que buscás no existe.</p>
          <Button className="mt-4" onClick={() => navigate('/orders')}>
            Volver a Pedidos
          </Button>
        </div>
      </div>
    );
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
    }).format(amount);
  };

  // Handler para registrar pago en efectivo
  const handleCashPayment = async () => {
    if (!cashAmount || Number(cashAmount) <= 0) {
      setCashError('Ingresá un monto válido');
      return;
    }

    setIsSubmittingCash(true);
    setCashError(null);
    setCashSuccess(null);

    try {
      const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
      const response = await fetch(`${API_URL}/pago-efectivo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          orderNumber: order.orderNumber.replace('TN-2024-', ''),
          monto: Number(cashAmount),
          registradoPor: 'operador', // TODO: obtener del usuario logueado
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Error al registrar pago');
      }

      setCashSuccess(`Pago de ${formatCurrency(Number(cashAmount))} registrado correctamente`);
      setCashAmount('');

      // Cerrar modal después de 2 segundos
      setTimeout(() => {
        setIsCashModalOpen(false);
        setCashSuccess(null);
        // TODO: Recargar datos del pedido
        window.location.reload();
      }, 2000);

    } catch (error) {
      setCashError(error instanceof Error ? error.message : 'Error al registrar pago');
    } finally {
      setIsSubmittingCash(false);
    }
  };

  const difference = order.amountPaid - order.totalAmount;
  const orderActivities = mockActivityLog.filter((a) => a.orderId === order.id);

  // Determinar qué acciones están disponibles según el estado
  // Solo se puede imprimir si ya hay comprobante subido (a_confirmar, parcial, total)
  const canPrint = ['a_confirmar', 'parcial', 'total'].includes(order.paymentStatus);
  const showReprint = order.printedAt !== null;
  // Solo se puede enviar si el pago está completo
  const canShip = order.paymentStatus === 'total';

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
            <span>Pedido {order.orderNumber}</span>
          </div>
        }
        subtitle={`Creado ${formatDistanceToNow(new Date(order.createdAt), { addSuffix: true, locale: es })}`}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<ExternalLink size={14} />}
            >
              Ver en Tiendanube
            </Button>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<MessageSquare size={14} />}
            >
              Enviar WhatsApp
            </Button>
          </div>
        }
      />

      <div className="p-6">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Columna izquierda */}
          <div className="lg:col-span-3 space-y-6">
            {/* Productos del pedido */}
            <Card>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-semibold text-neutral-900">
                  Productos ({order.products.length})
                </h3>
                {showReprint && (
                  <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={<RotateCcw size={14} />}
                  >
                    Re-imprimir
                  </Button>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-neutral-100">
                      <th className="py-2 px-3 text-left text-xs font-semibold text-neutral-500 uppercase">Producto</th>
                      <th className="py-2 px-3 text-left text-xs font-semibold text-neutral-500 uppercase">SKU</th>
                      <th className="py-2 px-3 text-right text-xs font-semibold text-neutral-500 uppercase">Cant.</th>
                      <th className="py-2 px-3 text-right text-xs font-semibold text-neutral-500 uppercase">Precio</th>
                      <th className="py-2 px-3 text-right text-xs font-semibold text-neutral-500 uppercase">Subtotal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.products.map((product) => (
                      <tr key={product.id} className="border-b border-neutral-50">
                        <td className="py-3 px-3 text-sm text-neutral-900">{product.name}</td>
                        <td className="py-3 px-3 text-sm font-mono text-neutral-500">{product.sku}</td>
                        <td className="py-3 px-3 text-sm text-neutral-900 text-right">{product.quantity}</td>
                        <td className="py-3 px-3 text-sm font-mono text-neutral-600 text-right">{formatCurrency(product.price)}</td>
                        <td className="py-3 px-3 text-sm font-mono font-medium text-neutral-900 text-right">
                          {formatCurrency(product.price * product.quantity)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-neutral-50">
                      <td colSpan={4} className="py-3 px-3 text-sm font-semibold text-neutral-900 text-right">Total:</td>
                      <td className="py-3 px-3 text-sm font-mono font-bold text-neutral-900 text-right">
                        {formatCurrency(order.totalAmount)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>

            {/* Comprobantes */}
            <Card>
              <h3 className="text-base font-semibold text-neutral-900 mb-4">
                Comprobantes ({order.receipts.length})
              </h3>
              {order.receipts.length === 0 ? (
                <div className="text-center py-8 text-neutral-500">
                  Aún no hay comprobantes subidos
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {order.receipts.map((receipt) => (
                    <div
                      key={receipt.id}
                      className={clsx(
                        'group relative bg-neutral-100 rounded-xl overflow-hidden cursor-pointer',
                        'hover:ring-2 hover:ring-neutral-900/10 transition-all'
                      )}
                      onClick={() => setSelectedReceipt(receipt)}
                    >
                      <div className="aspect-square">
                        <img
                          src={receipt.imageUrl}
                          alt="Comprobante"
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <ZoomIn size={24} className="text-white" />
                      </div>
                      {receipt.isDuplicate && (
                        <div className="absolute top-2 right-2">
                          <div className="p-1 bg-amber-500 rounded-full">
                            <AlertTriangle size={12} className="text-white" />
                          </div>
                        </div>
                      )}
                      <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/60 to-transparent">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-white font-medium">
                            {receipt.detectedAmount
                              ? formatCurrency(receipt.detectedAmount)
                              : 'N/A'}
                          </span>
                          <PaymentStatusBadge status={receipt.paymentStatus} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* OCR */}
            {order.receipts.length > 0 && (
              <Card>
                <h3 className="text-base font-semibold text-neutral-900 mb-4">
                  Análisis OCR
                </h3>
                <div className="space-y-4">
                  {order.receipts.map((receipt) => (
                    <div
                      key={receipt.id}
                      className="p-4 bg-neutral-50 rounded-xl space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-neutral-700">
                          Comprobante #{receipt.id.slice(-6)}
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          leftIcon={<Copy size={14} />}
                          onClick={() => navigator.clipboard.writeText(receipt.ocrText)}
                        >
                          Copiar
                        </Button>
                      </div>
                      <div className="bg-white rounded-lg p-3 border border-neutral-200">
                        <pre className="text-xs text-neutral-600 whitespace-pre-wrap font-mono">
                          {receipt.ocrText}
                        </pre>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <div>
                          <span className="text-neutral-500">Detectado: </span>
                          <span className={clsx(
                            'font-semibold',
                            receipt.detectedAmount ? 'text-neutral-900' : 'text-neutral-400'
                          )}>
                            {receipt.detectedAmount
                              ? formatCurrency(receipt.detectedAmount)
                              : 'No detectado'}
                          </span>
                        </div>
                        {receipt.isDuplicate && (
                          <div className="flex items-center gap-1 text-amber-600">
                            <AlertTriangle size={14} />
                            <span className="font-medium">Posible duplicado</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Timeline */}
            <Card>
              <h3 className="text-base font-semibold text-neutral-900 mb-4">
                Historial de Actividad
              </h3>
              <OrderTimeline activities={orderActivities} />
            </Card>
          </div>

          {/* Columna derecha */}
          <div className="lg:col-span-2 space-y-6">
            {/* Info del pedido */}
            <Card>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-semibold text-neutral-900">Info del Pedido</h3>
                <div className="flex gap-2">
                  <PaymentStatusBadge status={order.paymentStatus} />
                  <OrderStatusBadge status={order.orderStatus} />
                </div>
              </div>
              <div className="space-y-4">
                <div className="flex items-center justify-between py-2 border-b border-neutral-100">
                  <span className="text-sm text-neutral-500">Total Tiendanube</span>
                  <span className="text-sm font-semibold text-neutral-900">
                    {formatCurrency(order.totalAmount)}
                  </span>
                </div>
                <div className="flex items-center justify-between py-2 border-b border-neutral-100">
                  <span className="text-sm text-neutral-500">Monto Pagado</span>
                  <span className="text-sm font-semibold text-neutral-900">
                    {formatCurrency(order.amountPaid)}
                  </span>
                </div>
                <div className="flex items-center justify-between py-2">
                  <span className="text-sm text-neutral-500">Diferencia</span>
                  <span
                    className={clsx(
                      'text-sm font-semibold',
                      difference === 0 && 'text-emerald-600',
                      difference > 0 && 'text-blue-600',
                      difference < 0 && 'text-red-600'
                    )}
                  >
                    {difference >= 0 ? '+' : ''}
                    {formatCurrency(difference)}
                  </span>
                </div>
              </div>
            </Card>

            {/* Cliente */}
            <Card>
              <h3 className="text-base font-semibold text-neutral-900 mb-4">Cliente</h3>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center text-white font-medium">
                    {order.customer.name.split(' ').map((n) => n[0]).join('')}
                  </div>
                  <div>
                    <div className="font-medium text-neutral-900">{order.customer.name}</div>
                    <div className="text-sm text-neutral-500">Cliente</div>
                  </div>
                </div>
                <div className="space-y-2 pt-2">
                  <a
                    href={`mailto:${order.customer.email}`}
                    className="flex items-center gap-2 text-sm text-neutral-600 hover:text-neutral-900"
                  >
                    <Mail size={14} />
                    {order.customer.email}
                  </a>
                  <a
                    href={`tel:${order.customer.phone}`}
                    className="flex items-center gap-2 text-sm text-neutral-600 hover:text-neutral-900"
                  >
                    <Phone size={14} />
                    {order.customer.phone}
                  </a>
                </div>
              </div>
            </Card>

            {/* Acciones de Pago */}
            {order.paymentStatus === 'pendiente' && (
              <Card>
                <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-3">Acciones de Pago</h3>
                <div className="space-y-3">
                  <Button
                    variant="success"
                    className="w-full"
                    size="lg"
                    leftIcon={<Check size={18} />}
                  >
                    Confirmar Pago
                  </Button>
                  <Button
                    variant="danger"
                    className="w-full"
                    size="lg"
                    leftIcon={<X size={18} />}
                  >
                    Rechazar Pago
                  </Button>
                  <div className="grid grid-cols-2 gap-3">
                    <Button
                      variant="secondary"
                      className="w-full"
                      leftIcon={<AlertTriangle size={16} />}
                    >
                      Duplicado
                    </Button>
                    <Button
                      variant="secondary"
                      className="w-full"
                      leftIcon={<Edit size={16} />}
                      onClick={() => {
                        setEditedAmount(order.amountPaid.toString());
                        setIsEditModalOpen(true);
                      }}
                    >
                      Editar Monto
                    </Button>
                  </div>
                </div>
              </Card>
            )}

            {/* Registrar Pago en Efectivo - disponible si no está totalmente pagado */}
            {order.paymentStatus !== 'total' && order.paymentStatus !== 'rechazado' && (
              <Card>
                <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-3">Pago en Efectivo</h3>
                <div className="space-y-3">
                  <p className="text-sm text-neutral-600">
                    Registrá un pago recibido en efectivo para este pedido.
                  </p>
                  <Button
                    variant="secondary"
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

            {/* Acciones del Pedido */}
            <Card>
              <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-3">Estado del Pedido</h3>
              <div className="space-y-3">
                {/* Pendiente de pago - solo mostrar mensaje */}
                {order.orderStatus === 'pendiente_pago' && (
                  <div className="p-4 bg-amber-50 rounded-xl text-center">
                    <p className="text-sm text-amber-700">
                      El pedido está pendiente de pago. Una vez confirmado el pago, podrás imprimir la hoja de productos.
                    </p>
                  </div>
                )}

                {/* A imprimir - botón de imprimir */}
                {order.orderStatus === 'a_imprimir' && (
                  <Button
                    variant="primary"
                    className="w-full"
                    size="lg"
                    leftIcon={<Printer size={18} />}
                  >
                    Imprimir Hoja de Pedido
                  </Button>
                )}

                {/* Puede imprimir si el pago está confirmado y está pendiente de pago */}
                {canPrint && order.orderStatus === 'pendiente_pago' && (
                  <Button
                    variant="primary"
                    className="w-full"
                    size="lg"
                    leftIcon={<Printer size={18} />}
                  >
                    Imprimir Hoja de Pedido
                  </Button>
                )}

                {/* Armado - opciones de envío */}
                {order.orderStatus === 'armado' && (
                  <>
                    {showReprint && (
                      <Button
                        variant="secondary"
                        className="w-full"
                        leftIcon={<Printer size={16} />}
                      >
                        Re-imprimir Hoja
                      </Button>
                    )}
                    {!canShip && (
                      <div className="p-3 bg-amber-50 rounded-xl text-center mb-3">
                        <p className="text-xs text-amber-700">
                          Para enviar/retirar el pedido, el pago debe estar confirmado como "Total"
                        </p>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <Button
                        variant="primary"
                        className="w-full"
                        leftIcon={<UserCheck size={16} />}
                      >
                        Retirado
                      </Button>
                      <Button
                        variant="primary"
                        className="w-full"
                        leftIcon={<Truck size={16} />}
                        disabled={!canShip}
                      >
                        Enviado
                      </Button>
                    </div>
                  </>
                )}

                {/* Enviado - marcar en calle */}
                {order.orderStatus === 'enviado' && (
                  <>
                    {!canShip && (
                      <div className="p-3 bg-amber-50 rounded-xl text-center mb-3">
                        <p className="text-xs text-amber-700">
                          Para marcar en calle, el pago debe estar confirmado como "Total"
                        </p>
                      </div>
                    )}
                    <Button
                      variant="primary"
                      className="w-full"
                      size="lg"
                      leftIcon={<MapPin size={18} />}
                      disabled={!canShip}
                    >
                      Marcar En Calle
                    </Button>
                  </>
                )}

                {/* En calle o retirado - estado final */}
                {(order.orderStatus === 'en_calle' || order.orderStatus === 'retirado') && (
                  <div className="p-4 bg-emerald-50 rounded-xl text-center">
                    <Check size={24} className="mx-auto text-emerald-600 mb-2" />
                    <p className="text-sm font-medium text-emerald-700">
                      {order.orderStatus === 'retirado' ? 'Pedido retirado por el cliente' : 'Pedido en camino al cliente'}
                    </p>
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>
      </div>

      <ReceiptViewer
        receipt={selectedReceipt}
        isOpen={!!selectedReceipt}
        onClose={() => setSelectedReceipt(null)}
      />

      <Modal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        title="Editar Monto Pagado"
        size="sm"
      >
        <div className="space-y-4">
          <Input
            label="Nuevo Monto"
            type="number"
            value={editedAmount}
            onChange={(e) => setEditedAmount(e.target.value)}
            placeholder="Ingresá el monto"
          />
          <div className="flex gap-3">
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => setIsEditModalOpen(false)}
            >
              Cancelar
            </Button>
            <Button className="flex-1" onClick={() => setIsEditModalOpen(false)}>
              Guardar Cambios
            </Button>
          </div>
        </div>
      </Modal>

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
                  <span className="font-medium">{order.orderNumber}</span>
                </div>
                <div className="flex justify-between text-sm mt-1">
                  <span className="text-neutral-500">Total a pagar:</span>
                  <span className="font-medium">{formatCurrency(order.totalAmount)}</span>
                </div>
                <div className="flex justify-between text-sm mt-1">
                  <span className="text-neutral-500">Ya pagado:</span>
                  <span className="font-medium">{formatCurrency(order.amountPaid)}</span>
                </div>
                <div className="flex justify-between text-sm mt-1 pt-1 border-t border-neutral-200">
                  <span className="text-neutral-500">Saldo pendiente:</span>
                  <span className="font-semibold text-red-600">
                    {formatCurrency(order.totalAmount - order.amountPaid)}
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
    </div>
  );
}
