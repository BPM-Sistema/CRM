import { useState, useEffect, useCallback, useRef } from 'react';
import { Header } from '../components/layout';
import { Card } from '../components/ui';
import { Button } from '../components/ui';
import {
  RefreshCw,
  AlertCircle,
  Wifi,
  WifiOff,
  Phone,
  ExternalLink,
  Loader2,
  ShieldCheck,
  Key,
  CheckCircle2,
  Eye,
  EyeOff,
  Link2,
  Unlink,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

import {
  fetchChannelStatus,
  startWhatsAppConnect,
  fetchConnectStatus,
  fetchWaspyConfig,
  saveWaspyConfig,
  deleteWaspyConfig,
  WaspyChannelStatus,
  WaspyConfig,
} from '../services/waspy';

function formatDateTime(dateString: string | null): string {
  if (!dateString) return 'Nunca';
  const date = new Date(dateString);
  return date.toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function StatusDot({ status }: { status: WaspyChannelStatus['status'] }) {
  const colorMap = {
    connected: 'bg-green-500',
    disconnected: 'bg-red-500',
    degraded: 'bg-amber-500',
  };
  const color = colorMap[status] || 'bg-neutral-400';

  return (
    <span className="relative flex h-3 w-3">
      <span
        className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${color}`}
      />
      <span className={`relative inline-flex rounded-full h-3 w-3 ${color}`} />
    </span>
  );
}

function statusLabel(status: WaspyChannelStatus['status']): string {
  switch (status) {
    case 'connected':
      return 'Conectado';
    case 'disconnected':
      return 'Desconectado';
    case 'degraded':
      return 'Degradado';
    default:
      return 'Desconocido';
  }
}

// ── Waspy Connection Section ─────────────────────────────────────────

function WaspyConnectionCard({
  config,
  onConfigChange,
}: {
  config: WaspyConfig | null;
  onConfigChange: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [waspyUrl, setWaspyUrl] = useState('http://localhost:8080');
  const [embedUrl, setEmbedUrl] = useState('http://localhost:3000/embed/inbox');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleConnect = async () => {
    if (!apiKey.trim()) {
      setError('Ingresá el API Key');
      return;
    }
    if (!apiKey.startsWith('wspy_')) {
      setError('El API Key debe empezar con wspy_');
      return;
    }

    try {
      setSaving(true);
      setError(null);
      setSuccess(null);
      const result = await saveWaspyConfig(
        apiKey.trim(),
        showAdvanced ? waspyUrl.trim() : undefined,
        showAdvanced ? embedUrl.trim() : undefined
      );
      setSuccess(`Conectado a "${result.tenant.name}"`);
      setApiKey('');
      onConfigChange();
    } catch (err: any) {
      setError(err.message || 'Error al conectar');
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('¿Desconectar Waspy? El inbox dejará de funcionar hasta que vuelvas a conectar.')) {
      return;
    }
    try {
      setDeleting(true);
      setError(null);
      await deleteWaspyConfig();
      setSuccess(null);
      onConfigChange();
    } catch (err: any) {
      setError(err.message || 'Error al desconectar');
    } finally {
      setDeleting(false);
    }
  };

  if (config) {
    return (
      <Card>
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Link2 className="h-5 w-5 text-green-500" />
              <h3 className="text-lg font-semibold text-neutral-900">Conexión con Waspy</h3>
            </div>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Conectado
            </span>
          </div>

          <div className="space-y-2.5 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-neutral-500 w-24">Tenant:</span>
              <span className="font-medium text-neutral-700">{config.tenantName}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-neutral-500 w-24">Tenant ID:</span>
              <code className="text-xs bg-neutral-100 px-1.5 py-0.5 rounded font-mono text-neutral-600">
                {config.tenantId}
              </code>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-neutral-500 w-24">API Key:</span>
              <code className="text-xs bg-neutral-100 px-1.5 py-0.5 rounded font-mono text-neutral-600">
                {config.apiKeyPrefix}
              </code>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-neutral-500 w-24">Verificado:</span>
              <span className="text-neutral-600">{formatDateTime(config.verifiedAt)}</span>
            </div>
          </div>

          {error && (
            <div className="mt-3 flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              {error}
            </div>
          )}

          <div className="mt-4 pt-3 border-t border-neutral-100">
            <button
              onClick={handleDisconnect}
              disabled={deleting}
              className="inline-flex items-center gap-1.5 text-sm text-red-600 hover:text-red-800 transition-colors disabled:opacity-50"
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Unlink className="h-4 w-4" />
              )}
              Desconectar
            </button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <Key className="h-5 w-5 text-neutral-400" />
          <h3 className="text-lg font-semibold text-neutral-900">Conexión con Waspy</h3>
        </div>

        <p className="text-sm text-neutral-500 mb-4">
          Para conectar el inbox de WhatsApp, generá un API Key en Waspy
          (Configuración &gt; Integraciones) y pegalo acá.
        </p>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1">API Key</label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="wspy_xxxxxxxxxxxx..."
                className="w-full px-3 py-2 pr-10 border border-neutral-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-neutral-400 hover:text-neutral-600"
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-xs text-neutral-400 hover:text-neutral-600"
          >
            {showAdvanced ? 'Ocultar opciones avanzadas' : 'Opciones avanzadas'}
          </button>

          {showAdvanced && (
            <div className="space-y-3 pl-3 border-l-2 border-neutral-100">
              <div>
                <label className="block text-xs font-medium text-neutral-600 mb-1">URL API de Waspy</label>
                <input
                  type="text"
                  value={waspyUrl}
                  onChange={(e) => setWaspyUrl(e.target.value)}
                  className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-600 mb-1">URL Embed (iframe)</label>
                <input
                  type="text"
                  value={embedUrl}
                  onChange={(e) => setEmbedUrl(e.target.value)}
                  className="w-full px-3 py-1.5 border border-neutral-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              {error}
            </div>
          )}

          {success && (
            <div className="flex items-center gap-2 text-sm text-green-600">
              <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
              {success}
            </div>
          )}

          <Button onClick={handleConnect} disabled={saving || !apiKey.trim()}>
            {saving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Key className="h-4 w-4 mr-2" />
            )}
            Conectar
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ── Main Component ───────────────────────────────────────────────────

export default function WhatsAppSettings() {
  const { hasPermission } = useAuth();

  const [waspyConfig, setWaspyConfig] = useState<WaspyConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [channelStatus, setChannelStatus] = useState<WaspyChannelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectResult, setConnectResult] = useState<any>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadWaspyConfig = useCallback(async () => {
    try {
      setConfigLoading(true);
      const config = await fetchWaspyConfig();
      setWaspyConfig(config);
    } catch {
      // Ignore — not configured
    } finally {
      setConfigLoading(false);
    }
  }, []);

  const loadChannelStatus = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchChannelStatus();
      setChannelStatus(data);
    } catch (err: any) {
      setError(err.message || 'Error al cargar el estado del canal');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWaspyConfig();
  }, [loadWaspyConfig]);

  // Only load channel status if Waspy is configured
  useEffect(() => {
    if (waspyConfig && !configLoading) {
      loadChannelStatus();
    } else if (!configLoading) {
      setLoading(false);
    }
  }, [waspyConfig, configLoading, loadChannelStatus]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, []);

  const handleConnect = async () => {
    try {
      setConnecting(true);
      setConnectResult(null);
      setError(null);

      const result = await startWhatsAppConnect();
      setConnectResult(result);

      if (result.redirectUrl) {
        window.open(result.redirectUrl, '_blank');
      }

      pollRef.current = setInterval(async () => {
        try {
          const status = await fetchConnectStatus();
          setConnectResult((prev: any) => ({ ...prev, ...status }));

          if (status.status === 'connected' || status.status === 'failed') {
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
            setConnecting(false);
            loadChannelStatus();
          }
        } catch {
          // Keep polling on transient errors
        }
      }, 3000);
    } catch (err: any) {
      setError(err.message || 'Error al iniciar la conexión');
      setConnecting(false);
    }
  };

  const handleConfigChange = () => {
    loadWaspyConfig();
    // Reset channel status so it reloads
    setChannelStatus(null);
    setLoading(true);
  };

  if (!hasPermission('whatsapp.connect') && !hasPermission('inbox.view')) {
    return (
      <div className="min-h-screen">
        <Header title="WhatsApp" subtitle="Configuración del canal" />
        <div className="p-6 text-neutral-500">No tienes permiso para ver esta página</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header title="WhatsApp" subtitle="Configuración del canal" />
      <div className="p-6 max-w-2xl space-y-6">
        {/* Config loading */}
        {configLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-neutral-400" />
            <span className="ml-2 text-neutral-500">Cargando configuración...</span>
          </div>
        )}

        {/* Waspy Connection Card */}
        {!configLoading && hasPermission('whatsapp.connect') && (
          <WaspyConnectionCard config={waspyConfig} onConfigChange={handleConfigChange} />
        )}

        {/* Only show channel status & connection if Waspy is configured */}
        {!configLoading && waspyConfig && (
          <>
            {/* Loading channel status */}
            {loading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-neutral-400" />
                <span className="ml-2 text-neutral-500 text-sm">Cargando estado del canal...</span>
              </div>
            )}

            {/* Error */}
            {error && !loading && (
              <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4">
                <AlertCircle className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-red-800">{error}</p>
                  <button
                    onClick={() => {
                      setLoading(true);
                      loadChannelStatus();
                    }}
                    className="mt-2 text-sm text-red-600 hover:text-red-800 underline"
                  >
                    Reintentar
                  </button>
                </div>
              </div>
            )}

            {/* Channel Status Card */}
            {!loading && channelStatus && (
              <Card>
                <div className="p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold text-neutral-900">Estado del Canal</h3>
                    <button
                      onClick={() => {
                        setLoading(true);
                        loadChannelStatus();
                      }}
                      className="p-1.5 rounded-md text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-colors"
                      title="Actualizar"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <StatusDot status={channelStatus.status} />
                      <span className="text-sm font-medium text-neutral-700">
                        {statusLabel(channelStatus.status)}
                      </span>
                      {channelStatus.status === 'connected' ? (
                        <Wifi className="h-4 w-4 text-green-500" />
                      ) : (
                        <WifiOff className="h-4 w-4 text-neutral-400" />
                      )}
                    </div>

                    {channelStatus.phoneNumber && (
                      <div className="flex items-center gap-2 text-sm">
                        <Phone className="h-4 w-4 text-neutral-400" />
                        <span className="text-neutral-500">Teléfono:</span>
                        <span className="font-medium text-neutral-700">{channelStatus.phoneNumber}</span>
                      </div>
                    )}

                    {channelStatus.wabaId && (
                      <div className="flex items-center gap-2 text-sm">
                        <ShieldCheck className="h-4 w-4 text-neutral-400" />
                        <span className="text-neutral-500">WABA ID:</span>
                        <span className="font-mono text-neutral-700">{channelStatus.wabaId}</span>
                      </div>
                    )}

                    {channelStatus.qualityRating && (
                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-neutral-500">Calidad:</span>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                            channelStatus.qualityRating === 'GREEN'
                              ? 'bg-green-100 text-green-800'
                              : channelStatus.qualityRating === 'YELLOW'
                              ? 'bg-amber-100 text-amber-800'
                              : channelStatus.qualityRating === 'RED'
                              ? 'bg-red-100 text-red-800'
                              : 'bg-neutral-100 text-neutral-800'
                          }`}
                        >
                          {channelStatus.qualityRating}
                        </span>
                      </div>
                    )}

                    <div className="flex items-center gap-2 text-sm border-t border-neutral-100 pt-3 mt-3">
                      <span className="text-neutral-500">Última sincronización:</span>
                      <span className="text-neutral-600">
                        {formatDateTime(channelStatus.lastSync)}
                      </span>
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {/* Connection Card */}
            {!loading && hasPermission('whatsapp.connect') && (
              <Card>
                <div className="p-5">
                  <h3 className="text-lg font-semibold text-neutral-900 mb-4">Conexión WhatsApp</h3>

                  {channelStatus?.status === 'disconnected' && !connecting && !connectResult && (
                    <div className="space-y-3">
                      <p className="text-sm text-neutral-500">
                        El canal de WhatsApp no está conectado. Haz clic en el botón para iniciar el
                        proceso de conexión.
                      </p>
                      <Button onClick={handleConnect}>
                        <Phone className="h-4 w-4 mr-2" />
                        Conectar WhatsApp
                      </Button>
                    </div>
                  )}

                  {channelStatus?.status === 'connected' && !connecting && (
                    <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 rounded-lg p-3">
                      <Wifi className="h-4 w-4" />
                      <span>El canal de WhatsApp está conectado y funcionando correctamente.</span>
                    </div>
                  )}

                  {channelStatus?.status === 'degraded' && !connecting && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 rounded-lg p-3">
                        <AlertCircle className="h-4 w-4" />
                        <span>
                          El canal está experimentando problemas. Puedes intentar reconectar.
                        </span>
                      </div>
                      <Button onClick={handleConnect}>
                        <RefreshCw className="h-4 w-4 mr-2" />
                        Reconectar
                      </Button>
                    </div>
                  )}

                  {connecting && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-sm text-neutral-600">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Conectando... esperando confirmación.</span>
                      </div>
                      {connectResult?.redirectUrl && (
                        <a
                          href={connectResult.redirectUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 underline"
                        >
                          Abrir página de conexión
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                  )}

                  {!connecting && connectResult && (
                    <div className="space-y-2 text-sm">
                      <p className="text-neutral-600">
                        <span className="font-medium">Estado:</span> {connectResult.status}
                      </p>
                      {connectResult.message && (
                        <p className="text-neutral-500">{connectResult.message}</p>
                      )}
                    </div>
                  )}
                </div>
              </Card>
            )}
          </>
        )}

        {/* Message when not configured */}
        {!configLoading && !waspyConfig && !hasPermission('whatsapp.connect') && (
          <Card>
            <div className="p-5 text-center text-sm text-neutral-500">
              <AlertCircle className="h-8 w-8 mx-auto mb-2 text-neutral-300" />
              <p>Waspy no está configurado. Contactá a un administrador.</p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
