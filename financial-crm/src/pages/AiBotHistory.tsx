import { useState, useEffect, useCallback } from 'react';
import { Header } from '../components/layout';
import { AccessDenied } from '../components/AccessDenied';
import { Badge } from '../components/ui/Badge';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '../components/ui/Table';
import {
  RefreshCw,
  AlertCircle,
  Eye,
  Check,
  X,
  ChevronLeft,
  ChevronRight,
  Instagram,
  Facebook,
  MessageCircle,
  Bot,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useUrlFilters } from '../hooks/useUrlFilters';
import {
  fetchAiBotEvents,
  approveAiBotReply,
  rejectAiBotReply,
  fetchAiBotEvent,
} from '../services/ai-bot-api';
import type { AiBotEvent, AiBotChannel, AiBotEventStatus } from '../types/ai-bot';

// ── Channel helpers ────────────────────────────────────────────────────────

const CHANNEL_LABELS: Record<AiBotChannel, string> = {
  instagram_comment: 'Instagram',
  facebook_comment: 'Facebook',
  messenger: 'Messenger',
};

const CHANNEL_ICONS: Record<AiBotChannel, typeof Instagram> = {
  instagram_comment: Instagram,
  facebook_comment: Facebook,
  messenger: MessageCircle,
};

const CHANNEL_VARIANTS: Record<AiBotChannel, 'purple' | 'info'> = {
  instagram_comment: 'purple',
  facebook_comment: 'info',
  messenger: 'info',
};

// ── Status helpers ─────────────────────────────────────────────────────────

const STATUS_LABELS: Record<AiBotEventStatus, string> = {
  received: 'Recibido',
  processing: 'Procesando',
  responded: 'Respondido',
  skipped: 'Omitido',
  ignored: 'Ignorado',
  failed: 'Error',
};

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'cyan' | 'orange';

const STATUS_VARIANTS: Record<AiBotEventStatus, BadgeVariant> = {
  received: 'default',
  processing: 'info',
  responded: 'success',
  skipped: 'warning',
  ignored: 'default',
  failed: 'danger',
};

// ── Filter options ─────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: 'all', label: 'Todos los estados' },
  { value: 'received', label: 'Recibido' },
  { value: 'processing', label: 'Procesando' },
  { value: 'responded', label: 'Respondido' },
  { value: 'skipped', label: 'Omitido' },
  { value: 'failed', label: 'Error' },
];

const CHANNEL_OPTIONS = [
  { value: 'all', label: 'Todos los canales' },
  { value: 'instagram_comment', label: 'Instagram' },
  { value: 'facebook_comment', label: 'Facebook' },
  { value: 'messenger', label: 'Messenger' },
];

const ITEMS_PER_PAGE = 25;

// ── Detail Modal ───────────────────────────────────────────────────────────

function EventDetailModal({
  event,
  onClose,
  onApprove,
  onReject,
}: {
  event: AiBotEvent;
  onClose: () => void;
  onApprove: (id: number) => Promise<void>;
  onReject: (id: number) => Promise<void>;
}) {
  const [showPayload, setShowPayload] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const latestReply = event.replies?.[0];
  const latestMessage = event.messages?.[0];
  const isPendingApproval = latestReply?.status === 'pending_approval';

  const handleApprove = async () => {
    setActionLoading(true);
    try {
      await onApprove(event.id);
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    setActionLoading(true);
    try {
      await onReject(event.id);
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl shadow-xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-neutral-200">
          <div>
            <h2 className="text-lg font-semibold text-neutral-900">
              Detalle del Evento #{event.id}
            </h2>
            <p className="text-sm text-neutral-500">
              {new Date(event.created_at).toLocaleString('es-AR')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-neutral-400 hover:text-neutral-600 rounded-lg transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Event info */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">
                Canal
              </label>
              <Badge variant={CHANNEL_VARIANTS[event.channel]}>
                {CHANNEL_LABELS[event.channel]}
              </Badge>
            </div>
            <div>
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">
                Estado
              </label>
              <Badge variant={STATUS_VARIANTS[event.status]}>
                {STATUS_LABELS[event.status]}
              </Badge>
            </div>
            <div>
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">
                Usuario
              </label>
              <p className="text-sm text-neutral-900">{event.sender_name || event.sender_id}</p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">
                Event ID
              </label>
              <p className="text-sm text-neutral-600 font-mono truncate">{event.event_id}</p>
            </div>
          </div>

          {/* Message content */}
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">
              Mensaje recibido
            </label>
            <div className="bg-neutral-50 rounded-xl p-4 text-sm text-neutral-800">
              {event.content_text || <span className="text-neutral-400 italic">Sin contenido de texto</span>}
            </div>
          </div>

          {/* Skip reason */}
          {event.skip_reason && (
            <div>
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">
                Motivo de omision
              </label>
              <div className="bg-amber-50 rounded-xl p-4 text-sm text-amber-800">
                {event.skip_reason}
              </div>
            </div>
          )}

          {/* AI generated message */}
          {latestMessage && (
            <div>
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">
                Respuesta generada por IA
              </label>
              <div className="bg-emerald-50 rounded-xl p-4 text-sm text-emerald-800">
                {latestMessage.generated_text}
              </div>
              <div className="flex items-center gap-4 mt-2 text-xs text-neutral-500">
                <span>Modelo: {latestMessage.model}</span>
                <span>Confianza: {(latestMessage.confidence * 100).toFixed(0)}%</span>
                <span>Tiempo: {latestMessage.generation_time_ms}ms</span>
                <span>Tokens: {latestMessage.prompt_tokens + latestMessage.completion_tokens}</span>
              </div>
            </div>
          )}

          {/* Reply status */}
          {latestReply && (
            <div>
              <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">
                Estado de respuesta
              </label>
              <div className="bg-white border border-neutral-200 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-neutral-700">Estado:</span>
                  <span className="text-sm text-neutral-900">{latestReply.status}</span>
                </div>
                {latestReply.meta_reply_id && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-neutral-700">Meta Reply ID:</span>
                    <span className="text-sm text-neutral-600 font-mono">{latestReply.meta_reply_id}</span>
                  </div>
                )}
                {latestReply.sent_at && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-neutral-700">Enviado:</span>
                    <span className="text-sm text-neutral-600">
                      {new Date(latestReply.sent_at).toLocaleString('es-AR')}
                    </span>
                  </div>
                )}
                {latestReply.error_message && (
                  <div className="mt-2 p-2 bg-red-50 rounded-lg text-sm text-red-700">
                    {latestReply.error_message}
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-neutral-700">Intentos:</span>
                  <span className="text-sm text-neutral-600">{latestReply.attempts}</span>
                </div>
              </div>
            </div>
          )}

          {/* Timestamps */}
          <div>
            <label className="block text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">
              Timestamps
            </label>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-500">Creado:</span>
                <span className="text-neutral-700">{new Date(event.created_at).toLocaleString('es-AR')}</span>
              </div>
              {event.processed_at && (
                <div className="flex justify-between">
                  <span className="text-neutral-500">Procesado:</span>
                  <span className="text-neutral-700">{new Date(event.processed_at).toLocaleString('es-AR')}</span>
                </div>
              )}
            </div>
          </div>

          {/* Raw payload */}
          <div>
            <button
              onClick={() => setShowPayload(!showPayload)}
              className="flex items-center gap-2 text-sm font-medium text-neutral-600 hover:text-neutral-900 transition-colors"
            >
              {showPayload ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              Payload completo (JSON)
            </button>
            {showPayload && (
              <pre className="mt-2 bg-neutral-900 text-neutral-100 rounded-xl p-4 text-xs overflow-x-auto max-h-64 overflow-y-auto">
                {JSON.stringify(event, null, 2)}
              </pre>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-neutral-200 flex gap-3">
          {isPendingApproval && (
            <>
              <button
                onClick={handleReject}
                disabled={actionLoading}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-red-200 text-red-700 rounded-lg font-medium hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                <X size={16} />
                Rechazar
              </button>
              <button
                onClick={handleApprove}
                disabled={actionLoading}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
              >
                {actionLoading ? (
                  <RefreshCw size={16} className="animate-spin" />
                ) : (
                  <Check size={16} />
                )}
                Aprobar
              </button>
            </>
          )}
          <button
            onClick={onClose}
            className={`${isPendingApproval ? '' : 'flex-1'} px-4 py-2.5 border border-neutral-200 rounded-lg text-neutral-700 font-medium hover:bg-neutral-50 transition-colors`}
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

export function AiBotHistory() {
  const { hasPermission } = useAuth();

  const { filters, setFilter } = useUrlFilters({
    status: 'all',
    channel: 'all',
    from: '',
    to: '',
    page: 1,
  });

  const [events, setEvents] = useState<AiBotEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Detail modal
  const [selectedEvent, setSelectedEvent] = useState<AiBotEvent | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string | number> = {
        page: filters.page as number,
        limit: ITEMS_PER_PAGE,
      };
      if (filters.status !== 'all') params.status = filters.status as string;
      if (filters.channel !== 'all') params.channel = filters.channel as string;
      if (filters.from) params.from = filters.from as string;
      if (filters.to) params.to = filters.to as string;

      const result = await fetchAiBotEvents(params);
      setEvents(result.data);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar eventos');
    } finally {
      setLoading(false);
    }
  }, [filters.page, filters.status, filters.channel, filters.from, filters.to]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const openDetail = async (event: AiBotEvent) => {
    setDetailLoading(true);
    try {
      const full = await fetchAiBotEvent(event.id);
      setSelectedEvent(full);
    } catch {
      // Fallback to the row data
      setSelectedEvent(event);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleApprove = async (eventId: number) => {
    await approveAiBotReply(eventId);
    setSelectedEvent(null);
    loadData();
  };

  const handleReject = async (eventId: number) => {
    await rejectAiBotReply(eventId);
    setSelectedEvent(null);
    loadData();
  };

  // ── Permission check ──────────────────────────────────────────────────────

  if (!hasPermission('ai_bot.view')) {
    return <AccessDenied message="No tenes permiso para acceder al historial del Bot IA." />;
  }

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loading && events.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <RefreshCw size={32} className="animate-spin text-neutral-400" />
      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────────────────

  if (error && events.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl border border-neutral-200/60 p-8 text-center max-w-md">
          <AlertCircle size={48} className="mx-auto text-red-400 mb-4" />
          <h3 className="text-lg font-semibold text-neutral-900 mb-2">Error al cargar datos</h3>
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

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen">
      <Header
        title="Historial Bot IA"
        subtitle="Eventos procesados por el bot de inteligencia artificial"
        actions={
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded-lg transition-colors"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Actualizar
          </button>
        }
      />

      <div className="p-6">
        {error && (
          <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm">
            {error}
          </div>
        )}

        {/* Filters */}
        <div className="bg-white rounded-2xl border border-neutral-200/60 shadow-soft p-4 mb-4">
          <div className="flex flex-wrap items-center gap-3">
            {/* Status filter */}
            <select
              value={filters.status as string}
              onChange={(e) => {
                setFilter('status', e.target.value);
                setFilter('page', 1);
              }}
              className="px-3 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            {/* Channel filter */}
            <select
              value={filters.channel as string}
              onChange={(e) => {
                setFilter('channel', e.target.value);
                setFilter('page', 1);
              }}
              className="px-3 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
            >
              {CHANNEL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            {/* Date from */}
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-neutral-500">Desde</label>
              <input
                type="date"
                value={filters.from as string}
                onChange={(e) => {
                  setFilter('from', e.target.value);
                  setFilter('page', 1);
                }}
                className="px-3 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
              />
            </div>

            {/* Date to */}
            <div className="flex items-center gap-1.5">
              <label className="text-xs text-neutral-500">Hasta</label>
              <input
                type="date"
                value={filters.to as string}
                onChange={(e) => {
                  setFilter('to', e.target.value);
                  setFilter('page', 1);
                }}
                className="px-3 py-2 border border-neutral-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
              />
            </div>

            <span className="text-xs text-neutral-400 ml-auto">
              {total} evento{total !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white rounded-2xl border border-neutral-200/60 shadow-soft overflow-hidden">
          <Table>
            <TableHeader>
              <tr>
                <TableHead>Fecha</TableHead>
                <TableHead>Canal</TableHead>
                <TableHead>Usuario</TableHead>
                <TableHead>Mensaje</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Respuesta</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {events.map((event) => {
                const ChannelIcon = CHANNEL_ICONS[event.channel];
                const latestReply = event.replies?.[0];
                const replyText = latestReply?.reply_text;
                const isPendingApproval = latestReply?.status === 'pending_approval';

                return (
                  <TableRow
                    key={event.id}
                    isClickable
                    onClick={() => openDetail(event)}
                  >
                    <TableCell>
                      <span className="text-xs text-neutral-600 whitespace-nowrap">
                        {new Date(event.created_at).toLocaleDateString('es-AR', {
                          day: '2-digit',
                          month: '2-digit',
                          year: '2-digit',
                        })}
                        <br />
                        {new Date(event.created_at).toLocaleTimeString('es-AR', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={CHANNEL_VARIANTS[event.channel]}>
                        <ChannelIcon size={12} className="mr-1" />
                        {CHANNEL_LABELS[event.channel]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-neutral-900 font-medium">
                        {event.sender_name || event.sender_id}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-neutral-600 line-clamp-2 max-w-[200px]">
                        {event.content_text || '-'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANTS[event.status]}>
                        {STATUS_LABELS[event.status]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-neutral-600 line-clamp-1 max-w-[180px]">
                        {replyText || '-'}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div
                        className="flex items-center justify-end gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          onClick={() => openDetail(event)}
                          className="p-2 text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 rounded-lg transition-colors"
                          title="Ver detalle"
                        >
                          <Eye size={16} />
                        </button>
                        {isPendingApproval && (
                          <>
                            <button
                              onClick={() => handleApprove(event.id)}
                              className="p-2 text-emerald-500 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors"
                              title="Aprobar"
                            >
                              <Check size={16} />
                            </button>
                            <button
                              onClick={() => handleReject(event.id)}
                              className="p-2 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors"
                              title="Rechazar"
                            >
                              <X size={16} />
                            </button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {events.length === 0 && !loading && (
            <div className="p-8 text-center">
              <Bot size={48} className="mx-auto text-neutral-300 mb-4" />
              <p className="text-neutral-500">No se encontraron eventos</p>
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <p className="text-sm text-neutral-500">
              Pagina {filters.page as number} de {totalPages}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setFilter('page', (filters.page as number) - 1)}
                disabled={(filters.page as number) <= 1}
                className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium border border-neutral-200 rounded-lg hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft size={16} />
                Anterior
              </button>
              <button
                onClick={() => setFilter('page', (filters.page as number) + 1)}
                disabled={(filters.page as number) >= totalPages}
                className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium border border-neutral-200 rounded-lg hover:bg-neutral-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Siguiente
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Detail modal */}
      {detailLoading && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <RefreshCw size={32} className="animate-spin text-white" />
        </div>
      )}

      {selectedEvent && (
        <EventDetailModal
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}
    </div>
  );
}
