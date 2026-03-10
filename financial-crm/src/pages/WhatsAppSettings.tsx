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
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

import {
  fetchChannelStatus,
  startWhatsAppConnect,
  fetchConnectStatus,
  WaspyChannelStatus,
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

export default function WhatsAppSettings() {
  const { hasPermission } = useAuth();

  const [channelStatus, setChannelStatus] = useState<WaspyChannelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectResult, setConnectResult] = useState<any>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    loadChannelStatus();
  }, [loadChannelStatus]);

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

      // If there's a redirect URL, open it
      if (result.redirectUrl) {
        window.open(result.redirectUrl, '_blank');
      }

      // Start polling for connection status
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
            // Reload channel status
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
        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-neutral-400" />
            <span className="ml-2 text-neutral-500">Cargando estado del canal...</span>
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
                {/* Status */}
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

                {/* Phone Number */}
                {channelStatus.phoneNumber && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="h-4 w-4 text-neutral-400" />
                    <span className="text-neutral-500">Teléfono:</span>
                    <span className="font-medium text-neutral-700">{channelStatus.phoneNumber}</span>
                  </div>
                )}

                {/* WABA ID */}
                {channelStatus.wabaId && (
                  <div className="flex items-center gap-2 text-sm">
                    <ShieldCheck className="h-4 w-4 text-neutral-400" />
                    <span className="text-neutral-500">WABA ID:</span>
                    <span className="font-mono text-neutral-700">{channelStatus.wabaId}</span>
                  </div>
                )}

                {/* Quality Rating */}
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

                {/* Last Sync */}
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
              <h3 className="text-lg font-semibold text-neutral-900 mb-4">Conexión</h3>

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
      </div>
    </div>
  );
}
