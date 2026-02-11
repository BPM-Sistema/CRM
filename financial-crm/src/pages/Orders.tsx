import { useState, useMemo } from 'react';
import { Plus, Printer } from 'lucide-react';
import { Header } from '../components/layout';
import { OrdersTable, OrderFilters } from '../components/orders';
import { Button } from '../components/ui';
import { mockOrders } from '../data/mockData';
import { PaymentStatus, OrderStatus } from '../types';
import { useAuth } from '../contexts/AuthContext';

// Mapeo de estados a permisos
const paymentStatusPermissions: Record<PaymentStatus, string> = {
  pendiente: 'orders.view_pendiente',
  a_confirmar: 'orders.view_a_confirmar',
  parcial: 'orders.view_parcial',
  total: 'orders.view_total',
  rechazado: 'orders.view_rechazado',
};

const orderStatusPermissions: Record<OrderStatus, string> = {
  pendiente_pago: 'orders.view_pendiente_pago',
  a_imprimir: 'orders.view_a_imprimir',
  hoja_impresa: 'orders.view_hoja_impresa',
  armado: 'orders.view_armado',
  enviado: 'orders.view_enviado',
  en_calle: 'orders.view_en_calle',
  retirado: 'orders.view_retirado',
};

export function Orders() {
  const { hasPermission } = useAuth();
  const [paymentFilter, setPaymentFilter] = useState<PaymentStatus | 'all'>('all');
  const [orderStatusFilter, setOrderStatusFilter] = useState<OrderStatus | 'all'>('all');

  // Filtrar pedidos basado en permisos del usuario
  const permittedOrders = useMemo(() => {
    return mockOrders.filter((order) => {
      const hasPaymentPermission = hasPermission(paymentStatusPermissions[order.paymentStatus]);
      const hasOrderStatusPermission = hasPermission(orderStatusPermissions[order.orderStatus]);
      return hasPaymentPermission && hasOrderStatusPermission;
    });
  }, [hasPermission]);

  const filteredOrders = useMemo(() => {
    return permittedOrders.filter((order) => {
      const matchesPayment = paymentFilter === 'all' || order.paymentStatus === paymentFilter;
      const matchesOrderStatus = orderStatusFilter === 'all' || order.orderStatus === orderStatusFilter;

      return matchesPayment && matchesOrderStatus;
    });
  }, [permittedOrders, paymentFilter, orderStatusFilter]);

  const statusCounts = useMemo(() => {
    return permittedOrders.reduce(
      (acc, order) => {
        acc[order.paymentStatus] = (acc[order.paymentStatus] || 0) + 1;
        acc.total += 1;
        return acc;
      },
      { total: 0 } as Record<string, number>
    );
  }, [permittedOrders]);

  // Contar pedidos pendientes de imprimir (solo si ya tienen comprobante subido: a_confirmar, parcial, total)
  const printableStatuses = ['a_confirmar', 'parcial', 'total'];

  const pendingPrintCount = useMemo(() => {
    return permittedOrders.filter(
      (order) =>
        order.printedAt === null &&
        printableStatuses.includes(order.paymentStatus)
    ).length;
  }, [permittedOrders]);

  const handlePrintAllPending = () => {
    const ordersToPrint = permittedOrders.filter(
      (order) =>
        order.printedAt === null &&
        printableStatuses.includes(order.paymentStatus)
    );

    // Aquí iría la lógica real de impresión
    console.log('Imprimiendo pedidos:', ordersToPrint.map(o => o.orderNumber));
    alert(`Imprimiendo ${ordersToPrint.length} pedidos pendientes:\n${ordersToPrint.map(o => o.orderNumber).join(', ')}`);
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Pedidos"
        subtitle={`${statusCounts.total} pedidos en total · ${statusCounts.pendiente || 0} pendientes de pago`}
        actions={
          <div className="flex items-center gap-2">
            {pendingPrintCount > 0 && (
              <Button
                variant="secondary"
                leftIcon={<Printer size={16} />}
                onClick={handlePrintAllPending}
              >
                Imprimir Pendientes ({pendingPrintCount})
              </Button>
            )}
            <Button leftIcon={<Plus size={16} />}>
              Nuevo Pedido
            </Button>
          </div>
        }
      />

      <div className="p-6 space-y-6">
        <OrderFilters
          paymentFilter={paymentFilter}
          onPaymentFilterChange={setPaymentFilter}
          orderStatusFilter={orderStatusFilter}
          onOrderStatusFilterChange={setOrderStatusFilter}
        />

        <OrdersTable orders={filteredOrders} />

        <div className="flex items-center justify-between">
          <span className="text-sm text-neutral-500">
            Mostrando {filteredOrders.length} de {permittedOrders.length} pedidos
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled>
              Anterior
            </Button>
            <span className="px-3 py-1.5 text-sm text-neutral-600">Página 1 de 1</span>
            <Button variant="secondary" size="sm" disabled>
              Siguiente
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
