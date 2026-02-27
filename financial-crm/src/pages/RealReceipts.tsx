import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, AlertCircle, Eye, Banknote, FileText, Download, Calendar, CheckSquare, Square, X, Search, ChevronLeft, ChevronRight, Building2 } from 'lucide-react';
import { Header } from '../components/layout';
import { Button, Card } from '../components/ui';
import { fetchComprobantes, fetchFinancieras, ApiComprobanteList, PaginationInfo, Financiera, ComprobantesFilters } from '../services/api';
import { formatDistanceToNow, format } from 'date-fns';
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
        {comp.financiera_nombre && (
          <div className="mt-2 pt-2 border-t border-neutral-100">
            <span className="text-[10px] uppercase tracking-wider text-neutral-400">
              {comp.financiera_nombre}
            </span>
          </div>
        )}
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
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 48; // Divisible by 2,3,4,6 columns - avoids incomplete last row

  // Filtros (con refs para polling)
  const [financieras, setFinancieras] = useState<Financiera[]>([]);
  const [financieraFilter, setFinancieraFilter] = useState<number | null>(null);
  const financieraFilterRef = useRef<number | null>(null);
  const estadoFilterRef = useRef<ComprobanteEstado | 'all'>('all');
  const fechaFilterRef = useRef<'all' | 'hoy' | 'custom'>('all');
  const customDateRef = useRef<string>('');

  // Calcular valor de fecha para enviar al servidor
  const getFechaParam = (): string | null => {
    const fecha = fechaFilterRef.current;
    if (fecha === 'hoy') return 'hoy';
    if (fecha === 'custom' && customDateRef.current) return customDateRef.current;
    return null;
  };

  const loadComprobantes = async (page?: number, filters?: Partial<ComprobantesFilters>) => {
    const pageToLoad = page ?? currentPage;
    const currentFilters: ComprobantesFilters = {
      financieraId: filters?.financieraId !== undefined ? filters.financieraId : financieraFilterRef.current,
      estado: filters?.estado !== undefined ? filters.estado : (estadoFilterRef.current === 'all' ? null : estadoFilterRef.current),
      fecha: filters?.fecha !== undefined ? filters.fecha : getFechaParam(),
    };

    setLoading(true);
    setError(null);
    try {
      const response = await fetchComprobantes(pageToLoad, ITEMS_PER_PAGE, currentFilters);
      setComprobantes(response.data);
      setPagination(response.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar comprobantes');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = () => loadComprobantes();

  const goToPage = (page: number) => {
    setCurrentPage(page);
    setSelectedIds(new Set()); // Reset selección al cambiar página
    loadComprobantes(page);
    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleEstadoChange = (estado: ComprobanteEstado | 'all') => {
    setEstadoFilter(estado);
    estadoFilterRef.current = estado;
    setCurrentPage(1);
    setSelectedIds(new Set());
    loadComprobantes(1, { estado: estado === 'all' ? null : estado });
  };

  const handleFinancieraChange = (id: number | null) => {
    setFinancieraFilter(id);
    financieraFilterRef.current = id;
    setCurrentPage(1);
    setSelectedIds(new Set());
    loadComprobantes(1, { financieraId: id });
  };

  const handleFechaChange = (fecha: 'all' | 'hoy' | 'custom', customValue?: string) => {
    setFechaFilter(fecha);
    fechaFilterRef.current = fecha;
    if (customValue !== undefined) {
      setCustomDate(customValue);
      customDateRef.current = customValue;
    }
    setCurrentPage(1);
    setSelectedIds(new Set());
    // Calcular valor para server
    let fechaParam: string | null = null;
    if (fecha === 'hoy') fechaParam = 'hoy';
    if (fecha === 'custom' && (customValue || customDateRef.current)) {
      fechaParam = customValue || customDateRef.current;
    }
    loadComprobantes(1, { fecha: fechaParam });
  };

  // Cargar financieras al montar
  useEffect(() => {
    fetchFinancieras().then(setFinancieras).catch(console.error);
  }, []);

  // Ref para guardar la función loadComprobantes actualizada (evita stale closures)
  const loadComprobantesRef = useRef(loadComprobantes);
  useEffect(() => {
    loadComprobantesRef.current = loadComprobantes;
  });

  // Carga inicial
  useEffect(() => {
    loadComprobantes();
  }, []);

  // Refetch al volver a la pestaña (sin polling para evitar sync issues)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Usar ref para siempre tener la función actualizada
        loadComprobantesRef.current();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []); // Sin dependencias - el ref siempre tiene la función actual

  // Filtros client-side: solo búsqueda (fecha y estado ya se filtran server-side)
  const filteredComprobantes = useMemo(() => {
    return comprobantes.filter((comp) => {
      // Búsqueda por número de pedido, ID de comprobante o nombre de cliente
      const query = searchQuery.toLowerCase().trim();
      const matchesSearch = !query ||
        comp.order_number?.toLowerCase().includes(query) ||
        comp.id.toString().includes(query) ||
        (comp.customer_name?.toLowerCase().includes(query));

      return matchesSearch;
    });
  }, [comprobantes, searchQuery]);

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
    // Descargar todos los comprobantes visibles con imagen
    const conImagen = filteredComprobantes.filter(c => c.file_url);
    const folderName = estadoFilter !== 'all' ? `comprobantes_${estadoFilter}` : 'comprobantes';
    downloadComprobantesAsZip(conImagen, setDownloading, folderName);
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Comprobantes"
        subtitle={pagination ? `${pagination.total} comprobantes${estadoFilter !== 'all' ? ` (${estadoFilter === 'a_confirmar' ? 'a confirmar' : estadoFilter})` : ''}` : 'Cargando...'}
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
                  disabled={loading || downloading || filteredComprobantes.length === 0}
                >
                  {downloading ? 'Descargando...' : `Descargar visible (${filteredComprobantes.filter(c => c.file_url).length})`}
                </Button>
                <Button
                  variant="secondary"
                  leftIcon={<RefreshCw size={16} className={loading ? 'animate-spin' : ''} />}
                  onClick={handleRefresh}
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

          {/* Filtro de fecha (server-side) */}
          <div>
            <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2 block">Fecha</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleFechaChange('all')}
                disabled={loading}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap',
                  fechaFilter === 'all'
                    ? 'bg-neutral-100 text-neutral-700 ring-2 ring-neutral-900/10'
                    : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200',
                  loading && 'opacity-50 cursor-not-allowed'
                )}
              >
                Todos
              </button>
              <button
                onClick={() => handleFechaChange('hoy')}
                disabled={loading}
                className={clsx(
                  'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap flex items-center gap-1.5',
                  fechaFilter === 'hoy'
                    ? 'bg-blue-50 text-blue-700 ring-2 ring-blue-900/10'
                    : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200',
                  loading && 'opacity-50 cursor-not-allowed'
                )}
              >
                <Calendar size={14} />
                Hoy
              </button>
              <div className="relative">
                <input
                  type="date"
                  value={customDate}
                  disabled={loading}
                  onChange={(e) => {
                    if (e.target.value) {
                      handleFechaChange('custom', e.target.value);
                    } else {
                      // Limpiar fecha → volver a "Todos"
                      handleFechaChange('all');
                    }
                  }}
                  className={clsx(
                    'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150',
                    fechaFilter === 'custom' && customDate
                      ? 'bg-purple-50 text-purple-700 ring-2 ring-purple-900/10 border-transparent'
                      : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200',
                    loading && 'opacity-50 cursor-not-allowed'
                  )}
                />
              </div>
            </div>
          </div>

          {/* Filtro de estado del comprobante (server-side) */}
          <div>
            <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2 block">Estado</span>
            <div className="flex items-center gap-2 overflow-x-auto pb-2 sm:pb-0">
              {estadoButtons.map((btn) => (
                <button
                  key={btn.value}
                  onClick={() => handleEstadoChange(btn.value)}
                  disabled={loading}
                  className={clsx(
                    'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap',
                    estadoFilter === btn.value
                      ? clsx(btn.color, 'ring-2 ring-neutral-900/10')
                      : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200',
                    loading && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  {btn.label}
                </button>
              ))}
            </div>
          </div>

          {/* Filtro por financiera */}
          {financieras.length > 0 && (
            <div>
              <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2 block">Financiera</span>
              <div className="flex items-center gap-2 overflow-x-auto pb-2 sm:pb-0">
                <button
                  onClick={() => handleFinancieraChange(null)}
                  className={clsx(
                    'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap flex items-center gap-1.5',
                    financieraFilter === null
                      ? 'bg-neutral-100 text-neutral-700 ring-2 ring-neutral-900/10'
                      : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                  )}
                >
                  Todas
                </button>
                {financieras.filter(f => f.activa).map((fin) => (
                  <button
                    key={fin.id}
                    onClick={() => handleFinancieraChange(fin.id)}
                    className={clsx(
                      'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap flex items-center gap-1.5',
                      financieraFilter === fin.id
                        ? 'bg-violet-50 text-violet-700 ring-2 ring-violet-900/10'
                        : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                    )}
                  >
                    <Building2 size={14} />
                    {fin.nombre}
                  </button>
                ))}
              </div>
            </div>
          )}

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
            <Button onClick={handleRefresh}>Reintentar</Button>
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

        {/* Paginación */}
        {pagination && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-neutral-500">
              {/* Si hay filtros client-side activos, mostrar cuántos se filtran */}
              {filteredComprobantes.length !== comprobantes.length ? (
                <>Mostrando {filteredComprobantes.length} de {comprobantes.length} en página (total: {pagination.total})</>
              ) : (
                <>Mostrando {comprobantes.length} de {pagination.total} (página {pagination.page} de {pagination.totalPages})</>
              )}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1 || loading}
                leftIcon={<ChevronLeft size={16} />}
              >
                Anterior
              </Button>
              <div className="flex items-center gap-1">
                {Array.from({ length: Math.min(5, pagination.totalPages) }, (_, i) => {
                  let pageNum: number;
                  if (pagination.totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (currentPage <= 3) {
                    pageNum = i + 1;
                  } else if (currentPage >= pagination.totalPages - 2) {
                    pageNum = pagination.totalPages - 4 + i;
                  } else {
                    pageNum = currentPage - 2 + i;
                  }
                  return (
                    <button
                      key={pageNum}
                      onClick={() => goToPage(pageNum)}
                      disabled={loading}
                      className={clsx(
                        'w-8 h-8 rounded-lg text-sm font-medium transition-colors',
                        pageNum === currentPage
                          ? 'bg-neutral-900 text-white'
                          : 'bg-white text-neutral-600 hover:bg-neutral-100 border border-neutral-200'
                      )}
                    >
                      {pageNum}
                    </button>
                  );
                })}
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage >= pagination.totalPages || loading}
                rightIcon={<ChevronRight size={16} />}
              >
                Siguiente
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
