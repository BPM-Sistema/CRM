import { useState, useEffect, useRef, useCallback } from 'react';
import { RefreshCw, Upload, FileText, Check, X, AlertCircle, Clock, Loader2, Eye, ChevronLeft, ChevronRight, Search, RotateCcw, Maximize2, ExternalLink } from 'lucide-react';
import { Header } from '../components/layout';
import { Button, Card } from '../components/ui';
import {
  fetchRemitos,
  fetchRemitosStats,
  uploadRemitos,
  confirmRemito,
  rejectRemito,
  reprocessRemito,
  Remito,
  RemitosStats,
  RemitoStatus,
  PaginationInfo
} from '../services/api';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { clsx } from 'clsx';

// Status configuration
const statusConfig: Record<RemitoStatus, { label: string; color: string; icon: React.ReactNode }> = {
  pending: { label: 'Pendiente', color: 'bg-gray-100 text-gray-700', icon: <Clock size={14} /> },
  processing: { label: 'Procesando', color: 'bg-blue-100 text-blue-700', icon: <Loader2 size={14} className="animate-spin" /> },
  ready: { label: 'Listo', color: 'bg-yellow-100 text-yellow-700', icon: <Eye size={14} /> },
  confirmed: { label: 'Confirmado', color: 'bg-emerald-100 text-emerald-700', icon: <Check size={14} /> },
  rejected: { label: 'Rechazado', color: 'bg-red-100 text-red-700', icon: <X size={14} /> },
  error: { label: 'Error', color: 'bg-red-100 text-red-700', icon: <AlertCircle size={14} /> },
};

const statusFilters: { value: RemitoStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'ready', label: 'Listos para revisar' },
  { value: 'processing', label: 'Procesando' },
  { value: 'confirmed', label: 'Confirmados' },
  { value: 'rejected', label: 'Rechazados' },
  { value: 'error', label: 'Con error' },
];

function StatusBadge({ status }: { status: RemitoStatus }) {
  const config = statusConfig[status];
  return (
    <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium', config.color)}>
      {config.icon}
      {config.label}
    </span>
  );
}

function MatchScoreBadge({ score }: { score: number | null }) {
  if (!score) return null;

  const percentage = Math.round(score * 100);
  const color = percentage >= 80 ? 'text-emerald-600' : percentage >= 60 ? 'text-yellow-600' : 'text-red-600';

  return (
    <span className={clsx('text-xs font-medium', color)}>
      {percentage}% match
    </span>
  );
}

interface RemitoCardProps {
  remito: Remito;
  onConfirm: (id: number, orderNumber?: string) => void;
  onReject: (id: number) => void;
  onReprocess: (id: number) => void;
  onOpen: (remito: Remito) => void;
  isLoading: boolean;
}

function RemitoCard({ remito, onConfirm, onReject, onReprocess, onOpen, isLoading }: RemitoCardProps) {
  const [showOCR, setShowOCR] = useState(false);
  const [customOrder, setCustomOrder] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);

  const handleConfirm = () => {
    if (showCustomInput && customOrder) {
      onConfirm(remito.id, customOrder);
    } else if (remito.suggested_order_number) {
      onConfirm(remito.id);
    }
  };

  return (
    <Card className="p-0 overflow-hidden">
      {/* Image preview - clickable */}
      <div
        className="relative h-40 bg-gray-100 cursor-pointer group"
        onClick={() => onOpen(remito)}
      >
        {remito.file_url && (
          <img
            src={remito.file_url}
            alt={remito.file_name || 'Remito'}
            className="w-full h-full object-cover"
          />
        )}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
          <Maximize2 size={24} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
        <div className="absolute top-2 right-2">
          <StatusBadge status={remito.status} />
        </div>
      </div>

      {/* Content */}
      <div className="p-3 space-y-2">
        {/* File name */}
        <p className="text-xs text-gray-500 truncate" title={remito.file_name || undefined}>
          {remito.file_name || 'Sin nombre'}
        </p>

        {/* Detected data */}
        {remito.detected_name && (
          <div className="text-sm">
            <span className="text-gray-500">Nombre:</span>{' '}
            <span className="font-medium">{remito.detected_name}</span>
          </div>
        )}
        {remito.detected_address && (
          <div className="text-sm">
            <span className="text-gray-500">Dir:</span>{' '}
            <span className="font-medium truncate">{remito.detected_address}</span>
          </div>
        )}

        {/* Suggested match */}
        {remito.suggested_order_number && (
          <div className="p-2 bg-emerald-50 rounded-lg">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-emerald-700">
                #{remito.suggested_order_number}
              </span>
              <MatchScoreBadge score={remito.match_score} />
            </div>
            {remito.order_customer_name && (
              <p className="text-xs text-emerald-600 mt-1">{remito.order_customer_name}</p>
            )}
          </div>
        )}

        {/* No match found */}
        {remito.status === 'ready' && !remito.suggested_order_number && (
          <div className="p-2 bg-yellow-50 rounded-lg">
            <p className="text-sm text-yellow-700">Sin coincidencia encontrada</p>
          </div>
        )}

        {/* Error message */}
        {remito.status === 'error' && remito.error_message && (
          <div className="p-2 bg-red-50 rounded-lg">
            <p className="text-xs text-red-600">{remito.error_message}</p>
          </div>
        )}

        {/* OCR text toggle */}
        {remito.ocr_text && (
          <button
            onClick={() => setShowOCR(!showOCR)}
            className="text-xs text-blue-600 hover:underline"
          >
            {showOCR ? 'Ocultar OCR' : 'Ver texto OCR'}
          </button>
        )}
        {showOCR && remito.ocr_text && (
          <pre className="text-xs bg-gray-50 p-2 rounded max-h-32 overflow-auto whitespace-pre-wrap">
            {remito.ocr_text}
          </pre>
        )}

        {/* Custom order input */}
        {showCustomInput && (
          <div className="flex gap-2">
            <input
              type="text"
              value={customOrder}
              onChange={(e) => setCustomOrder(e.target.value)}
              placeholder="# Pedido"
              className="flex-1 px-2 py-1 text-sm border rounded"
            />
            <button
              onClick={() => setShowCustomInput(false)}
              className="text-gray-500 hover:text-gray-700"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Actions */}
        {remito.status === 'ready' && (
          <div className="flex gap-2 pt-2">
            {remito.suggested_order_number || (showCustomInput && customOrder) ? (
              <Button
                size="sm"
                onClick={handleConfirm}
                disabled={isLoading}
                className="flex-1"
              >
                <Check size={14} className="mr-1" />
                Confirmar
              </Button>
            ) : null}

            {!showCustomInput && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setShowCustomInput(true)}
                disabled={isLoading}
              >
                <Search size={14} />
              </Button>
            )}

            <Button
              size="sm"
              variant="secondary"
              onClick={() => onReject(remito.id)}
              disabled={isLoading}
              className="text-red-600 hover:bg-red-50"
            >
              <X size={14} />
            </Button>
          </div>
        )}

        {remito.status === 'error' && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onReprocess(remito.id)}
            disabled={isLoading}
            className="w-full"
          >
            <RotateCcw size={14} className="mr-1" />
            Reprocesar
          </Button>
        )}

        {/* Timestamp */}
        <p className="text-xs text-gray-400 pt-1">
          {format(new Date(remito.created_at), "dd/MM HH:mm", { locale: es })}
        </p>
      </div>
    </Card>
  );
}

// Modal para ver remito completo
function RemitoModal({
  remito,
  onClose,
  onConfirm,
  onReject,
  isLoading
}: {
  remito: Remito;
  onClose: () => void;
  onConfirm: (id: number, orderNumber?: string) => void;
  onReject: (id: number) => void;
  isLoading: boolean;
}) {
  const [customOrder, setCustomOrder] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);

  const handleConfirm = () => {
    if (showCustomInput && customOrder) {
      onConfirm(remito.id, customOrder);
    } else if (remito.suggested_order_number) {
      onConfirm(remito.id);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className="bg-white rounded-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-3">
            <h2 className="font-semibold">{remito.file_name || 'Remito'}</h2>
            <StatusBadge status={remito.status} />
          </div>
          <div className="flex items-center gap-2">
            {remito.file_url && (
              <a
                href={remito.file_url}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 hover:bg-gray-100 rounded-lg"
                title="Abrir en nueva pestaña"
              >
                <ExternalLink size={18} />
              </a>
            )}
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          <div className="grid md:grid-cols-2 gap-4">
            {/* Image */}
            <div className="bg-gray-100 rounded-lg overflow-hidden">
              {remito.file_url && (
                <img
                  src={remito.file_url}
                  alt={remito.file_name || 'Remito'}
                  className="w-full h-auto max-h-[60vh] object-contain"
                />
              )}
            </div>

            {/* Details */}
            <div className="space-y-4">
              {/* Detected data */}
              <div className="space-y-2">
                <h3 className="font-medium text-gray-700">Datos detectados</h3>
                {remito.detected_name ? (
                  <p><span className="text-gray-500">Nombre:</span> {remito.detected_name}</p>
                ) : (
                  <p className="text-gray-400 text-sm">Sin nombre detectado</p>
                )}
                {remito.detected_address && (
                  <p><span className="text-gray-500">Dirección:</span> {remito.detected_address}</p>
                )}
                {remito.detected_city && (
                  <p><span className="text-gray-500">Ciudad:</span> {remito.detected_city}</p>
                )}
              </div>

              {/* Suggested match */}
              {remito.suggested_order_number && (
                <div className="p-3 bg-emerald-50 rounded-lg">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-emerald-700">
                      Pedido sugerido: #{remito.suggested_order_number}
                    </span>
                    <MatchScoreBadge score={remito.match_score} />
                  </div>
                  {remito.order_customer_name && (
                    <p className="text-sm text-emerald-600">{remito.order_customer_name}</p>
                  )}
                </div>
              )}

              {/* No match */}
              {remito.status === 'ready' && !remito.suggested_order_number && (
                <div className="p-3 bg-yellow-50 rounded-lg">
                  <p className="text-yellow-700">Sin coincidencia encontrada</p>
                </div>
              )}

              {/* OCR text */}
              {remito.ocr_text && (
                <div>
                  <h3 className="font-medium text-gray-700 mb-2">Texto OCR</h3>
                  <pre className="text-xs bg-gray-50 p-3 rounded-lg max-h-40 overflow-auto whitespace-pre-wrap">
                    {remito.ocr_text}
                  </pre>
                </div>
              )}

              {/* Custom order input */}
              {remito.status === 'ready' && (
                <div className="space-y-2">
                  {showCustomInput ? (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={customOrder}
                        onChange={(e) => setCustomOrder(e.target.value)}
                        placeholder="Número de pedido"
                        className="flex-1 px-3 py-2 border rounded-lg"
                        autoFocus
                      />
                      <button
                        onClick={() => setShowCustomInput(false)}
                        className="px-3 py-2 text-gray-500 hover:bg-gray-100 rounded-lg"
                      >
                        Cancelar
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowCustomInput(true)}
                      className="text-sm text-blue-600 hover:underline"
                    >
                      Asignar a otro pedido
                    </button>
                  )}
                </div>
              )}

              {/* Timestamp */}
              <p className="text-sm text-gray-400">
                Subido: {format(new Date(remito.created_at), "dd/MM/yyyy HH:mm", { locale: es })}
              </p>
            </div>
          </div>
        </div>

        {/* Footer with actions */}
        {remito.status === 'ready' && (
          <div className="flex justify-end gap-3 p-4 border-t bg-gray-50">
            <Button
              variant="secondary"
              onClick={() => {
                onReject(remito.id);
                onClose();
              }}
              disabled={isLoading}
              className="text-red-600"
            >
              <X size={16} className="mr-1" />
              Rechazar
            </Button>
            {(remito.suggested_order_number || (showCustomInput && customOrder)) && (
              <Button onClick={handleConfirm} disabled={isLoading}>
                <Check size={16} className="mr-1" />
                Confirmar {showCustomInput ? `#${customOrder}` : `#${remito.suggested_order_number}`}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ShippingDocuments() {
  const [remitos, setRemitos] = useState<Remito[]>([]);
  const [stats, setStats] = useState<RemitosStats | null>(null);
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [statusFilter, setStatusFilter] = useState<RemitoStatus | 'all'>('ready');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedRemito, setSelectedRemito] = useState<Remito | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [remitosRes, statsRes] = await Promise.all([
        fetchRemitos(page, 50, { status: statusFilter === 'all' ? undefined : statusFilter }),
        fetchRemitosStats()
      ]);

      setRemitos(remitosRes.data);
      setPagination(remitosRes.pagination);
      setStats(statsRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar datos');
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-refresh every 10 seconds if there are processing items
  useEffect(() => {
    if (stats?.processing && stats.processing > 0) {
      const interval = setInterval(loadData, 10000);
      return () => clearInterval(interval);
    }
  }, [stats?.processing, loadData]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    try {
      setUploading(true);
      setError(null);

      const result = await uploadRemitos(Array.from(files));

      if (result.errors > 0) {
        setError(`${result.uploaded} subidos, ${result.errors} errores`);
      }

      // Reset input and reload
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al subir archivos');
    } finally {
      setUploading(false);
    }
  };

  const handleConfirm = async (id: number, orderNumber?: string) => {
    try {
      setActionLoading(id);
      await confirmRemito(id, orderNumber);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al confirmar');
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (id: number) => {
    try {
      setActionLoading(id);
      await rejectRemito(id);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al rechazar');
    } finally {
      setActionLoading(null);
    }
  };

  const handleReprocess = async (id: number) => {
    try {
      setActionLoading(id);
      await reprocessRemito(id);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al reprocesar');
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-50">
      <Header title="Remitos" />

      <main className="p-4 md:p-6 max-w-7xl mx-auto">
        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-4">
            {Object.entries(statusConfig).map(([key, config]) => (
              <button
                key={key}
                onClick={() => {
                  setStatusFilter(key as RemitoStatus);
                  setPage(1);
                }}
                className={clsx(
                  'p-3 rounded-xl text-center transition-all',
                  statusFilter === key ? 'ring-2 ring-neutral-900' : 'hover:bg-white',
                  config.color.replace('text-', 'bg-').replace('-700', '-50')
                )}
              >
                <p className="text-2xl font-bold">{stats[key as keyof RemitosStats]}</p>
                <p className="text-xs text-gray-600">{config.label}</p>
              </button>
            ))}
          </div>
        )}

        {/* Actions bar */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          {/* Status filter */}
          <div className="flex gap-1 flex-wrap">
            {statusFilters.map((filter) => (
              <button
                key={filter.value}
                onClick={() => {
                  setStatusFilter(filter.value);
                  setPage(1);
                }}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-sm transition-colors',
                  statusFilter === filter.value
                    ? 'bg-neutral-900 text-white'
                    : 'bg-white text-neutral-600 hover:bg-neutral-100'
                )}
              >
                {filter.label}
              </button>
            ))}
          </div>

          <div className="flex-1" />

          {/* Upload button */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? (
              <Loader2 size={16} className="mr-2 animate-spin" />
            ) : (
              <Upload size={16} className="mr-2" />
            )}
            Subir Remitos
          </Button>

          {/* Refresh */}
          <Button variant="secondary" onClick={loadData} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </Button>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg flex items-center gap-2">
            <AlertCircle size={16} />
            {error}
            <button onClick={() => setError(null)} className="ml-auto">
              <X size={16} />
            </button>
          </div>
        )}

        {/* Grid */}
        {loading && remitos.length === 0 ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 size={32} className="animate-spin text-neutral-400" />
          </div>
        ) : remitos.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-neutral-500">
            <FileText size={48} className="mb-2 opacity-50" />
            <p>No hay remitos {statusFilter !== 'all' ? `con estado "${statusConfig[statusFilter as RemitoStatus]?.label}"` : ''}</p>
            <Button
              variant="secondary"
              className="mt-4"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={16} className="mr-2" />
              Subir primeros remitos
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {remitos.map((remito) => (
              <RemitoCard
                key={remito.id}
                remito={remito}
                onConfirm={handleConfirm}
                onReject={handleReject}
                onReprocess={handleReprocess}
                onOpen={setSelectedRemito}
                isLoading={actionLoading === remito.id}
              />
            ))}
          </div>
        )}

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 && (
          <div className="flex items-center justify-center gap-4 mt-6">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              <ChevronLeft size={16} />
            </Button>
            <span className="text-sm text-neutral-600">
              Página {pagination.page} de {pagination.totalPages}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
              disabled={page === pagination.totalPages}
            >
              <ChevronRight size={16} />
            </Button>
          </div>
        )}
      </main>

      {/* Modal */}
      {selectedRemito && (
        <RemitoModal
          remito={selectedRemito}
          onClose={() => setSelectedRemito(null)}
          onConfirm={handleConfirm}
          onReject={handleReject}
          isLoading={actionLoading === selectedRemito.id}
        />
      )}
    </div>
  );
}
