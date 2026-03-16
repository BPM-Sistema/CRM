import { useState, useEffect, useMemo } from 'react';
import {
  FileText,
  Truck,
  Package,
  DollarSign,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import { Header } from '../components/layout';
import { KPISection, ActivityFeed, StatusDistributionChart } from '../components/dashboard';
import { SystemActivity } from '../components/dashboard/ActivityFeed';
import { fetchDashboardStats, fetchActivityLog, DashboardStats, ActivityLog } from '../services/api';

export function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, activityRes] = await Promise.all([
        fetchDashboardStats(),
        fetchActivityLog(1, 15)
      ]);
      setStats(statsRes);
      setActivityLogs(activityRes.logs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar datos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadData();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const pollInterval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadData();
      }
    }, 15000);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(pollInterval);
    };
  }, []);

  const chartData = useMemo(() => {
    if (!stats) return [];
    const today = new Date().toISOString().split('T')[0];
    return [{
      date: today,
      paid: stats.comprobantes.confirmados_hoy,
      pending: stats.comprobantes.a_confirmar,
      rejected: stats.comprobantes.rechazados_hoy,
      total: stats.pedidos.nuevos_hoy,
    }];
  }, [stats]);

  const actividadReciente: SystemActivity[] = useMemo(() => {
    return activityLogs.slice(0, 10).map(log => ({
      id: log.id,
      orderNumber: log.order_number,
      accion: log.accion,
      timestamp: log.created_at,
      performedBy: log.user_name || log.username || log.origen,
    }));
  }, [activityLogs]);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(amount);
  };

  if (loading && !stats) {
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

  if (!stats) return null;

  return (
    <div className="min-h-screen">
      <Header
        title="Panel"
        subtitle="Resumen de operaciones"
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

      <div className="p-6 space-y-4">
        {/* KPIs en grid 2x2 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Comprobantes */}
          <KPISection
            title="Comprobantes"
            icon={<FileText size={14} className="text-blue-500" />}
            navigateTo="/receipts"
            kpis={[
              { label: 'Pend', value: stats.comprobantes.a_confirmar, color: 'amber', navigateTo: '/receipts?estado=a_confirmar' },
              { label: 'Confirm', value: stats.comprobantes.confirmados_hoy, color: 'green', navigateTo: '/receipts?estado=confirmado' },
              { label: 'Rech', value: stats.comprobantes.rechazados_hoy, color: 'red', navigateTo: '/receipts?estado=rechazado' },
              { label: 'Monto', value: formatCurrency(stats.comprobantes.monto_confirmado_hoy), color: 'green' },
            ]}
          />

          {/* Remitos */}
          <KPISection
            title="Remitos"
            icon={<Truck size={14} className="text-indigo-500" />}
            navigateTo="/remitos"
            kpis={[
              { label: 'Proc', value: stats.remitos.procesando, color: 'blue', navigateTo: '/remitos?status=processing' },
              { label: 'Listos', value: stats.remitos.listos, color: 'amber', navigateTo: '/remitos?status=ready' },
              { label: 'Confirm', value: stats.remitos.confirmados_hoy, color: 'green', navigateTo: '/remitos?status=confirmed' },
              { label: 'Error', value: stats.remitos.con_error, color: 'red', navigateTo: '/remitos?status=error' },
            ]}
          />

          {/* Pedidos */}
          <KPISection
            title="Pedidos"
            icon={<Package size={14} className="text-violet-500" />}
            navigateTo="/orders"
            kpis={[
              { label: 'Hoy', value: stats.pedidos.nuevos_hoy, color: 'neutral' },
              { label: 'A impr', value: stats.pedidos.a_imprimir, color: 'violet', navigateTo: '/orders?estado_pedido=a_imprimir' },
              { label: 'Armado', value: stats.pedidos.armados, color: 'blue', navigateTo: '/orders?estado_pedido=armado' },
              { label: 'Enviado', value: stats.pedidos.enviados, color: 'green', navigateTo: '/orders?estado_pedido=enviado' },
            ]}
          />

          {/* Pagos */}
          <KPISection
            title="Pagos"
            icon={<DollarSign size={14} className="text-emerald-500" />}
            kpis={[
              { label: 'Hoy', value: formatCurrency(stats.pagos.recaudado_hoy), color: 'green' },
              { label: 'Efectivo', value: formatCurrency(stats.pagos.efectivo_hoy), color: 'amber' },
              { label: 'Pend', value: formatCurrency(stats.pagos.saldo_pendiente), color: 'red' },
              { label: 'Parcial', value: stats.pagos.parciales, color: 'amber', navigateTo: '/orders?estado_pago=confirmado_parcial' },
            ]}
          />
        </div>

        {/* Gráfico y Actividad */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <StatusDistributionChart data={chartData} />
          <ActivityFeed activities={actividadReciente} />
        </div>
      </div>
    </div>
  );
}
