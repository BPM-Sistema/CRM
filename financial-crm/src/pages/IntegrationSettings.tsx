import { useState, useEffect, useCallback } from 'react';
import { Header } from '../components/layout';
import { AccessDenied } from '../components/AccessDenied';
import {
  RefreshCw,
  AlertCircle,
  Settings,
  ToggleLeft,
  ToggleRight,
  History,
  Clock,
  ChevronDown,
  ChevronUp,
  Shield,
  Zap,
  Tags,
  RefreshCcw,
  Image,
  Info,
  RotateCcw,
  XCircle,
  CreditCard,
} from 'lucide-react';
import {
  fetchIntegrations,
  updateIntegration,
  fetchIntegrationHistory,
  IntegrationConfig,
  IntegrationConfigHistory,
} from '../services/api';
import { useAuth } from '../contexts/AuthContext';

// Mapeo de iconos por key
const KEY_ICONS: Record<string, typeof Settings> = {
  tiendanube_webhooks_enabled: Zap,
  tiendanube_validate_orders: Shield,
  tiendanube_fulfillment_labels: Tags,
  tiendanube_sync_orders: RefreshCcw,
  tiendanube_sync_images: Image,
  tiendanube_resync_manual: RotateCcw,
  tiendanube_sync_cancelled: XCircle,
  tiendanube_mark_paid: CreditCard,
};

// Nombres amigables
const KEY_NAMES: Record<string, string> = {
  tiendanube_webhooks_enabled: 'Webhooks',
  tiendanube_validate_orders: 'Validar Pedidos',
  tiendanube_fulfillment_labels: 'Etiquetas Envio Nube',
  tiendanube_sync_orders: 'Sync Pedidos',
  tiendanube_sync_images: 'Sync Imagenes',
  tiendanube_resync_manual: 'Resync Manual',
  tiendanube_sync_cancelled: 'Sync Cancelados',
  tiendanube_mark_paid: 'Marcar Pagado en TN',
};

// Tooltips explicativos (no tecnicos)
const KEY_TOOLTIPS: Record<string, string> = {
  tiendanube_webhooks_enabled:
    'Cuando alguien hace un pedido en la tienda, el sistema lo recibe automaticamente. Si esta apagado, los pedidos nuevos no van a aparecer.',
  tiendanube_validate_orders:
    'Al subir un comprobante, el sistema verifica que el pedido exista y que el monto sea correcto. Si esta apagado, se aceptan comprobantes sin verificar.',
  tiendanube_fulfillment_labels:
    'Permite descargar las etiquetas de envio de Andreani o Correo Argentino desde el panel. Si esta apagado, hay que buscarlas manualmente en Tiendanube.',
  tiendanube_sync_orders:
    'Cada 5 minutos el sistema busca pedidos que no hayan llegado por webhook. Si esta apagado, pedidos perdidos no se recuperan automaticamente.',
  tiendanube_sync_images:
    'Cada 5 horas se descargan las imagenes de productos para mostrarlas en el panel. Si esta apagado, algunos productos pueden no tener foto.',
  tiendanube_resync_manual:
    'Permite actualizar manualmente un pedido desde Tiendanube usando el boton "Resync". Si esta apagado, no se puede forzar la actualizacion.',
  tiendanube_sync_cancelled:
    'Detecta pedidos que fueron cancelados en Tiendanube y actualiza su estado aca. Si esta apagado, pedidos cancelados pueden seguir apareciendo como activos.',
  tiendanube_mark_paid:
    'Cuando un pedido se paga completamente, se marca como pagado en Tiendanube. Si esta apagado, Tiendanube no se entera de los pagos.',
};

export function IntegrationSettings() {
  const { hasPermission } = useAuth();
  const [configs, setConfigs] = useState<IntegrationConfig[]>([]);
  const [history, setHistory] = useState<IntegrationConfigHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);


  const canView = hasPermission('integrations.view');
  const canUpdate = hasPermission('integrations.update');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchIntegrations();
      setConfigs(data.configs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar datos');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const data = await fetchIntegrationHistory(undefined, 30);
      setHistory(data);
    } catch (err) {
      console.error('Error loading history:', err);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canView) {
      loadData();
    }
  }, [canView, loadData]);

  useEffect(() => {
    if (showHistory && history.length === 0) {
      loadHistory();
    }
  }, [showHistory, history.length, loadHistory]);

  const handleToggle = async (key: string, currentValue: boolean) => {
    const newValue = !currentValue;
    setUpdating(key);
    setError(null);
    try {
      await updateIntegration(key, newValue);
      await loadData();
      if (showHistory) {
        await loadHistory();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al actualizar');
    } finally {
      setUpdating(null);
    }
  };

  if (!canView) {
    return <AccessDenied />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header title="Integraciones" subtitle="Configuracion de feature flags" />

      <main className="max-w-4xl mx-auto px-4 py-6">
        {/* Header con refresh */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-100 rounded-lg">
              <Settings className="h-6 w-6 text-indigo-600" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900">Tiendanube</h2>
              <p className="text-sm text-gray-500">
                Control de integraciones con Tiendanube
              </p>
            </div>
          </div>
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0" />
            <p className="text-red-700">{error}</p>
          </div>
        )}

        {/* Loading */}
        {loading ? (
          <div className="flex justify-center py-12">
            <RefreshCw className="h-8 w-8 text-indigo-500 animate-spin" />
          </div>
        ) : (
          <div className="space-y-3">
            {configs.map(config => {
              const Icon = KEY_ICONS[config.key] || Settings;
              const friendlyName = KEY_NAMES[config.key] || config.key;
              const tooltip = KEY_TOOLTIPS[config.key];
              const isUpdating = updating === config.key;

              return (
                <div
                  key={config.key}
                  className="bg-white rounded-lg border border-gray-200 p-4 transition-all"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className={`p-2 rounded-lg ${
                          config.enabled
                            ? 'bg-green-100 text-green-600'
                            : 'bg-gray-100 text-gray-400'
                        }`}
                      >
                        <Icon className="h-5 w-5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-medium text-gray-900">{friendlyName}</h3>
                          {tooltip && (
                            <div className="relative group">
                              <Info className="h-4 w-4 text-gray-400 cursor-help" />
                              <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block z-50">
                                <div className="bg-gray-900 text-white text-sm rounded-lg py-2 px-3 max-w-xs shadow-lg">
                                  {tooltip}
                                  <div className="absolute left-3 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900" />
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                        <p className="text-sm text-gray-500 mt-0.5">{config.description}</p>
                        {config.updated_at && (
                          <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {new Date(config.updated_at).toLocaleString('es-AR')}
                            {config.updated_by_email && ` - ${config.updated_by_email}`}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Toggle */}
                    <button
                      onClick={() => handleToggle(config.key, config.enabled)}
                      disabled={!canUpdate || isUpdating}
                      className={`relative p-1 rounded-full transition-colors ${
                        isUpdating ? 'opacity-50' : ''
                      } ${
                        !canUpdate
                          ? 'cursor-not-allowed'
                          : 'cursor-pointer hover:bg-gray-100'
                      }`}
                      title={config.enabled ? 'Click para desactivar' : 'Click para activar'}
                    >
                      {isUpdating ? (
                        <RefreshCw className="h-8 w-8 text-gray-400 animate-spin" />
                      ) : config.enabled ? (
                        <ToggleRight className="h-10 w-10 text-green-500" />
                      ) : (
                        <ToggleLeft className="h-10 w-10 text-gray-300" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Historial de cambios */}
        <div className="mt-8">
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="flex items-center gap-2 text-gray-600 hover:text-gray-900 font-medium"
          >
            <History className="h-4 w-4" />
            Historial de cambios
            {showHistory ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>

          {showHistory && (
            <div className="mt-4 bg-white rounded-lg border border-gray-200 overflow-hidden">
              {historyLoading ? (
                <div className="p-4 flex justify-center">
                  <RefreshCw className="h-5 w-5 text-gray-400 animate-spin" />
                </div>
              ) : history.length === 0 ? (
                <div className="p-4 text-center text-gray-500">
                  No hay cambios registrados
                </div>
              ) : (
                <table className="w-full">
                  <thead className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase">
                    <tr>
                      <th className="px-4 py-3">Config</th>
                      <th className="px-4 py-3">Cambio</th>
                      <th className="px-4 py-3">Usuario</th>
                      <th className="px-4 py-3">Fecha</th>
                      <th className="px-4 py-3">Razon</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {history.map((item, idx) => (
                      <tr key={idx} className="text-sm">
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {KEY_NAMES[item.config_key] || item.config_key}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium ${
                              item.new_value
                                ? 'bg-green-100 text-green-700'
                                : 'bg-red-100 text-red-700'
                            }`}
                          >
                            {item.new_value ? (
                              <>
                                <ToggleRight className="h-3 w-3" />
                                ON
                              </>
                            ) : (
                              <>
                                <ToggleLeft className="h-3 w-3" />
                                OFF
                              </>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {item.changed_by_email || 'Sistema'}
                        </td>
                        <td className="px-4 py-3 text-gray-500">
                          {new Date(item.changed_at).toLocaleString('es-AR')}
                        </td>
                        <td className="px-4 py-3 text-gray-500 max-w-xs truncate">
                          {item.reason || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
