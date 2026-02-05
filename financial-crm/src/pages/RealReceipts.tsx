import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, AlertCircle, Eye, Banknote, FileText, Download, Calendar, CheckSquare, Square, X, Search } from 'lucide-react';
import { Header } from '../components/layout';
import { Button, Card } from '../components/ui';
import { fetchComprobantes, ApiComprobanteList } from '../services/api';
import { formatDistanceToNow, format, isToday, isSameDay, parseISO } from 'date-fns';
import { es } from 'date-fns/locale';
import { clsx } from 'clsx';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

async function downloadComprobantesAsZip(
  comprobantes: ApiComprobanteList[],
  setDownloading: (v: boolean) => void,
  folderName: string = 'comprobantes'
) {
  const conImagen = comprobantes.filter(c => c.file_url);

  if (conImagen.length === 0) {
    alert('No hay comprobantes con imagen para descargar');
    return;
  }

  setDownloading(true);

  try {
    const zip = new JSZip();
    const folder = zip.folder(folderName);

    const downloadPromises = conImagen.map(async (comp) => {
      if (!comp.file_url) return;

      try {
        const response = await fetch(comp.file_url);
        if (!response.ok) return;

        const blob = await response.blob();
        const contentType = response.headers.get('content-type') || '';
        let extension = 'jpg';
        if (contentType.includes('png')) extension = 'png';
        else if (contentType.includes('webp')) extension = 'webp';

        const fileName = `pedido_${comp.order_number}_comp${comp.id}_$${comp.monto}.${extension}`;
        folder?.file(fileName, blob);
      } catch (err) {
        console.error(`Error descargando imagen ${comp.id}:`, err);
      }
    });

    await Promise.all(downloadPromises);

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    saveAs(zipBlob, `${folderName}_${format(new Date(), 'yyyy-MM-dd_HH-mm')}.zip`);
  } catch (err) {
    console.error('Error creando ZIP:', err);
    alert('Error al crear el archivo ZIP');
  } finally {
    setDownloading(false);
  }
}

// Estados del comprobante (no del pedido)
type ComprobanteEstado = 'a_confirmar' | 'confirmado' | 'rechazado';

const estadoButtons: { value: ComprobanteEstado | 'all'; label: string; color: string }[] = [
  { value: 'all', label: 'Todos', color: 'bg-neutral-100 text-neutral-700' },
  { value: 'a_confirmar', label: 'A confirmar', color: 'bg-blue-50 text-blue-700' },
  { value: 'confirmado', label: 'Confirmado', color: 'bg-emerald-50 text-emerald-700' },
  { value: 'rechazado', label: 'Rechazado', color: 'bg-red-50 text-red-700' },
];

// Mapear estado del comprobante (para datos viejos que tienen 'pendiente')
function mapComprobanteEstado(estado: string | null): ComprobanteEstado {
  if (!estado || estado === 'pendiente') return 'a_confirmar';
  if (estado === 'confirmado') return 'confirmado';
  if (estado === 'rechazado') return 'rechazado';
  return 'a_confirmar';
}

function EstadoBadge({ estado }: { estado: string | null }) {
  const mappedEstado = mapComprobanteEstado(estado);

  const estadoMap: Record<ComprobanteEstado, { label: string; className: string }> = {
    a_confirmar: { label: 'A confirmar', className: 'bg-blue-50 text-blue-700' },
    confirmado: { label: 'Confirmado', className: 'bg-emerald-50 text-emerald-700' },
    rechazado: { label: 'Rechazado', className: 'bg-red-50 text-red-700' },
  };

  const info = estadoMap[mappedEstado];

  return (
    <span className={clsx('px-2 py-0.5 rounded-full text-xs font-medium', info.className)}>
      {info.label}
    </span>
  );
}

interface ComprobanteCardProps {
  comp: ApiComprobanteList;
  onClick: () => void;
  selectionMode: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
}

function ComprobanteCard({ comp, onClick, selectionMode, isSelected, onToggleSelect }: ComprobanteCardProps) {
  const handleClick = () => {
    if (selectionMode) {
      onToggleSelect();
    } else {
      onClick();
    }
  };

  return (
    <div
      className={clsx(
        'group relative bg-white rounded-2xl border overflow-hidden',
        'hover:shadow-medium transition-all duration-200 cursor-pointer',
        isSelected
          ? 'border-blue-500 ring-2 ring-blue-500/20'
          : 'border-neutral-200/60 hover:border-neutral-300/60'
      )}
      onClick={handleClick}
    >
      {/* Checkbox de selección */}
      {selectionMode && (
        <div className="absolute top-3 left-3 z-10">
          <div className={clsx(
            'w-6 h-6 rounded-md flex items-center justify-center transition-colors',
            isSelected
              ? 'bg-blue-500 text-white'
              : 'bg-white/90 border border-neutral-300 text-transparent hover:border-blue-400'
          )}>
            {isSelected ? <CheckSquare size={16} /> : <Square size={16} />}
          </div>
        </div>
      )}

      <div className="aspect-[3/4] bg-neutral-100 relative overflow-hidden">
        {comp.file_url ? (
          <img
            src={comp.file_url}
            alt="Comprobante"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            {comp.tipo === 'efectivo' ? (
              <Banknote size={48} className="text-neutral-300" />
            ) : (
              <FileText size={48} className="text-neutral-300" />
            )}
          </div>
        )}
        {!selectionMode && (
          <>
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
            <div className="absolute bottom-3 left-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Eye size={14} />}
                className="w-full bg-white/90 backdrop-blur-sm"
              >
                Ver Detalle
              </Button>
            </div>
          </>
        )}
        {comp.tipo === 'efectivo' && (
          <div className="absolute top-3 right-3">
            <div className="flex items-center gap-1 px-2 py-1 bg-green-500 text-white rounded-lg text-xs font-medium">
              <Banknote size={12} />
              Efectivo
            </div>
          </div>
        )}
      </div>
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-neutral-900">
            #{comp.id}
          </span>
          <EstadoBadge estado={comp.estado} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-neutral-500">
            {formatDistanceToNow(new Date(comp.created_at), { addSuffix: true, locale: es })}
          </span>
          <span className="text-xs font-mono text-neutral-400">
            #{comp.order_number}
          </span>
        </div>
      </div>
    </div>
  );
}

export function RealReceipts() {
  const navigate = useNavigate();
  const [comprobantes, setComprobantes] = useState<ApiComprobanteList[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [estadoFilter, setEstadoFilter] = useState<ComprobanteEstado | 'all'>('all');
  const [fechaFilter, setFechaFilter] = useState<'all' | 'hoy' | 'custom'>('all');
  const [customDate, setCustomDate] = useState<string>('');
  const [downloading, setDownloading] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');

  const loadComprobantes = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchComprobantes();
      setComprobantes(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar comprobantes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadComprobantes();
  }, []);

  const filteredComprobantes = useMemo(() => {
    return comprobantes.filter((comp) => {
      // Mapear estado del comprobante (pendiente → a_confirmar para datos viejos)
      const compEstado = mapComprobanteEstado(comp.estado);
      const matchesEstado = estadoFilter === 'all' || compEstado === estadoFilter;
      let matchesFecha = true;
      if (fechaFilter === 'hoy') {
        matchesFecha = isToday(new Date(comp.created_at));
      } else if (fechaFilter === 'custom' && customDate) {
        matchesFecha = isSameDay(new Date(comp.created_at), parseISO(customDate));
      }

      // Búsqueda por número de pedido, ID de comprobante o nombre de cliente
      const query = searchQuery.toLowerCase().trim();
      const matchesSearch = !query ||
        comp.order_number?.toLowerCase().includes(query) ||
        comp.id.toString().includes(query) ||
        (comp.customer_name?.toLowerCase().includes(query));

      return matchesEstado && matchesFecha && matchesSearch;
    });
  }, [comprobantes, estadoFilter, fechaFilter, customDate, searchQuery]);

  const estadoCounts = useMemo(() => {
    let filtered = comprobantes;
    if (fechaFilter === 'hoy') {
      filtered = comprobantes.filter(c => isToday(new Date(c.created_at)));
    } else if (fechaFilter === 'custom' && customDate) {
      filtered = comprobantes.filter(c => isSameDay(new Date(c.created_at), parseISO(customDate)));
    }

    return filtered.reduce(
      (acc, comp) => {
        const estado = mapComprobanteEstado(comp.estado);
        acc[estado] = (acc[estado] || 0) + 1;
        acc.total += 1;
        return acc;
      },
      { total: 0 } as Record<string, number>
    );
  }, [comprobantes, fechaFilter, customDate]);

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const selectAllVisible = () => {
    const visibleIds = filteredComprobantes.filter(c => c.file_url).map(c => c.id);
    setSelectedIds(new Set(visibleIds));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectionMode(false);
  };

  const downloadSelected = () => {
    const selected = filteredComprobantes.filter(c => selectedIds.has(c.id));
    downloadComprobantesAsZip(selected, setDownloading, 'comprobantes_seleccionados');
  };

  const downloadPending = () => {
    const pendientes = filteredComprobantes.filter(c =>
      (c.estado === 'pendiente' || c.estado === 'a_confirmar') && c.file_url
    );
    downloadComprobantesAsZip(pendientes, setDownloading, 'comprobantes_pendientes');
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Comprobantes"
        subtitle={`${estadoCounts.total} comprobantes · ${estadoCounts.a_confirmar || 0} a confirmar`}
        actions={
          <div className="flex items-center gap-2">
            {selectionMode ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={selectAllVisible}
                >
                  Seleccionar todos
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<Download size={16} className={downloading ? 'animate-bounce' : ''} />}
                  onClick={downloadSelected}
                  disabled={loading || downloading || selectedIds.size === 0}
                >
                  {downloading ? 'Descargando...' : `Descargar (${selectedIds.size})`}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<X size={16} />}
                  onClick={clearSelection}
                >
                  Cancelar
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="secondary"
                  onClick={() => setSelectionMode(true)}
                  leftIcon={<CheckSquare size={16} />}
                >
                  Seleccionar
                </Button>
                <Button
                  variant="secondary"
                  leftIcon={<Download size={16} className={downloading ? 'animate-bounce' : ''} />}
                  onClick={downloadPending}
                  disabled={loading || downloading || (estadoCounts.a_confirmar || 0) === 0}
                >
                  {downloading ? 'Descargando...' : `Pendientes (${estadoCounts.a_confirmar || 0})`}
                </Button>
                <Button
                  variant="secondary"
                  leftIcon={<RefreshCw size={16} className={loading ? 'animate-spin' : ''} />}
                  onClick={loadComprobantes}
                  disabled={loading}
                >
                  Actualizar
                </Button>
              </>
            )}
          </div>
        }
      />

      <div className="p-6 space-y-6">
        {/* Búsqueda y Filtros */}
        <div className="space-y-4">
          {/* Barra de búsqueda */}
          <div className="relative">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              placeholder="Buscar por número de pedido, ID o cliente..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-neutral-200 bg-white text-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900/10 focus:border-neutral-300 transition-all"
            />
          </div>

          {/* Filtro de fecha */}
          <div>
            <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2 block">Fecha</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setFechaFilter('all')}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap',
                  fechaFilter === 'all'
                    ? 'bg-neutral-100 text-neutral-700 ring-2 ring-neutral-900/10'
                    : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                )}
              >
                Todos
              </button>
              <button
                onClick={() => setFechaFilter('hoy')}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap flex items-center gap-1.5',
                  fechaFilter === 'hoy'
                    ? 'bg-blue-50 text-blue-700 ring-2 ring-blue-900/10'
                    : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                )}
              >
                <Calendar size={14} />
                Hoy
              </button>
              <div className="relative">
                <input
                  type="date"
                  value={customDate}
                  onChange={(e) => {
                    setCustomDate(e.target.value);
                    if (e.target.value) {
                      setFechaFilter('custom');
                    }
                  }}
                  className={clsx(
                    'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150',
                    fechaFilter === 'custom' && customDate
                      ? 'bg-purple-50 text-purple-700 ring-2 ring-purple-900/10 border-transparent'
                      : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                  )}
                />
              </div>
            </div>
          </div>

          {/* Filtro de estado del comprobante */}
          <div>
            <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2 block">Estado</span>
            <div className="flex items-center gap-2 overflow-x-auto pb-2 sm:pb-0">
              {estadoButtons.map((btn) => (
                <button
                  key={btn.value}
                  onClick={() => setEstadoFilter(btn.value)}
                  className={clsx(
                    'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap',
                    estadoFilter === btn.value
                      ? clsx(btn.color, 'ring-2 ring-neutral-900/10')
                      : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                  )}
                >
                  {btn.label}
                </button>
              ))}
            </div>
          </div>

          </div>

        {/* Grid de comprobantes */}
        {loading && comprobantes.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <RefreshCw size={32} className="animate-spin text-neutral-400" />
          </div>
        ) : error ? (
          <Card className="text-center py-8">
            <AlertCircle size={48} className="mx-auto text-red-400 mb-4" />
            <h3 className="text-lg font-semibold text-neutral-900 mb-2">Error al cargar comprobantes</h3>
            <p className="text-neutral-500 mb-4">{error}</p>
            <Button onClick={loadComprobantes}>Reintentar</Button>
          </Card>
        ) : filteredComprobantes.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-neutral-400 mb-2">No se encontraron comprobantes</div>
            <p className="text-sm text-neutral-500">
              Intentá ajustar los filtros
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {filteredComprobantes.map((comp) => (
              <ComprobanteCard
                key={comp.id}
                comp={comp}
                onClick={() => navigate(`/receipts/${comp.id}`)}
                selectionMode={selectionMode}
                isSelected={selectedIds.has(comp.id)}
                onToggleSelect={() => toggleSelect(comp.id)}
              />
            ))}
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-sm text-neutral-500">
            Mostrando {filteredComprobantes.length} de {comprobantes.length} comprobantes
          </span>
        </div>
      </div>
    </div>
  );
}
