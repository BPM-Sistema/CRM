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
  MessageSquare,
  Phone,
  Send,
  Users,
  MapPin,
  FileText,
  DollarSign,
  Truck,
  Check,
  Plus,
  Edit2,
  Trash2,
  X,
} from 'lucide-react';
import {
  fetchIntegrations,
  updateIntegration,
  updateIntegrationMetadata,
  fetchIntegrationHistory,
  fetchPlantillasResueltas,
  fetchPlantillaTiposCRUD,
  createPlantillaTipo,
  updatePlantillaTipo,
  deletePlantillaTipo,
  IntegrationConfig,
  IntegrationConfigHistory,
  PlantillaResuelta,
  PlantillaTipoCRUD,
} from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { Switch } from '../components/ui/Switch';

// Mapeo de iconos por key
const KEY_ICONS: Record<string, typeof Settings> = {
  tiendanube_master_enabled: Settings,
  tiendanube_webhooks_enabled: Zap,
  tiendanube_validate_orders: Shield,
  tiendanube_fulfillment_labels: Tags,
  tiendanube_sync_orders: RefreshCcw,
  tiendanube_sync_images: Image,
  tiendanube_resync_manual: RotateCcw,
  tiendanube_sync_cancelled: XCircle,
  tiendanube_mark_paid: CreditCard,
  tiendanube_webhook_order_created: Zap,
  tiendanube_webhook_order_updated: Zap,
  tiendanube_webhook_order_cancelled: Zap,
  tiendanube_webhook_sync_payment: CreditCard,
  tiendanube_webhook_sync_shipping: Send,
  tiendanube_webhook_sync_products: Zap,
  tiendanube_webhook_sync_customer: Users,
  tiendanube_webhook_sync_address: MapPin,
  tiendanube_webhook_sync_notes: FileText,
  tiendanube_webhook_sync_costs: DollarSign,
  tiendanube_webhook_sync_tracking: Truck,
  tiendanube_resync_single: RotateCcw,
  tiendanube_resync_inconsistent: RotateCcw,
  tiendanube_resync_bulk: RotateCcw,
  tiendanube_sync_estado_pagado: CreditCard,
  tiendanube_sync_estado_armado: CreditCard,
  tiendanube_sync_estado_enviado: CreditCard,
  tiendanube_sync_estado_cancelado: CreditCard,
  whatsapp_testing_mode: MessageSquare,
  botmaker_channel: Phone,
  whatsapp_tpl_pedido_creado: Send,
  whatsapp_tpl_comprobante_confirmado: Send,
  whatsapp_tpl_comprobante_rechazado: Send,
  whatsapp_tpl_datos_envio: Send,
  whatsapp_tpl_enviado_env_nube: Send,
  whatsapp_tpl_pedido_cancelado: Send,
  whatsapp_tpl_partial_paid: Send,
  whatsapp_tpl_enviado_transporte: Send,
  whatsapp_tpl_resenia_maps: Send,
  whatsapp_tpl_envio_extra: Send,
};

// Nombres amigables
const KEY_NAMES: Record<string, string> = {
  tiendanube_master_enabled: 'Switch Maestro',
  tiendanube_webhooks_enabled: 'Webhooks',
  tiendanube_validate_orders: 'Validar Pedidos',
  tiendanube_fulfillment_labels: 'Etiquetas Envio Nube',
  tiendanube_sync_orders: 'Sync Pedidos',
  tiendanube_sync_images: 'Sync Imagenes',
  tiendanube_resync_manual: 'Resync Manual',
  tiendanube_sync_cancelled: 'Sync Cancelados',
  tiendanube_mark_paid: 'Sync Estados → TN',
  tiendanube_webhook_order_created: 'Pedido Creado',
  tiendanube_webhook_order_updated: 'Pedido Modificado',
  tiendanube_webhook_order_cancelled: 'Pedido Cancelado',
  tiendanube_webhook_sync_payment: 'Pagos',
  tiendanube_webhook_sync_shipping: 'Envíos',
  tiendanube_webhook_sync_products: 'Productos y Montos',
  tiendanube_webhook_sync_customer: 'Datos del Cliente',
  tiendanube_webhook_sync_address: 'Dirección de Envío',
  tiendanube_webhook_sync_notes: 'Notas',
  tiendanube_webhook_sync_costs: 'Descuentos y Costos',
  tiendanube_webhook_sync_tracking: 'Nro. de Seguimiento',
  tiendanube_resync_single: 'Individual',
  tiendanube_resync_inconsistent: 'Inconsistencias',
  tiendanube_resync_bulk: 'Masivo',
  tiendanube_sync_estado_pagado: 'Pagado',
  tiendanube_sync_estado_armado: 'Armado → Empaquetado',
  tiendanube_sync_estado_enviado: 'Enviado → Despachado',
  tiendanube_sync_estado_cancelado: 'Cancelado',
  whatsapp_testing_mode: 'Modo Testing',
  botmaker_channel: 'Canal de WhatsApp',
  whatsapp_tpl_pedido_creado: 'Pedido Creado',
  whatsapp_tpl_comprobante_confirmado: 'Comprobante Confirmado',
  whatsapp_tpl_comprobante_rechazado: 'Comprobante Rechazado',
  whatsapp_tpl_datos_envio: 'Datos de Envío',
  whatsapp_tpl_enviado_env_nube: 'Pedido Despachado',
  whatsapp_tpl_pedido_cancelado: 'Pedido Cancelado',
  whatsapp_tpl_partial_paid: 'Saldo Pendiente',
  whatsapp_tpl_enviado_transporte: 'Envío por Transporte',
  whatsapp_tpl_resenia_maps: 'Reseña Maps (Local)',
  whatsapp_tpl_envio_extra: 'Envío Extra',
};

// Tooltips explicativos (no tecnicos)
const KEY_TOOLTIPS: Record<string, string> = {
  tiendanube_master_enabled:
    'Switch maestro de Tiendanube. Si esta apagado, TODAS las integraciones con Tiendanube quedan desactivadas (webhooks, sync, etiquetas, todo).',
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
    'Sincroniza estados de pedido desde BPM hacia Tiendanube (pagado, armado, enviado, cancelado). Si esta apagado, Tiendanube no se entera de los cambios de estado.',
  whatsapp_testing_mode:
    'Cuando esta activado, TODOS los mensajes de WhatsApp se envian al numero de testing configurado en vez de al cliente real. Al desactivarlo, los mensajes van directo al cliente.',
  botmaker_channel:
    'El Channel ID de Botmaker desde el cual se envian los mensajes. Formato: nombre-whatsapp-numero. Lo encontras en Botmaker → Configuración → Canales.',
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
  const [testingPhones, setTestingPhones] = useState<string[]>([]);
  const [activePhone, setActivePhone] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [savingPhone, setSavingPhone] = useState(false);
  const [phoneSaved, setPhoneSaved] = useState(false);

  // Canal de WhatsApp (Botmaker channelId)
  const [channelId, setChannelId] = useState('');
  const [editingChannelId, setEditingChannelId] = useState('');
  const [savingChannel, setSavingChannel] = useState(false);
  const [channelSaved, setChannelSaved] = useState(false);

  // Plantillas resueltas (para mostrar qué template usa cada toggle)
  const [plantillas, setPlantillas] = useState<Record<string, PlantillaResuelta>>({});

  // CRUD de tipos de plantilla
  const [plantillaTipos, setPlantillaTipos] = useState<PlantillaTipoCRUD[]>([]);
  const [tipoModal, setTipoModal] = useState<{ mode: 'create' | 'edit'; tipo?: PlantillaTipoCRUD } | null>(null);
  const [tipoForm, setTipoForm] = useState({ key: '', nombre: '', descripcion: '', plantilla_default: '', requiere_variante: false });
  const [tipoSaving, setTipoSaving] = useState(false);
  const [tipoError, setTipoError] = useState('');

  const canView = hasPermission('integrations.view');
  const canUpdate = hasPermission('integrations.update');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Cargar configs, plantillas y tipos en paralelo
      const [data, plantillasData, tiposData] = await Promise.all([
        fetchIntegrations(),
        fetchPlantillasResueltas().catch(() => ({ byKey: {} })),
        fetchPlantillaTiposCRUD().catch(() => [])
      ]);

      setConfigs(data.configs);
      setPlantillas(plantillasData.byKey || {});
      setPlantillaTipos(tiposData);

      // Inicializar teléfonos de testing desde metadata
      const waConfig = data.configs.find((c: IntegrationConfig) => c.key === 'whatsapp_testing_mode');
      if (waConfig?.metadata) {
        const phones = waConfig.metadata.phones;
        setTestingPhones(Array.isArray(phones) ? phones : (waConfig.metadata.testing_phone ? [waConfig.metadata.testing_phone] : []));
        setActivePhone(String(waConfig.metadata.active_phone || waConfig.metadata.testing_phone || ''));
      }
      // Inicializar channelId desde metadata
      const channelConfig = data.configs.find((c: IntegrationConfig) => c.key === 'botmaker_channel');
      if (channelConfig?.metadata) {
        const meta = channelConfig.metadata as { channel_id?: string };
        if (meta.channel_id) {
          setChannelId(meta.channel_id);
          setEditingChannelId(meta.channel_id);
        }
      }
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

  const savePhoneMetadata = async (phones: string[], active: string) => {
    setSavingPhone(true);
    setError(null);
    try {
      await updateIntegrationMetadata('whatsapp_testing_mode', { phones, active_phone: active });
      setTestingPhones(phones);
      setActivePhone(active);
      setPhoneSaved(true);
      setTimeout(() => setPhoneSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar teléfono');
    } finally {
      setSavingPhone(false);
    }
  };

  const handleAddPhone = () => {
    if (!newPhone || testingPhones.includes(newPhone)) return;
    const updatedPhones = [...testingPhones, newPhone];
    const active = updatedPhones.length === 1 ? newPhone : activePhone;
    setNewPhone('');
    savePhoneMetadata(updatedPhones, active);
  };

  const saveChannelId = async () => {
    if (!editingChannelId.trim() || editingChannelId === channelId) return;
    setSavingChannel(true);
    setError(null);
    try {
      await updateIntegrationMetadata('botmaker_channel', { channel_id: editingChannelId.trim() });
      setChannelId(editingChannelId.trim());
      setChannelSaved(true);
      setTimeout(() => setChannelSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar canal');
    } finally {
      setSavingChannel(false);
    }
  };

  const handleRemovePhone = (phone: string) => {
    const updatedPhones = testingPhones.filter(p => p !== phone);
    const active = activePhone === phone ? (updatedPhones[0] || '') : activePhone;
    savePhoneMetadata(updatedPhones, active);
  };

  const handleSelectActive = (phone: string) => {
    savePhoneMetadata(testingPhones, phone);
  };

  // ─── CRUD Tipos de Plantilla ────────────────────────────

  const openTipoModal = (mode: 'create' | 'edit', tipo?: PlantillaTipoCRUD) => {
    setTipoModal({ mode, tipo });
    // Para edición, mostrar la plantilla resuelta (la que realmente se usa), no el default
    const plantillaResuelta = tipo ? (plantillas[tipo.key]?.plantilla_resuelta || tipo.plantilla_default) : '';
    setTipoForm(tipo ? {
      key: tipo.key,
      nombre: tipo.nombre,
      descripcion: tipo.descripcion || '',
      plantilla_default: plantillaResuelta,
      requiere_variante: tipo.requiere_variante
    } : { key: '', nombre: '', descripcion: '', plantilla_default: '', requiere_variante: false });
    setTipoError('');
  };

  const closeTipoModal = () => {
    setTipoModal(null);
    setTipoForm({ key: '', nombre: '', descripcion: '', plantilla_default: '', requiere_variante: false });
    setTipoError('');
  };

  const handleTipoSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTipoSaving(true);
    setTipoError('');

    try {
      if (tipoModal?.mode === 'create') {
        const nuevo = await createPlantillaTipo({
          key: tipoForm.key,
          nombre: tipoForm.nombre,
          descripcion: tipoForm.descripcion || undefined,
          plantilla_default: tipoForm.plantilla_default,
          requiere_variante: tipoForm.requiere_variante
        });
        setPlantillaTipos(prev => [...prev, nuevo]);
      } else if (tipoModal?.tipo) {
        const actualizado = await updatePlantillaTipo(tipoModal.tipo.id, {
          nombre: tipoForm.nombre,
          descripcion: tipoForm.descripcion || undefined,
          plantilla_default: tipoForm.plantilla_default
        });
        setPlantillaTipos(prev => prev.map(t => t.id === actualizado.id ? actualizado : t));
      }
      closeTipoModal();
      // Recargar plantillas resueltas
      const plantillasData = await fetchPlantillasResueltas().catch(() => ({ byKey: {} }));
      setPlantillas(plantillasData.byKey || {});
    } catch (err) {
      setTipoError(err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setTipoSaving(false);
    }
  };

  const handleDeleteTipo = async (tipo: PlantillaTipoCRUD) => {
    if (!confirm(`¿Eliminar tipo "${tipo.nombre}"? Esto también eliminará su toggle.`)) return;

    try {
      await deletePlantillaTipo(tipo.id);
      setPlantillaTipos(prev => prev.filter(t => t.id !== tipo.id));
      // Recargar configs y plantillas
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al eliminar');
    }
  };

  // Separar configs por categoría
  const tiendanubeConfigs = configs.filter(c => c.category === 'tiendanube');
  const whatsappConfigs = configs.filter(c => c.category === 'whatsapp');

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
          <>
            {/* Tiendanube configs by category */}
            {(() => {
              // Sub-opciones: key padre -> keys hijos
              const SUB_OPTIONS: Record<string, string[]> = {
                'tiendanube_webhooks_enabled': ['tiendanube_webhook_order_created', 'tiendanube_webhook_order_updated', 'tiendanube_webhook_order_cancelled'],
                'tiendanube_webhook_order_updated': ['tiendanube_webhook_sync_payment', 'tiendanube_webhook_sync_shipping', 'tiendanube_webhook_sync_products', 'tiendanube_webhook_sync_customer', 'tiendanube_webhook_sync_address', 'tiendanube_webhook_sync_notes', 'tiendanube_webhook_sync_costs', 'tiendanube_webhook_sync_tracking'],
                'tiendanube_resync_manual': ['tiendanube_resync_single', 'tiendanube_resync_inconsistent', 'tiendanube_resync_bulk'],
                'tiendanube_mark_paid': ['tiendanube_sync_estado_pagado', 'tiendanube_sync_estado_armado', 'tiendanube_sync_estado_enviado', 'tiendanube_sync_estado_cancelado'],
              };

              const TN_CATEGORIES: { label: string; icon: string; keys: string[] }[] = [
                { label: 'General', icon: '⚙️', keys: ['tiendanube_master_enabled'] },
                { label: 'Sincronización', icon: '🔄', keys: ['tiendanube_sync_orders', 'tiendanube_sync_cancelled', 'tiendanube_sync_images'] },
                { label: 'Acciones', icon: '▶️', keys: ['tiendanube_mark_paid', 'tiendanube_validate_orders', 'tiendanube_resync_manual'] },
                { label: 'Envíos', icon: '📦', keys: ['tiendanube_fulfillment_labels'] },
                { label: 'Conexión', icon: '🔌', keys: ['tiendanube_webhooks_enabled'] },
              ];

              const renderTnRow = (config: typeof tiendanubeConfigs[0]) => {
                const Icon = KEY_ICONS[config.key] || Settings;
                const friendlyName = KEY_NAMES[config.key] || config.key;
                const tooltip = KEY_TOOLTIPS[config.key];
                const isUpdating = updating === config.key;
                const subKeys = SUB_OPTIONS[config.key];
                const subItems = subKeys
                  ? subKeys.map(k => tiendanubeConfigs.find(c => c.key === k)).filter(Boolean) as typeof tiendanubeConfigs
                  : [];

                return (
                  <div key={config.key}>
                    <div className="flex items-center justify-between px-4 py-3 rounded-lg border border-gray-100 bg-white transition-all">
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
                                <Info className="h-4 w-4 text-gray-400 cursor-help hover:text-gray-600 transition-colors" />
                                <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 hidden group-hover:block z-50 pointer-events-none">
                                  <div className="bg-gray-800 text-white text-sm rounded-lg py-3 px-4 w-72 shadow-xl leading-relaxed">
                                    {tooltip}
                                    <div className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-[6px] border-r-[6px] border-t-[6px] border-transparent border-t-gray-800" />
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
                      {isUpdating ? (
                        <RefreshCw className="h-5 w-5 text-gray-400 animate-spin" />
                      ) : (
                        <Switch
                          checked={config.enabled}
                          onChange={() => handleToggle(config.key, config.enabled)}
                          disabled={!canUpdate}
                        />
                      )}
                    </div>
                    {/* Sub-opciones (nivel 2) */}
                    {subItems.length > 0 && config.enabled && (
                      <div className="ml-8 mt-1 space-y-1">
                        {subItems.map(sub => {
                          const subName = KEY_NAMES[sub.key] || sub.key;
                          const subUpdating = updating === sub.key;
                          // Check for nested sub-sub-options (nivel 3)
                          const subSubKeys = SUB_OPTIONS[sub.key];
                          const subSubItems = subSubKeys
                            ? subSubKeys.map(k => tiendanubeConfigs.find(c => c.key === k)).filter(Boolean) as typeof tiendanubeConfigs
                            : [];
                          return (
                            <div key={sub.key}>
                              <div className="flex items-center justify-between px-4 py-2 rounded-lg border border-gray-50 bg-gray-50 transition-all">
                                <div>
                                  <span className="text-sm font-medium text-gray-700">{subName}</span>
                                  <p className="text-xs text-gray-400">{sub.description}</p>
                                </div>
                                {subUpdating ? (
                                  <RefreshCw className="h-4 w-4 text-gray-400 animate-spin" />
                                ) : (
                                  <Switch
                                    checked={sub.enabled}
                                    onChange={() => handleToggle(sub.key, sub.enabled)}
                                    disabled={!canUpdate}
                                  />
                                )}
                              </div>
                              {/* Sub-sub-opciones (nivel 3) */}
                              {subSubItems.length > 0 && sub.enabled && (
                                <div className="ml-6 mt-1 space-y-1">
                                  {subSubItems.map(subsub => {
                                    const subsubName = KEY_NAMES[subsub.key] || subsub.key;
                                    const SubIcon = KEY_ICONS[subsub.key] || Settings;
                                    const subsubUpdating = updating === subsub.key;
                                    return (
                                      <div
                                        key={subsub.key}
                                        className="flex items-center justify-between px-3 py-1.5 rounded-lg border border-gray-100 bg-white transition-all"
                                      >
                                        <div className="flex items-center gap-2">
                                          <SubIcon className="h-3.5 w-3.5 text-gray-400" />
                                          <span className="text-sm text-gray-600">{subsubName}</span>
                                        </div>
                                        {subsubUpdating ? (
                                          <RefreshCw className="h-3.5 w-3.5 text-gray-400 animate-spin" />
                                        ) : (
                                          <Switch
                                            checked={subsub.enabled}
                                            onChange={() => handleToggle(subsub.key, subsub.enabled)}
                                            disabled={!canUpdate}
                                          />
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              };

              return (
                <div className="space-y-6">
                  {TN_CATEGORIES.map(cat => {
                    const items = cat.keys
                      .map(k => tiendanubeConfigs.find(c => c.key === k))
                      .filter(Boolean) as typeof tiendanubeConfigs;
                    if (items.length === 0) return null;
                    return (
                      <div key={cat.label}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-base">{cat.icon}</span>
                          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{cat.label}</h3>
                        </div>
                        <div className="space-y-2">
                          {items.map(renderTnRow)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {/* WhatsApp section */}
            {whatsappConfigs.length > 0 && (
              <div className="mt-8">
                <div className="flex items-center gap-3 mb-4">
                  <div className="p-2 bg-green-100 rounded-lg">
                    <MessageSquare className="h-6 w-6 text-green-600" />
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold text-gray-900">WhatsApp</h2>
                    <p className="text-sm text-gray-500">
                      Control de envío de mensajes
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                {/* Canal de WhatsApp (Botmaker) */}
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="p-2 rounded-lg bg-blue-100 text-blue-600">
                      <Phone className="h-5 w-5" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-gray-900">Canal de WhatsApp</h3>
                        <div className="relative group">
                          <Info className="h-4 w-4 text-gray-400 cursor-help" />
                          <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block z-50">
                            <div className="bg-gray-900 text-white text-sm rounded-lg py-2 px-3 max-w-xs shadow-lg">
                              {KEY_TOOLTIPS['botmaker_channel']}
                              <div className="absolute left-3 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900" />
                            </div>
                          </div>
                        </div>
                      </div>
                      <p className="text-sm text-gray-500">
                        Channel ID desde el cual se envian los mensajes
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={editingChannelId}
                      onChange={(e) => setEditingChannelId(e.target.value)}
                      placeholder="blanqueriaxmayor-whatsapp-5491136914124"
                      disabled={!canUpdate || savingChannel}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
                    />
                    <button
                      onClick={saveChannelId}
                      disabled={!canUpdate || savingChannel || editingChannelId === channelId || !editingChannelId.trim()}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                    >
                      {savingChannel ? (
                        <RefreshCw className="h-4 w-4 animate-spin" />
                      ) : channelSaved ? (
                        <>
                          <Check className="h-4 w-4" />
                          Guardado
                        </>
                      ) : (
                        'Guardar'
                      )}
                    </button>
                  </div>
                  {(channelId || editingChannelId) && (
                    <div className="mt-3 pt-3 border-t border-gray-100 flex items-center gap-2">
                      <span className="text-xs text-gray-500 font-medium">Activo:</span>
                      <code className="text-xs bg-green-50 text-green-700 px-2 py-1 rounded border border-green-200">
                        {channelId || editingChannelId}
                      </code>
                      {channelId && editingChannelId && channelId !== editingChannelId && (
                        <span className="text-xs text-amber-600">(sin guardar)</span>
                      )}
                    </div>
                  )}
                </div>

                {/* Modo Testing */}
                {whatsappConfigs.filter(c => c.key === 'whatsapp_testing_mode').map(config => {
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
                                  ? 'bg-yellow-100 text-yellow-600'
                                  : 'bg-green-100 text-green-600'
                              }`}
                            >
                              <Icon className="h-5 w-5" />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <h3 className="font-medium text-gray-900">{friendlyName}</h3>
                                {config.enabled && (
                                  <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs font-medium rounded-full">
                                    Testing
                                  </span>
                                )}
                                {!config.enabled && (
                                  <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                                    Produccion
                                  </span>
                                )}
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
                              <p className="text-sm text-gray-500 mt-0.5">
                                {config.enabled
                                  ? 'Modo testing: los mensajes se envían solo al número configurado, no al cliente real'
                                  : 'Modo producción: los mensajes se envían directo al cliente real'}
                              </p>
                              {config.updated_at && (
                                <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                                  <Clock className="h-3 w-3" />
                                  {new Date(config.updated_at).toLocaleString('es-AR')}
                                </p>
                              )}
                            </div>
                          </div>

                          {isUpdating ? (
                            <RefreshCw className="h-5 w-5 text-gray-400 animate-spin" />
                          ) : (
                            <Switch
                              checked={config.enabled}
                              onChange={() => handleToggle(config.key, config.enabled)}
                              disabled={!canUpdate}
                            />
                          )}
                        </div>

                        {/* Teléfonos de testing - solo visible si está en modo testing */}
                        {config.enabled && config.key === 'whatsapp_testing_mode' && (
                          <div className="mt-4 pt-4 border-t border-gray-100 space-y-4">
                            {/* Lista de teléfonos */}
                            {testingPhones.length > 0 && (
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                  <Phone className="h-4 w-4 inline mr-1" />
                                  Numero activo (todos los mensajes se envian aca)
                                </label>
                                <div className="space-y-2">
                                  {testingPhones.map(phone => (
                                    <div
                                      key={phone}
                                      className={`flex items-center justify-between px-3 py-2 rounded-lg border transition-all ${
                                        activePhone === phone
                                          ? 'border-green-300 bg-green-50'
                                          : 'border-gray-200 bg-white'
                                      }`}
                                    >
                                      <div className="flex items-center gap-3">
                                        <button
                                          onClick={() => handleSelectActive(phone)}
                                          disabled={!canUpdate || savingPhone || activePhone === phone}
                                          className="flex items-center gap-2"
                                        >
                                          <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                                            activePhone === phone
                                              ? 'border-green-500'
                                              : 'border-gray-300 hover:border-gray-400'
                                          }`}>
                                            {activePhone === phone && (
                                              <div className="w-2 h-2 rounded-full bg-green-500" />
                                            )}
                                          </div>
                                          <span className={`text-sm font-mono ${activePhone === phone ? 'font-medium text-gray-900' : 'text-gray-600'}`}>
                                            {phone}
                                          </span>
                                        </button>
                                        {activePhone === phone && (
                                          <span className="px-1.5 py-0.5 bg-green-100 text-green-700 text-xs font-medium rounded">
                                            Activo
                                          </span>
                                        )}
                                      </div>
                                      {canUpdate && (
                                        <button
                                          onClick={() => handleRemovePhone(phone)}
                                          disabled={savingPhone}
                                          className="text-gray-400 hover:text-red-500 transition-colors p-1"
                                          title="Eliminar número"
                                        >
                                          <XCircle className="h-4 w-4" />
                                        </button>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Agregar nuevo teléfono */}
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-2">
                                Agregar numero
                              </label>
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  value={newPhone}
                                  onChange={e => setNewPhone(e.target.value.replace(/[^0-9]/g, ''))}
                                  placeholder="Ej: 1123945965"
                                  className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                                  disabled={!canUpdate || savingPhone}
                                  onKeyDown={e => e.key === 'Enter' && handleAddPhone()}
                                />
                                <button
                                  onClick={handleAddPhone}
                                  disabled={!canUpdate || savingPhone || !newPhone || testingPhones.includes(newPhone)}
                                  className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50 transition-colors"
                                >
                                  {savingPhone ? (
                                    <RefreshCw className="h-4 w-4 animate-spin" />
                                  ) : (
                                    'Agregar'
                                  )}
                                </button>
                              </div>
                            </div>

                            {phoneSaved && (
                              <p className="text-sm text-green-600 font-medium">Guardado</p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                })}

                {/* Plantillas WhatsApp - Vista unificada */}
                <div className="mt-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-gray-700">Plantillas de Mensajes</h3>
                    {canUpdate && (
                      <button
                        onClick={() => openTipoModal('create')}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800"
                      >
                        <Plus className="h-4 w-4" />
                        Nueva Plantilla
                      </button>
                    )}
                  </div>

                  <div className="space-y-2">
                    {plantillaTipos.map(tipo => {
                      const configKey = `whatsapp_tpl_${tipo.key}`;
                      const config = configs.find(c => c.key === configKey);
                      const plantillaInfo = plantillas[tipo.key];
                      const isUpd = updating === configKey;
                      const isEnabled = config?.enabled ?? false; // Si no existe config, mostrar como deshabilitado
                      const hasConfig = !!config;

                      return (
                        <div
                          key={tipo.id}
                          className={`flex items-center justify-between px-4 py-3 rounded-lg border transition-all ${
                            !hasConfig ? 'bg-amber-50 border-amber-200' : isEnabled ? 'bg-white border-gray-200' : 'bg-gray-50 border-gray-200'
                          }`}
                        >
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <Send className={`h-4 w-4 flex-shrink-0 ${!hasConfig ? 'text-amber-500' : isEnabled ? 'text-green-500' : 'text-gray-400'}`} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-gray-900">{tipo.nombre}</span>
                                {!hasConfig && (
                                  <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">sin toggle</span>
                                )}
                              </div>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded font-mono text-gray-700">
                                  {plantillaInfo?.plantilla_resuelta || tipo.plantilla_default}
                                </code>
                                {plantillaInfo && !plantillaInfo.usa_default && (
                                  <span className="text-xs text-indigo-600">✓ custom</span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 ml-4">
                            {canUpdate && (
                              <>
                                <button
                                  onClick={() => openTipoModal('edit', tipo)}
                                  className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"
                                  title="Editar"
                                >
                                  <Edit2 className="h-4 w-4" />
                                </button>
                                <button
                                  onClick={() => handleDeleteTipo(tipo)}
                                  className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                                  title="Eliminar"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </>
                            )}
                            {isUpd ? (
                              <RefreshCw className="h-4 w-4 text-gray-400 animate-spin" />
                            ) : (
                              <Switch
                                checked={isEnabled}
                                onChange={() => config && handleToggle(configKey, isEnabled)}
                                disabled={!canUpdate || !config}
                              />
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {plantillaTipos.length === 0 && (
                      <p className="text-center text-gray-400 py-4">No hay plantillas configuradas</p>
                    )}
                  </div>
                </div>
                </div>
              </div>
            )}
          </>
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

      {/* Modal: Crear/Editar Tipo de Plantilla */}
      {tipoModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-md shadow-xl">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">
                {tipoModal.mode === 'create' ? 'Nuevo Tipo de Plantilla' : 'Editar Tipo'}
              </h2>
              <button onClick={closeTipoModal} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleTipoSubmit} className="p-4 space-y-4">
              {tipoModal.mode === 'create' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Key *</label>
                  <input
                    type="text"
                    value={tipoForm.key}
                    onChange={e => setTipoForm(prev => ({ ...prev, key: e.target.value.toLowerCase().replace(/[^a-z_]/g, '') }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none font-mono"
                    placeholder="nombre_plantilla"
                    required
                  />
                  <p className="mt-1 text-xs text-gray-500">Solo minúsculas y guiones bajos. No se puede cambiar después.</p>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nombre *</label>
                <input
                  type="text"
                  value={tipoForm.nombre}
                  onChange={e => setTipoForm(prev => ({ ...prev, nombre: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none"
                  placeholder="Nombre para mostrar"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Plantilla en Botmaker *</label>
                {tipoModal.mode === 'edit' && tipoModal.tipo?.requiere_variante ? (
                  <div>
                    <div className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg font-mono text-sm text-gray-700">
                      {tipoForm.plantilla_default}
                    </div>
                    <p className="mt-1 text-xs text-amber-600">
                      Esta plantilla tiene variantes por financiera. Para cambiarla, editá la financiera correspondiente.
                    </p>
                  </div>
                ) : (
                  <>
                    <input
                      type="text"
                      value={tipoForm.plantilla_default}
                      onChange={e => setTipoForm(prev => ({ ...prev, plantilla_default: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none font-mono"
                      placeholder="nombre_en_botmaker"
                      required
                    />
                    <p className="mt-1 text-xs text-gray-500">Nombre exacto del intent en Botmaker</p>
                  </>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Descripción</label>
                <input
                  type="text"
                  value={tipoForm.descripcion}
                  onChange={e => setTipoForm(prev => ({ ...prev, descripcion: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none"
                  placeholder="Cuándo se envía este mensaje..."
                />
              </div>


              {tipoError && (
                <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">
                  {tipoError}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeTipoModal}
                  className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-gray-700 font-medium hover:bg-gray-50"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={tipoSaving}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-gray-900 text-white rounded-lg font-medium hover:bg-gray-800 disabled:opacity-50"
                >
                  {tipoSaving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  {tipoModal.mode === 'create' ? 'Crear' : 'Guardar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
