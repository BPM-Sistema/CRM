import { useState, useEffect, useCallback } from 'react';
import { Header } from '../components/layout';
import { Card, Button } from '../components/ui';
import {
  Send,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  MessageSquare,
  Package,
  Plus,
  Trash2,
  RefreshCw,
  RotateCcw,
  Check,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { authFetch } from '../services/api';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// Plantillas que requieren variables de tracking
const TRACKING_TEMPLATES = ['envio_extra'];

interface Template {
  key: string;
  nombre: string;
  descripcion: string;
}

interface SendResult {
  orderNumber: string;
  customerName?: string;
  phone?: string;
  error?: string;
  reason?: string;
}

interface BulkSendResponse {
  ok: boolean;
  template: string;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  results: {
    sent: SendResult[];
    failed: SendResult[];
    skipped: SendResult[];
  };
}

interface TrackingEntry {
  orderNumber: string;
  totalShipments: number;
  trackingCodes: Record<number, string>; // position → code
}

export default function WhatsAppActions() {
  const { hasPermission } = useAuth();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState('numero_viejo_sin_stock');
  const [orderNumbers, setOrderNumbers] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<BulkSendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Estado para tracking entries
  const [trackingEntries, setTrackingEntries] = useState<TrackingEntry[]>([
    { orderNumber: '', totalShipments: 1, trackingCodes: {} }
  ]);

  const isTrackingTemplate = TRACKING_TEMPLATES.includes(selectedTemplate);

  // Failed messages
  const [failedMessages, setFailedMessages] = useState<any[]>([]);
  const [failedLoading, setFailedLoading] = useState(false);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [discardingId, setDiscardingId] = useState<number | null>(null);

  const loadFailedMessages = useCallback(async () => {
    setFailedLoading(true);
    try {
      const response = await authFetch(`${API_BASE_URL}/whatsapp/messages?status=failed&limit=50`);
      if (response.ok) {
        const data = await response.json();
        setFailedMessages(data.messages || []);
      }
    } catch { /* ignore */ }
    setFailedLoading(false);
  }, []);

  async function retryMessage(id: number) {
    setRetryingId(id);
    try {
      const response = await authFetch(`${API_BASE_URL}/whatsapp/messages/${id}/retry`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        setFailedMessages(prev => prev.filter(m => m.id !== id));
      } else if (data.discarded) {
        // El backend descartó automáticamente porque el pedido ya cumplió la acción
        setFailedMessages(prev => prev.filter(m => m.id !== id));
        alert(`Se descartó automáticamente: ${data.error}`);
      } else {
        alert(data.error || 'Error al reintentar');
      }
    } catch (err: any) {
      alert(err.message || 'Error al reintentar');
    }
    setRetryingId(null);
  }

  async function discardMessage(id: number, reason?: string) {
    if (!confirm('¿Descartar este mensaje? No se reenviará y saldrá de la lista.')) return;
    setDiscardingId(id);
    try {
      const response = await authFetch(`${API_BASE_URL}/whatsapp/messages/${id}/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || 'Descartado desde UI' }),
      });
      if (response.ok) {
        setFailedMessages(prev => prev.filter(m => m.id !== id));
      } else {
        const data = await response.json();
        alert(data.error || 'Error al descartar');
      }
    } catch (err: any) {
      alert(err.message || 'Error al descartar');
    }
    setDiscardingId(null);
  }

  useEffect(() => {
    loadTemplates();
    loadFailedMessages();
  }, [loadFailedMessages]);

  async function loadTemplates() {
    try {
      setLoadingTemplates(true);
      const response = await authFetch(`${API_BASE_URL}/whatsapp/templates`);
      if (!response.ok) {
        throw new Error('Error al cargar plantillas');
      }
      const data = await response.json();
      setTemplates(data.templates || []);
    } catch (err) {
      console.error('Error loading templates:', err);
      setError('Error al cargar plantillas');
    } finally {
      setLoadingTemplates(false);
    }
  }

  // Envío masivo genérico (plantillas normales)
  async function handleSend() {
    if (!orderNumbers.trim()) {
      setError('Ingresá al menos un número de pedido');
      return;
    }

    const orders = orderNumbers
      .split(/[\s,\n]+/)
      .map(n => n.trim())
      .filter(n => n.length > 0);

    if (orders.length === 0) {
      setError('Ingresá al menos un número de pedido');
      return;
    }

    if (orders.length > 100) {
      setError('Máximo 100 pedidos por envío');
      return;
    }

    setError(null);
    setResult(null);
    setSending(true);

    try {
      const response = await authFetch(`${API_BASE_URL}/whatsapp/bulk-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template: selectedTemplate,
          orderNumbers: orders,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Error al enviar');
      }
      setResult(data);
    } catch (err: any) {
      setError(err.message || 'Error al enviar');
    } finally {
      setSending(false);
    }
  }

  // Envío de tracking (un solo WhatsApp por pedido con códigos concatenados)
  async function handleSendTracking() {
    // Validar que todos los entries tengan datos
    for (let i = 0; i < trackingEntries.length; i++) {
      const entry = trackingEntries[i];
      if (!entry.orderNumber.trim()) {
        setError(`Falta el número de pedido en la entrada ${i + 1}`);
        return;
      }
      for (let pos = 1; pos <= entry.totalShipments; pos++) {
        if (!entry.trackingCodes[pos]?.trim()) {
          setError(`Falta el código de envío #${pos} en pedido ${entry.orderNumber}`);
          return;
        }
      }
    }

    setError(null);
    setResult(null);
    setSending(true);

    try {
      const response = await authFetch(`${API_BASE_URL}/whatsapp/send-tracking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries: trackingEntries }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Error al enviar');
      }
      setResult(data);
    } catch (err: any) {
      setError(err.message || 'Error al enviar');
    } finally {
      setSending(false);
    }
  }

  function addTrackingEntry() {
    setTrackingEntries(prev => [...prev, { orderNumber: '', totalShipments: 1, trackingCodes: {} }]);
  }

  function removeTrackingEntry(index: number) {
    setTrackingEntries(prev => prev.filter((_, i) => i !== index));
  }

  function updateTrackingEntry(index: number, updates: Partial<TrackingEntry>) {
    setTrackingEntries(prev => prev.map((entry, i) => {
      if (i !== index) return entry;
      const updated = { ...entry, ...updates };
      // Limpiar tracking codes que estén fuera del rango si cambia totalShipments
      if (updates.totalShipments) {
        const cleaned: Record<number, string> = {};
        for (let pos = 1; pos <= updates.totalShipments; pos++) {
          if (entry.trackingCodes[pos]) cleaned[pos] = entry.trackingCodes[pos];
        }
        updated.trackingCodes = cleaned;
      }
      return updated;
    }));
  }

  function updateTrackingCode(entryIndex: number, position: number, code: string) {
    setTrackingEntries(prev => prev.map((entry, i) => {
      if (i !== entryIndex) return entry;
      return { ...entry, trackingCodes: { ...entry.trackingCodes, [position]: code } };
    }));
  }

  if (!hasPermission('whatsapp.send_bulk')) {
    return (
      <div className="min-h-screen">
        <Header title="WhatsApp" subtitle="Acciones de envío" />
        <div className="p-6 text-neutral-500">No tienes permiso para ver esta página</div>
      </div>
    );
  }

  const selectedTemplateInfo = templates.find(t => t.key === selectedTemplate);

  return (
    <div className="min-h-screen">
      <Header title="WhatsApp" subtitle="Acciones de envío masivo" />

      <div className="p-6 max-w-3xl space-y-6">
        {/* Plantilla selector */}
        <Card>
          <div className="p-5">
            <h3 className="text-lg font-semibold text-neutral-900 mb-4 flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-green-600" />
              Enviar Plantilla
            </h3>

            <div className="space-y-4">
              {/* Template select */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1">
                  Plantilla
                </label>
                {loadingTemplates ? (
                  <div className="flex items-center gap-2 text-sm text-neutral-500 py-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Cargando plantillas...
                  </div>
                ) : (
                  <select
                    value={selectedTemplate}
                    onChange={(e) => {
                      setSelectedTemplate(e.target.value);
                      setResult(null);
                      setError(null);
                    }}
                    className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  >
                    {templates.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.nombre}
                      </option>
                    ))}
                  </select>
                )}
                {selectedTemplateInfo?.descripcion && (
                  <p className="mt-1 text-xs text-neutral-500">
                    {selectedTemplateInfo.descripcion}
                  </p>
                )}
              </div>

              {/* Modo tracking: campos por pedido */}
              {isTrackingTemplate ? (
                <div className="space-y-4">
                  {trackingEntries.map((entry, entryIdx) => (
                    <div key={entryIdx} className="p-4 bg-neutral-50 rounded-lg border border-neutral-200 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Package className="h-4 w-4 text-neutral-500" />
                          <span className="text-sm font-medium text-neutral-700">
                            Pedido {entryIdx + 1}
                          </span>
                        </div>
                        {trackingEntries.length > 1 && (
                          <button
                            onClick={() => removeTrackingEntry(entryIdx)}
                            className="p-1 text-neutral-400 hover:text-red-600 rounded"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs font-medium text-neutral-600 mb-1 block">
                            Nro. Pedido
                          </label>
                          <input
                            type="text"
                            value={entry.orderNumber}
                            onChange={(e) => updateTrackingEntry(entryIdx, { orderNumber: e.target.value })}
                            placeholder="Ej: 31163"
                            className="w-full px-3 py-2 text-sm border border-neutral-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                            disabled={sending}
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-neutral-600 mb-1 block">
                            Total envíos
                          </label>
                          <select
                            value={entry.totalShipments}
                            onChange={(e) => updateTrackingEntry(entryIdx, { totalShipments: Number(e.target.value) })}
                            className="w-full px-3 py-2 text-sm border border-neutral-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                            disabled={sending}
                          >
                            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                              <option key={n} value={n}>{n} {n === 1 ? 'envío' : 'envíos'}</option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {/* Campos editables para cada tracking */}
                      {Array.from({ length: entry.totalShipments }, (_, i) => i + 1).map(pos => (
                        <div key={pos}>
                          <label className="text-xs font-medium text-neutral-600 mb-1 block">
                            Envío #{pos}
                          </label>
                          <input
                            type="text"
                            value={entry.trackingCodes[pos] || ''}
                            onChange={(e) => updateTrackingCode(entryIdx, pos, e.target.value)}
                            placeholder="Código de seguimiento"
                            className="w-full px-3 py-2 text-sm border border-neutral-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                            disabled={sending}
                          />
                        </div>
                      ))}
                    </div>
                  ))}

                  <button
                    onClick={addTrackingEntry}
                    className="w-full py-2 border-2 border-dashed border-neutral-300 rounded-lg text-sm text-neutral-500 hover:border-green-400 hover:text-green-600 flex items-center justify-center gap-2"
                  >
                    <Plus size={16} />
                    Agregar otro pedido
                  </button>
                </div>
              ) : (
                /* Modo normal: textarea de números */
                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1">
                    Números de pedido
                  </label>
                  <textarea
                    value={orderNumbers}
                    onChange={(e) => setOrderNumbers(e.target.value)}
                    placeholder="Ej: 30001, 30002, 30003&#10;O uno por línea:&#10;30001&#10;30002"
                    rows={5}
                    className="w-full px-3 py-2 border border-neutral-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent resize-none"
                  />
                  <p className="mt-1 text-xs text-neutral-500">
                    Separados por coma, espacio o uno por línea. Máximo 100 pedidos.
                  </p>
                </div>
              )}

              {/* Error message */}
              {error && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">
                  <XCircle className="h-4 w-4 flex-shrink-0" />
                  {error}
                </div>
              )}

              {/* Send button */}
              <Button
                onClick={isTrackingTemplate ? handleSendTracking : handleSend}
                disabled={sending || (isTrackingTemplate ? false : !orderNumbers.trim())}
                className="bg-green-600 hover:bg-green-700"
              >
                {sending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Enviando...
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4 mr-2" />
                    {isTrackingTemplate ? 'Guardar y enviar WA' : 'Enviar WhatsApp'}
                  </>
                )}
              </Button>
            </div>
          </div>
        </Card>

        {/* Results */}
        {result && (
          <Card>
            <div className="p-5">
              <h3 className="text-lg font-semibold text-neutral-900 mb-4">
                Resultado del envío
              </h3>

              {/* Summary */}
              <div className="grid grid-cols-3 gap-4 mb-4">
                <div className="text-center p-3 bg-green-50 rounded-lg">
                  <div className="text-2xl font-bold text-green-700">{result.sent}</div>
                  <div className="text-xs text-green-600">Enviados</div>
                </div>
                <div className="text-center p-3 bg-red-50 rounded-lg">
                  <div className="text-2xl font-bold text-red-700">{result.failed}</div>
                  <div className="text-xs text-red-600">Fallidos</div>
                </div>
                <div className="text-center p-3 bg-amber-50 rounded-lg">
                  <div className="text-2xl font-bold text-amber-700">{result.skipped}</div>
                  <div className="text-xs text-amber-600">Omitidos</div>
                </div>
              </div>

              {/* Sent list */}
              {result.results.sent.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-sm font-medium text-green-700 mb-2 flex items-center gap-1">
                    <CheckCircle2 className="h-4 w-4" />
                    Enviados ({result.results.sent.length})
                  </h4>
                  <div className="bg-green-50 rounded-lg p-3 text-sm space-y-1 max-h-40 overflow-y-auto">
                    {result.results.sent.map((r, i) => (
                      <div key={i} className="text-green-800">
                        #{r.orderNumber} - {r.customerName} (***{r.phone})
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Failed list */}
              {result.results.failed.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-sm font-medium text-red-700 mb-2 flex items-center gap-1">
                    <XCircle className="h-4 w-4" />
                    Fallidos ({result.results.failed.length})
                  </h4>
                  <div className="bg-red-50 rounded-lg p-3 text-sm space-y-1 max-h-40 overflow-y-auto">
                    {result.results.failed.map((r, i) => (
                      <div key={i} className="text-red-800">
                        #{r.orderNumber}: {r.error}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Skipped list */}
              {result.results.skipped.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-amber-700 mb-2 flex items-center gap-1">
                    <AlertTriangle className="h-4 w-4" />
                    Omitidos ({result.results.skipped.length})
                  </h4>
                  <div className="bg-amber-50 rounded-lg p-3 text-sm space-y-1 max-h-40 overflow-y-auto">
                    {result.results.skipped.map((r, i) => (
                      <div key={i} className="text-amber-800">
                        #{r.orderNumber}: {r.reason}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Card>
        )}
        {/* Failed Messages Section */}
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-neutral-900 flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-500" />
              Mensajes fallidos
              {failedMessages.length > 0 && (
                <span className="bg-red-100 text-red-700 text-xs font-medium px-2 py-0.5 rounded-full">
                  {failedMessages.length}
                </span>
              )}
            </h3>
            <Button
              variant="secondary"
              size="sm"
              onClick={loadFailedMessages}
              disabled={failedLoading}
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${failedLoading ? 'animate-spin' : ''}`} />
              Actualizar
            </Button>
          </div>

          {failedMessages.length === 0 ? (
            <p className="text-sm text-neutral-500">No hay mensajes fallidos</p>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {failedMessages.map((m) => {
                const cumplida = m.accion_cumplida?.done === true;
                const bg = cumplida ? 'bg-emerald-50' : 'bg-red-50';
                return (
                  <div key={m.id} className={`flex items-center justify-between ${bg} rounded-lg px-4 py-3`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-sm flex-wrap">
                        <span className="font-medium text-neutral-900">#{m.order_number}</span>
                        <span className="text-neutral-500">{m.customer_name || m.contact_id}</span>
                        <span className="text-neutral-400">·</span>
                        <span className="text-neutral-500 truncate">{m.template}</span>
                        {cumplida && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">
                            <Check className="h-3 w-3" /> {m.accion_cumplida.reason}
                          </span>
                        )}
                      </div>
                      <div className={`text-xs mt-0.5 truncate ${cumplida ? 'text-emerald-700' : 'text-red-600'}`}>
                        {m.error_message || 'Error desconocido'} · {m.retry_count || 0} reintentos · {new Date(m.created_at).toLocaleString('es-AR')}
                      </div>
                    </div>
                    <div className="ml-3 shrink-0 flex gap-2">
                      {cumplida ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => discardMessage(m.id, m.accion_cumplida.reason)}
                          disabled={discardingId === m.id}
                        >
                          {discardingId === m.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <><Trash2 className="h-3 w-3 mr-1" /> Descartar</>
                          )}
                        </Button>
                      ) : (
                        <>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => retryMessage(m.id)}
                            disabled={retryingId === m.id}
                          >
                            {retryingId === m.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <><RotateCcw className="h-3 w-3 mr-1" /> Reintentar</>
                            )}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => discardMessage(m.id)}
                            disabled={discardingId === m.id}
                            className="text-neutral-500"
                          >
                            {discardingId === m.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3" />
                            )}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
