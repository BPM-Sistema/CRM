import { useState, useEffect, useCallback } from 'react';
import { Header } from '../components/layout';
import { AccessDenied } from '../components/AccessDenied';
import {
  RefreshCw,
  AlertCircle,
  Save,
  RotateCcw,
  Info,
  Check,
  Bot,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import {
  fetchAiBotSystemPrompt,
  updateAiBotSystemPrompt,
} from '../services/ai-bot-api';

const DEFAULT_SYSTEM_PROMPT = `Sos un asistente virtual de atención al cliente para una tienda de productos para mascotas. Tu objetivo es responder comentarios y mensajes de clientes en redes sociales de forma amable, profesional y concisa.

Reglas:
- Responde siempre en español rioplatense (vos, tenés, etc.)
- Sé breve: máximo 2-3 oraciones
- Si el cliente pregunta por precios o stock, indicale que escriba por mensaje privado
- Si es una queja, mostrá empatía y ofrecé ayuda
- Nunca inventes información sobre productos
- No uses emojis en exceso (máximo 1-2 por respuesta)
- Si no sabés la respuesta, derivá amablemente al inbox`;

export function AiBotPromptEditor() {
  const { hasPermission } = useAuth();

  const [prompt, setPrompt] = useState('');
  const [savedPrompt, setSavedPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const hasChanges = prompt !== savedPrompt;
  const charCount = prompt.length;

  const loadPrompt = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAiBotSystemPrompt();
      setPrompt(data.prompt);
      setSavedPrompt(data.prompt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar el prompt');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPrompt();
  }, [loadPrompt]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccessMessage(null);
    try {
      await updateAiBotSystemPrompt(prompt);
      setSavedPrompt(prompt);
      setSuccessMessage('Prompt guardado correctamente');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar el prompt');
    } finally {
      setSaving(false);
    }
  };

  const handleRestoreDefault = () => {
    if (!confirm('Se restaurara el prompt al valor por defecto. Los cambios no guardados se perderan.')) {
      return;
    }
    setPrompt(DEFAULT_SYSTEM_PROMPT);
  };

  // ── Permission check ──────────────────────────────────────────────────────

  if (!hasPermission('ai_bot.manage')) {
    return <AccessDenied message="No tenes permiso para gestionar el prompt del Bot IA." />;
  }

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <RefreshCw size={32} className="animate-spin text-neutral-400" />
      </div>
    );
  }

  // ── Error (no data) ───────────────────────────────────────────────────────

  if (error && !savedPrompt) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl border border-neutral-200/60 p-8 text-center max-w-md">
          <AlertCircle size={48} className="mx-auto text-red-400 mb-4" />
          <h3 className="text-lg font-semibold text-neutral-900 mb-2">Error al cargar datos</h3>
          <p className="text-neutral-500 mb-4">{error}</p>
          <button
            onClick={loadPrompt}
            className="px-4 py-2 bg-neutral-900 text-white rounded-lg hover:bg-neutral-800"
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen">
      <Header
        title="Editor de Prompt - Bot IA"
        subtitle="Configura la personalidad y conocimiento del bot"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={handleRestoreDefault}
              disabled={saving}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded-lg transition-colors"
            >
              <RotateCcw size={16} />
              Restaurar Default
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !hasChanges}
              className="flex items-center gap-2 px-4 py-1.5 text-sm font-medium bg-neutral-900 text-white rounded-lg hover:bg-neutral-800 disabled:opacity-50 transition-colors"
            >
              {saving ? (
                <RefreshCw size={16} className="animate-spin" />
              ) : (
                <Save size={16} />
              )}
              Guardar
            </button>
          </div>
        }
      />

      <div className="p-6">
        {/* Success message */}
        {successMessage && (
          <div className="mb-4 p-3 bg-emerald-50 text-emerald-700 rounded-lg text-sm flex items-center gap-2">
            <Check size={16} />
            {successMessage}
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Editor column */}
          <div className="lg:col-span-2 space-y-4">
            {/* Textarea card */}
            <div className="bg-white rounded-2xl border border-neutral-200/60 shadow-soft overflow-hidden">
              <div className="flex items-center justify-between px-6 py-3 bg-neutral-50 border-b border-neutral-200">
                <div className="flex items-center gap-2">
                  <Bot size={16} className="text-neutral-500" />
                  <span className="text-sm font-semibold text-neutral-700">System Prompt</span>
                </div>
                <span className={`text-xs font-medium ${charCount > 4000 ? 'text-red-500' : 'text-neutral-400'}`}>
                  {charCount.toLocaleString()} caracteres
                </span>
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={20}
                className="w-full px-6 py-4 text-sm text-neutral-800 font-mono leading-relaxed resize-y focus:outline-none min-h-[480px]"
                placeholder="Escribe el system prompt aqui..."
              />
            </div>

            {/* Unsaved changes indicator */}
            {hasChanges && (
              <div className="flex items-center gap-2 text-sm text-amber-600">
                <div className="w-2 h-2 rounded-full bg-amber-500" />
                Hay cambios sin guardar
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            {/* Preview card */}
            <div className="bg-white rounded-2xl border border-neutral-200/60 shadow-soft overflow-hidden">
              <div className="px-6 py-3 bg-neutral-50 border-b border-neutral-200">
                <span className="text-sm font-semibold text-neutral-700">Vista previa</span>
              </div>
              <div className="p-6">
                {prompt ? (
                  <div className="text-sm text-neutral-700 whitespace-pre-wrap leading-relaxed max-h-[300px] overflow-y-auto">
                    {prompt}
                  </div>
                ) : (
                  <p className="text-sm text-neutral-400 italic">El prompt esta vacio</p>
                )}
              </div>
            </div>

            {/* Tips card */}
            <div className="bg-blue-50 rounded-2xl border border-blue-100 overflow-hidden">
              <div className="px-6 py-3 border-b border-blue-100">
                <div className="flex items-center gap-2">
                  <Info size={16} className="text-blue-600" />
                  <span className="text-sm font-semibold text-blue-800">Consejos</span>
                </div>
              </div>
              <div className="p-6 space-y-3">
                <p className="text-sm text-blue-700">
                  El system prompt define la personalidad y conocimiento del bot.
                </p>
                <p className="text-sm text-blue-700">
                  Los cambios aplican inmediatamente a nuevas respuestas.
                </p>
                <p className="text-sm text-blue-700">
                  Las respuestas en curso no se ven afectadas.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
