import { useState, useEffect } from 'react';
import { Header } from '../components/layout';
import { Card, Button } from '../components/ui';
import {
  Send,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  MessageSquare,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { authFetch } from '../services/api';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

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

export default function WhatsAppActions() {
  const { hasPermission } = useAuth();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState('numero_viejo_sin_stock');
  const [orderNumbers, setOrderNumbers] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<BulkSendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTemplates();
  }, []);

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

  async function handleSend() {
    if (!orderNumbers.trim()) {
      setError('Ingresá al menos un número de pedido');
      return;
    }

    // Parse order numbers: split by comma, newline, or space
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
                    onChange={(e) => setSelectedTemplate(e.target.value)}
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

              {/* Order numbers input */}
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

              {/* Error message */}
              {error && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">
                  <XCircle className="h-4 w-4 flex-shrink-0" />
                  {error}
                </div>
              )}

              {/* Send button */}
              <Button
                onClick={handleSend}
                disabled={sending || !orderNumbers.trim()}
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
                    Enviar WhatsApp
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
      </div>
    </div>
  );
}
