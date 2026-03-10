import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Check, AlertCircle, Loader2 } from 'lucide-react';
import { fetchTemplates, sendTemplate, WaspyTemplate } from '../../services/waspy';
import { Modal, Button, Input } from '../ui';

interface TemplatePickerProps {
  isOpen: boolean;
  onClose: () => void;
  conversationId: string;
  contactPhone: string;
  onSent: () => void;
}

const categoryColors: Record<string, string> = {
  MARKETING: 'bg-purple-100 text-purple-700',
  UTILITY: 'bg-blue-100 text-blue-700',
  AUTHENTICATION: 'bg-amber-100 text-amber-700',
};

const statusColors: Record<string, string> = {
  APPROVED: 'text-emerald-600',
  PENDING: 'text-amber-600',
  REJECTED: 'text-red-600',
};

function extractParameters(template: WaspyTemplate): string[] {
  const params: string[] = [];
  for (const component of template.components) {
    if (component.text) {
      const matches = component.text.match(/\{\{(\d+)\}\}/g);
      if (matches) {
        for (const match of matches) {
          const index = match.replace(/[{}]/g, '');
          if (!params.includes(index)) {
            params.push(index);
          }
        }
      }
    }
  }
  return params.sort((a, b) => Number(a) - Number(b));
}

function getTemplatePreview(template: WaspyTemplate): string {
  const body = template.components.find(
    (c) => c.type === 'BODY' || c.type === 'body'
  );
  return body?.text || '';
}

export function TemplatePicker({
  isOpen,
  onClose,
  conversationId,
  contactPhone,
  onSent,
}: TemplatePickerProps) {
  const [templates, setTemplates] = useState<WaspyTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<WaspyTemplate | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const sentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (sentTimerRef.current) clearTimeout(sentTimerRef.current);
    };
  }, []);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchTemplates();
      setTemplates(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar templates');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadTemplates();
      setSelectedTemplate(null);
      setParamValues({});
      setSearch('');
      setSent(false);
    }
  }, [isOpen, loadTemplates]);

  const filteredTemplates = templates.filter((t) =>
    t.name.toLowerCase().includes(search.toLowerCase())
  );

  const parameters = selectedTemplate ? extractParameters(selectedTemplate) : [];

  const handleSelect = (template: WaspyTemplate) => {
    setSelectedTemplate(template);
    setParamValues({});
    setSent(false);
  };

  const handleParamChange = (paramIndex: string, value: string) => {
    setParamValues((prev) => ({ ...prev, [paramIndex]: value }));
  };

  const allParamsFilled = parameters.every((p) => paramValues[p]?.trim());

  const handleSend = async () => {
    if (!selectedTemplate) return;

    setSending(true);
    setError(null);
    try {
      const parameterArrays: Record<string, string[]> | undefined =
        parameters.length > 0
          ? {
              body: parameters.map((p) => paramValues[p]),
            }
          : undefined;

      await sendTemplate({
        conversationId,
        phone: contactPhone,
        templateName: selectedTemplate.name,
        language: selectedTemplate.language,
        parameters: parameterArrays,
      });

      setSent(true);
      sentTimerRef.current = setTimeout(() => {
        onSent();
        onClose();
      }, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al enviar template');
    } finally {
      setSending(false);
    }
  };

  const previewWithParams = (text: string): string => {
    let result = text;
    for (const [index, value] of Object.entries(paramValues)) {
      if (value.trim()) {
        result = result.replace(`{{${index}}}`, value);
      }
    }
    return result;
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Enviar Template" size="lg">
      {sent ? (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center">
            <Check className="w-6 h-6 text-emerald-600" />
          </div>
          <p className="text-sm font-medium text-neutral-900">Template enviado correctamente</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Search */}
          <Input
            placeholder="Buscar template..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leftIcon={<Search size={16} />}
          />

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 text-red-700 text-sm">
              <AlertCircle size={16} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-neutral-400" />
            </div>
          )}

          {/* Template list */}
          {!loading && !selectedTemplate && (
            <div className="max-h-[400px] overflow-y-auto flex flex-col gap-2">
              {filteredTemplates.length === 0 && !error && (
                <p className="text-sm text-neutral-500 text-center py-8">
                  No se encontraron templates
                </p>
              )}
              {filteredTemplates.map((template) => (
                <button
                  key={template.id}
                  onClick={() => handleSelect(template)}
                  className="p-3 border border-neutral-200 rounded-xl hover:border-neutral-400 cursor-pointer text-left transition-colors"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-neutral-900">
                      {template.name}
                    </span>
                    <span
                      className={`text-xs font-medium ${
                        statusColors[template.status.toUpperCase()] || 'text-neutral-500'
                      }`}
                    >
                      {template.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full ${
                        categoryColors[template.category.toUpperCase()] ||
                        'bg-neutral-100 text-neutral-600'
                      }`}
                    >
                      {template.category}
                    </span>
                    <span className="text-xs text-neutral-400">{template.language}</span>
                  </div>
                  {getTemplatePreview(template) && (
                    <p className="text-xs text-neutral-500 line-clamp-2">
                      {getTemplatePreview(template)}
                    </p>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Selected template detail */}
          {selectedTemplate && (
            <div className="flex flex-col gap-4">
              <div className="p-3 border border-neutral-900 bg-neutral-50 rounded-xl">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-neutral-900">
                    {selectedTemplate.name}
                  </span>
                  <button
                    onClick={() => setSelectedTemplate(null)}
                    className="text-xs text-neutral-500 hover:text-neutral-700 underline"
                  >
                    Cambiar
                  </button>
                </div>
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full ${
                      categoryColors[selectedTemplate.category.toUpperCase()] ||
                      'bg-neutral-100 text-neutral-600'
                    }`}
                  >
                    {selectedTemplate.category}
                  </span>
                  <span className="text-xs text-neutral-400">
                    {selectedTemplate.language}
                  </span>
                </div>
                {getTemplatePreview(selectedTemplate) && (
                  <p className="text-sm text-neutral-700 whitespace-pre-wrap">
                    {previewWithParams(getTemplatePreview(selectedTemplate))}
                  </p>
                )}
              </div>

              {/* Parameter inputs */}
              {parameters.length > 0 && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm font-medium text-neutral-700">
                    Parametros del template
                  </p>
                  {parameters.map((paramIndex) => (
                    <Input
                      key={paramIndex}
                      label={`Parametro {{${paramIndex}}}`}
                      placeholder={`Valor para {{${paramIndex}}}`}
                      value={paramValues[paramIndex] || ''}
                      onChange={(e) => handleParamChange(paramIndex, e.target.value)}
                    />
                  ))}
                </div>
              )}

              {/* Send button */}
              <Button
                onClick={handleSend}
                isLoading={sending}
                disabled={parameters.length > 0 && !allParamsFilled}
                className="w-full"
              >
                Enviar Template
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
