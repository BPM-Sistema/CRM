import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, Link2, X, Plus, Loader2, AlertCircle } from 'lucide-react';
import {
  fetchOrdersByPhone,
  fetchLinkedOrders,
  linkOrderToConversation,
  unlinkOrderFromConversation,
  LinkedOrder,
} from '../../services/waspy';
import { mapEstadoPago, mapEstadoPedido } from '../../services/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { PaymentStatusBadge, OrderStatusBadge } from '../ui/Badge';

interface OrderPanelConversation {
  id: string;
  contactPhone: string;
  contactName?: string;
}

interface OrderPanelProps {
  conversation: OrderPanelConversation;
  canAssign: boolean;
}

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(amount);

const formatDate = (dateStr: string) =>
  new Date(dateStr).toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });

export function OrderPanel({ conversation, canAssign }: OrderPanelProps) {
  const navigate = useNavigate();

  const [phoneOrders, setPhoneOrders] = useState<LinkedOrder[]>([]);
  const [linkedOrders, setLinkedOrders] = useState<LinkedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [orderNumberInput, setOrderNumberInput] = useState('');
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [unlinkingOrder, setUnlinkingOrder] = useState<string | null>(null);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [byPhone, linked] = await Promise.all([
        conversation.contactPhone ? fetchOrdersByPhone(conversation.contactPhone) : Promise.resolve([]),
        fetchLinkedOrders(conversation.id),
      ]);
      setPhoneOrders(byPhone);
      setLinkedOrders(linked);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Error al cargar pedidos');
    } finally {
      setLoading(false);
    }
  }, [conversation.id, conversation.contactPhone]);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  const handleLink = async () => {
    if (!orderNumberInput.trim()) return;
    setLinking(true);
    setLinkError(null);
    try {
      await linkOrderToConversation(conversation.id, orderNumberInput.trim());
      setOrderNumberInput('');
      setLinkModalOpen(false);
      const updated = await fetchLinkedOrders(conversation.id);
      setLinkedOrders(updated);
    } catch (err: unknown) {
      setLinkError(err instanceof Error ? err.message : 'Error al vincular pedido');
    } finally {
      setLinking(false);
    }
  };

  const handleUnlink = async (orderNumber: string) => {
    setUnlinkingOrder(orderNumber);
    try {
      await unlinkOrderFromConversation(conversation.id, orderNumber);
      setLinkedOrders((prev) => prev.filter((o) => o.order_number !== orderNumber));
    } catch {
      // silently fail
    } finally {
      setUnlinkingOrder(null);
    }
  };

  const renderOrderCard = (order: LinkedOrder, showUnlink = false) => (
    <div key={order.order_number} className="p-3 bg-neutral-50 rounded-xl space-y-1">
      <div className="flex items-center justify-between">
        <button
          onClick={() => navigate(`/orders/${order.order_number}`)}
          className="font-mono font-medium text-sm text-blue-600 hover:underline"
        >
          #{order.order_number}
        </button>
        <div className="flex items-center gap-1">
          <span className="text-xs text-neutral-500">{formatDate(order.created_at)}</span>
          {showUnlink && canAssign && (
            <button
              onClick={() => handleUnlink(order.order_number)}
              disabled={unlinkingOrder === order.order_number}
              className="ml-1 p-0.5 text-neutral-400 hover:text-red-500 transition-colors disabled:opacity-50"
              title="Desvincular pedido"
            >
              {unlinkingOrder === order.order_number ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <X className="w-3.5 h-3.5" />
              )}
            </button>
          )}
        </div>
      </div>
      {order.customer_name && (
        <p className="text-sm text-neutral-700">{order.customer_name}</p>
      )}
      <div className="flex items-center justify-between">
        <span className="font-semibold text-sm">{formatCurrency(order.monto_tiendanube)}</span>
        <div className="flex gap-1">
          <PaymentStatusBadge status={mapEstadoPago(order.estado_pago)} size="sm" />
          <OrderStatusBadge status={mapEstadoPedido(order.estado_pedido)} size="sm" />
        </div>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="p-4 flex flex-col items-center justify-center gap-2 text-neutral-400">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Cargando pedidos...</span>
      </div>
    );
  }

  const hasNoOrders = phoneOrders.length === 0 && linkedOrders.length === 0;

  return (
    <div className="space-y-4">
      {loadError && (
        <div className="flex items-center gap-1.5 text-sm text-red-600 p-2 bg-red-50 rounded-lg">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{loadError}</span>
          <button onClick={loadOrders} className="ml-auto text-xs underline">Reintentar</button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm flex items-center gap-1.5">
          <Package className="w-4 h-4" />
          Pedidos del cliente
        </h3>
        {canAssign && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setLinkError(null);
              setOrderNumberInput('');
              setLinkModalOpen(true);
            }}
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            Vincular pedido
          </Button>
        )}
      </div>

      {hasNoOrders ? (
        <div className="py-6 text-center text-sm text-neutral-400">
          No se encontraron pedidos para este contacto.
        </div>
      ) : (
        <>
          {phoneOrders.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
                Por teléfono
              </h4>
              <div className="space-y-2">
                {phoneOrders.map((order) => renderOrderCard(order))}
              </div>
            </div>
          )}

          {linkedOrders.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-neutral-500 uppercase tracking-wider flex items-center gap-1">
                <Link2 className="w-3 h-3" />
                Vinculados manualmente
              </h4>
              <div className="space-y-2">
                {linkedOrders.map((order) => renderOrderCard(order, true))}
              </div>
            </div>
          )}
        </>
      )}

      <Modal
        isOpen={linkModalOpen}
        onClose={() => setLinkModalOpen(false)}
        title="Vincular pedido"
      >
        <div className="space-y-4">
          <Input
            placeholder="Número de pedido"
            value={orderNumberInput}
            onChange={(e) => setOrderNumberInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleLink();
            }}
          />
          {linkError && (
            <div className="flex items-center gap-1.5 text-sm text-red-600">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {linkError}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setLinkModalOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleLink} disabled={linking || !orderNumberInput.trim()}>
              {linking ? (
                <>
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  Vinculando...
                </>
              ) : (
                'Vincular'
              )}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
