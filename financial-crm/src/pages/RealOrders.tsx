import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, AlertCircle, Eye, Receipt, RotateCcw, Printer, Calendar, Search } from 'lucide-react';
import { Header } from '../components/layout';
import { Button, Card, PaymentStatusBadge, OrderStatusBadge, Modal } from '../components/ui';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '../components/ui';
import { fetchOrders, ApiOrder, mapEstadoPago, mapEstadoPedido, PaymentStatus, OrderStatus } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { format, isToday } from 'date-fns';
import { es } from 'date-fns/locale';
import { clsx } from 'clsx';

const paymentButtons: { value: PaymentStatus | 'all'; label: string; color: string; permission?: string }[] = [
  { value: 'all', label: 'Todos', color: 'bg-neutral-100 text-neutral-700' },
  { value: 'pendiente', label: 'Pendiente', color: 'bg-amber-50 text-amber-700', permission: 'orders.view_pendiente' },
  { value: 'a_confirmar', label: 'A confirmar', color: 'bg-blue-50 text-blue-700', permission: 'orders.view_a_confirmar' },
  { value: 'parcial', label: 'Parcial', color: 'bg-violet-50 text-violet-700', permission: 'orders.view_parcial' },
  { value: 'total', label: 'Total', color: 'bg-emerald-50 text-emerald-700', permission: 'orders.view_total' },
  { value: 'rechazado', label: 'Rechazado', color: 'bg-red-50 text-red-700', permission: 'orders.view_rechazado' },
];

const orderStatusButtons: { value: OrderStatus | 'all'; label: string; color: string; permission?: string }[] = [
  { value: 'all', label: 'Todos', color: 'bg-neutral-100 text-neutral-700' },
  { value: 'pendiente_pago', label: 'Pend. Pago', color: 'bg-amber-50 text-amber-700', permission: 'orders.view_pendiente_pago' },
  { value: 'a_imprimir', label: 'A Imprimir', color: 'bg-blue-50 text-blue-700', permission: 'orders.view_a_imprimir' },
  { value: 'armado', label: 'Armado', color: 'bg-cyan-50 text-cyan-700', permission: 'orders.view_armado' },
  { value: 'retirado', label: 'Retirado', color: 'bg-purple-50 text-purple-700', permission: 'orders.view_retirado' },
  { value: 'enviado', label: 'Enviado', color: 'bg-emerald-50 text-emerald-700', permission: 'orders.view_enviado' },
  { value: 'en_calle', label: 'En Calle', color: 'bg-orange-50 text-orange-700', permission: 'orders.view_en_calle' },
];

export function RealOrders() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const [orders, setOrders] = useState<ApiOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paymentFilter, setPaymentFilter] = useState<PaymentStatus | 'all'>('all');
  const [orderStatusFilter, setOrderStatusFilter] = useState<OrderStatus | 'all'>('all');
  const [fechaFilter, setFechaFilter] = useState<'all' | 'hoy'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Filtrar botones según permisos del usuario
  const visiblePaymentButtons = useMemo(() => {
    return paymentButtons.filter(btn =>
      btn.value === 'all' || !btn.permission || hasPermission(btn.permission)
    );
  }, [hasPermission]);

  const visibleOrderStatusButtons = useMemo(() => {
    return orderStatusButtons.filter(btn =>
      btn.value === 'all' || !btn.permission || hasPermission(btn.permission)
    );
  }, [hasPermission]);

  // Estado para modal de impresión
  const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);
  const [selectedPrintStatuses, setSelectedPrintStatuses] = useState<Set<PaymentStatus>>(
    new Set(['a_confirmar', 'parcial', 'total'])
  );

  const loadOrders = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchOrders();
      setOrders(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar pedidos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOrders();
  }, []);

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
    armado: 'orders.view_armado',
    enviado: 'orders.view_enviado',
    en_calle: 'orders.view_en_calle',
    retirado: 'orders.view_retirado',
  };

  // Primero filtrar por permisos del usuario
  const permittedOrders = useMemo(() => {
    return orders.filter((order) => {
      const paymentStatus = mapEstadoPago(order.estado_pago);
      const orderStatus = mapEstadoPedido(order.estado_pedido);

      // Verificar que el usuario tiene permiso para ver este estado de pago Y este estado de pedido
      const hasPaymentPermission = hasPermission(paymentStatusPermissions[paymentStatus]);
      const hasOrderStatusPermission = hasPermission(orderStatusPermissions[orderStatus]);

      return hasPaymentPermission && hasOrderStatusPermission;
    });
  }, [orders, hasPermission]);

  // Luego aplicar filtros de UI sobre los pedidos permitidos
  const filteredOrders = useMemo(() => {
    return permittedOrders.filter((order) => {
      const paymentStatus = mapEstadoPago(order.estado_pago);
      const orderStatus = mapEstadoPedido(order.estado_pedido);

      const matchesPayment = paymentFilter === 'all' || paymentStatus === paymentFilter;
      const matchesOrderStatus = orderStatusFilter === 'all' || orderStatus === orderStatusFilter;
      const matchesFecha = fechaFilter === 'all' || isToday(new Date(order.created_at));

      // Búsqueda por número de pedido, nombre, email o teléfono
      const query = searchQuery.toLowerCase().trim();
      const matchesSearch = !query ||
        order.order_number.toLowerCase().includes(query) ||
        (order.customer_name?.toLowerCase().includes(query)) ||
        (order.customer_email?.toLowerCase().includes(query)) ||
        (order.customer_phone?.toLowerCase().includes(query));

      return matchesPayment && matchesOrderStatus && matchesFecha && matchesSearch;
    });
  }, [permittedOrders, paymentFilter, orderStatusFilter, fechaFilter, searchQuery]);

  const statusCounts = useMemo(() => {
    return permittedOrders.reduce(
      (acc, order) => {
        const status = mapEstadoPago(order.estado_pago);
        acc[status] = (acc[status] || 0) + 1;
        acc.total += 1;
        return acc;
      },
      { total: 0 } as Record<string, number>
    );
  }, [permittedOrders]);

  // Contar pedidos por estado de pago (no impresos) - solo los permitidos
  const printCountByStatus = useMemo(() => {
    const counts: Record<PaymentStatus, number> = {
      pendiente: 0,
      a_confirmar: 0,
      parcial: 0,
      total: 0,
      rechazado: 0,
    };
    permittedOrders.forEach(order => {
      if (!order.printed_at) {
        const status = mapEstadoPago(order.estado_pago);
        counts[status]++;
      }
    });
    return counts;
  }, [permittedOrders]);

  // Contar pedidos seleccionados para imprimir - solo los permitidos
  const selectedPrintCount = useMemo(() => {
    return permittedOrders.filter(
      (order) =>
        !order.printed_at &&
        selectedPrintStatuses.has(mapEstadoPago(order.estado_pago))
    ).length;
  }, [permittedOrders, selectedPrintStatuses]);

  const formatCurrency = (amount: number | null) => {
    if (amount === null) return '-';
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      maximumFractionDigits: 0,
    }).format(amount);
  };

  const togglePrintStatus = (status: PaymentStatus) => {
    setSelectedPrintStatuses(prev => {
      const newSet = new Set(prev);
      if (newSet.has(status)) {
        newSet.delete(status);
      } else {
        newSet.add(status);
      }
      return newSet;
    });
  };

  const handlePrintSelected = () => {
    const ordersToPrint = permittedOrders.filter(
      (order) =>
        !order.printed_at &&
        selectedPrintStatuses.has(mapEstadoPago(order.estado_pago))
    );

    if (ordersToPrint.length === 0) {
      alert('No hay pedidos para imprimir con los filtros seleccionados');
      return;
    }

    console.log('Imprimiendo pedidos:', ordersToPrint.map(o => o.order_number));
    alert(`Imprimiendo ${ordersToPrint.length} pedidos:\n${ordersToPrint.map(o => '#' + o.order_number).join(', ')}`);
    setIsPrintModalOpen(false);
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Pedidos"
        subtitle={`${statusCounts.total} pedidos en total · ${statusCounts.pendiente || 0} pendientes de pago`}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              leftIcon={<Printer size={16} />}
              onClick={() => setIsPrintModalOpen(true)}
            >
              Imprimir Pedidos
            </Button>
            <Button
              variant="secondary"
              leftIcon={<RefreshCw size={16} className={loading ? 'animate-spin' : ''} />}
              onClick={loadOrders}
              disabled={loading}
            >
              Actualizar
            </Button>
          </div>
        }
      />

      <div className="p-6 space-y-6">
        {/* Búsqueda y Filtros */}
        <div className="space-y-4">
          {/* Barra de búsqueda */}
          <div className="relative">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              placeholder="Buscar por número, cliente, email o teléfono..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-neutral-200 bg-white text-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 focus:border-neutral-300 transition-all"
            />
          </div>

          {/* Filtro de fecha */}
          <div>
            <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2 block">Fecha</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setFechaFilter('all')}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap',
                  fechaFilter === 'all'
                    ? 'bg-neutral-100 text-neutral-700 ring-2 ring-neutral-900/10'
                    : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                )}
              >
                Todos
              </button>
              <button
                onClick={() => setFechaFilter('hoy')}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap flex items-center gap-1.5',
                  fechaFilter === 'hoy'
                    ? 'bg-blue-50 text-blue-700 ring-2 ring-blue-900/10'
                    : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                )}
              >
                <Calendar size={14} />
                Hoy
              </button>
            </div>
          </div>

          {/* Solo mostrar filtro de pago si hay más de un botón (además de "Todos") */}
          {visiblePaymentButtons.length > 1 && (
            <div>
              <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2 block">Estado de Pago</span>
              <div className="flex items-center gap-2 overflow-x-auto pb-2 sm:pb-0">
                {visiblePaymentButtons.map((btn) => (
                  <button
                    key={btn.value}
                    onClick={() => setPaymentFilter(btn.value)}
                    className={clsx(
                      'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap',
                      paymentFilter === btn.value
                        ? clsx(btn.color, 'ring-2 ring-neutral-900/10')
                        : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                    )}
                  >
                    {btn.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Solo mostrar filtro de estado si hay más de un botón (además de "Todos") */}
          {visibleOrderStatusButtons.length > 1 && (
            <div>
              <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2 block">Estado del Pedido</span>
              <div className="flex items-center gap-2 overflow-x-auto pb-2 sm:pb-0">
                {visibleOrderStatusButtons.map((btn) => (
                  <button
                    key={btn.value}
                    onClick={() => setOrderStatusFilter(btn.value)}
                    className={clsx(
                      'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap',
                      orderStatusFilter === btn.value
                        ? clsx(btn.color, 'ring-2 ring-neutral-900/10')
                        : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                    )}
                  >
                    {btn.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Tabla */}
        {loading && orders.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <RefreshCw size={32} className="animate-spin text-neutral-400" />
          </div>
        ) : error ? (
          <Card className="text-center py-8">
            <AlertCircle size={48} className="mx-auto text-red-400 mb-4" />
            <h3 className="text-lg font-semibold text-neutral-900 mb-2">Error al cargar pedidos</h3>
            <p className="text-neutral-500 mb-4">{error}</p>
            <Button onClick={loadOrders}>Reintentar</Button>
          </Card>
        ) : filteredOrders.length === 0 ? (
          <Card className="text-center py-8">
            <p className="text-neutral-500">No hay pedidos que coincidan con los filtros</p>
          </Card>
        ) : (
          <div className="bg-white rounded-2xl border border-neutral-200/60 shadow-soft overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">Pedido</TableHead>
                  <TableHead className="min-w-[140px]">Cliente</TableHead>
                  <TableHead className="text-right w-[90px]">Total</TableHead>
                  <TableHead className="text-right w-[90px]">Pagado</TableHead>
                  <TableHead className="text-center w-[85px]">Pago</TableHead>
                  <TableHead className="text-center w-[95px]">Estado</TableHead>
                  <TableHead className="text-center w-[45px]">Comp</TableHead>
                  <TableHead className="w-[80px]">Fecha</TableHead>
                  <TableHead className="text-right w-[140px]">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredOrders.map((order) => (
                  <TableRow
                    key={order.order_number}
                    isClickable
                    onClick={() => navigate(`/orders/${order.order_number}`)}
                  >
                    <TableCell>
                      <span className="font-mono text-xs font-medium text-neutral-900">
                        #{order.order_number}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium text-sm text-neutral-900 truncate max-w-[160px]">
                          {order.customer_name || 'Sin nombre'}
                        </span>
                        <span className="text-xs text-neutral-500 truncate max-w-[160px]">
                          {order.customer_email || order.customer_phone || '-'}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="font-mono text-xs">{formatCurrency(order.monto_tiendanube)}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="font-mono text-xs">{formatCurrency(order.total_pagado)}</span>
                    </TableCell>
                    <TableCell className="text-center">
                      <PaymentStatusBadge status={mapEstadoPago(order.estado_pago)} size="sm" />
                    </TableCell>
                    <TableCell className="text-center">
                      <OrderStatusBadge status={mapEstadoPedido(order.estado_pedido)} size="sm" />
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-1">
                        <Receipt size={12} className="text-neutral-400" />
                        <span className="text-xs font-medium text-neutral-600">
                          {order.comprobantes_count}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-neutral-500">
                        {format(new Date(order.created_at), 'dd/MM/yyyy HH:mm', { locale: es })}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-0.5">
                        {order.printed_at && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              console.log('Re-imprimiendo:', order.order_number);
                              alert(`Re-imprimiendo pedido #${order.order_number}`);
                            }}
                            className="p-1.5 text-violet-600 hover:text-violet-700 hover:bg-violet-50 rounded-lg transition-colors"
                            title="Re-imprimir"
                          >
                            <RotateCcw size={14} />
                          </button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(`/orders/${order.order_number}`);
                          }}
                          leftIcon={<Eye size={14} />}
                        >
                          Ver
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-sm text-neutral-500">
            Mostrando {filteredOrders.length} de {permittedOrders.length} pedidos
          </span>
        </div>
      </div>

      {/* Modal de selección para impresión */}
      <Modal
        isOpen={isPrintModalOpen}
        onClose={() => setIsPrintModalOpen(false)}
        title="Imprimir Pedidos"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-neutral-600">
            Seleccioná los estados de pago que querés incluir en la impresión:
          </p>

          <div className="space-y-2">
            {/* Opción: Pendiente */}
            <label className="flex items-center justify-between p-3 rounded-xl border border-neutral-200 hover:bg-neutral-50 cursor-pointer transition-colors">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={selectedPrintStatuses.has('pendiente')}
                  onChange={() => togglePrintStatus('pendiente')}
                  className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
                />
                <span className="font-medium text-neutral-900">Pendiente</span>
              </div>
              <span className="text-sm text-neutral-500">{printCountByStatus.pendiente} pedidos</span>
            </label>

            {/* Opción: A confirmar */}
            <label className="flex items-center justify-between p-3 rounded-xl border border-neutral-200 hover:bg-neutral-50 cursor-pointer transition-colors">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={selectedPrintStatuses.has('a_confirmar')}
                  onChange={() => togglePrintStatus('a_confirmar')}
                  className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
                />
                <span className="font-medium text-neutral-900">A confirmar</span>
              </div>
              <span className="text-sm text-neutral-500">{printCountByStatus.a_confirmar} pedidos</span>
            </label>

            {/* Opción: Parcial */}
            <label className="flex items-center justify-between p-3 rounded-xl border border-neutral-200 hover:bg-neutral-50 cursor-pointer transition-colors">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={selectedPrintStatuses.has('parcial')}
                  onChange={() => togglePrintStatus('parcial')}
                  className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
                />
                <span className="font-medium text-neutral-900">Parcial</span>
              </div>
              <span className="text-sm text-neutral-500">{printCountByStatus.parcial} pedidos</span>
            </label>

            {/* Opción: Total */}
            <label className="flex items-center justify-between p-3 rounded-xl border border-neutral-200 hover:bg-neutral-50 cursor-pointer transition-colors">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={selectedPrintStatuses.has('total')}
                  onChange={() => togglePrintStatus('total')}
                  className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
                />
                <span className="font-medium text-neutral-900">Total (Pagado)</span>
              </div>
              <span className="text-sm text-neutral-500">{printCountByStatus.total} pedidos</span>
            </label>

            {/* Opción: Rechazado */}
            <label className="flex items-center justify-between p-3 rounded-xl border border-neutral-200 hover:bg-neutral-50 cursor-pointer transition-colors">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={selectedPrintStatuses.has('rechazado')}
                  onChange={() => togglePrintStatus('rechazado')}
                  className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
                />
                <span className="font-medium text-neutral-900">Rechazado</span>
              </div>
              <span className="text-sm text-neutral-500">{printCountByStatus.rechazado} pedidos</span>
            </label>
          </div>

          {/* Resumen */}
          <div className="p-3 bg-neutral-50 rounded-xl">
            <div className="flex justify-between items-center">
              <span className="text-sm text-neutral-600">Total a imprimir:</span>
              <span className="font-semibold text-neutral-900">{selectedPrintCount} pedidos</span>
            </div>
            <p className="text-xs text-neutral-500 mt-1">
              Solo se imprimirán pedidos que no hayan sido impresos anteriormente
            </p>
          </div>

          {/* Botones */}
          <div className="flex gap-3">
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => setIsPrintModalOpen(false)}
            >
              Cancelar
            </Button>
            <Button
              className="flex-1"
              onClick={handlePrintSelected}
              disabled={selectedPrintCount === 0}
              leftIcon={<Printer size={16} />}
            >
              Imprimir ({selectedPrintCount})
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
