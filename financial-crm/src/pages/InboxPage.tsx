import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { Header } from '../components/layout';
import { Card } from '../components/ui';
import { OrderPanel } from '../components/inbox/OrderPanel';
import {
  fetchWaspyToken,
  fetchWaspyConfig,
  fetchChannelStatus,
  WaspyChannelStatus,
} from '../services/waspy';
import { useAuth } from '../contexts/AuthContext';

// ── Protocolo postMessage Waspy Embed ──────────────────────────────────
//
// CRM → Waspy:
//   { type: 'auth', token }
//   { type: 'navigate', conversationId }
//   { type: 'navigate', phone }
//   { type: 'context', orderId, customerName, phone }
//
// Waspy → CRM:
//   { type: 'ready', source: 'waspy-embed' }
//   { type: 'conversation:selected', conversationId, phone? }
//   { type: 'auth:error', message }
//   { type: 'token:expired' }
//   { type: 'navigate:result', success, conversationId?, message? }

/** Tipado de los mensajes postMessage que llegan del embed de Waspy */
interface WaspyInboundEvent {
  type: string;
  source?: string;
  conversationId?: string;
  phone?: string;
  message?: string;
  success?: boolean;
}

/** Datos mínimos de conversación para el OrderPanel */
interface EmbedConversation {
  id: string;
  contactPhone: string;
  contactName: string;
}

export function InboxPage() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const tokenRef = useRef<string | null>(null);
  const pendingNavigateRef = useRef<string | null>(null);
  const embedOriginRef = useRef<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [iframeReady, setIframeReady] = useState(false);
  const [channelStatus, setChannelStatus] = useState<WaspyChannelStatus | null>(null);
  const [activeConversation, setActiveConversation] = useState<EmbedConversation | null>(null);
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const phoneParam = searchParams.get('phone');
  const orderParam = searchParams.get('order');

  // ── Obtener config + JWT ────────────────────────────────────────────
  const init = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      setNotConfigured(false);

      // 1. Get Waspy config (embedUrl, etc.)
      const config = await fetchWaspyConfig();
      if (!config) {
        setNotConfigured(true);
        return;
      }
      setEmbedUrl(config.embedUrl);
      embedOriginRef.current = new URL(config.embedUrl).origin;

      // 2. Get embed token
      const token = await fetchWaspyToken();
      tokenRef.current = token;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al inicializar inbox');
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Cargar estado del canal (para banner) ───────────────────────────
  const loadChannelStatus = useCallback(async () => {
    try {
      const status = await fetchChannelStatus();
      setChannelStatus(status);
    } catch {
      // No bloquear la UI si falla el status
    }
  }, []);

  useEffect(() => {
    init();
    loadChannelStatus();
  }, [init, loadChannelStatus]);

  // ── Bridge: enviar mensaje al iframe ────────────────────────────────
  const postToEmbed = useCallback((message: Record<string, unknown>) => {
    if (iframeRef.current?.contentWindow && embedOriginRef.current) {
      iframeRef.current.contentWindow.postMessage(message, embedOriginRef.current);
    }
  }, []);

  // ── Cuando el iframe está listo, enviar auth + navigate ─────────────
  useEffect(() => {
    if (!iframeReady || !tokenRef.current) return;

    // 1. Autenticar
    postToEmbed({ type: 'auth', token: tokenRef.current });

    // 2. Navegar si hay phone param (desde "Abrir Inbox" en pedido)
    if (phoneParam) {
      pendingNavigateRef.current = phoneParam;
      postToEmbed({ type: 'navigate', phone: phoneParam });
    }

    // 3. Enviar contexto de pedido si viene desde detalle de pedido
    if (orderParam) {
      postToEmbed({
        type: 'context',
        orderId: orderParam,
        phone: phoneParam || undefined,
      });
    }
  }, [iframeReady, postToEmbed, phoneParam, orderParam]);

  // ── Bridge: escuchar mensajes del iframe ────────────────────────────
  useEffect(() => {
    const expectedOrigin = embedOriginRef.current;

    function handleMessage(event: MessageEvent) {
      // Validar origin estrictamente
      if (!expectedOrigin || event.origin !== expectedOrigin) return;

      const data = event.data as WaspyInboundEvent;
      if (!data || typeof data.type !== 'string') return;

      switch (data.type) {
        case 'ready':
          setIframeReady(true);
          break;

        case 'conversation:selected':
          setActiveConversation(
            data.conversationId
              ? {
                  id: data.conversationId,
                  contactPhone: data.phone || '',
                  contactName: '',
                }
              : null
          );
          break;

        case 'navigate:result':
          if (!data.success && pendingNavigateRef.current) {
            console.warn('[CRM] Waspy navigate failed:', data.message);
          }
          pendingNavigateRef.current = null;
          break;

        case 'auth:error':
          console.error('[CRM] Waspy auth error:', data.message);
          init().then(() => {
            if (tokenRef.current) {
              postToEmbed({ type: 'auth', token: tokenRef.current });
            }
          });
          break;

        case 'token:expired':
          // Re-obtener token y reenviar
          fetchWaspyToken().then((token) => {
            tokenRef.current = token;
            postToEmbed({ type: 'auth', token });
          }).catch(() => {
            // If re-auth fails, full re-init
            init();
          });
          break;
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [init, postToEmbed]);

  // ── Permisos ────────────────────────────────────────────────────────
  if (!hasPermission('inbox.view')) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="text-center py-8 px-12">
          <AlertCircle size={48} className="mx-auto text-red-400 mb-4" />
          <h3 className="text-lg font-semibold text-neutral-900 mb-2">Sin permisos</h3>
          <p className="text-neutral-500">No tienes permiso para ver el inbox.</p>
        </Card>
      </div>
    );
  }

  // ── Not configured ──────────────────────────────────────────────────
  if (notConfigured) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header title="Inbox WhatsApp" subtitle="Conversaciones" />
        <div className="flex-1 flex items-center justify-center">
          <Card className="text-center py-8 px-12 max-w-md">
            <AlertCircle size={48} className="mx-auto text-amber-400 mb-4" />
            <h3 className="text-lg font-semibold text-neutral-900 mb-2">Waspy no configurado</h3>
            <p className="text-neutral-500 text-sm mb-4">
              Configurá la conexión con Waspy en Configuración &gt; WhatsApp para habilitar el inbox.
            </p>
            {hasPermission('whatsapp.connect') && (
              <button
                onClick={() => navigate('/admin/whatsapp')}
                className="text-sm text-blue-600 hover:underline"
              >
                Ir a Configuración
              </button>
            )}
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header
        title="Inbox WhatsApp"
        subtitle="Conversaciones"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={loadChannelStatus}
              className="p-2 text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 rounded-lg transition-colors"
            >
              <RefreshCw size={16} />
            </button>
          </div>
        }
      />

      {/* Channel status banner */}
      {channelStatus && channelStatus.status !== 'connected' && (
        <div className="mx-6 mt-4 p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-center gap-2">
          <AlertCircle size={16} className="text-amber-600 flex-shrink-0" />
          <span className="text-sm text-amber-700">
            {channelStatus.status === 'disconnected'
              ? 'WhatsApp desconectado. Conecta el canal desde Configuracion.'
              : 'WhatsApp con problemas. Algunos mensajes podrian no enviarse.'}
          </span>
          {hasPermission('whatsapp.connect') && (
            <button
              onClick={() => navigate('/admin/whatsapp')}
              className="ml-auto text-sm text-amber-700 underline whitespace-nowrap"
            >
              Configurar
            </button>
          )}
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-200 rounded-xl flex items-center gap-2">
          <AlertCircle size={16} className="text-red-600 flex-shrink-0" />
          <span className="text-sm text-red-700">{error}</span>
          <button
            onClick={init}
            className="ml-auto text-sm text-red-700 underline whitespace-nowrap"
          >
            Reintentar
          </button>
        </div>
      )}

      {/* Main layout: embed + order panel */}
      <div className="flex flex-1 h-[calc(100vh-8rem)] overflow-hidden">
        {/* Waspy Embed */}
        <div className="flex-1 flex flex-col min-w-0 bg-white">
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 size={32} className="animate-spin text-neutral-400" />
            </div>
          ) : error ? (
            <div className="flex-1 flex items-center justify-center text-neutral-500">
              <div className="text-center space-y-3">
                <AlertCircle size={48} className="mx-auto text-red-300" />
                <p className="text-sm">No se pudo conectar con Waspy</p>
                <button
                  onClick={init}
                  className="text-sm text-blue-600 hover:underline"
                >
                  Reintentar
                </button>
              </div>
            </div>
          ) : embedUrl ? (
            <iframe
              ref={iframeRef}
              src={embedUrl}
              className="w-full h-full border-0"
              allow="clipboard-write"
              title="Waspy Inbox"
            />
          ) : null}
        </div>

        {/* Order Panel (CRM context) */}
        {activeConversation && (
          <div className="w-80 border-l border-neutral-200 bg-white overflow-y-auto p-4">
            <OrderPanel
              conversation={activeConversation}
              canAssign={hasPermission('inbox.assign')}
            />
          </div>
        )}

        {/* Order context when navigating from an order but no conversation selected yet */}
        {!activeConversation && orderParam && (
          <div className="w-80 border-l border-neutral-200 bg-white overflow-y-auto p-4">
            <div className="text-center py-6 text-sm text-neutral-400">
              <p>Pedido #{orderParam}</p>
              <p className="mt-1">Selecciona una conversacion en el inbox para ver los pedidos vinculados.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
