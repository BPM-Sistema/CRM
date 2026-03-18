import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUrlFilters } from '../hooks';
import { RefreshCw, AlertCircle, Printer, Calendar, Search, ChevronLeft, ChevronRight, CheckSquare, X, Truck, Tag } from 'lucide-react';
import { Header } from '../components/layout';
import { Button, Card, PaymentStatusBadge, OrderStatusBadge, Modal } from '../components/ui';
import { AccessDenied } from '../components/AccessDenied';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '../components/ui';
import { fetchOrders, fetchPrintCounts, fetchOrdersToPrint, ApiOrder, mapEstadoPago, mapEstadoPedido, PaymentStatus, OrderStatus, PaginationInfo, OrderFilters, ShippingTypeFilter, getEnvioNubeLabels } from '../services/api';
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
  { value: 'en_calle', label: 'En Calle', color: 'bg-orange-50 text-orange-700', permission: 'orders.view_en_calle' },
  { value: 'enviado', label: 'Enviado', color: 'bg-emerald-50 text-emerald-700', permission: 'orders.view_enviado' },
  { value: 'cancelado', label: 'Cancelado', color: 'bg-red-50 text-red-700', permission: 'orders.view_cancelado' },
];

export function RealOrders() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const [orders, setOrders] = useState<ApiOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Filtros persistidos en URL (se mantienen al navegar y volver)
  const { filters, setFilter, setFilters } = useUrlFilters({
    estado_pago: 'all' as PaymentStatus | 'all',
    estado_pedido: 'all' as OrderStatus | 'all',
    fecha: 'all' as 'all' | 'hoy' | 'custom',
    fecha_custom: '',
    search: '',
    shipping_data: 'all' as 'all' | 'pending' | 'complete',
    shipping_type: 'all' as ShippingTypeFilter,
    page: 1,
  });

  // Aliases para compatibilidad con código existente
  const paymentFilter = filters.estado_pago;
  const orderStatusFilter = filters.estado_pedido;
  const fechaFilter = filters.fecha;
  const customDate = filters.fecha_custom;
  const searchQuery = filters.search;
  const shippingDataFilter = filters.shipping_data;
  const shippingTypeFilter = filters.shipping_type;
  const currentPage = filters.page;

  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
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

  // Estado para modal de pedidos excluidos
  const [excludedModalOpen, setExcludedModalOpen] = useState(false);
  const [excludedOrders, setExcludedOrders] = useState<string[]>([]);
  const [printableOrders, setPrintableOrders] = useState<string[]>([]);

  // Estado para etiquetas Envío Nube
  const [isLoadingLabels, setIsLoadingLabels] = useState(false);

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

  const loadOrders = useCallback(async (page?: number, overrideFilters?: OrderFilters, isFilterChange = false) => {
    const pageToLoad = page ?? currentPage;

    // Calcular fecha desde URL filters
    let fechaParam: string | undefined = undefined;
    const currentFecha = overrideFilters?.fecha !== undefined ? overrideFilters.fecha : fechaFilter;
    if (currentFecha === 'hoy') {
      fechaParam = 'hoy';
    } else if (currentFecha === 'custom' && customDate) {
      fechaParam = customDate;
    }

    const filtersToUse = overrideFilters ?? {
      estado_pago: paymentFilter,
      estado_pedido: orderStatusFilter,
      search: searchQuery,
      fecha: fechaParam,
      shipping_data: shippingDataFilter === 'all' ? undefined : shippingDataFilter,
      shipping_type: shippingTypeFilter === 'all' ? undefined : shippingTypeFilter,
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
  }, [currentPage, fechaFilter, customDate, paymentFilter, orderStatusFilter, searchQuery, shippingDataFilter, shippingTypeFilter]);

  const handleRefresh = () => loadOrders();

  // Handler para cambios de fecha
  const handleFechaChange = (fecha: 'all' | 'hoy' | 'custom', customValue?: string) => {
    // Actualizar filtros en URL (esto dispara el useEffect que recarga)
    if (fecha === 'all' || fecha === 'hoy') {
      setFilters({ fecha, fecha_custom: '', page: 1 });
    } else {
      setFilters({ fecha, fecha_custom: customValue || '', page: 1 });
    }
  };

  const goToPage = (page: number) => {
    setFilter('page', page);
  };

  // Recargar cuando cambian los filtros desde la URL
  // Este efecto se dispara cuando cualquier filtro cambia (incluyendo navegación back/forward)
  useEffect(() => {
    loadOrders(currentPage, undefined, true);
  }, [paymentFilter, orderStatusFilter, shippingDataFilter, shippingTypeFilter, fechaFilter, customDate, currentPage, searchQuery]);

  // Estado local para input de búsqueda (con debounce antes de actualizar URL)
  const [searchInput, setSearchInput] = useState(searchQuery);

  // Sincronizar searchInput cuando searchQuery cambia desde URL (back/forward)
  useEffect(() => {
    setSearchInput(searchQuery);
  }, [searchQuery]);

  // Debounce para búsqueda: actualiza URL después de 300ms sin typing
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput !== searchQuery) {
        setFilters({ search: searchInput, page: 1 });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Ref para guardar la función loadOrders actualizada (evita stale closures)
  const loadOrdersRef = useRef(loadOrders);
  useEffect(() => {
    loadOrdersRef.current = loadOrders;
  });

  // Refetch al volver a la pestaña (sin polling para evitar sync issues)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Usar ref para siempre tener la función actualizada
        loadOrdersRef.current();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []); // Sin dependencias - el ref siempre tiene la función actual

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
    retirado: 'orders.view_retirado',
    en_calle: 'orders.view_en_calle',
    enviado: 'orders.view_enviado',
    cancelado: 'orders.view_cancelado',
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

  // Imprimir etiquetas de Envío Nube para pedidos seleccionados
  const printEnvioNubeLabels = async () => {
    if (selectedOrderNumbers.size === 0) return;

    setIsLoadingLabels(true);
    try {
      // Filtrar solo pedidos con Envío Nube
      const selectedOrders = orders.filter(o => selectedOrderNumbers.has(o.order_number));
      const envioNubeOrders = selectedOrders.filter(o => {
        const shippingType = (o.shipping_type || '').toLowerCase();
        return shippingType.includes('envío nube') || shippingType.includes('envio nube');
      });

      if (envioNubeOrders.length === 0) {
        alert('Ninguno de los pedidos seleccionados usa Envío Nube');
        return;
      }

      const orderNumbers = envioNubeOrders.map(o => o.order_number);
      const result = await getEnvioNubeLabels(orderNumbers);

      // Abrir PDF en nueva pestaña para imprimir
      window.open(result.url, '_blank');

      if (result.failed > 0) {
        alert(`Se obtuvieron ${result.success} etiquetas. ${result.failed} fallaron.`);
      }

      clearSelection();
    } catch (err) {
      console.error('Error al obtener etiquetas:', err);
      alert(err instanceof Error ? err.message : 'Error al obtener etiquetas de Envío Nube');
    } finally {
      setIsLoadingLabels(false);
    }
  };

  const [isPrinting, setIsPrinting] = useState(false);

  const handlePrintSelected = async () => {
    if (selectedPrintStatuses.size === 0) {
      return;
    }

    setIsPrinting(true);
    try {
      // Obtener TODOS los pedidos a imprimir desde el backend
      const statuses = Array.from(selectedPrintStatuses);
      const { orderNumbers, count, excluded, excludedCount } = await fetchOrdersToPrint(statuses);

      if (count === 0 && excludedCount === 0) {
        // No hay nada que imprimir - mostrar modal vacío
        setExcludedOrders([]);
        setPrintableOrders([]);
        setExcludedModalOpen(true);
        return;
      }

      // Si hay excluidos, mostrar modal de confirmación
      if (excludedCount > 0) {
        setExcludedOrders(excluded);
        setPrintableOrders(orderNumbers);
        setExcludedModalOpen(true);
        setIsPrintModalOpen(false);
        // Recargar notificaciones inmediatamente
        window.dispatchEvent(new Event('refresh-notifications'));
        return;
      }

      // No hay excluidos, imprimir directamente
      proceedToPrint(orderNumbers);
    } catch (err) {
      console.error('Error al obtener pedidos:', err);
    } finally {
      setIsPrinting(false);
    }
  };

  const proceedToPrint = (orderNumbers: string[]) => {
    const params = new URLSearchParams();
    params.set('orders', orderNumbers.join(','));
    navigate(`/orders/print?${params.toString()}`);
    setIsPrintModalOpen(false);
    setExcludedModalOpen(false);
  };

  // Check permission to view this page
  const canView = hasPermission('orders.view') || hasPermission('orders.print') ||
                  hasPermission('orders.update_status') || hasPermission('orders.create_cash_payment');

  if (!canView) {
    return <AccessDenied message="No tenés permiso para acceder a la sección de Pedidos." />;
  }

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
                  leftIcon={<Tag size={16} />}
                  onClick={printEnvioNubeLabels}
                  disabled={selectedOrderNumbers.size === 0 || isLoadingLabels}
                >
                  {isLoadingLabels ? 'Cargando...' : 'Etiquetas Envío Nube'}
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
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-neutral-200 bg-white text-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 focus:border-neutral-300 transition-all"
            />
          </div>

          {/* Filtro de fecha */}
          <div>
            <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2 block">Fecha</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleFechaChange('all')}
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
                onClick={() => handleFechaChange('hoy')}
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
              <input
                type="date"
                value={customDate}
                onChange={(e) => {
                  if (e.target.value) {
                    handleFechaChange('custom', e.target.value);
                  } else {
                    // Limpiar fecha → volver a "Todos"
                    handleFechaChange('all');
                  }
                }}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150',
                  fechaFilter === 'custom'
                    ? 'bg-violet-50 text-violet-700 ring-2 ring-violet-900/10 border-transparent'
                    : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                )}
              />
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
                    onClick={() => setFilters({ estado_pago: btn.value, page: 1 })}
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
                    onClick={() => setFilters({ estado_pedido: btn.value, page: 1 })}
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

          {/* Filtro de tipo de envío */}
          <div>
            <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2 block flex items-center gap-1.5">
              <Truck size={12} />
              Tipo de Envío
            </span>
            <div className="flex items-center gap-2 overflow-x-auto pb-2 sm:pb-0">
              {([
                { value: 'all', label: 'Todos', color: 'bg-neutral-100 text-neutral-700' },
                { value: 'envio_nube', label: 'Envío Nube', color: 'bg-sky-50 text-sky-700' },
                { value: 'via_cargo', label: 'Via Cargo', color: 'bg-orange-50 text-orange-700' },
                { value: 'expreso', label: 'Expreso', color: 'bg-violet-50 text-violet-700' },
                { value: 'retiro', label: 'Retiro', color: 'bg-emerald-50 text-emerald-700' },
              ] as const).map((btn) => (
                <button
                  key={btn.value}
                  onClick={() => setFilters({ shipping_type: btn.value, page: 1 })}
                  className={clsx(
                    'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap',
                    shippingTypeFilter === btn.value
                      ? clsx(btn.color, 'ring-2 ring-neutral-900/10')
                      : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                  )}
                >
                  {btn.label}
                </button>
              ))}
            </div>
          </div>

          {/* Filtro de datos de envío (solo para Transporte a elección / Via Cargo) */}
          <div>
            <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2 block flex items-center gap-1.5">
              Datos de Envío
              <span className="normal-case font-normal text-neutral-400">(solo transporte a elección)</span>
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setFilters({ shipping_data: 'all', page: 1 })}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap',
                  shippingDataFilter === 'all'
                    ? 'bg-neutral-100 text-neutral-700 ring-2 ring-neutral-900/10'
                    : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                )}
              >
                Todos
              </button>
              <button
                onClick={() => setFilters({ shipping_data: 'pending', page: 1 })}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap',
                  shippingDataFilter === 'pending'
                    ? 'bg-amber-50 text-amber-700 ring-2 ring-amber-900/10'
                    : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                )}
              >
                Pendiente
              </button>
              <button
                onClick={() => setFilters({ shipping_data: 'complete', page: 1 })}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap',
                  shippingDataFilter === 'complete'
                    ? 'bg-emerald-50 text-emerald-700 ring-2 ring-emerald-900/10'
                    : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                )}
              >
                Completo
              </button>
            </div>
          </div>
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
                  <TableHead className="w-[90px]">Venta</TableHead>
                  <TableHead className="w-[110px]">Fecha ↓</TableHead>
                  <TableHead className="min-w-[150px]">Cliente</TableHead>
                  <TableHead className="text-right w-[130px]">Total</TableHead>
                  <TableHead className="text-center w-[90px]">Productos</TableHead>
                  <TableHead className="w-[200px]">Pago</TableHead>
                  <TableHead className="w-[240px]">Envío</TableHead>
                  <TableHead className="w-[36px]">{' '}</TableHead>
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
                    className={selectedOrderNumbers.has(order.order_number) ? 'bg-blue-50' : 'even:bg-neutral-50/50'}
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
                    {/* Venta */}
                    <TableCell>
                      <span className="text-sm font-medium text-blue-600">
                        #{order.order_number}
                      </span>
                    </TableCell>

                    {/* Fecha */}
                    <TableCell>
                      <span className="text-sm text-neutral-600">
                        {format(new Date(order.created_at), 'd MMM HH:mm', { locale: es })}
                      </span>
                    </TableCell>

                    {/* Cliente */}
                    <TableCell>
                      <span className="text-sm text-blue-600 truncate max-w-[180px] block">
                        {order.customer_name || 'Sin nombre'}
                      </span>
                    </TableCell>

                    {/* Total */}
                    <TableCell className="text-right">
                      <span className="text-sm text-neutral-900">{formatCurrency(order.monto_tiendanube)}</span>
                    </TableCell>

                    {/* Productos */}
                    <TableCell className="text-center">
                      <span className="text-sm text-blue-600">
                        {order.productos_count || 0} unid. ∨
                      </span>
                    </TableCell>

                    {/* Pago */}
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <div>
                          <PaymentStatusBadge status={mapEstadoPago(order.estado_pago)} size="md" />
                        </div>
                        {order.estado_pedido === 'cancelado' && (
                          <div>
                            <OrderStatusBadge status="cancelado" size="md" />
                          </div>
                        )}
                        <span className="text-xs text-neutral-400">
                          Personalizado - A convenir
                        </span>
                      </div>
                    </TableCell>

                    {/* Envío */}
                    <TableCell>
                      {order.estado_pedido !== 'cancelado' && (
                        <div className="flex flex-col gap-1">
                          <div>
                            <OrderStatusBadge status={mapEstadoPedido(order.estado_pedido)} size="md" />
                          </div>
                          <span className="text-xs text-neutral-500 truncate max-w-[220px]" title={order.shipping_type || ''}>
                            {order.shipping_type || '-'}
                          </span>
                        </div>
                      )}
                    </TableCell>

                    {/* Menú */}
                    <TableCell className="text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/orders/${order.order_number}`);
                        }}
                        className="p-1 text-neutral-400 hover:text-neutral-600 rounded transition-colors"
                        title="Ver detalle"
                      >
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                          <circle cx="8" cy="3" r="1.5" />
                          <circle cx="8" cy="8" r="1.5" />
                          <circle cx="8" cy="13" r="1.5" />
                        </svg>
                      </button>
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

      {/* Modal de pedidos excluidos */}
      <Modal
        isOpen={excludedModalOpen}
        onClose={() => setExcludedModalOpen(false)}
        title="Pedidos excluidos de la impresión"
        size="sm"
      >
        <div className="space-y-4">
          {printableOrders.length === 0 && excludedOrders.length === 0 ? (
            <div className="p-4 bg-neutral-50 rounded-xl text-center">
              <p className="text-neutral-600">No hay pedidos para imprimir con los estados seleccionados.</p>
            </div>
          ) : printableOrders.length === 0 ? (
            <>
              <div className="p-4 bg-amber-50 rounded-xl">
                <p className="text-sm text-amber-800 font-medium mb-2">
                  No se puede imprimir ningún pedido
                </p>
                <p className="text-sm text-amber-700">
                  {excludedOrders.length} pedido(s) requieren datos de envío (Transporte a elección):
                </p>
                <p className="text-sm text-amber-600 mt-2 font-mono">
                  {excludedOrders.slice(0, 10).map(n => `#${n}`).join(', ')}
                  {excludedOrders.length > 10 && ` y ${excludedOrders.length - 10} más...`}
                </p>
              </div>
              <p className="text-xs text-neutral-500 text-center">
                Esta información quedó registrada en tus notificaciones.
              </p>
            </>
          ) : (
            <>
              <div className="p-4 bg-emerald-50 rounded-xl">
                <p className="text-sm text-emerald-800 font-medium">
                  Se van a imprimir {printableOrders.length} pedido(s)
                </p>
              </div>
              <div className="p-4 bg-amber-50 rounded-xl">
                <p className="text-sm text-amber-800 font-medium mb-2">
                  {excludedOrders.length} pedido(s) NO se imprimirán
                </p>
                <p className="text-sm text-amber-700">
                  Requieren datos de envío (Transporte a elección):
                </p>
                <p className="text-sm text-amber-600 mt-2 font-mono">
                  {excludedOrders.slice(0, 10).map(n => `#${n}`).join(', ')}
                  {excludedOrders.length > 10 && ` y ${excludedOrders.length - 10} más...`}
                </p>
              </div>
              <p className="text-xs text-neutral-500 text-center">
                Esta información quedó registrada en tus notificaciones.
              </p>
            </>
          )}

          <div className="flex gap-3 pt-2">
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => setExcludedModalOpen(false)}
            >
              Cerrar
            </Button>
            {printableOrders.length > 0 && (
              <Button
                className="flex-1"
                onClick={() => proceedToPrint(printableOrders)}
                leftIcon={<Printer size={16} />}
              >
                Continuar ({printableOrders.length})
              </Button>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
