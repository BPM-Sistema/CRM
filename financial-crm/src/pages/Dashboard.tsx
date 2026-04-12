import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  FileText,
  Truck,
  Package,
  DollarSign,
  RefreshCw,
  AlertCircle,
  Calendar,
  TrendingUp,
} from 'lucide-react';
import { Header } from '../components/layout';
import { KPISection, ActivityFeed, StatusDistributionChart } from '../components/dashboard';
import { SystemActivity } from '../components/dashboard/ActivityFeed';
import { fetchDashboardStats, fetchActivityLog, DashboardStats, ActivityLog } from '../services/api';
import { format } from 'date-fns';

type DatePreset = 'hoy' | 'ayer' | 'semana' | 'mes' | 'custom';

function getDateRange(preset: DatePreset): { desde: string; hasta: string } {
  const now = new Date();
  const today = format(now, 'yyyy-MM-dd');

  switch (preset) {
    case 'hoy':
      return { desde: today, hasta: today };
    case 'ayer': {
      const ayer = new Date(now);
      ayer.setDate(ayer.getDate() - 1);
      const ayerStr = format(ayer, 'yyyy-MM-dd');
      return { desde: ayerStr, hasta: ayerStr };
    }
    case 'semana': {
      const lunes = new Date(now);
      lunes.setDate(lunes.getDate() - lunes.getDay() + (lunes.getDay() === 0 ? -6 : 1));
      return { desde: format(lunes, 'yyyy-MM-dd'), hasta: today };
    }
    case 'mes': {
      const primero = new Date(now.getFullYear(), now.getMonth(), 1);
      return { desde: format(primero, 'yyyy-MM-dd'), hasta: today };
    }
    default:
      return { desde: today, hasta: today };
  }
}

export function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [datePreset, setDatePreset] = useState<DatePreset>('hoy');
  const [customDesde, setCustomDesde] = useState('');
  const [customHasta, setCustomHasta] = useState('');

  const dateRange = useMemo(() => {
    if (datePreset === 'custom' && customDesde) {
      return { desde: customDesde, hasta: customHasta || customDesde };
    }
    return getDateRange(datePreset);
  }, [datePreset, customDesde, customHasta]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statsRes, activityRes] = await Promise.all([
        fetchDashboardStats(dateRange.desde, dateRange.hasta),
        fetchActivityLog(1, 1000, { fecha_desde: format(new Date(), 'yyyy-MM-dd') })
      ]);
      setStats(statsRes);
      setActivityLogs(activityRes.logs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar datos');
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

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
  }, [loadData]);

  const chartData = useMemo(() => {
    if (!stats) return [];
    return [{
      date: dateRange.desde,
      paid: stats.comprobantes.confirmados_hoy,
      pending: stats.comprobantes.a_confirmar,
      rejected: stats.comprobantes.rechazados_hoy,
      total: stats.pedidos.nuevos_hoy,
    }];
  }, [stats, dateRange]);

  const actividadReciente: SystemActivity[] = useMemo(() => {
    return activityLogs.map(log => ({
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

  const presetLabel = (p: DatePreset) => {
    switch (p) {
      case 'hoy': return 'Hoy';
      case 'ayer': return 'Ayer';
      case 'semana': return 'Semana';
      case 'mes': return 'Mes';
      case 'custom': return 'Rango';
    }
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

  const facturacionTotal = stats.facturacion.facturacion_confirmada + stats.facturacion.efectivo_periodo;
  const facturacionConPendiente = facturacionTotal + stats.facturacion.facturacion_pendiente;

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
        {/* Filtro de fechas */}
        <div className="bg-white rounded-xl border border-neutral-200/60 p-3 shadow-soft">
          <div className="flex items-center gap-2 flex-wrap">
            <Calendar size={14} className="text-neutral-400" />
            {(['hoy', 'ayer', 'semana', 'mes', 'custom'] as DatePreset[]).map((p) => (
              <button
                key={p}
                onClick={() => setDatePreset(p)}
                className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors ${
                  datePreset === p
                    ? 'bg-neutral-900 text-white'
                    : 'text-neutral-600 hover:bg-neutral-100'
                }`}
              >
                {presetLabel(p)}
              </button>
            ))}
            {datePreset === 'custom' && (
              <div className="flex items-center gap-2 ml-2">
                <input
                  type="date"
                  value={customDesde}
                  onChange={(e) => setCustomDesde(e.target.value)}
                  className="px-2 py-1 text-xs border border-neutral-200 rounded-lg"
                />
                <span className="text-xs text-neutral-400">a</span>
                <input
                  type="date"
                  value={customHasta}
                  onChange={(e) => setCustomHasta(e.target.value)}
                  className="px-2 py-1 text-xs border border-neutral-200 rounded-lg"
                />
              </div>
            )}
          </div>
        </div>

        {/* Facturación */}
        <div className="bg-white rounded-xl border border-neutral-200/60 p-4 shadow-soft">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={14} className="text-emerald-500" />
            <h3 className="text-xs font-semibold text-neutral-500 uppercase tracking-wide">Facturación</h3>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="flex flex-col items-center p-2">
              <span className="text-xl font-bold text-emerald-600">{formatCurrency(facturacionTotal)}</span>
              <span className="text-[10px] text-neutral-400 mt-0.5 text-center leading-tight">Confirmada</span>
            </div>
            <div className="flex flex-col items-center p-2">
              <span className="text-xl font-bold text-amber-600">{formatCurrency(stats.facturacion.facturacion_pendiente)}</span>
              <span className="text-[10px] text-neutral-400 mt-0.5 text-center leading-tight">Pendiente</span>
            </div>
            <div className="flex flex-col items-center p-2">
              <span className="text-xl font-bold text-blue-600">{formatCurrency(facturacionConPendiente)}</span>
              <span className="text-[10px] text-neutral-400 mt-0.5 text-center leading-tight">Conf + Pend</span>
            </div>
            <div className="flex flex-col items-center p-2">
              <span className="text-xl font-bold text-neutral-900">{formatCurrency(stats.facturacion.efectivo_periodo)}</span>
              <span className="text-[10px] text-neutral-400 mt-0.5 text-center leading-tight">Efectivo</span>
            </div>
          </div>
        </div>

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
              { label: 'Nuevos', value: stats.pedidos.nuevos_hoy, color: 'neutral' },
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
              { label: 'Recaudado', value: formatCurrency(stats.pagos.recaudado_hoy), color: 'green' },
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
