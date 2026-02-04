import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShoppingCart,
  CheckCircle,
  Clock,
  XCircle,
  DollarSign,
  RefreshCw,
  Printer,
  Package,
  FileText,
  AlertCircle,
} from 'lucide-react';
import { Header } from '../components/layout';
import { KPICard, ActivityFeed, StatusDistributionChart } from '../components/dashboard';
import { fetchOrders, fetchComprobantes, ApiOrder, ApiComprobanteList } from '../services/api';
import { isToday } from 'date-fns';

export function Dashboard() {
  const navigate = useNavigate();
  const [orders, setOrders] = useState<ApiOrder[]>([]);
  const [comprobantes, setComprobantes] = useState<ApiComprobanteList[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [ordersData, comprobantesData] = await Promise.all([
        fetchOrders(),
        fetchComprobantes()
      ]);
      setOrders(ordersData);
      setComprobantes(comprobantesData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar datos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Calcular KPIs
  const kpis = useMemo(() => {
    const pedidosHoy = orders.filter(o => isToday(new Date(o.created_at)));

    // Pedidos por estado de pago
    const pagados = pedidosHoy.filter(o =>
      o.estado_pago === 'confirmado_total' || o.estado_pago === 'a_favor'
    ).length;

    const pendientes = pedidosHoy.filter(o =>
      o.estado_pago === 'pendiente' || o.estado_pago === 'a_confirmar'
    ).length;

    const parciales = pedidosHoy.filter(o =>
      o.estado_pago === 'confirmado_parcial'
    ).length;

    // Comprobantes pendientes de confirmar
    const comprobantesAConfirmar = comprobantes.filter(c =>
      c.estado === 'pendiente' || c.estado === 'a_confirmar'
    ).length;

    // Total recaudado hoy (solo confirmados)
    const recaudadoHoy = pedidosHoy
      .filter(o => o.estado_pago === 'confirmado_total' || o.estado_pago === 'a_favor')
      .reduce((sum, o) => sum + (o.total_pagado || 0), 0);

    // Pedidos por estado de proceso
    const aImprimir = orders.filter(o => o.estado_pedido === 'a_imprimir').length;
    const armados = orders.filter(o => o.estado_pedido === 'armado').length;
    const enviados = orders.filter(o =>
      o.estado_pedido === 'enviado' || o.estado_pedido === 'en_calle' || o.estado_pedido === 'retirado'
    ).length;

    return {
      totalPedidosHoy: pedidosHoy.length,
      pagados,
      pendientes,
      parciales,
      comprobantesAConfirmar,
      recaudadoHoy,
      aImprimir,
      armados,
      enviados,
    };
  }, [orders, comprobantes]);

  // Datos para el gráfico de estados
  const chartData = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    const rejected = comprobantes.filter(c => c.estado === 'rechazado').length;
    return [{
      date: today,
      paid: kpis.pagados,
      pending: kpis.pendientes + kpis.parciales,
      rejected,
      total: kpis.totalPedidosHoy,
    }];
  }, [kpis, comprobantes]);

  // Actividad reciente (últimos comprobantes)
  const actividadReciente = useMemo(() => {
    return comprobantes.slice(0, 10).map(c => ({
      id: c.id.toString(),
      orderId: c.id.toString(),
      action: c.estado === 'confirmado' ? 'validated' as const :
              c.estado === 'rechazado' ? 'rejected' as const : 'created' as const,
      performedBy: 'Sistema',
      description: c.estado === 'confirmado'
        ? `Comprobante confirmado - $${c.monto?.toLocaleString('es-AR') || '0'}`
        : c.estado === 'rechazado'
        ? `Comprobante rechazado`
        : `Nuevo comprobante recibido - $${c.monto?.toLocaleString('es-AR') || '0'}`,
      timestamp: c.created_at,
      orderNumber: c.order_number || `#${c.id}`,
    }));
  }, [comprobantes]);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(amount);
  };

  if (loading && orders.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <RefreshCw size={32} className="animate-spin text-neutral-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl border border-neutral-200/60 p-8 text-center max-w-md">
          <AlertCircle size={48} className="mx-auto text-red-400 mb-4" />
          <h3 className="text-lg font-semibold text-neutral-900 mb-2">Error al cargar datos</h3>
          <p className="text-neutral-500 mb-4">{error}</p>
          <button
            onClick={loadData}
            className="px-4 py-2 bg-neutral-900 text-white rounded-lg hover:bg-neutral-800"
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header
        title="Panel"
        subtitle="Resumen de operaciones financieras"
        actions={
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded-lg transition-colors"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Actualizar
          </button>
        }
      />

      <div className="p-6 space-y-6">
        {/* KPIs principales */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          <KPICard
            title="Pedidos Hoy"
            value={kpis.totalPedidosHoy}
            icon={<ShoppingCart size={20} />}
            iconColor="neutral"
          />
          <KPICard
            title="Pagados"
            value={kpis.pagados}
            icon={<CheckCircle size={20} />}
            iconColor="green"
          />
          <KPICard
            title="Pendientes"
            value={kpis.pendientes}
            icon={<Clock size={20} />}
            iconColor="yellow"
          />
          <KPICard
            title="Parciales"
            value={kpis.parciales}
            icon={<XCircle size={20} />}
            iconColor="red"
          />
          <KPICard
            title="Recaudado Hoy"
            value={formatCurrency(kpis.recaudadoHoy)}
            icon={<DollarSign size={20} />}
            iconColor="green"
          />
          <KPICard
            title="A Confirmar"
            value={kpis.comprobantesAConfirmar}
            icon={<FileText size={20} />}
            iconColor="blue"
          />
        </div>

        {/* Gráfico de estados */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <StatusDistributionChart data={chartData} />

          {/* Acciones rápidas */}
          <div className="bg-white rounded-2xl border border-neutral-200/60 p-6 shadow-soft">
            <h3 className="text-base font-semibold text-neutral-900 mb-4">Acciones Rápidas</h3>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => navigate('/receipts')}
                className="flex flex-col items-center justify-center p-4 bg-neutral-50 hover:bg-neutral-100 rounded-xl transition-colors"
              >
                <Clock size={24} className="text-amber-600 mb-2" />
                <span className="text-sm font-medium text-neutral-700">Revisar Pendientes</span>
                <span className="text-xs text-neutral-500 mt-0.5">{kpis.comprobantesAConfirmar} comprobantes</span>
              </button>
              <button
                onClick={() => navigate('/orders')}
                className="flex flex-col items-center justify-center p-4 bg-neutral-50 hover:bg-neutral-100 rounded-xl transition-colors"
              >
                <Printer size={24} className="text-violet-600 mb-2" />
                <span className="text-sm font-medium text-neutral-700">Para Imprimir</span>
                <span className="text-xs text-neutral-500 mt-0.5">{kpis.aImprimir} pedidos</span>
              </button>
              <button
                onClick={() => navigate('/orders')}
                className="flex flex-col items-center justify-center p-4 bg-neutral-50 hover:bg-neutral-100 rounded-xl transition-colors"
              >
                <Package size={24} className="text-cyan-600 mb-2" />
                <span className="text-sm font-medium text-neutral-700">Armados</span>
                <span className="text-xs text-neutral-500 mt-0.5">{kpis.armados} pedidos</span>
              </button>
              <button
                onClick={() => navigate('/orders')}
                className="flex flex-col items-center justify-center p-4 bg-neutral-50 hover:bg-neutral-100 rounded-xl transition-colors"
              >
                <DollarSign size={24} className="text-emerald-600 mb-2" />
                <span className="text-sm font-medium text-neutral-700">Ver Pedidos</span>
                <span className="text-xs text-neutral-500 mt-0.5">{orders.length} total</span>
              </button>
            </div>
          </div>
        </div>

        {/* Actividad reciente */}
        <ActivityFeed activities={actividadReciente} />
      </div>
    </div>
  );
}
