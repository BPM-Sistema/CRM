import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bot,
  RefreshCw,
  AlertCircle,
  Zap,
  Reply,
  SkipForward,
  AlertTriangle,
  Instagram,
  Facebook,
  MessageCircle,
  Clock,
  Settings,
} from 'lucide-react';
import { Header } from '../components/layout';
import { Card, CardHeader, Badge } from '../components/ui';
import { Switch } from '../components/ui/Switch';
import { useAuth } from '../contexts/AuthContext';
import { fetchAiBotDashboard, fetchAiBotEvents, updateAiBotConfig } from '../services/ai-bot-api';
import type { AiBotDashboard as AiBotDashboardData, AiBotEvent, AiBotMode, AiBotChannel, AiBotEventStatus } from '../types/ai-bot';

const modeLabels: Record<AiBotMode, string> = {
  off: 'Apagado',
  suggestion: 'Sugerencia',
  automatic: 'Automatico',
};

const modeColors: Record<AiBotMode, string> = {
  off: 'text-neutral-400',
  suggestion: 'text-amber-500',
  automatic: 'text-emerald-500',
};

const channelLabels: Record<AiBotChannel, string> = {
  instagram_comment: 'IG Comments',
  facebook_comment: 'FB Comments',
  messenger: 'Messenger',
};

const channelIcons: Record<AiBotChannel, React.ReactNode> = {
  instagram_comment: <Instagram size={20} />,
  facebook_comment: <Facebook size={20} />,
  messenger: <MessageCircle size={20} />,
};

const eventStatusVariant: Record<AiBotEventStatus, 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple'> = {
  received: 'default',
  processing: 'info',
  responded: 'success',
  ignored: 'warning',
  failed: 'danger',
  skipped: 'purple',
};

const eventStatusLabels: Record<AiBotEventStatus, string> = {
  received: 'Recibido',
  processing: 'Procesando',
  responded: 'Respondido',
  ignored: 'Ignorado',
  failed: 'Fallido',
  skipped: 'Omitido',
};

export function AiBotDashboard() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState<AiBotDashboardData | null>(null);
  const [recentEvents, setRecentEvents] = useState<AiBotEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  const canView = hasPermission('ai_bot.view');
  const canConfig = hasPermission('ai_bot.config');

  const loadData = useCallback(async () => {
    setError(null);
    try {
      const [dashData, eventsData] = await Promise.all([
        fetchAiBotDashboard(),
        fetchAiBotEvents({ limit: 10 }),
      ]);
      setDashboard(dashData);
      setRecentEvents(eventsData.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar datos del bot');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canView) return;
    loadData();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') loadData();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const pollInterval = setInterval(() => {
      if (document.visibilityState === 'visible') loadData();
    }, 30000);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(pollInterval);
    };
  }, [loadData, canView]);

  const handleToggleBot = async () => {
    if (!dashboard || !canConfig) return;
    setToggling(true);
    try {
      const newEnabled = !dashboard.config.enabled;
      await updateAiBotConfig('enabled', newEnabled);
      if (!newEnabled) {
        await updateAiBotConfig('mode', 'off');
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cambiar estado del bot');
    } finally {
      setToggling(false);
    }
  };

  if (!canView) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl border border-neutral-200/60 p-8 text-center max-w-md">
          <AlertCircle size={48} className="mx-auto text-red-400 mb-4" />
          <h3 className="text-lg font-semibold text-neutral-900 mb-2">Sin permisos</h3>
          <p className="text-neutral-500">No tienes permisos para ver el panel del Bot IA.</p>
        </div>
      </div>
    );
  }

  if (loading && !dashboard) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <RefreshCw size={32} className="animate-spin text-neutral-400" />
      </div>
    );
  }

  if (error && !dashboard) {
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

  if (!dashboard) return null;

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Bot IA"
        subtitle="Panel de control del bot de atencion automatica"
        actions={
          <div className="flex items-center gap-3">
            {canConfig && (
              <button
                onClick={() => navigate('/admin/ai-bot/config')}
                className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded-lg transition-colors"
              >
                <Settings size={16} />
                Configurar
              </button>
            )}
            <button
              onClick={loadData}
              disabled={loading}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded-lg transition-colors"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              Actualizar
            </button>
          </div>
        }
      />

      <div className="p-6 space-y-4">
        {/* Status + Quick Toggle */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Bot Status */}
          <Card className="lg:col-span-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${
                  dashboard.config.enabled ? 'bg-emerald-50' : 'bg-neutral-100'
                }`}>
                  <Bot size={28} className={dashboard.config.enabled ? 'text-emerald-600' : 'text-neutral-400'} />
                </div>
                <div>
                  <div className="flex items-center gap-3">
                    <h2 className="text-lg font-semibold text-neutral-900">
                      {dashboard.config.enabled ? 'Bot Activo' : 'Bot Inactivo'}
                    </h2>
                    <div className={`w-2.5 h-2.5 rounded-full ${
                      dashboard.config.enabled ? 'bg-emerald-500 animate-pulse' : 'bg-neutral-300'
                    }`} />
                  </div>
                  <p className="text-sm text-neutral-500 mt-0.5">
                    Modo: <span className={`font-medium ${modeColors[dashboard.config.mode]}`}>
                      {modeLabels[dashboard.config.mode]}
                    </span>
                  </p>
                </div>
              </div>
              {canConfig && (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-neutral-500">{dashboard.config.enabled ? 'ON' : 'OFF'}</span>
                  <Switch
                    checked={dashboard.config.enabled}
                    onChange={handleToggleBot}
                    disabled={toggling}
                  />
                </div>
              )}
            </div>
          </Card>

          {/* Queue Stats */}
          <Card>
            <CardHeader title="Colas" description="Jobs pendientes" />
            <div className="mt-3 space-y-2">
              {Object.entries(dashboard.queue_stats).map(([queue, count]) => (
                <div key={queue} className="flex items-center justify-between">
                  <span className="text-sm text-neutral-600">{queue.replace(/_/g, ' ')}</span>
                  <Badge variant={count > 0 ? 'warning' : 'default'}>{count}</Badge>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Stats 24h */}
        <div>
          <h3 className="text-sm font-medium text-neutral-500 mb-2 flex items-center gap-1.5">
            <Clock size={14} />
            Ultimas 24 horas
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard label="Eventos" value={dashboard.stats_24h.events} icon={<Zap size={16} />} color="blue" />
            <StatCard label="Respuestas" value={dashboard.stats_24h.replies} icon={<Reply size={16} />} color="emerald" />
            <StatCard label="Omitidos" value={dashboard.stats_24h.skipped} icon={<SkipForward size={16} />} color="amber" />
            <StatCard label="Fallos" value={dashboard.stats_24h.failures} icon={<AlertTriangle size={16} />} color="red" />
          </div>
        </div>

        {/* Stats 7d */}
        <div>
          <h3 className="text-sm font-medium text-neutral-500 mb-2 flex items-center gap-1.5">
            <Clock size={14} />
            Ultimos 7 dias
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard label="Eventos" value={dashboard.stats_7d.events} icon={<Zap size={16} />} color="blue" />
            <StatCard label="Respuestas" value={dashboard.stats_7d.replies} icon={<Reply size={16} />} color="emerald" />
            <StatCard label="Omitidos" value={dashboard.stats_7d.skipped} icon={<SkipForward size={16} />} color="amber" />
            <StatCard label="Fallos" value={dashboard.stats_7d.failures} icon={<AlertTriangle size={16} />} color="red" />
          </div>
        </div>

        {/* Channels */}
        <div>
          <h3 className="text-sm font-medium text-neutral-500 mb-2">Canales</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {(Object.entries(dashboard.channels) as [AiBotChannel, boolean][]).map(([channel, enabled]) => (
              <Card key={channel} padding="sm">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                      enabled ? 'bg-blue-50 text-blue-600' : 'bg-neutral-100 text-neutral-400'
                    }`}>
                      {channelIcons[channel]}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-neutral-900">{channelLabels[channel]}</p>
                      <p className="text-xs text-neutral-500">{enabled ? 'Activo' : 'Inactivo'}</p>
                    </div>
                  </div>
                  <Badge variant={enabled ? 'success' : 'default'} size="sm">
                    {enabled ? 'ON' : 'OFF'}
                  </Badge>
                </div>
              </Card>
            ))}
          </div>
        </div>

        {/* Recent Events */}
        <Card padding="none">
          <div className="px-6 pt-6 pb-3">
            <CardHeader title="Eventos recientes" description="Ultimos 10 eventos procesados" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-t border-neutral-100">
                  <th className="text-left px-6 py-3 text-xs font-medium text-neutral-500 uppercase tracking-wider">Fecha</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-neutral-500 uppercase tracking-wider">Canal</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-neutral-500 uppercase tracking-wider">Remitente</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-neutral-500 uppercase tracking-wider">Contenido</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-neutral-500 uppercase tracking-wider">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {recentEvents.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-neutral-400">
                      No hay eventos recientes
                    </td>
                  </tr>
                ) : (
                  recentEvents.map((event) => (
                    <tr key={event.id} className="hover:bg-neutral-50 transition-colors">
                      <td className="px-6 py-3 text-neutral-500 whitespace-nowrap">{formatTime(event.created_at)}</td>
                      <td className="px-6 py-3">
                        <Badge variant="info" size="sm">{channelLabels[event.channel]}</Badge>
                      </td>
                      <td className="px-6 py-3 text-neutral-900 font-medium">{event.sender_name || event.sender_id}</td>
                      <td className="px-6 py-3 text-neutral-600 max-w-xs truncate">{event.content_text}</td>
                      <td className="px-6 py-3">
                        <Badge variant={eventStatusVariant[event.status]} size="sm">
                          {eventStatusLabels[event.status]}
                        </Badge>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── StatCard helper ──────────────────────────────────────────────────────────

function StatCard({ label, value, icon, color }: {
  label: string;
  value: number;
  icon: React.ReactNode;
  color: 'blue' | 'emerald' | 'amber' | 'red';
}) {
  const colorStyles = {
    blue: 'bg-blue-50 text-blue-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    amber: 'bg-amber-50 text-amber-600',
    red: 'bg-red-50 text-red-600',
  };

  return (
    <Card padding="sm">
      <div className="flex items-center gap-3">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${colorStyles[color]}`}>
          {icon}
        </div>
        <div>
          <p className="text-2xl font-semibold text-neutral-900">{value.toLocaleString('es-AR')}</p>
          <p className="text-xs text-neutral-500">{label}</p>
        </div>
      </div>
    </Card>
  );
}
