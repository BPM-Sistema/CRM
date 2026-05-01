import { useState, useEffect, useRef, useCallback } from 'react';
import { useUrlFilters } from '../hooks';
import { RefreshCw, Upload, FileText, Check, X, AlertCircle, Loader2, Eye, ChevronLeft, ChevronRight, Search, Maximize2, ExternalLink, Trash2, Package, ZoomIn, ZoomOut, RotateCcw, MapPin, User, Phone, Mail, ShoppingBag, DollarSign, Truck } from 'lucide-react';
import { Header } from '../components/layout';
import { Button, Card } from '../components/ui';
import { AccessDenied } from '../components/AccessDenied';
import { useAuth } from '../contexts/AuthContext';
import {
  fetchRemitos,
  fetchRemitosStats,
  uploadRemitos,
  confirmRemito,
  deleteRemito,
  fetchOrderPrintData,
  Remito,
  RemitosStats,
  RemitoStatus,
  PaginationInfo,
  ApiOrderPrintData
} from '../services/api';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { clsx } from 'clsx';

// Fullscreen image lightbox with zoom
function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const minScale = 0.5;
  const maxScale = 5;

  // Handle keyboard events
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') setScale(s => Math.min(maxScale, s + 0.25));
      if (e.key === '-') setScale(s => Math.max(minScale, s - 0.25));
      if (e.key === '0') { setScale(1); setPosition({ x: 0, y: 0 }); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Handle wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    setScale(s => Math.min(maxScale, Math.max(minScale, s + delta)));
  }, []);

  // Handle double click to zoom
  const handleDoubleClick = () => {
    if (scale > 1) {
      setScale(1);
      setPosition({ x: 0, y: 0 });
    } else {
      setScale(2.5);
    }
  };

  // Handle drag start
  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale > 1) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  };

  // Handle drag move
  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && scale > 1) {
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      });
    }
  };

  // Handle drag end
  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const zoomIn = () => setScale(s => Math.min(maxScale, s + 0.5));
  const zoomOut = () => setScale(s => Math.max(minScale, s - 0.5));
  const resetZoom = () => { setScale(1); setPosition({ x: 0, y: 0 }); };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/95 flex items-center justify-center"
      onClick={onClose}
    >
      {/* Controls */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        <span className="text-white/70 text-sm mr-2">{Math.round(scale * 100)}%</span>
        <button
          onClick={(e) => { e.stopPropagation(); zoomOut(); }}
          className="p-2 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-colors"
          title="Zoom out (-)"
        >
          <ZoomOut size={20} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); zoomIn(); }}
          className="p-2 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-colors"
          title="Zoom in (+)"
        >
          <ZoomIn size={20} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); resetZoom(); }}
          className="p-2 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-colors"
          title="Reset (0)"
        >
          <RotateCcw size={20} />
        </button>
        <button
          onClick={onClose}
          className="p-2 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-colors ml-2"
          title="Cerrar (ESC)"
        >
          <X size={20} />
        </button>
      </div>

      {/* Hint */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/50 text-sm">
        Doble click para zoom • Scroll para zoom • Arrastrar para mover
      </div>

      {/* Image container */}
      <div
        ref={containerRef}
        className="w-full h-full flex items-center justify-center overflow-hidden"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={handleDoubleClick}
        style={{ cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in' }}
      >
        <img
          src={src}
          alt={alt}
          className="max-w-[95vw] max-h-[90vh] object-contain select-none"
          style={{
            transform: `scale(${scale}) translate(${position.x / scale}px, ${position.y / scale}px)`,
            transition: isDragging ? 'none' : 'transform 0.15s ease-out'
          }}
          draggable={false}
        />
      </div>
    </div>
  );
}

// Order preview drawer (side panel)
function OrderDrawer({ orderNumber, onClose }: { orderNumber: string; onClose: () => void }) {
  const [orderData, setOrderData] = useState<ApiOrderPrintData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch order data
  useEffect(() => {
    async function loadOrder() {
      try {
        setLoading(true);
        setError(null);
        const data = await fetchOrderPrintData(orderNumber);
        setOrderData(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error al cargar pedido');
      } finally {
        setLoading(false);
      }
    }
    loadOrder();
  }, [orderNumber]);

  // Handle ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Format address from JSONB
  const formatAddress = (addr: Record<string, string> | null) => {
    if (!addr) return null;
    const parts = [
      addr.address,
      addr.locality,
      addr.city,
      addr.province,
      addr.zipcode
    ].filter(Boolean);
    return parts.join(', ');
  };

  // Format currency
  const formatMoney = (amount: number) => {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      minimumFractionDigits: 0
    }).format(amount);
  };

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/40 z-50 transition-opacity"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-full sm:w-[420px] md:w-[480px] lg:w-[520px] bg-white shadow-2xl z-50 flex flex-col animate-slideIn">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b bg-gray-50">
          <div className="flex items-center gap-2">
            <Package size={20} className="text-gray-600" />
            <h2 className="text-lg font-semibold">Pedido #{orderNumber}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-200 rounded-lg transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 size={32} className="animate-spin text-gray-400" />
            </div>
          ) : error ? (
            <div className="p-4 bg-red-50 text-red-700 rounded-lg">
              <AlertCircle size={20} className="inline mr-2" />
              {error}
            </div>
          ) : orderData ? (
            <div className="space-y-5">
              {/* Customer info */}
              <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                <h3 className="font-medium text-gray-700 flex items-center gap-2">
                  <User size={16} />
                  Cliente
                </h3>
                <p className="font-semibold text-lg">{orderData.customer.name}</p>
                {orderData.customer.phone && (
                  <p className="text-sm text-gray-600 flex items-center gap-2">
                    <Phone size={14} />
                    {orderData.customer.phone}
                  </p>
                )}
                {orderData.customer.email && (
                  <p className="text-sm text-gray-600 flex items-center gap-2">
                    <Mail size={14} />
                    {orderData.customer.email}
                  </p>
                )}
              </div>

              {/* Shipping address */}
              {orderData.shipping_address && (
                <div className="bg-blue-50 rounded-lg p-4 space-y-2">
                  <h3 className="font-medium text-blue-700 flex items-center gap-2">
                    <MapPin size={16} />
                    Dirección de envío
                  </h3>
                  <p className="text-blue-900">
                    {formatAddress(orderData.shipping_address as Record<string, string>)}
                  </p>
                </div>
              )}

              {/* Shipping type */}
              <div className="bg-gray-50 rounded-lg p-4">
                <h3 className="font-medium text-gray-700 flex items-center gap-2">
                  <Truck size={16} />
                  Envío
                </h3>
                <p className="mt-1">{orderData.shipping.type}</p>
                {orderData.shipping.tracking_number && (
                  <p className="text-sm text-gray-500 mt-1">
                    Tracking: {orderData.shipping.tracking_number}
                  </p>
                )}
              </div>

              {/* Order status */}
              <div className="flex gap-3">
                <div className="flex-1 bg-amber-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-amber-600 mb-1">Estado Pago</p>
                  <p className="font-medium text-amber-800">
                    {orderData.internal?.estado_pago || orderData.payment_status || '-'}
                  </p>
                </div>
                <div className="flex-1 bg-purple-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-purple-600 mb-1">Estado Pedido</p>
                  <p className="font-medium text-purple-800">
                    {orderData.internal?.estado_pedido || orderData.shipping_status || '-'}
                  </p>
                </div>
              </div>

              {/* Totals */}
              <div className="bg-emerald-50 rounded-lg p-4">
                <h3 className="font-medium text-emerald-700 flex items-center gap-2 mb-3">
                  <DollarSign size={16} />
                  Total
                </h3>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Subtotal</span>
                    <span>{formatMoney(orderData.totals.subtotal)}</span>
                  </div>
                  {orderData.totals.discount > 0 && (
                    <div className="flex justify-between text-red-600">
                      <span>Descuento</span>
                      <span>-{formatMoney(orderData.totals.discount)}</span>
                    </div>
                  )}
                  {orderData.totals.shipping > 0 && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Envío</span>
                      <span>{formatMoney(orderData.totals.shipping)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-bold text-lg pt-2 border-t border-emerald-200">
                    <span>Total</span>
                    <span className="text-emerald-700">{formatMoney(orderData.totals.total)}</span>
                  </div>
                  {orderData.internal?.total_pagado !== null && orderData.internal?.total_pagado !== undefined && (
                    <div className="flex justify-between text-sm pt-1">
                      <span className="text-gray-600">Pagado</span>
                      <span className="text-emerald-600">{formatMoney(orderData.internal.total_pagado)}</span>
                    </div>
                  )}
                  {orderData.internal?.saldo !== null && orderData.internal?.saldo !== undefined && orderData.internal.saldo > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600">Saldo</span>
                      <span className="text-amber-600">{formatMoney(orderData.internal.saldo)}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Products */}
              {orderData.products.length > 0 && (
                <div>
                  <h3 className="font-medium text-gray-700 flex items-center gap-2 mb-3">
                    <ShoppingBag size={16} />
                    Productos ({orderData.products.length})
                  </h3>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {orderData.products.map((product, idx) => (
                      <div
                        key={idx}
                        className="flex items-start justify-between p-3 bg-gray-50 rounded-lg text-sm"
                      >
                        <div className="flex-1">
                          <p className="font-medium">{product.name}</p>
                          {product.variant && (
                            <p className="text-gray-500 text-xs">{product.variant}</p>
                          )}
                          <p className="text-gray-500 text-xs">
                            {product.quantity} x {formatMoney(product.price)}
                          </p>
                        </div>
                        <p className="font-medium">{formatMoney(product.total)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Notes */}
              {(orderData.note || orderData.owner_note) && (
                <div className="bg-yellow-50 rounded-lg p-4 space-y-2">
                  <h3 className="font-medium text-yellow-700">Notas</h3>
                  {orderData.note && (
                    <p className="text-sm text-yellow-800">
                      <strong>Cliente:</strong> {orderData.note}
                    </p>
                  )}
                  {orderData.owner_note && (
                    <p className="text-sm text-yellow-800">
                      <strong>Interna:</strong> {orderData.owner_note}
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="p-4 border-t bg-gray-50">
          <Button variant="secondary" onClick={onClose} className="w-full">
            Cerrar
          </Button>
        </div>
      </div>
    </>
  );
}

// Status configuration (solo estados relevantes para UI)
const statusConfig: Record<RemitoStatus, { label: string; color: string; icon: React.ReactNode }> = {
  pending: { label: 'Pendiente', color: 'bg-gray-100 text-gray-700', icon: <Loader2 size={14} className="animate-spin" /> },
  processing: { label: 'Procesando', color: 'bg-blue-100 text-blue-700', icon: <Loader2 size={14} className="animate-spin" /> },
  ready: { label: 'Listo', color: 'bg-yellow-100 text-yellow-700', icon: <Eye size={14} /> },
  confirmed: { label: 'Confirmado', color: 'bg-emerald-100 text-emerald-700', icon: <Check size={14} /> },
  rejected: { label: 'Rechazado', color: 'bg-red-100 text-red-700', icon: <X size={14} /> },
  error: { label: 'Error', color: 'bg-red-100 text-red-700', icon: <AlertCircle size={14} /> },
};

// Solo filtros relevantes para el usuario
const statusFilters: { value: RemitoStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'ready', label: 'Listos para revisar' },
  { value: 'confirmed', label: 'Confirmados' },
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

// Skeleton loader for remito cards
function RemitoCardSkeleton() {
  return (
    <Card className="p-0 overflow-hidden flex flex-col animate-pulse">
      {/* Image placeholder */}
      <div className="h-72 md:h-80 bg-gray-200" />

      {/* Content placeholder */}
      <div className="p-4 space-y-3 flex-1 flex flex-col">
        {/* Name placeholder */}
        <div className="h-5 bg-gray-200 rounded w-3/4" />

        {/* Address placeholder */}
        <div className="h-4 bg-gray-100 rounded w-full" />

        {/* Match result placeholder */}
        <div className="p-3 bg-gray-100 rounded-lg space-y-2">
          <div className="h-5 bg-gray-200 rounded w-1/2" />
          <div className="h-4 bg-gray-200 rounded w-2/3" />
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Action buttons placeholder */}
        <div className="flex gap-2 pt-2">
          <div className="flex-1 h-10 bg-gray-200 rounded-lg" />
          <div className="w-12 h-10 bg-gray-100 rounded-lg" />
        </div>

        {/* Footer placeholder */}
        <div className="flex items-center justify-between pt-2 border-t border-gray-100">
          <div className="h-3 bg-gray-100 rounded w-16" />
          <div className="h-3 bg-gray-100 rounded w-12" />
        </div>
      </div>
    </Card>
  );
}

interface RemitoCardProps {
  remito: Remito;
  onConfirm: (id: number, orderNumber?: string) => void;
  onDelete: (id: number) => void;
  onOpen: (remito: Remito) => void;
  onPreviewOrder: (orderNumber: string) => void;
  isLoading: boolean;
}

function RemitoCard({ remito, onConfirm, onDelete, onOpen, onPreviewOrder, isLoading }: RemitoCardProps) {
  const [showOCR, setShowOCR] = useState(false);
  const [customOrder, setCustomOrder] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);

  // Check if there are multiple candidates
  const hasMultipleCandidates = remito.match_details?.candidates && remito.match_details.candidates.length > 1;

  const handleConfirm = () => {
    if (customOrder) {
      onConfirm(remito.id, customOrder);
    } else if (remito.suggested_order_number) {
      onConfirm(remito.id);
    }
  };

  // Determine the order number to confirm
  const orderToConfirm = customOrder || remito.suggested_order_number;

  return (
    <Card className="p-0 overflow-hidden flex flex-col">
      {/* Image preview - large and prominent */}
      <div
        className="relative h-72 md:h-80 bg-gray-100 cursor-pointer group"
        onClick={() => onOpen(remito)}
      >
        {remito.file_url && (
          <img
            src={remito.file_url}
            alt={remito.file_name || 'Remito'}
            className="w-full h-full object-contain bg-gray-50"
          />
        )}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
          <Maximize2 size={28} className="text-gray-700 opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-lg" />
        </div>
        <div className="absolute top-3 right-3">
          <StatusBadge status={remito.status} />
        </div>
      </div>

      {/* Content - organized by priority */}
      <div className="p-4 space-y-3 flex-1 flex flex-col">
        {/* 1. Detected name - most important */}
        {remito.detected_name && (
          <div className="text-base">
            <span className="font-semibold text-gray-900">{remito.detected_name}</span>
          </div>
        )}

        {/* Address if present */}
        {remito.detected_address && (
          <div className="text-sm text-gray-600">
            {remito.detected_address}
          </div>
        )}

        {/* 2. Match result - confirmed order */}
        {remito.status === 'confirmed' && remito.confirmed_order_number && (
          <div className="p-3 bg-emerald-100 rounded-lg border border-emerald-200">
            <button
              onClick={() => onPreviewOrder(remito.confirmed_order_number!)}
              className="text-base font-bold text-emerald-800 hover:text-emerald-900 hover:underline"
            >
              Pedido #{remito.confirmed_order_number}
            </button>
            {remito.order_customer_name && (
              <p className="text-sm text-emerald-700 mt-1">{remito.order_customer_name}</p>
            )}
            {remito.tracking_number && (
              <a
                href={`https://formularios.viacargo.com.ar/seguimiento-envio/${remito.tracking_number}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-block mt-2 text-xs font-mono text-blue-600 hover:text-blue-800 hover:underline"
              >
                Seguimiento: {remito.tracking_number} ↗
              </a>
            )}
          </div>
        )}

        {/* Delete button for confirmed remitos */}
        {remito.status === 'confirmed' && (
          <Button
            variant="secondary"
            onClick={() => onDelete(remito.id)}
            disabled={isLoading}
            className="w-full text-red-600 hover:bg-red-50 py-2 mt-2"
          >
            <Trash2 size={16} className="mr-2" />
            Eliminar
          </Button>
        )}

        {/* 2. Match result - multiple candidates */}
        {remito.status === 'ready' && remito.match_details?.candidates && remito.match_details.candidates.length > 1 && (
          <div className="p-3 bg-amber-50 rounded-lg border border-amber-200 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-amber-800">
                {remito.match_details.candidates.length} pedidos encontrados
              </p>
              {!showCustomInput && (
                <button
                  onClick={() => setShowCustomInput(true)}
                  className="text-xs text-amber-700 hover:text-amber-900 underline"
                >
                  Otro pedido
                </button>
              )}
            </div>
            <div className="space-y-1.5 max-h-36 overflow-y-auto">
              {remito.match_details.candidates.map((candidate) => (
                <div
                  key={candidate.orderNumber}
                  className={clsx(
                    'w-full p-2 rounded text-left transition-colors border text-sm',
                    customOrder === candidate.orderNumber
                      ? 'bg-emerald-100 border-emerald-400'
                      : 'bg-white border-gray-200'
                  )}
                >
                  <div className="flex items-center justify-between">
                    <button
                      onClick={() => onPreviewOrder(candidate.orderNumber)}
                      className="font-medium text-blue-600 hover:text-blue-800 hover:underline"
                    >
                      #{candidate.orderNumber}
                    </button>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">
                        {format(new Date(candidate.createdAt), "dd/MM", { locale: es })}
                      </span>
                      <button
                        onClick={() => setCustomOrder(candidate.orderNumber)}
                        className={clsx(
                          'text-xs px-2 py-0.5 rounded',
                          customOrder === candidate.orderNumber
                            ? 'bg-emerald-600 text-white'
                            : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
                        )}
                      >
                        {customOrder === candidate.orderNumber ? 'Seleccionado' : 'Seleccionar'}
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-gray-600 truncate">{candidate.customerName}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 2. Match result - single suggested match */}
        {remito.status !== 'confirmed' && remito.suggested_order_number && (!remito.match_details?.candidates || remito.match_details.candidates.length <= 1) && (
          <div className="p-3 bg-emerald-50 rounded-lg border border-emerald-200">
            <div className="flex items-center justify-between">
              <button
                onClick={() => onPreviewOrder(remito.suggested_order_number!)}
                className="text-base font-bold text-emerald-700 hover:text-emerald-900 hover:underline"
              >
                #{remito.suggested_order_number}
              </button>
              <MatchScoreBadge score={remito.match_score} />
            </div>
            {remito.order_customer_name && (
              <p className="text-sm text-emerald-600 mt-1">{remito.order_customer_name}</p>
            )}
            {remito.status === 'ready' && !showCustomInput && (
              <button
                onClick={() => setShowCustomInput(true)}
                className="text-xs text-emerald-700 hover:text-emerald-900 underline mt-2"
              >
                Cambiar pedido
              </button>
            )}
          </div>
        )}

        {/* No match found - con botón de asignación manual */}
        {remito.status === 'ready' && !remito.suggested_order_number && (
          <div className="p-3 bg-yellow-50 rounded-lg border border-yellow-200 space-y-2">
            <p className="text-sm font-medium text-yellow-700">Sin coincidencia encontrada</p>
            {!showCustomInput && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setShowCustomInput(true)}
                disabled={isLoading}
                className="w-full"
              >
                <Search size={16} className="mr-2" />
                Asignar pedido manualmente
              </Button>
            )}
          </div>
        )}

        {/* Error message */}
        {remito.status === 'error' && remito.error_message && (
          <div className="p-3 bg-red-50 rounded-lg border border-red-200">
            <p className="text-sm text-red-600">{remito.error_message}</p>
          </div>
        )}

        {/* Custom order input */}
        {showCustomInput && (
          <div className="flex gap-2">
            <input
              type="text"
              value={customOrder}
              onChange={(e) => setCustomOrder(e.target.value)}
              placeholder="Número de pedido"
              className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
              autoFocus
            />
            <button
              onClick={() => setShowCustomInput(false)}
              className="px-2 text-gray-500 hover:text-gray-700"
            >
              <X size={18} />
            </button>
          </div>
        )}

        {/* Spacer to push actions to bottom */}
        <div className="flex-1" />

        {/* 3. Actions - prominent confirm button */}
        {remito.status === 'ready' && (
          <div className="flex gap-2 pt-2">
            {(orderToConfirm || hasMultipleCandidates) && (
              <Button
                onClick={handleConfirm}
                disabled={isLoading || (hasMultipleCandidates && !customOrder)}
                className="flex-1 py-2.5"
              >
                <Check size={18} className="mr-2" />
                {hasMultipleCandidates && !customOrder
                  ? 'Seleccionar pedido'
                  : `Confirmar #${orderToConfirm}`}
              </Button>
            )}

            <Button
              variant="secondary"
              onClick={() => onDelete(remito.id)}
              disabled={isLoading}
              className="text-red-600 hover:bg-red-50 px-3"
              title="Eliminar remito"
            >
              <Trash2 size={18} />
            </Button>
          </div>
        )}

        {remito.status === 'error' && (
          <Button
            variant="secondary"
            onClick={() => onDelete(remito.id)}
            disabled={isLoading}
            className="w-full text-red-600 hover:bg-red-50 py-2.5"
          >
            <Trash2 size={18} className="mr-2" />
            Eliminar
          </Button>
        )}

        {/* Audit info: subido y aprobado, sin abrir el remito */}
        <div className="pt-2 border-t border-gray-100 space-y-0.5">
          <p className="text-xs text-gray-500">
            <span className="text-gray-400">Subido:</span> {format(new Date(remito.created_at), "dd/MM HH:mm", { locale: es })}
            {remito.uploaded_by_name && <span className="text-gray-600"> · {remito.uploaded_by_name}</span>}
          </p>
          {remito.confirmed_at && (
            <p className="text-xs text-emerald-700">
              <span className="text-emerald-600/70">Aprobado:</span> {format(new Date(remito.confirmed_at), "dd/MM HH:mm", { locale: es })}
              {remito.confirmed_by_name && <span> · {remito.confirmed_by_name}</span>}
            </p>
          )}
        </div>

        {/* OCR text toggle - less prominent, at the bottom */}
        <div className="flex items-center justify-end pt-2">
          {remito.ocr_text && (
            <button
              onClick={() => setShowOCR(!showOCR)}
              className="text-xs text-blue-600 hover:underline"
            >
              {showOCR ? 'Ocultar OCR' : 'Ver OCR'}
            </button>
          )}
        </div>
        {showOCR && remito.ocr_text && (
          <pre className="text-xs bg-gray-50 p-2 rounded max-h-32 overflow-auto whitespace-pre-wrap border">
            {remito.ocr_text}
          </pre>
        )}
      </div>
    </Card>
  );
}

// Modal para ver remito completo
function RemitoModal({
  remito,
  onClose,
  onConfirm,
  onDelete,
  onPreviewOrder,
  isLoading
}: {
  remito: Remito;
  onClose: () => void;
  onConfirm: (id: number, orderNumber?: string) => void;
  onDelete: (id: number) => void;
  onPreviewOrder: (orderNumber: string) => void;
  isLoading: boolean;
}) {
  const [customOrder, setCustomOrder] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [showLightbox, setShowLightbox] = useState(false);

  // Determinar si hay múltiples candidatos
  const hasMultipleCandidates = remito.match_details?.candidates && remito.match_details.candidates.length > 1;

  const handleConfirm = () => {
    // Si hay múltiples candidatos o input manual, usar customOrder
    if (customOrder) {
      onConfirm(remito.id, customOrder);
    } else if (remito.suggested_order_number) {
      onConfirm(remito.id);
    }
    onClose();
  };

  // Determinar qué número de pedido se va a confirmar
  const orderToConfirm = customOrder || remito.suggested_order_number;

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
            {/* Image - clickable to open lightbox */}
            <div
              className="bg-gray-100 rounded-lg overflow-hidden cursor-pointer group relative"
              onClick={() => setShowLightbox(true)}
            >
              {remito.file_url && (
                <>
                  <img
                    src={remito.file_url}
                    alt={remito.file_name || 'Remito'}
                    className="w-full h-auto max-h-[60vh] object-contain"
                  />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                    <div className="bg-black/50 text-white px-3 py-1.5 rounded-lg flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <ZoomIn size={16} />
                      <span className="text-sm">Ver en grande</span>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Details */}
            <div className="space-y-4">
              {/* Confirmed order info */}
              {remito.status === 'confirmed' && remito.confirmed_order_number && (
                <div className="p-3 bg-emerald-100 rounded-lg border border-emerald-200">
                  <div className="flex items-center justify-between">
                    <div>
                      <button
                        onClick={() => onPreviewOrder(remito.confirmed_order_number!)}
                        className="font-semibold text-emerald-800 hover:text-emerald-900 hover:underline"
                      >
                        Pedido #{remito.confirmed_order_number}
                      </button>
                      {remito.order_customer_name && (
                        <span className="text-emerald-700"> — {remito.order_customer_name}</span>
                      )}
                    </div>
                    <button
                      onClick={() => onPreviewOrder(remito.confirmed_order_number!)}
                      className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      <Eye size={14} />
                      Ver detalle
                    </button>
                  </div>
                </div>
              )}

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
                {remito.tracking_number && (
                  <p>
                    <span className="text-gray-500">Seguimiento:</span>{' '}
                    <a
                      href={`https://formularios.viacargo.com.ar/seguimiento-envio/${remito.tracking_number}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-blue-600 hover:text-blue-800 hover:underline"
                    >
                      {remito.tracking_number}
                    </a>
                  </p>
                )}
              </div>

              {/* Suggested match - multiple candidates */}
              {remito.status === 'ready' && remito.match_details?.candidates && remito.match_details.candidates.length > 1 && (
                <div className="p-3 bg-amber-50 rounded-lg border border-amber-200 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-amber-800">
                      {remito.match_details.candidates.length} pedidos encontrados para este cliente
                    </p>
                    {!showCustomInput && (
                      <button
                        onClick={() => setShowCustomInput(true)}
                        className="text-xs text-amber-700 hover:text-amber-900 underline"
                      >
                        Otro pedido
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-amber-600">Click en # para ver detalle, o selecciona el correcto:</p>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {remito.match_details.candidates.map((candidate) => (
                      <div
                        key={candidate.orderNumber}
                        className={clsx(
                          'w-full p-2 rounded-lg text-left transition-colors border',
                          customOrder === candidate.orderNumber
                            ? 'bg-emerald-100 border-emerald-400'
                            : 'bg-white border-gray-200'
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <button
                            onClick={() => onPreviewOrder(candidate.orderNumber)}
                            className="font-medium text-blue-600 hover:text-blue-800 hover:underline"
                          >
                            #{candidate.orderNumber}
                          </button>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-500">
                              {format(new Date(candidate.createdAt), "dd/MM", { locale: es })}
                            </span>
                            <button
                              onClick={() => setCustomOrder(candidate.orderNumber)}
                              className={clsx(
                                'text-xs px-2 py-0.5 rounded',
                                customOrder === candidate.orderNumber
                                  ? 'bg-emerald-600 text-white'
                                  : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
                              )}
                            >
                              {customOrder === candidate.orderNumber ? 'Seleccionado' : 'Seleccionar'}
                            </button>
                          </div>
                        </div>
                        <p className="text-sm text-gray-600">{candidate.customerName}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Suggested match - single candidate */}
              {remito.status === 'ready' && remito.suggested_order_number && (!remito.match_details?.candidates || remito.match_details.candidates.length <= 1) && (
                <div className="p-3 bg-emerald-50 rounded-lg">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-emerald-700">Pedido sugerido:</span>
                      <button
                        onClick={() => onPreviewOrder(remito.suggested_order_number!)}
                        className="font-medium text-emerald-700 hover:text-emerald-900 hover:underline"
                      >
                        #{remito.suggested_order_number}
                      </button>
                    </div>
                    <MatchScoreBadge score={remito.match_score} />
                  </div>
                  {remito.order_customer_name && (
                    <p className="text-sm text-emerald-600">{remito.order_customer_name}</p>
                  )}
                  {!showCustomInput && (
                    <button
                      onClick={() => setShowCustomInput(true)}
                      className="text-xs text-emerald-700 hover:text-emerald-900 underline mt-2"
                    >
                      Cambiar pedido
                    </button>
                  )}
                </div>
              )}

              {/* Input manual de N° pedido — se muestra cuando se activa
                  desde cualquier bloque (sugerencia única, múltiples candidatos
                  o sin match), para que el operador siempre pueda corregir. */}
              {remito.status === 'ready' && showCustomInput && (
                <div className="p-3 bg-blue-50 rounded-lg border border-blue-200 space-y-2">
                  <p className="text-sm text-blue-800">Asignar N° de pedido manualmente</p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={customOrder}
                      onChange={(e) => setCustomOrder(e.target.value)}
                      placeholder="Número de pedido"
                      className="flex-1 px-3 py-2 border rounded-lg bg-white"
                      autoFocus
                    />
                    <button
                      onClick={() => { setCustomOrder(''); setShowCustomInput(false); }}
                      className="px-3 py-2 text-gray-500 hover:bg-blue-100 rounded-lg"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}

              {/* No match - botón para abrir el input manual */}
              {remito.status === 'ready' && !remito.suggested_order_number && !showCustomInput && (
                <div className="p-3 bg-yellow-50 rounded-lg space-y-3">
                  <p className="text-yellow-700">Sin coincidencia encontrada</p>
                  <Button
                    variant="secondary"
                    onClick={() => setShowCustomInput(true)}
                    className="w-full"
                  >
                    <Search size={16} className="mr-2" />
                    Asignar pedido
                  </Button>
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
                onDelete(remito.id);
                onClose();
              }}
              disabled={isLoading}
              className="text-red-600"
            >
              <Trash2 size={16} className="mr-1" />
              Eliminar
            </Button>
            {orderToConfirm && (
              <Button onClick={handleConfirm} disabled={isLoading || (hasMultipleCandidates && !customOrder)}>
                <Check size={16} className="mr-1" />
                Confirmar #{orderToConfirm}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Fullscreen image lightbox */}
      {showLightbox && remito.file_url && (
        <ImageLightbox
          src={remito.file_url}
          alt={remito.file_name || 'Remito'}
          onClose={() => setShowLightbox(false)}
        />
      )}
    </div>
  );
}

export function ShippingDocuments() {
  const { hasPermission } = useAuth();
  const [remitos, setRemitos] = useState<Remito[]>([]);
  const [stats, setStats] = useState<RemitosStats | null>(null);
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);

  // Filtros persistidos en URL
  const { filters, setFilter, setFilters } = useUrlFilters({
    status: 'all' as RemitoStatus | 'all',
    search: '' as string,
    dateFrom: '' as string,
    dateTo: '' as string,
    page: 1,
  });
  const statusFilter = filters.status;
  const page = filters.page;
  const search = filters.search;
  const dateFrom = filters.dateFrom;
  const dateTo = filters.dateTo;
  // Debounce del search para no disparar request por cada tecla.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedRemito, setSelectedRemito] = useState<Remito | null>(null);
  const [previewOrderNumber, setPreviewOrderNumber] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePreviewOrder = (orderNumber: string) => {
    setPreviewOrderNumber(orderNumber);
  };

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [remitosRes, statsRes] = await Promise.all([
        fetchRemitos(page, 50, {
          status: statusFilter === 'all' ? undefined : statusFilter,
          search: debouncedSearch || undefined,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
        }),
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
  }, [page, statusFilter, debouncedSearch, dateFrom, dateTo]);

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

    // El backend acepta hasta 200 por batch. Multer falla con "Unexpected field"
    // en el archivo 201, lo que termina como 500 sin mensaje útil — mejor avisar acá.
    if (files.length > 200) {
      setError(`Seleccionaste ${files.length} archivos. El máximo por subida es 200. Subilos en tandas.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

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

  const handleDelete = async (id: number) => {
    if (!confirm('¿Eliminar este remito?')) {
      return;
    }
    try {
      setActionLoading(id);
      await deleteRemito(id);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al eliminar');
    } finally {
      setActionLoading(null);
    }
  };

  // Check permission to view this page
  const canView = hasPermission('remitos.view') || hasPermission('remitos.upload') ||
                  hasPermission('remitos.confirm') || hasPermission('remitos.reject');

  if (!canView) {
    return <AccessDenied message="No tenés permiso para acceder a la sección de Remitos." />;
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <Header title="Remitos" />

      <main className="p-4 md:p-6 max-w-7xl mx-auto">
        {/* Actions bar */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          {/* Status filter */}
          <div className="flex gap-1 flex-wrap">
            {statusFilters.map((filter) => (
              <button
                key={filter.value}
                onClick={() => setFilters({ status: filter.value, page: 1 })}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-sm transition-colors',
                  statusFilter === filter.value
                    ? 'bg-neutral-900 text-white'
                    : 'bg-white text-neutral-600 hover:bg-neutral-100'
                )}
              >
                {filter.label}
                {stats && filter.value !== 'all' && (
                  <span className="ml-1.5 text-xs opacity-70">
                    ({stats[filter.value as keyof RemitosStats] || 0})
                  </span>
                )}
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

        {/* Search + date filters */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setFilters({ search: e.target.value, page: 1 })}
              placeholder="Buscar por N° de pedido o nombre…"
              className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-900"
            />
          </div>
          <div className="flex items-center gap-1.5 text-sm">
            <span className="text-neutral-500">Desde</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setFilters({ dateFrom: e.target.value, page: 1 })}
              className="px-2 py-2 bg-white border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-900"
            />
            <span className="text-neutral-500">Hasta</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setFilters({ dateTo: e.target.value, page: 1 })}
              className="px-2 py-2 bg-white border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-900"
            />
            {(search || dateFrom || dateTo) && (
              <button
                onClick={() => setFilters({ search: '', dateFrom: '', dateTo: '', page: 1 })}
                className="text-xs text-neutral-500 hover:text-neutral-900 underline ml-2"
              >
                Limpiar
              </button>
            )}
          </div>
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
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 transition-opacity duration-300">
            {[...Array(4)].map((_, i) => (
              <RemitoCardSkeleton key={i} />
            ))}
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
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 animate-fadeIn">
            {remitos.map((remito) => (
              <RemitoCard
                key={remito.id}
                remito={remito}
                onConfirm={handleConfirm}
                onDelete={handleDelete}
                onOpen={setSelectedRemito}
                onPreviewOrder={handlePreviewOrder}
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
              onClick={() => { setFilter('page', Math.max(1, page - 1)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
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
              onClick={() => { setFilter('page', Math.min(pagination.totalPages, page + 1)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
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
          onDelete={handleDelete}
          onPreviewOrder={handlePreviewOrder}
          isLoading={actionLoading === selectedRemito.id}
        />
      )}

      {/* Order preview drawer */}
      {previewOrderNumber && (
        <OrderDrawer
          orderNumber={previewOrderNumber}
          onClose={() => setPreviewOrderNumber(null)}
        />
      )}
    </div>
  );
}
