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
  Power,
  PowerOff,
  Clock,
  ChevronDown,
  ChevronUp,
  Shield,
  Zap,
  Tags,
  RefreshCcw,
  Image,
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
const KEY_ICONS: Record<string, typeof Power> = {
  tiendanube_master_enabled: Power,
  tiendanube_webhooks_enabled: Zap,
  tiendanube_validate_orders: Shield,
  tiendanube_fulfillment_labels: Tags,
  tiendanube_sync_orders: RefreshCcw,
  tiendanube_sync_images: Image,
};

// Nombres amigables
const KEY_NAMES: Record<string, string> = {
  tiendanube_master_enabled: 'Master Switch',
  tiendanube_webhooks_enabled: 'Webhooks',
  tiendanube_validate_orders: 'Validar Pedidos',
  tiendanube_fulfillment_labels: 'Etiquetas Envio Nube',
  tiendanube_sync_orders: 'Sync Pedidos',
  tiendanube_sync_images: 'Sync Imagenes',
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

  // Modal de confirmacion para master switch
  const [confirmModal, setConfirmModal] = useState<{
    key: string;
    newValue: boolean;
    reason: string;
  } | null>(null);

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

    // Si es el master switch, pedir confirmacion
    if (key === 'tiendanube_master_enabled') {
      setConfirmModal({ key, newValue, reason: '' });
      return;
    }

    // Para otros toggles, actualizar directamente
    await performUpdate(key, newValue);
  };

  const performUpdate = async (key: string, newValue: boolean, reason?: string) => {
    setUpdating(key);
    setError(null);
    try {
      await updateIntegration(key, newValue, reason);
      await loadData();
      // Recargar historial si esta visible
      if (showHistory) {
        await loadHistory();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al actualizar');
    } finally {
      setUpdating(null);
      setConfirmModal(null);
    }
  };

  // Verificar si el master esta apagado
  const masterConfig = configs.find(c => c.key === 'tiendanube_master_enabled');
  const isMasterOff = masterConfig && !masterConfig.enabled;

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

        {/* Warning si master esta apagado */}
        {isMasterOff && (
          <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-3">
            <PowerOff className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-amber-800">Integracion Tiendanube desactivada</p>
              <p className="text-sm text-amber-700 mt-1">
                El Master Switch esta apagado. Ninguna integracion con Tiendanube esta funcionando.
              </p>
            </div>
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
              const isMaster = config.key === 'tiendanube_master_enabled';
              const isDisabledByMaster = !isMaster && isMasterOff;
              const isUpdating = updating === config.key;

              return (
                <div
                  key={config.key}
                  className={`bg-white rounded-lg border ${
                    isMaster
                      ? config.enabled
                        ? 'border-green-200 bg-green-50/30'
                        : 'border-red-200 bg-red-50/30'
                      : isDisabledByMaster
                      ? 'border-gray-200 opacity-60'
                      : 'border-gray-200'
                  } p-4 transition-all`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className={`p-2 rounded-lg ${
                          config.enabled && !isDisabledByMaster
                            ? 'bg-green-100 text-green-600'
                            : 'bg-gray-100 text-gray-400'
                        }`}
                      >
                        <Icon className="h-5 w-5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-medium text-gray-900">{friendlyName}</h3>
                          {isMaster && (
                            <span className="px-2 py-0.5 text-xs font-medium bg-indigo-100 text-indigo-700 rounded">
                              MASTER
                            </span>
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
                      disabled={!canUpdate || isUpdating || isDisabledByMaster}
                      className={`relative p-1 rounded-full transition-colors ${
                        isUpdating ? 'opacity-50' : ''
                      } ${
                        !canUpdate || isDisabledByMaster
                          ? 'cursor-not-allowed'
                          : 'cursor-pointer hover:bg-gray-100'
                      }`}
                      title={
                        isDisabledByMaster
                          ? 'Deshabilitado porque el Master Switch esta apagado'
                          : config.enabled
                          ? 'Click para desactivar'
                          : 'Click para activar'
                      }
                    >
                      {isUpdating ? (
                        <RefreshCw className="h-8 w-8 text-gray-400 animate-spin" />
                      ) : config.enabled && !isDisabledByMaster ? (
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

      {/* Modal de confirmacion para Master Switch */}
      {confirmModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-md w-full p-6 shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              {confirmModal.newValue ? (
                <Power className="h-8 w-8 text-green-500" />
              ) : (
                <PowerOff className="h-8 w-8 text-red-500" />
              )}
              <div>
                <h3 className="text-lg font-semibold text-gray-900">
                  {confirmModal.newValue
                    ? 'Activar integracion Tiendanube'
                    : 'Desactivar integracion Tiendanube'}
                </h3>
                <p className="text-sm text-gray-500">
                  {confirmModal.newValue
                    ? 'Todas las integraciones volveran a funcionar'
                    : 'Esto desactivara TODAS las integraciones con Tiendanube'}
                </p>
              </div>
            </div>

            {!confirmModal.newValue && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Razon (opcional)
                </label>
                <textarea
                  value={confirmModal.reason}
                  onChange={e =>
                    setConfirmModal({ ...confirmModal, reason: e.target.value })
                  }
                  placeholder="Ej: Problemas de performance en Tiendanube..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  rows={2}
                />
              </div>
            )}

            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmModal(null)}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={() =>
                  performUpdate(
                    confirmModal.key,
                    confirmModal.newValue,
                    confirmModal.reason || undefined
                  )
                }
                disabled={updating !== null}
                className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${
                  confirmModal.newValue
                    ? 'bg-green-600 hover:bg-green-700 text-white'
                    : 'bg-red-600 hover:bg-red-700 text-white'
                } ${updating ? 'opacity-50' : ''}`}
              >
                {updating && <RefreshCw className="h-4 w-4 animate-spin" />}
                {confirmModal.newValue ? 'Activar' : 'Desactivar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
