import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, AlertCircle, Info, RefreshCw, Bell } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { fetchLocalAlerts, type LocalAlert } from '../../services/local-api';
import { AccessDenied } from '../../components/AccessDenied';

const SEVERITY_CONFIG = {
  error: { icon: AlertCircle, color: 'text-red-600', bg: 'bg-red-50 border-red-200', badge: 'danger' as const },
  warning: { icon: AlertTriangle, color: 'text-amber-600', bg: 'bg-amber-50 border-amber-200', badge: 'warning' as const },
  info: { icon: Info, color: 'text-sky-600', bg: 'bg-sky-50 border-sky-200', badge: 'info' as const },
};

const TYPE_LABELS: Record<string, string> = {
  reserva_sin_tomar: 'Reserva sin tomar',
  impreso_sin_armar: 'Impreso sin armar',
  armado_sin_enviar: 'Armado sin enviar',
  enviado_sin_recibir: 'Enviado sin recibir',
  con_diferencias: 'Con diferencias',
  caja_pendiente_pago: 'Caja: pago pendiente',
  caja_editado_post_pago: 'Caja: editado post-pago',
};

export default function LocalAlertas() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();

  const [alerts, setAlerts] = useState<LocalAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'error' | 'warning'>('all');

  if (!hasPermission('local.alerts.view')) return <AccessDenied />;

  const loadAlerts = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchLocalAlerts();
      setAlerts(data.alerts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAlerts(); }, []);

  const filtered = filter === 'all' ? alerts : alerts.filter((a) => a.severity === filter);
  const errorCount = alerts.filter((a) => a.severity === 'error').length;
  const warningCount = alerts.filter((a) => a.severity === 'warning').length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-neutral-900">Alertas Local</h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            {alerts.length} alerta{alerts.length !== 1 ? 's' : ''} activa{alerts.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={loadAlerts}>
          <RefreshCw size={14} /> Actualizar
        </Button>
      </div>

      {/* Filtros */}
      <div className="flex gap-2">
        <button
          onClick={() => setFilter('all')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            filter === 'all' ? 'bg-sky-100 text-sky-700 ring-1 ring-sky-200' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
          }`}
        >
          Todas ({alerts.length})
        </button>
        <button
          onClick={() => setFilter('error')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            filter === 'error' ? 'bg-red-100 text-red-700 ring-1 ring-red-200' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
          }`}
        >
          Errores ({errorCount})
        </button>
        <button
          onClick={() => setFilter('warning')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
            filter === 'warning' ? 'bg-amber-100 text-amber-700 ring-1 ring-amber-200' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
          }`}
        >
          Avisos ({warningCount})
        </button>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-xl text-sm">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="w-6 h-6 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <div className="text-center py-8">
            <Bell size={32} className="mx-auto mb-3 text-neutral-300" />
            <p className="text-neutral-500 text-sm">No hay alertas activas</p>
          </div>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((alert, idx) => {
            const config = SEVERITY_CONFIG[alert.severity] || SEVERITY_CONFIG.info;
            const Icon = config.icon;
            return (
              <button
                key={`${alert.type}-${alert.entity_id}-${idx}`}
                onClick={() => navigate(alert.link)}
                className={`w-full text-left border rounded-xl px-4 py-3 transition-all hover:shadow-sm ${config.bg}`}
              >
                <div className="flex items-start gap-3">
                  <Icon size={18} className={`mt-0.5 shrink-0 ${config.color}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Badge variant={config.badge} size="sm">
                        {TYPE_LABELS[alert.type] || alert.type}
                      </Badge>
                    </div>
                    <p className="text-sm text-neutral-800 font-medium">{alert.message}</p>
                    <p className="text-xs text-neutral-500 mt-1">
                      {new Date(alert.created_at).toLocaleString('es-AR')}
                    </p>
                  </div>
                  <span className="text-xs text-sky-600 font-medium shrink-0">Ver →</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
