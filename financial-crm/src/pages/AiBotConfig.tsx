import { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw,
  AlertCircle,
  Bot,
  Instagram,
  Facebook,
  MessageCircle,
  Gauge,
  Cpu,
  Globe,
  Save,
  CheckCircle2,
} from 'lucide-react';
import { Header } from '../components/layout';
import { Card, CardHeader, Badge, Button, Input } from '../components/ui';
import { Switch } from '../components/ui/Switch';
import { useAuth } from '../contexts/AuthContext';
import { fetchAiBotConfig, updateAiBotConfig } from '../services/ai-bot-api';
import type { AiBotConfig, AiBotMode, AiBotChannel } from '../types/ai-bot';

type Toast = { type: 'success' | 'error'; message: string } | null;

const modeOptions = [
  { value: 'off', label: 'OFF - Apagado', description: 'El bot no procesa ningun evento' },
  { value: 'suggestion', label: 'SUGERENCIA - Genera respuestas para revision', description: 'El bot genera respuestas pero requiere aprobacion humana antes de enviar' },
  { value: 'automatic', label: 'AUTOMATICO - Responde sin intervencion', description: 'El bot genera y envia respuestas automaticamente' },
];

const channelMeta: Record<AiBotChannel, { label: string; icon: React.ReactNode; description: string }> = {
  instagram_comment: {
    label: 'Instagram Comments',
    icon: <Instagram size={20} />,
    description: 'Responder comentarios en publicaciones de Instagram',
  },
  facebook_comment: {
    label: 'Facebook Comments',
    icon: <Facebook size={20} />,
    description: 'Responder comentarios en publicaciones de Facebook',
  },
  messenger: {
    label: 'Messenger',
    icon: <MessageCircle size={20} />,
    description: 'Responder mensajes directos de Messenger',
  },
};

// Helper to extract config value
function getConfigValue<T>(configs: AiBotConfig[], key: string, fallback: T): T {
  const item = configs.find((c) => c.key === key);
  if (!item) return fallback;
  return item.value as T;
}

export function AiBotConfig() {
  const { hasPermission } = useAuth();
  const [configs, setConfigs] = useState<AiBotConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  // Local form states
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<AiBotMode>('off');
  const [channels, setChannels] = useState<Record<AiBotChannel, boolean>>({
    instagram_comment: false,
    facebook_comment: false,
    messenger: false,
  });
  const [rateLimits, setRateLimits] = useState({
    max_replies_per_minute: 10,
    max_replies_per_hour: 100,
    max_tokens_per_day: 500000,
  });
  const [replyDelay, setReplyDelay] = useState({
    min_seconds: 5,
    max_seconds: 30,
    enabled: true,
  });
  const [claudeConfig, setClaudeConfig] = useState({
    model: 'claude-sonnet-4-5-20250514',
    max_tokens: 1024,
    temperature: 0.7,
  });
  const [metaConfig, setMetaConfig] = useState({
    page_id: '',
    ig_account_id: '',
    token_configured: false,
  });

  const canConfig = hasPermission('ai_bot.config');

  const loadData = useCallback(async () => {
    setError(null);
    try {
      const data = await fetchAiBotConfig();
      setConfigs(data);
      // Hydrate local state from config
      setEnabled(getConfigValue(data, 'enabled', false));
      setMode(getConfigValue(data, 'mode', 'off'));
      setChannels({
        instagram_comment: getConfigValue(data, 'channel_instagram_comment', false),
        facebook_comment: getConfigValue(data, 'channel_facebook_comment', false),
        messenger: getConfigValue(data, 'channel_messenger', false),
      });
      setRateLimits({
        max_replies_per_minute: getConfigValue(data, 'max_replies_per_minute', 10),
        max_replies_per_hour: getConfigValue(data, 'max_replies_per_hour', 100),
        max_tokens_per_day: getConfigValue(data, 'max_tokens_per_day', 500000),
      });
      const delayVal = getConfigValue(data, 'reply_delay', { min_seconds: 5, max_seconds: 30, enabled: true });
      setReplyDelay(delayVal as { min_seconds: number; max_seconds: number; enabled: boolean });
      setClaudeConfig({
        model: getConfigValue(data, 'claude_model', 'claude-sonnet-4-5-20250514'),
        max_tokens: getConfigValue(data, 'claude_max_tokens', 1024),
        temperature: getConfigValue(data, 'claude_temperature', 0.7),
      });
      setMetaConfig({
        page_id: getConfigValue(data, 'meta_page_id', ''),
        ig_account_id: getConfigValue(data, 'meta_ig_account_id', ''),
        token_configured: getConfigValue(data, 'meta_token_configured', false),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar configuracion');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canConfig) return;
    loadData();
  }, [loadData, canConfig]);

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const saveSection = async (section: string, updates: Record<string, unknown>) => {
    setSaving(section);
    try {
      for (const [key, value] of Object.entries(updates)) {
        await updateAiBotConfig(key, value);
      }
      showToast('success', 'Configuracion guardada correctamente');
      await loadData();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setSaving(null);
    }
  };

  if (!canConfig) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl border border-neutral-200/60 p-8 text-center max-w-md">
          <AlertCircle size={48} className="mx-auto text-red-400 mb-4" />
          <h3 className="text-lg font-semibold text-neutral-900 mb-2">Sin permisos</h3>
          <p className="text-neutral-500">No tienes permisos para configurar el Bot IA.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <RefreshCw size={32} className="animate-spin text-neutral-400" />
      </div>
    );
  }

  if (error && configs.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl border border-neutral-200/60 p-8 text-center max-w-md">
          <AlertCircle size={48} className="mx-auto text-red-400 mb-4" />
          <h3 className="text-lg font-semibold text-neutral-900 mb-2">Error al cargar configuracion</h3>
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

  return (
    <div className="min-h-screen">
      <Header
        title="Configuracion Bot IA"
        subtitle="Ajustes generales, canales, limites y modelo"
        actions={
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded-lg transition-colors"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Recargar
          </button>
        }
      />

      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-lg text-sm font-medium transition-all ${
          toast.type === 'success'
            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
            : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {toast.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          {toast.message}
        </div>
      )}

      <div className="p-6 space-y-6 max-w-3xl">
        {/* ── Global Settings ─────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Configuracion General"
            description="Controla el estado global y modo de operacion del bot"
            action={
              <div className="flex items-center gap-2 text-neutral-400">
                <Bot size={18} />
              </div>
            }
          />
          <div className="mt-6 space-y-6">
            {/* Master Switch */}
            <div className="flex items-center justify-between p-4 bg-neutral-50 rounded-xl">
              <div>
                <p className="text-sm font-medium text-neutral-900">Bot habilitado</p>
                <p className="text-xs text-neutral-500 mt-0.5">Activa o desactiva completamente el bot</p>
              </div>
              <Switch checked={enabled} onChange={() => setEnabled(!enabled)} />
            </div>

            {/* Mode Selector */}
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-3">Modo de operacion</label>
              <div className="space-y-2">
                {modeOptions.map((opt) => (
                  <label
                    key={opt.value}
                    className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                      mode === opt.value
                        ? 'border-neutral-900 bg-neutral-50'
                        : 'border-neutral-200 hover:border-neutral-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="bot-mode"
                      value={opt.value}
                      checked={mode === opt.value}
                      onChange={(e) => setMode(e.target.value as AiBotMode)}
                      className="mt-0.5 accent-neutral-900"
                    />
                    <div>
                      <p className="text-sm font-medium text-neutral-900">{opt.label}</p>
                      <p className="text-xs text-neutral-500 mt-0.5">{opt.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex justify-end">
              <Button
                size="sm"
                isLoading={saving === 'global'}
                leftIcon={<Save size={14} />}
                onClick={() => saveSection('global', { enabled, mode })}
              >
                Guardar
              </Button>
            </div>
          </div>
        </Card>

        {/* ── Channels ────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Canales"
            description="Habilita o deshabilita canales individuales"
          />
          <div className="mt-6 space-y-3">
            {(Object.keys(channelMeta) as AiBotChannel[]).map((ch) => (
              <div
                key={ch}
                className="flex items-center justify-between p-4 bg-neutral-50 rounded-xl"
              >
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                    channels[ch] ? 'bg-blue-50 text-blue-600' : 'bg-neutral-200 text-neutral-400'
                  }`}>
                    {channelMeta[ch].icon}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-neutral-900">{channelMeta[ch].label}</p>
                    <p className="text-xs text-neutral-500">{channelMeta[ch].description}</p>
                  </div>
                </div>
                <Switch
                  checked={channels[ch]}
                  onChange={() => setChannels((prev) => ({ ...prev, [ch]: !prev[ch] }))}
                />
              </div>
            ))}
            <div className="flex justify-end pt-2">
              <Button
                size="sm"
                isLoading={saving === 'channels'}
                leftIcon={<Save size={14} />}
                onClick={() =>
                  saveSection('channels', {
                    channel_instagram_comment: channels.instagram_comment,
                    channel_facebook_comment: channels.facebook_comment,
                    channel_messenger: channels.messenger,
                  })
                }
              >
                Guardar
              </Button>
            </div>
          </div>
        </Card>

        {/* ── Rate Limits ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Limites de tasa"
            description="Controla la velocidad maxima de respuestas del bot"
            action={
              <div className="text-neutral-400">
                <Gauge size={18} />
              </div>
            }
          />
          <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
            <Input
              label="Max respuestas / minuto"
              type="number"
              min={1}
              max={60}
              value={rateLimits.max_replies_per_minute}
              onChange={(e) =>
                setRateLimits((prev) => ({ ...prev, max_replies_per_minute: parseInt(e.target.value) || 0 }))
              }
            />
            <Input
              label="Max respuestas / hora"
              type="number"
              min={1}
              max={1000}
              value={rateLimits.max_replies_per_hour}
              onChange={(e) =>
                setRateLimits((prev) => ({ ...prev, max_replies_per_hour: parseInt(e.target.value) || 0 }))
              }
            />
            <Input
              label="Max tokens / dia"
              type="number"
              min={1000}
              max={10000000}
              value={rateLimits.max_tokens_per_day}
              onChange={(e) =>
                setRateLimits((prev) => ({ ...prev, max_tokens_per_day: parseInt(e.target.value) || 0 }))
              }
            />
          </div>
          <div className="flex justify-end mt-4">
            <Button
              size="sm"
              isLoading={saving === 'rate_limits'}
              leftIcon={<Save size={14} />}
              onClick={() => saveSection('rate_limits', rateLimits)}
            >
              Guardar
            </Button>
          </div>
        </Card>

        {/* ── Reply Delay (Human-like) ─────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Delay de respuesta"
            description="Espera aleatoria antes de responder para simular comportamiento humano"
            action={
              <Switch
                checked={replyDelay.enabled}
                onChange={() => setReplyDelay((prev) => ({ ...prev, enabled: !prev.enabled }))}
              />
            }
          />
          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Minimo (segundos)"
              type="number"
              min={0}
              max={120}
              value={replyDelay.min_seconds}
              disabled={!replyDelay.enabled}
              onChange={(e) =>
                setReplyDelay((prev) => ({ ...prev, min_seconds: parseInt(e.target.value) || 0 }))
              }
            />
            <Input
              label="Maximo (segundos)"
              type="number"
              min={1}
              max={300}
              value={replyDelay.max_seconds}
              disabled={!replyDelay.enabled}
              onChange={(e) =>
                setReplyDelay((prev) => ({ ...prev, max_seconds: parseInt(e.target.value) || 1 }))
              }
            />
          </div>
          {replyDelay.enabled && (
            <p className="mt-3 text-sm text-neutral-500">
              Cada respuesta esperara entre <span className="font-medium text-neutral-300">{replyDelay.min_seconds}s</span> y <span className="font-medium text-neutral-300">{replyDelay.max_seconds}s</span> antes de enviarse.
            </p>
          )}
          <div className="flex justify-end mt-4">
            <Button
              size="sm"
              isLoading={saving === 'reply_delay'}
              leftIcon={<Save size={14} />}
              onClick={() => saveSection('reply_delay', replyDelay)}
            >
              Guardar
            </Button>
          </div>
        </Card>

        {/* ── Claude Config ───────────────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Configuracion Claude"
            description="Parametros del modelo de IA"
            action={
              <div className="text-neutral-400">
                <Cpu size={18} />
              </div>
            }
          />
          <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
            <Input
              label="Modelo"
              type="text"
              value={claudeConfig.model}
              onChange={(e) =>
                setClaudeConfig((prev) => ({ ...prev, model: e.target.value }))
              }
            />
            <Input
              label="Max tokens"
              type="number"
              min={64}
              max={8192}
              value={claudeConfig.max_tokens}
              onChange={(e) =>
                setClaudeConfig((prev) => ({ ...prev, max_tokens: parseInt(e.target.value) || 0 }))
              }
            />
            <Input
              label="Temperatura"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={claudeConfig.temperature}
              onChange={(e) =>
                setClaudeConfig((prev) => ({ ...prev, temperature: parseFloat(e.target.value) || 0 }))
              }
            />
          </div>
          <div className="flex justify-end mt-4">
            <Button
              size="sm"
              isLoading={saving === 'claude'}
              leftIcon={<Save size={14} />}
              onClick={() =>
                saveSection('claude', {
                  claude_model: claudeConfig.model,
                  claude_max_tokens: claudeConfig.max_tokens,
                  claude_temperature: claudeConfig.temperature,
                })
              }
            >
              Guardar
            </Button>
          </div>
        </Card>

        {/* ── Meta Config (read-only) ─────────────────────────────────────── */}
        <Card>
          <CardHeader
            title="Configuracion Meta"
            description="Datos de conexion con Meta (solo lectura)"
            action={
              <div className="text-neutral-400">
                <Globe size={18} />
              </div>
            }
          />
          <div className="mt-6 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">Page ID</label>
                <div className="w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3.5 py-2 text-sm text-neutral-600">
                  {metaConfig.page_id || <span className="text-neutral-400 italic">No configurado</span>}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">IG Account ID</label>
                <div className="w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3.5 py-2 text-sm text-neutral-600">
                  {metaConfig.ig_account_id || <span className="text-neutral-400 italic">No configurado</span>}
                </div>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">Estado del token</label>
              <Badge variant={metaConfig.token_configured ? 'success' : 'warning'}>
                {metaConfig.token_configured ? 'Token configurado' : 'Token no configurado'}
              </Badge>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
