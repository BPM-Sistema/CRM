import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  RefreshCw,
  AlertCircle,
  Check,
  X,
  Loader2,
  FileText,
  Phone,
  Mail,
  Banknote,
  ExternalLink,
  ZoomIn,
} from 'lucide-react';
import { getEventConfig, formatEventLabel } from '../utils/eventConfig';
import { Header } from '../components/layout';
import { Button, Card, Modal, Input } from '../components/ui';
import {
  fetchComprobanteDetail,
  confirmComprobante,
  rejectComprobante,
  ApiComprobanteDetail,
  ApiLog,
} from '../services/api';
import { formatDistanceToNow, format } from 'date-fns';
import { es } from 'date-fns/locale';
import { clsx } from 'clsx';

function EstadoBadge({ estado }: { estado: string | null }) {
  const estadoMap: Record<string, { label: string; className: string }> = {
    pendiente: { label: 'A confirmar', className: 'bg-blue-100 text-blue-800' },
    a_confirmar: { label: 'A confirmar', className: 'bg-blue-100 text-blue-800' },
    confirmado: { label: 'Confirmado', className: 'bg-emerald-100 text-emerald-800' },
    rechazado: { label: 'Rechazado', className: 'bg-red-100 text-red-800' },
  };

  const info = estadoMap[estado || 'pendiente'] || estadoMap.pendiente;

  return (
    <span className={clsx('px-3 py-1 rounded-full text-sm font-medium', info.className)}>
      {info.label}
    </span>
  );
}

export function RealReceiptDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [comprobante, setComprobante] = useState<ApiComprobanteDetail | null>(null);
  const [logs, setLogs] = useState<ApiLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Estados para acciones
  const [isConfirming, setIsConfirming] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectMotivo, setRejectMotivo] = useState('');
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Estado para zoom de imagen
  const [showImageModal, setShowImageModal] = useState(false);

  const loadComprobante = async () => {
    if (!id) return;

    setLoading(true);
    setError(null);
    try {
      const data = await fetchComprobanteDetail(id);
      setComprobante(data.comprobante);
      setLogs(data.logs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar comprobante');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadComprobante();
  }, [id]);

  const formatCurrency = (amount: number | null) => {
    if (amount === null) return '-';
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
    }).format(amount);
  };

  const handleConfirm = async () => {
    if (!id) return;

    setIsConfirming(true);
    try {
      await confirmComprobante(id);
      setActionSuccess('Comprobante confirmado correctamente');
      await loadComprobante();
      setTimeout(() => setActionSuccess(null), 3000);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error al confirmar');
    } finally {
      setIsConfirming(false);
    }
  };

  const handleReject = async () => {
    if (!id) return;

    setIsRejecting(true);
    try {
      await rejectComprobante(id, rejectMotivo || undefined);
      setShowRejectModal(false);
      setRejectMotivo('');
      setActionSuccess('Comprobante rechazado');
      await loadComprobante();
      setTimeout(() => setActionSuccess(null), 3000);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error al rechazar');
    } finally {
      setIsRejecting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <RefreshCw size={32} className="animate-spin text-neutral-400" />
      </div>
    );
  }

  if (error || !comprobante) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="text-center py-8 px-12">
          <AlertCircle size={48} className="mx-auto text-red-400 mb-4" />
          <h3 className="text-lg font-semibold text-neutral-900 mb-2">
            {error || 'Comprobante no encontrado'}
          </h3>
          <div className="flex gap-3 justify-center mt-4">
            <Button variant="secondary" onClick={() => navigate('/receipts')}>
              Volver
            </Button>
            <Button onClick={loadComprobante}>Reintentar</Button>
          </div>
        </Card>
      </div>
    );
  }

  const isPending = comprobante.estado === 'pendiente' || comprobante.estado === 'a_confirmar';

  return (
    <div className="min-h-screen">
      <Header
        title={
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/receipts')}
              className="p-1 -ml-1 text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 rounded-lg transition-colors"
            >
              <ArrowLeft size={20} />
            </button>
            <span>Comprobante #{comprobante.id}</span>
          </div>
        }
        subtitle={`Pedido #${comprobante.order_number} · ${formatDistanceToNow(new Date(comprobante.created_at), { addSuffix: true, locale: es })}`}
        actions={
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<RefreshCw size={14} className={loading ? 'animate-spin' : ''} />}
            onClick={loadComprobante}
          >
            Actualizar
          </Button>
        }
      />

      {/* Mensaje de éxito */}
      {actionSuccess && (
        <div className="mx-6 mt-4 p-4 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center gap-3">
          <Check size={20} className="text-emerald-600" />
          <span className="text-emerald-700 font-medium">{actionSuccess}</span>
        </div>
      )}

      <div className="p-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Columna izquierda - Imagen */}
          <div className="lg:col-span-2 space-y-6">
            {/* Imagen del comprobante */}
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-semibold text-neutral-900">Imagen del Comprobante</h3>
                <EstadoBadge estado={comprobante.estado} />
              </div>

              {comprobante.file_url ? (
                <div className="relative group">
                  <img
                    src={comprobante.file_url}
                    alt="Comprobante"
                    className="w-full max-h-[600px] object-contain rounded-xl bg-neutral-100 cursor-pointer"
                    onClick={() => setShowImageModal(true)}
                  />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors rounded-xl flex items-center justify-center">
                    <button
                      onClick={() => setShowImageModal(true)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-3 bg-white rounded-full shadow-lg"
                    >
                      <ZoomIn size={24} className="text-neutral-700" />
                    </button>
                  </div>
                  <div className="absolute bottom-4 right-4 flex gap-2">
                    <a
                      href={comprobante.file_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 bg-white/90 rounded-lg shadow hover:bg-white transition-colors"
                      title="Abrir en nueva pestaña"
                    >
                      <ExternalLink size={18} className="text-neutral-700" />
                    </a>
                  </div>
                </div>
              ) : (
                <div className="h-64 bg-neutral-100 rounded-xl flex items-center justify-center">
                  <div className="text-center text-neutral-400">
                    <Banknote size={48} className="mx-auto mb-2" />
                    <p>Pago en efectivo - Sin imagen</p>
                  </div>
                </div>
              )}
            </Card>

            {/* Detalles del comprobante */}
            <Card>
              <h3 className="text-base font-semibold text-neutral-900 mb-4">Detalles</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 bg-neutral-50 rounded-xl">
                  <p className="text-xs text-neutral-500 uppercase tracking-wider">Monto</p>
                  <p className="text-lg font-semibold text-neutral-900 mt-1">
                    {formatCurrency(comprobante.monto)}
                  </p>
                </div>
                <div className="p-4 bg-neutral-50 rounded-xl">
                  <p className="text-xs text-neutral-500 uppercase tracking-wider">Tipo</p>
                  <p className="text-lg font-semibold text-neutral-900 mt-1 flex items-center gap-2">
                    {comprobante.tipo === 'efectivo' ? (
                      <>
                        <Banknote size={18} className="text-green-600" />
                        Efectivo
                      </>
                    ) : (
                      <>
                        <FileText size={18} className="text-blue-600" />
                        Transferencia
                      </>
                    )}
                  </p>
                </div>
                <div className="p-4 bg-neutral-50 rounded-xl">
                  <p className="text-xs text-neutral-500 uppercase tracking-wider">Fecha</p>
                  <p className="text-sm font-medium text-neutral-900 mt-1">
                    {format(new Date(comprobante.created_at), 'dd/MM/yyyy HH:mm', { locale: es })}
                  </p>
                </div>
                <div className="p-4 bg-neutral-50 rounded-xl">
                  <p className="text-xs text-neutral-500 uppercase tracking-wider">Registrado por</p>
                  <p className="text-sm font-medium text-neutral-900 mt-1">
                    {comprobante.registrado_por || 'Sistema'}
                  </p>
                </div>
              </div>
            </Card>

            {/* Historial */}
            <Card>
              <h3 className="text-base font-semibold text-neutral-900 mb-4">
                Historial ({logs.length})
              </h3>
              {logs.length === 0 ? (
                <div className="text-center py-8 text-neutral-500">
                  No hay actividad registrada
                </div>
              ) : (
                <div className="space-y-3">
                  {logs.map((log) => {
                    const eventConfig = getEventConfig(log.accion);
                    return (
                      <div key={log.id} className="flex items-start gap-3">
                        <div className={`w-8 h-8 ${eventConfig.color} rounded-full flex items-center justify-center text-base`}>
                          {eventConfig.emoji}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-neutral-900">{formatEventLabel(log.accion)}</p>
                          <p className="text-xs text-neutral-500">
                            {format(new Date(log.created_at), 'dd/MM/yyyy HH:mm', { locale: es })} · {log.origen}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>

          {/* Columna derecha */}
          <div className="space-y-6">
            {/* Acciones */}
            {isPending && (
              <Card className="border-2 border-amber-200 bg-amber-50/50">
                <h3 className="text-sm font-semibold text-amber-800 uppercase tracking-wider mb-4">
                  Acción Requerida
                </h3>
                <p className="text-sm text-amber-700 mb-4">
                  Este comprobante está pendiente de revisión. Verificá la imagen y confirmá o rechazá el pago.
                </p>
                <div className="space-y-3">
                  <Button
                    variant="primary"
                    className="w-full bg-emerald-600 hover:bg-emerald-700"
                    size="lg"
                    leftIcon={isConfirming ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
                    onClick={handleConfirm}
                    disabled={isConfirming || isRejecting}
                  >
                    {isConfirming ? 'Confirmando...' : 'Confirmar Comprobante'}
                  </Button>
                  <Button
                    variant="secondary"
                    className="w-full border-red-200 text-red-700 hover:bg-red-50"
                    size="lg"
                    leftIcon={<X size={18} />}
                    onClick={() => setShowRejectModal(true)}
                    disabled={isConfirming || isRejecting}
                  >
                    Rechazar Comprobante
                  </Button>
                </div>
              </Card>
            )}

            {/* Estado confirmado */}
            {comprobante.estado === 'confirmado' && (
              <Card className="border-2 border-emerald-200 bg-emerald-50/50">
                <div className="text-center py-4">
                  <Check size={48} className="mx-auto text-emerald-600 mb-2" />
                  <h3 className="text-lg font-semibold text-emerald-800">Confirmado</h3>
                  <p className="text-sm text-emerald-700 mt-1">
                    Este comprobante fue aprobado
                  </p>
                </div>
              </Card>
            )}

            {/* Estado rechazado */}
            {comprobante.estado === 'rechazado' && (
              <Card className="border-2 border-red-200 bg-red-50/50">
                <div className="text-center py-4">
                  <X size={48} className="mx-auto text-red-600 mb-2" />
                  <h3 className="text-lg font-semibold text-red-800">Rechazado</h3>
                  <p className="text-sm text-red-700 mt-1">
                    Este comprobante fue rechazado
                  </p>
                </div>
              </Card>
            )}

            {/* Info del pedido */}
            <Card>
              <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-3">
                Pedido Asociado
              </h3>
              <div className="space-y-3">
                <button
                  onClick={() => navigate(`/orders/${comprobante.order_number}`)}
                  className="w-full p-3 bg-neutral-50 rounded-xl text-left hover:bg-neutral-100 transition-colors"
                >
                  <p className="font-mono text-sm font-medium text-blue-600">
                    #{comprobante.order_number}
                  </p>
                  <p className="text-xs text-neutral-500 mt-1">Ver detalle del pedido →</p>
                </button>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-neutral-500">Total:</span>
                    <span className="ml-2 font-medium">{formatCurrency(comprobante.orden_total)}</span>
                  </div>
                  <div>
                    <span className="text-neutral-500">Pagado:</span>
                    <span className="ml-2 font-medium text-emerald-600">{formatCurrency(comprobante.orden_pagado)}</span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-neutral-500">Saldo:</span>
                    <span className={clsx('ml-2 font-medium', (comprobante.orden_saldo || 0) > 0 ? 'text-red-600' : 'text-emerald-600')}>
                      {formatCurrency(comprobante.orden_saldo)}
                    </span>
                  </div>
                </div>
              </div>
            </Card>

            {/* Cliente */}
            <Card>
              <h3 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-3">Cliente</h3>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center text-white font-medium">
                    {comprobante.customer_name ? comprobante.customer_name.split(' ').map((n: string) => n[0]).join('').slice(0, 2) : '??'}
                  </div>
                  <div>
                    <div className="font-medium text-neutral-900">{comprobante.customer_name || 'Sin nombre'}</div>
                  </div>
                </div>
                {(comprobante.customer_email || comprobante.customer_phone) && (
                  <div className="space-y-2 pt-2">
                    {comprobante.customer_email && (
                      <a
                        href={`mailto:${comprobante.customer_email}`}
                        className="flex items-center gap-2 text-sm text-neutral-600 hover:text-neutral-900"
                      >
                        <Mail size={14} />
                        {comprobante.customer_email}
                      </a>
                    )}
                    {comprobante.customer_phone && (
                      <a
                        href={`tel:${comprobante.customer_phone}`}
                        className="flex items-center gap-2 text-sm text-neutral-600 hover:text-neutral-900"
                      >
                        <Phone size={14} />
                        {comprobante.customer_phone}
                      </a>
                    )}
                  </div>
                )}
              </div>
            </Card>
          </div>
        </div>
      </div>

      {/* Modal de rechazo */}
      <Modal
        isOpen={showRejectModal}
        onClose={() => !isRejecting && setShowRejectModal(false)}
        title="Rechazar Comprobante"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-neutral-600">
            ¿Estás seguro de rechazar este comprobante? Esta acción no se puede deshacer.
          </p>
          <Input
            label="Motivo del rechazo (opcional)"
            value={rejectMotivo}
            onChange={(e) => setRejectMotivo(e.target.value)}
            placeholder="Ej: Imagen ilegible, monto incorrecto..."
            disabled={isRejecting}
          />
          <div className="flex gap-3">
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => setShowRejectModal(false)}
              disabled={isRejecting}
            >
              Cancelar
            </Button>
            <Button
              className="flex-1 bg-red-600 hover:bg-red-700"
              onClick={handleReject}
              disabled={isRejecting}
              leftIcon={isRejecting ? <Loader2 size={16} className="animate-spin" /> : <X size={16} />}
            >
              {isRejecting ? 'Rechazando...' : 'Rechazar'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Modal de imagen ampliada */}
      {showImageModal && comprobante.file_url && (
        <div
          className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4"
          onClick={() => setShowImageModal(false)}
        >
          <div className="relative max-w-6xl max-h-[95vh]">
            <img
              src={comprobante.file_url}
              alt="Comprobante"
              className="max-w-full max-h-[95vh] object-contain"
            />
            <button
              onClick={() => setShowImageModal(false)}
              className="absolute top-4 right-4 p-2 bg-white rounded-full hover:bg-neutral-100 transition-colors"
            >
              <X size={24} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
