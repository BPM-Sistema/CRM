import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, AlertCircle, Eye, Receipt, RotateCcw, Printer, Calendar, Search, ChevronLeft, ChevronRight, CheckSquare, X } from 'lucide-react';
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
import { fetchOrders, fetchPrintCounts, fetchOrdersToPrint, ApiOrder, mapEstadoPago, mapEstadoPedido, PaymentStatus, OrderStatus, PaginationInfo, OrderFilters } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { format } from 'date-fns';
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
  { value: 'hoja_impresa', label: 'Hoja Impr.', color: 'bg-violet-50 text-violet-700', permission: 'orders.view_hoja_impresa' },
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
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  // Estado explícito para mostrar spinner cuando se cambian filtros
  const [isFiltering, setIsFiltering] = useState(false);
  const ITEMS_PER_PAGE = 50;

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

  // Estado para selección de pedidos
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedOrderNumbers, setSelectedOrderNumbers] = useState<Set<string>>(new Set());

  // Estado para modal de impresión
  const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);
  const [selectedPrintStatuses, setSelectedPrintStatuses] = useState<Set<OrderStatus>>(
    new Set(['a_imprimir'])
  );
  const [printCounts, setPrintCounts] = useState<Record<OrderStatus, number> | null>(null);
  const [loadingPrintCounts, setLoadingPrintCounts] = useState(false);

  // Cargar conteos de impresión desde el backend (independiente de filtros)
  const loadPrintCounts = async () => {
    setLoadingPrintCounts(true);
    try {
      const counts = await fetchPrintCounts();
      setPrintCounts(counts);
    } catch (err) {
      console.error('Error al cargar conteos de impresión:', err);
    } finally {
      setLoadingPrintCounts(false);
    }
  };

  // Abrir modal y cargar conteos (reset para forzar refresh visual)
  const openPrintModal = () => {
    setPrintCounts(null); // Reset para mostrar loading y forzar datos frescos
    setIsPrintModalOpen(true);
    loadPrintCounts();
  };

  const loadOrders = async (page?: number, filters?: OrderFilters, isFilterChange = false) => {
    const pageToLoad = page ?? currentPage;
    const filtersToUse = filters ?? {
      estado_pago: paymentFilter,
      estado_pedido: orderStatusFilter,
      search: searchQuery,
      fecha: fechaFilter,
    };
    setLoading(true);
    if (isFilterChange) {
      setIsFiltering(true);
    }
    setError(null);
    try {
      const response = await fetchOrders(pageToLoad, ITEMS_PER_PAGE, filtersToUse);
      setOrders(response.data);
      setPagination(response.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar pedidos');
    } finally {
      setLoading(false);
      setIsFiltering(false);
    }
  };

  const handleRefresh = () => loadOrders();

  const goToPage = (page: number) => {
    setCurrentPage(page);
    loadOrders(page, undefined, true); // true = mostrar spinner
  };

  // Recargar cuando cambian los filtros (resetear a página 1)
  useEffect(() => {
    setCurrentPage(1);
    loadOrders(1, undefined, true); // true = es cambio de filtro
  }, [paymentFilter, orderStatusFilter, fechaFilter]);

  // Debounce para búsqueda
  useEffect(() => {
    const timer = setTimeout(() => {
      setCurrentPage(1);
      loadOrders(1, undefined, true); // true = es cambio de filtro
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    // Refetch al enfocar la ventana
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadOrders();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Polling cada 15 segundos para datos en tiempo real
    const pollInterval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadOrders();
      }
    }, 15000);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(pollInterval);
    };
  }, [paymentFilter, orderStatusFilter, searchQuery, fechaFilter]);

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

  // Primero filtrar por permisos del usuario
  const permittedOrders = useMemo(() => {
    return orders.filter((order) => {
      const paymentStatus = mapEstadoPago(order.estado_pago);
      const orderStatus = mapEstadoPedido(order.estado_pedido);

      // Verificar que el usuario tiene permiso para ver este estado de pago O este estado de pedido
      const hasPaymentPermission = hasPermission(paymentStatusPermissions[paymentStatus]);
      const hasOrderStatusPermission = hasPermission(orderStatusPermissions[orderStatus]);

      return hasPaymentPermission || hasOrderStatusPermission;
    });
  }, [orders, hasPermission]);

  // Los filtros ahora se aplican en el servidor, solo filtramos por permisos localmente
  const filteredOrders = permittedOrders;

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

  // Contar pedidos seleccionados para imprimir - usa conteos del API
  const selectedPrintCount = useMemo(() => {
    if (!printCounts) return 0;
    let total = 0;
    selectedPrintStatuses.forEach(status => {
      total += printCounts[status] || 0;
    });
    return total;
  }, [printCounts, selectedPrintStatuses]);

  const formatCurrency = (amount: number | null) => {
    if (amount === null) return '-';
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      maximumFractionDigits: 0,
    }).format(amount);
  };

  const togglePrintStatus = (status: OrderStatus) => {
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

  // Funciones de selección de pedidos
  const toggleSelectOrder = (orderNumber: string) => {
    setSelectedOrderNumbers(prev => {
      const newSet = new Set(prev);
      if (newSet.has(orderNumber)) {
        newSet.delete(orderNumber);
      } else {
        newSet.add(orderNumber);
      }
      return newSet;
    });
  };

  const selectAllVisible = () => {
    const visibleOrderNumbers = filteredOrders.map(o => o.order_number);
    setSelectedOrderNumbers(new Set(visibleOrderNumbers));
  };

  const clearSelection = () => {
    setSelectedOrderNumbers(new Set());
    setSelectionMode(false);
  };

  const printSelectedOrders = () => {
    if (selectedOrderNumbers.size === 0) return;
    const params = new URLSearchParams();
    params.set('orders', Array.from(selectedOrderNumbers).join(','));
    navigate(`/orders/print?${params.toString()}`);
    clearSelection();
  };

  const [isPrinting, setIsPrinting] = useState(false);

  const handlePrintSelected = async () => {
    if (selectedPrintStatuses.size === 0) {
      alert('Seleccioná al menos un estado para imprimir');
      return;
    }

    setIsPrinting(true);
    try {
      // Obtener TODOS los pedidos a imprimir desde el backend
      const statuses = Array.from(selectedPrintStatuses);
      const { orderNumbers, count } = await fetchOrdersToPrint(statuses);

      if (count === 0) {
        alert('No hay pedidos para imprimir con los estados seleccionados');
        return;
      }

      // Navegar a la página de impresión con los order_numbers
      const params = new URLSearchParams();
      params.set('orders', orderNumbers.join(','));
      navigate(`/orders/print?${params.toString()}`);

      setIsPrintModalOpen(false);
    } catch (err) {
      console.error('Error al obtener pedidos:', err);
      alert(err instanceof Error ? err.message : 'Error al obtener pedidos para imprimir');
    } finally {
      setIsPrinting(false);
    }
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Pedidos"
        subtitle={`${statusCounts.total} pedidos en total · ${statusCounts.pendiente || 0} pendientes de pago`}
        actions={
          <div className="flex items-center gap-2">
            {selectionMode ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={selectAllVisible}
                >
                  Seleccionar todos ({filteredOrders.length})
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<Printer size={16} />}
                  onClick={printSelectedOrders}
                  disabled={selectedOrderNumbers.size === 0}
                >
                  Imprimir ({selectedOrderNumbers.size})
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<X size={16} />}
                  onClick={clearSelection}
                >
                  Cancelar
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="secondary"
                  onClick={() => setSelectionMode(true)}
                  leftIcon={<CheckSquare size={16} />}
                >
                  Seleccionar
                </Button>
                <Button
                  variant="secondary"
                  leftIcon={<Printer size={16} />}
                  onClick={openPrintModal}
                >
                  Imprimir Pedidos
                </Button>
                <Button
                  variant="secondary"
                  leftIcon={<RefreshCw size={16} className={loading ? 'animate-spin' : ''} />}
                  onClick={handleRefresh}
                  disabled={loading}
                >
                  Actualizar
                </Button>
              </>
            )}
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
        ) : isFiltering ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3">
              <RefreshCw size={32} className="animate-spin text-neutral-400" />
              <span className="text-sm text-neutral-500">Cargando...</span>
            </div>
          </div>
        ) : error ? (
          <Card className="text-center py-8">
            <AlertCircle size={48} className="mx-auto text-red-400 mb-4" />
            <h3 className="text-lg font-semibold text-neutral-900 mb-2">Error al cargar pedidos</h3>
            <p className="text-neutral-500 mb-4">{error}</p>
            <Button onClick={handleRefresh}>Reintentar</Button>
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
                  {selectionMode && (
                    <TableHead className="w-[40px] text-center">
                      <input
                        type="checkbox"
                        checked={selectedOrderNumbers.size === filteredOrders.length && filteredOrders.length > 0}
                        onChange={(e) => {
                          if (e.target.checked) {
                            selectAllVisible();
                          } else {
                            setSelectedOrderNumbers(new Set());
                          }
                        }}
                        className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
                      />
                    </TableHead>
                  )}
                  <TableHead className="w-[100px]">Pedido</TableHead>
                  <TableHead className="min-w-[140px]">Cliente</TableHead>
                  <TableHead className="text-right w-[90px]">Total</TableHead>
                  <TableHead className="text-right w-[90px]">Pagado</TableHead>
                  <TableHead className="text-center w-[85px]">Pago</TableHead>
                  <TableHead className="text-center w-[95px]">Estado</TableHead>
                  <TableHead className="text-center w-[45px]">Pagos</TableHead>
                  <TableHead className="w-[80px]">Fecha</TableHead>
                  <TableHead className="text-right w-[140px]">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredOrders.map((order) => (
                  <TableRow
                    key={order.order_number}
                    isClickable={!selectionMode}
                    onClick={() => {
                      if (selectionMode) {
                        toggleSelectOrder(order.order_number);
                      } else {
                        navigate(`/orders/${order.order_number}`);
                      }
                    }}
                    className={selectedOrderNumbers.has(order.order_number) ? 'bg-blue-50' : ''}
                  >
                    {selectionMode && (
                      <TableCell className="text-center">
                        <input
                          type="checkbox"
                          checked={selectedOrderNumbers.has(order.order_number)}
                          onChange={() => toggleSelectOrder(order.order_number)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
                        />
                      </TableCell>
                    )}
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

        {/* Paginación */}
        {pagination && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-neutral-500">
              Mostrando {filteredOrders.length} de {pagination.total} pedidos (página {pagination.page} de {pagination.totalPages})
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1 || loading}
                leftIcon={<ChevronLeft size={16} />}
              >
                Anterior
              </Button>
              <div className="flex items-center gap-1">
                {Array.from({ length: Math.min(5, pagination.totalPages) }, (_, i) => {
                  let pageNum: number;
                  if (pagination.totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (currentPage <= 3) {
                    pageNum = i + 1;
                  } else if (currentPage >= pagination.totalPages - 2) {
                    pageNum = pagination.totalPages - 4 + i;
                  } else {
                    pageNum = currentPage - 2 + i;
                  }
                  return (
                    <button
                      key={pageNum}
                      onClick={() => goToPage(pageNum)}
                      disabled={loading}
                      className={clsx(
                        'w-8 h-8 rounded-lg text-sm font-medium transition-colors',
                        pageNum === currentPage
                          ? 'bg-neutral-900 text-white'
                          : 'bg-white text-neutral-600 hover:bg-neutral-100 border border-neutral-200'
                      )}
                    >
                      {pageNum}
                    </button>
                  );
                })}
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage >= pagination.totalPages || loading}
                rightIcon={<ChevronRight size={16} />}
              >
                Siguiente
              </Button>
            </div>
          </div>
        )}
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
            Seleccioná los estados del pedido que querés incluir en la impresión:
          </p>

          {loadingPrintCounts ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw size={24} className="animate-spin text-neutral-400" />
            </div>
          ) : (
            <div className="space-y-2">
              {/* Opción: A Imprimir */}
              <label className="flex items-center justify-between p-3 rounded-xl border border-neutral-200 hover:bg-neutral-50 cursor-pointer transition-colors">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={selectedPrintStatuses.has('a_imprimir')}
                    onChange={() => togglePrintStatus('a_imprimir')}
                    className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
                  />
                  <span className="font-medium text-neutral-900">A Imprimir</span>
                </div>
                <span className="text-sm text-neutral-500">{printCounts?.a_imprimir ?? 0} pedidos</span>
              </label>

              {/* Opción: Hoja Impresa */}
              <label className="flex items-center justify-between p-3 rounded-xl border border-neutral-200 hover:bg-neutral-50 cursor-pointer transition-colors">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={selectedPrintStatuses.has('hoja_impresa')}
                    onChange={() => togglePrintStatus('hoja_impresa')}
                    className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
                  />
                  <span className="font-medium text-neutral-900">Hoja Impresa</span>
                </div>
                <span className="text-sm text-neutral-500">{printCounts?.hoja_impresa ?? 0} pedidos</span>
              </label>

              {/* Opción: Pendiente Pago */}
              <label className="flex items-center justify-between p-3 rounded-xl border border-neutral-200 hover:bg-neutral-50 cursor-pointer transition-colors">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={selectedPrintStatuses.has('pendiente_pago')}
                    onChange={() => togglePrintStatus('pendiente_pago')}
                    className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
                  />
                  <span className="font-medium text-neutral-900">Pendiente Pago</span>
                </div>
                <span className="text-sm text-neutral-500">{printCounts?.pendiente_pago ?? 0} pedidos</span>
              </label>

              {/* Opción: Armado */}
              <label className="flex items-center justify-between p-3 rounded-xl border border-neutral-200 hover:bg-neutral-50 cursor-pointer transition-colors">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={selectedPrintStatuses.has('armado')}
                    onChange={() => togglePrintStatus('armado')}
                    className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
                  />
                  <span className="font-medium text-neutral-900">Armado</span>
                </div>
                <span className="text-sm text-neutral-500">{printCounts?.armado ?? 0} pedidos</span>
              </label>

              {/* Opción: Retirado */}
              <label className="flex items-center justify-between p-3 rounded-xl border border-neutral-200 hover:bg-neutral-50 cursor-pointer transition-colors">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={selectedPrintStatuses.has('retirado')}
                    onChange={() => togglePrintStatus('retirado')}
                    className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
                  />
                  <span className="font-medium text-neutral-900">Retirado</span>
                </div>
                <span className="text-sm text-neutral-500">{printCounts?.retirado ?? 0} pedidos</span>
              </label>

              {/* Opción: Enviado */}
              <label className="flex items-center justify-between p-3 rounded-xl border border-neutral-200 hover:bg-neutral-50 cursor-pointer transition-colors">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={selectedPrintStatuses.has('enviado')}
                    onChange={() => togglePrintStatus('enviado')}
                    className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
                  />
                  <span className="font-medium text-neutral-900">Enviado</span>
                </div>
                <span className="text-sm text-neutral-500">{printCounts?.enviado ?? 0} pedidos</span>
              </label>

              {/* Opción: En Calle */}
              <label className="flex items-center justify-between p-3 rounded-xl border border-neutral-200 hover:bg-neutral-50 cursor-pointer transition-colors">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={selectedPrintStatuses.has('en_calle')}
                    onChange={() => togglePrintStatus('en_calle')}
                    className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-500"
                  />
                  <span className="font-medium text-neutral-900">En Calle</span>
                </div>
                <span className="text-sm text-neutral-500">{printCounts?.en_calle ?? 0} pedidos</span>
              </label>
            </div>
          )}

          {/* Resumen */}
          <div className="p-3 bg-neutral-50 rounded-xl">
            <div className="flex justify-between items-center">
              <span className="text-sm text-neutral-600">Total a imprimir:</span>
              <span className="font-semibold text-neutral-900">{selectedPrintCount} pedidos</span>
            </div>
            <p className="text-xs text-neutral-500 mt-1">
              Se incluyen todos los pedidos con los estados seleccionados
            </p>
          </div>

          {/* Botones */}
          <div className="flex gap-3">
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => setIsPrintModalOpen(false)}
              disabled={isPrinting}
            >
              Cancelar
            </Button>
            <Button
              className="flex-1"
              onClick={handlePrintSelected}
              disabled={selectedPrintCount === 0 || isPrinting}
              leftIcon={isPrinting ? <RefreshCw size={16} className="animate-spin" /> : <Printer size={16} />}
            >
              {isPrinting ? 'Cargando...' : `Imprimir (${selectedPrintCount})`}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
