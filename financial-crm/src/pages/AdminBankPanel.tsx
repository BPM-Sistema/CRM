import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUrlFilters } from '../hooks';
import {
  ArrowLeft, Upload, RefreshCw, Search, Calendar, Filter,
  ChevronLeft, ChevronRight, FileText, Eye, CheckCircle2,
  AlertCircle, Clock, X, ChevronDown
} from 'lucide-react';
import { Header } from '../components/layout';
import { Button, Badge, Modal } from '../components/ui';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../components/ui/Table';
import { AccessDenied } from '../components/AccessDenied';
import { useAuth } from '../contexts/AuthContext';
import {
  fetchBankMovements, fetchBankMovementDetail, fetchBankImports,
  bankImportPreview, bankImportApply,
  BankMovement, BankMovementDetail, BankImport,
  BankImportPreviewResult, BankImportApplyResult, BankMovementsFilters
} from '../services/api';
import { format } from 'date-fns';
import { clsx } from 'clsx';

const STATUS_CONFIG: Record<string, { label: string; variant: 'success' | 'warning' | 'danger' | 'info' | 'default' | 'purple' }> = {
  assigned: { label: 'Asignado', variant: 'success' },
  unassigned: { label: 'Sin asignar', variant: 'warning' },
  review: { label: 'Asignado', variant: 'success' },
  duplicate: { label: 'Duplicado', variant: 'danger' },
};

export function AdminBankPanel() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { filters, setFilter, setFilters } = useUrlFilters({
    fecha: 'all',
    assignment_status: 'all',
    search: '',
    page: 1,
  });

  // Movements list
  const [movements, setMovements] = useState<BankMovement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<{ page: number; total: number; pages: number; limit: number } | null>(null);
  const [stats, setStats] = useState<Record<string, string>>({});

  // Detail modal
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<BankMovementDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Import
  const [showImport, setShowImport] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importData, setImportData] = useState<unknown[] | null>(null);
  const [importPreview, setImportPreview] = useState<BankImportPreviewResult | null>(null);
  const [importResult, setImportResult] = useState<BankImportApplyResult | null>(null);
  const [importProcessing, setImportProcessing] = useState(false);
  const [importApplying, setImportApplying] = useState(false);

  // Imports history
  const [showHistory, setShowHistory] = useState(false);
  const [imports, setImports] = useState<BankImport[]>([]);
  const [importsLoading, setImportsLoading] = useState(false);

  // Search debounce
  const [searchInput, setSearchInput] = useState(String(filters.search || ''));

  const currentPage = Number(filters.page) || 1;
  const fechaFilter = String(filters.fecha || 'all');
  const statusFilter = String(filters.assignment_status || 'all');

  const loadMovements = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const apiFilters: BankMovementsFilters = {};
      if (fechaFilter !== 'all') apiFilters.fecha = fechaFilter;
      if (statusFilter !== 'all') apiFilters.assignment_status = statusFilter;
      if (filters.search) apiFilters.search = String(filters.search);

      const res = await fetchBankMovements(currentPage, 50, apiFilters);
      setMovements(res.data);
      setPagination(res.pagination);
      setStats(res.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, [currentPage, fechaFilter, statusFilter, filters.search]);

  useEffect(() => {
    loadMovements();
  }, [loadMovements]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput !== String(filters.search || '')) {
        setFilters({ search: searchInput, page: 1 });
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Load detail
  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    fetchBankMovementDetail(selectedId)
      .then(res => setDetail(res.data))
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  }, [selectedId]);

  // File handling
  const handleFileSelect = async (file: File) => {
    setImportFile(file);
    setImportPreview(null);
    setImportResult(null);
    setImportProcessing(true);

    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const movimientos = Array.isArray(json) ? json : json.movimientos || json.data || [];
      setImportData(movimientos);

      const preview = await bankImportPreview(movimientos, file.name);
      setImportPreview(preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al leer archivo');
    } finally {
      setImportProcessing(false);
    }
  };

  const handleApplyImport = async () => {
    if (!importData) return;
    setImportApplying(true);
    try {
      const result = await bankImportApply(importData, importFile?.name);
      setImportResult(result);
      setImportPreview(null);
      loadMovements();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al importar');
    } finally {
      setImportApplying(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.json')) handleFileSelect(file);
  };

  const loadImports = async () => {
    setImportsLoading(true);
    try {
      const res = await fetchBankImports(1, 50);
      setImports(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setImportsLoading(false);
    }
  };

  // Permissions
  if (!hasPermission('bank.view') && !hasPermission('receipts.confirm')) {
    return <AccessDenied message="No tenes permiso para acceder al panel bancario." />;
  }

  const formatCurrency = (amount: number) =>
    `$${Number(amount).toLocaleString('es-AR')}`;

  const formatDate = (dateStr: string) => {
    try {
      return format(new Date(dateStr), 'dd/MM/yyyy HH:mm');
    } catch {
      return dateStr;
    }
  };

  const formatDateShort = (dateStr: string) => {
    try {
      return format(new Date(dateStr), 'dd/MM/yyyy');
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Admin Banco"
        subtitle={pagination ? `${pagination.total} movimientos bancarios${stats.last_import_at ? ` · Última actualización: ${new Date(stats.last_import_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}` : 'Cargando...'}
        actions={
          <div className="flex items-center gap-2">
            {stats.unassigned_count && parseInt(stats.unassigned_count) > 0 && (
              <div className="px-3 py-1.5 bg-amber-500 text-white rounded-lg text-sm font-medium">
                {parseInt(stats.unassigned_count)} sin asignar ({formatCurrency(Number(stats.unassigned_total || 0))})
              </div>
            )}
            <Button
              variant="secondary"
              leftIcon={<Clock size={16} />}
              onClick={() => { setShowHistory(true); loadImports(); }}
            >
              Historial
            </Button>
<Button
              variant="secondary"
              leftIcon={<RefreshCw size={16} className={loading ? 'animate-spin' : ''} />}
              onClick={loadMovements}
              disabled={loading}
            >
              Actualizar
            </Button>
            <Button
              variant="secondary"
              leftIcon={<ArrowLeft size={16} />}
              onClick={() => navigate('/receipts')}
            >
              Comprobantes
            </Button>
          </div>
        }
      />

      <div className="p-6 space-y-4">
        {/* Filters */}
        <div className="bg-white rounded-xl border border-neutral-200/60 p-4">
          <div className="flex flex-wrap items-center gap-3">
            {/* Search */}
            <div className="relative flex-1 min-w-[200px]">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
              <input
                type="text"
                placeholder="Buscar por nombre, referencia, monto, pedido..."
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                className="w-full pl-9 pr-4 py-2 text-sm border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
              />
            </div>

            {/* Date filter */}
            <div className="flex items-center gap-1">
              <Calendar size={14} className="text-neutral-400" />
              {['all', 'hoy', 'ayer'].map(val => (
                <button
                  key={val}
                  onClick={() => setFilters({ fecha: val, page: 1 })}
                  className={clsx(
                    'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
                    fechaFilter === val
                      ? 'bg-neutral-900 text-white'
                      : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                  )}
                >
                  {val === 'all' ? 'Todos' : val === 'hoy' ? 'Hoy' : 'Ayer'}
                </button>
              ))}
            </div>

            {/* Status filter */}
            <div className="flex items-center gap-1">
              <Filter size={14} className="text-neutral-400" />
              {['all', 'unassigned', 'assigned'].map(val => (
                <button
                  key={val}
                  onClick={() => setFilters({ assignment_status: val, page: 1 })}
                  className={clsx(
                    'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
                    statusFilter === val
                      ? 'bg-neutral-900 text-white'
                      : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                  )}
                >
                  {val === 'all' ? 'Todos' : STATUS_CONFIG[val]?.label || val}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-center gap-2 text-red-700 text-sm">
            <AlertCircle size={16} />
            {error}
            <button onClick={() => setError(null)} className="ml-auto"><X size={14} /></button>
          </div>
        )}

        {/* Stats cards */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-white rounded-xl border border-neutral-200/60 p-4">
              <div className="text-xs text-neutral-500 mb-1">Asignados</div>
              <div className="text-2xl font-semibold text-emerald-600">{stats.assigned_count || 0}</div>
            </div>
            <div className="bg-white rounded-xl border border-neutral-200/60 p-4">
              <div className="text-xs text-neutral-500 mb-1">Sin asignar</div>
              <div className="text-2xl font-semibold text-amber-600">{stats.unassigned_count || 0}</div>
            </div>
            <div className="bg-white rounded-xl border border-neutral-200/60 p-4">
              <div className="text-xs text-neutral-500 mb-1">Total sin asignar</div>
              <div className="text-2xl font-semibold text-amber-600">{formatCurrency(Number(stats.unassigned_total || 0))}</div>
            </div>
          </div>
        )}

        {/* Table */}
        <div className="bg-white rounded-xl border border-neutral-200/60 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center p-12 text-neutral-400">
              <RefreshCw size={20} className="animate-spin mr-2" /> Cargando movimientos...
            </div>
          ) : movements.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-neutral-400">
              <FileText size={40} className="mb-3" />
              <p className="text-sm">No hay movimientos bancarios</p>
              <p className="text-xs mt-1">Importa un archivo JSON para comenzar</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Monto</TableHead>
                  <TableHead>Ordenante</TableHead>
                  <TableHead className="hidden md:table-cell">Referencia</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="hidden lg:table-cell">Comprobante</TableHead>
                  <TableHead className="hidden lg:table-cell">Pedido</TableHead>
                  <TableHead className="hidden xl:table-cell">Import</TableHead>
                  <TableHead>{' '}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movements.map(mov => (
                  <TableRow key={mov.id} isClickable onClick={() => setSelectedId(mov.id)}>
                    <TableCell>
                      <div className="text-sm font-medium">{formatDateShort(mov.posted_at)}</div>
                      <div className="text-xs text-neutral-400">{format(new Date(mov.posted_at), 'HH:mm')}</div>
                    </TableCell>
                    <TableCell>
                      <span className="font-semibold text-neutral-900">{formatCurrency(mov.amount)}</span>
                    </TableCell>
                    <TableCell>
                      <div className="max-w-[180px] truncate text-sm">{mov.sender_name || '-'}</div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <div className="max-w-[140px] truncate text-xs text-neutral-500">
                        {mov.reference || mov.description || '-'}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_CONFIG[mov.assignment_status]?.variant || 'default'} size="sm">
                        {STATUS_CONFIG[mov.assignment_status]?.label || mov.assignment_status}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {mov.linked_comprobante_id ? (
                        <span className="text-xs text-emerald-600 font-medium">#{mov.linked_comprobante_id}</span>
                      ) : (
                        <span className="text-xs text-neutral-300">-</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {mov.linked_order_number ? (
                        <span className="text-xs text-blue-600 font-medium">{mov.linked_order_number}</span>
                      ) : (
                        <span className="text-xs text-neutral-300">-</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden xl:table-cell">
                      <span className="text-xs text-neutral-400">#{mov.import_id}</span>
                    </TableCell>
                    <TableCell>
                      <Eye size={14} className="text-neutral-400" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {/* Pagination */}
          {pagination && pagination.pages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-neutral-100">
              <span className="text-xs text-neutral-500">
                Pagina {pagination.page} de {pagination.pages} ({pagination.total} total)
              </span>
              <div className="flex gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setFilter('page', Math.max(1, currentPage - 1))}
                  disabled={currentPage <= 1}
                >
                  <ChevronLeft size={14} />
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setFilter('page', Math.min(pagination.pages, currentPage + 1))}
                  disabled={currentPage >= pagination.pages}
                >
                  <ChevronRight size={14} />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Detail Modal */}
      <Modal isOpen={selectedId !== null} onClose={() => setSelectedId(null)} title="Detalle de Movimiento" size="lg">
        {detailLoading ? (
          <div className="flex items-center justify-center p-8 text-neutral-400">
            <RefreshCw size={20} className="animate-spin mr-2" /> Cargando...
          </div>
        ) : detail ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-neutral-500">Monto</label>
                <p className="text-xl font-bold">{formatCurrency(detail.amount)}</p>
              </div>
              <div>
                <label className="text-xs text-neutral-500">Estado</label>
                <p><Badge variant={STATUS_CONFIG[detail.assignment_status]?.variant || 'default'}>
                  {STATUS_CONFIG[detail.assignment_status]?.label || detail.assignment_status}
                </Badge></p>
              </div>
              <div>
                <label className="text-xs text-neutral-500">Fecha</label>
                <p className="text-sm font-medium">{formatDate(detail.posted_at)}</p>
              </div>
              <div>
                <label className="text-xs text-neutral-500">Ordenante</label>
                <p className="text-sm">{detail.sender_name || '-'}</p>
              </div>
              <div>
                <label className="text-xs text-neutral-500">Referencia</label>
                <p className="text-sm">{detail.reference || '-'}</p>
              </div>
              <div>
                <label className="text-xs text-neutral-500">Descripcion</label>
                <p className="text-sm">{detail.description || '-'}</p>
              </div>
              {detail.bank_name && (
                <div>
                  <label className="text-xs text-neutral-500">Banco</label>
                  <p className="text-sm">{detail.bank_name}</p>
                </div>
              )}
              {detail.movement_uid && (
                <div>
                  <label className="text-xs text-neutral-500">ID Movimiento</label>
                  <p className="text-xs font-mono">{detail.movement_uid}</p>
                </div>
              )}
            </div>

            {/* Linked Comprobante */}
            {detail.linked_comprobante_id && (
              <div className="bg-emerald-50 rounded-lg p-3 border border-emerald-200">
                <h4 className="text-xs font-semibold text-emerald-800 mb-2">Comprobante Vinculado</h4>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <span className="text-emerald-600">ID:</span> #{detail.comp_id}
                  </div>
                  <div>
                    <span className="text-emerald-600">Monto:</span> {formatCurrency(detail.comp_monto || 0)}
                  </div>
                  <div>
                    <span className="text-emerald-600">Estado:</span> {detail.comp_estado}
                  </div>
                  {detail.comp_numero_operacion && (
                    <div className="col-span-3">
                      <span className="text-emerald-600">N. Operacion:</span> {detail.comp_numero_operacion}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Linked Order */}
            {detail.linked_order_number && (
              <div className="bg-blue-50 rounded-lg p-3 border border-blue-200">
                <h4 className="text-xs font-semibold text-blue-800 mb-2">Pedido Vinculado</h4>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <span className="text-blue-600">Pedido:</span> {detail.linked_order_number}
                  </div>
                  <div>
                    <span className="text-blue-600">Cliente:</span> {detail.customer_name || '-'}
                  </div>
                  <div>
                    <span className="text-blue-600">Pago:</span> {detail.estado_pago || '-'}
                  </div>
                  {detail.order_total && (
                    <div>
                      <span className="text-blue-600">Total pedido:</span> {formatCurrency(detail.order_total)}
                    </div>
                  )}
                  {detail.total_pagado !== undefined && detail.total_pagado !== null && (
                    <div>
                      <span className="text-blue-600">Pagado:</span> {formatCurrency(detail.total_pagado)}
                    </div>
                  )}
                  {detail.saldo !== undefined && detail.saldo !== null && (
                    <div>
                      <span className="text-blue-600">Saldo:</span> {formatCurrency(detail.saldo)}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Raw Row */}
            <details className="group">
              <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-700 flex items-center gap-1">
                <ChevronDown size={12} className="group-open:rotate-180 transition-transform" />
                Ver datos originales (raw)
              </summary>
              <pre className="mt-2 p-3 bg-neutral-50 rounded-lg text-xs font-mono overflow-auto max-h-60 border border-neutral-200">
                {JSON.stringify(detail.raw_row, null, 2)}
              </pre>
            </details>

            {/* Import info */}
            <div className="text-xs text-neutral-400 pt-2 border-t border-neutral-100">
              Import #{detail.import_id} | {detail.import_filename} | {detail.import_uploaded_at ? formatDate(detail.import_uploaded_at) : '-'}
            </div>
          </div>
        ) : (
          <p className="text-neutral-400 text-sm">No se encontro el movimiento.</p>
        )}
      </Modal>

      {/* Import Modal */}
      <Modal isOpen={showImport} onClose={() => setShowImport(false)} title="Importar Movimientos Bancarios" size="xl">
        <div className="space-y-4">
          {/* Upload area */}
          {!importPreview && !importResult && (
            <div
              onDragOver={e => e.preventDefault()}
              onDrop={handleDrop}
              className="border-2 border-dashed border-neutral-300 rounded-xl p-8 text-center hover:border-primary-400 transition-colors"
            >
              {importProcessing ? (
                <div className="flex items-center justify-center text-neutral-500">
                  <RefreshCw size={20} className="animate-spin mr-2" /> Procesando archivo...
                </div>
              ) : (
                <>
                  <Upload size={32} className="mx-auto text-neutral-400 mb-3" />
                  <p className="text-sm text-neutral-600 mb-2">Arrastra un archivo JSON o</p>
                  <label className="inline-flex items-center gap-2 px-4 py-2 bg-neutral-100 rounded-lg text-sm font-medium text-neutral-700 hover:bg-neutral-200 cursor-pointer transition-colors">
                    <FileText size={16} />
                    Seleccionar archivo
                    <input
                      type="file"
                      accept=".json"
                      className="hidden"
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (file) handleFileSelect(file);
                      }}
                    />
                  </label>
                </>
              )}
            </div>
          )}

          {/* Preview */}
          {importPreview && !importResult && (
            <div className="space-y-4">
              <div className="bg-blue-50 rounded-xl p-4 border border-blue-200">
                <h4 className="text-sm font-semibold text-blue-800 mb-2">Preview de importacion</h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div>
                    <span className="text-blue-600">Total filas:</span>
                    <span className="ml-1 font-semibold">{importPreview.summary.total_rows}</span>
                  </div>
                  <div>
                    <span className="text-blue-600">Entrantes:</span>
                    <span className="ml-1 font-semibold">{importPreview.summary.total_incoming}</span>
                  </div>
                  <div>
                    <span className="text-emerald-600">Nuevos:</span>
                    <span className="ml-1 font-semibold text-emerald-700">{importPreview.summary.total_new}</span>
                  </div>
                  <div>
                    <span className="text-amber-600">Duplicados:</span>
                    <span className="ml-1 font-semibold text-amber-700">{importPreview.summary.total_duplicated}</span>
                  </div>
                </div>
              </div>

              {/* Preview table */}
              {importPreview.movements.length > 0 && (
                <div className="max-h-60 overflow-auto border rounded-lg">
                  <table className="w-full text-xs">
                    <thead className="bg-neutral-50 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left">Fecha</th>
                        <th className="px-3 py-2 text-left">Monto</th>
                        <th className="px-3 py-2 text-left">Ordenante</th>
                        <th className="px-3 py-2 text-left">Estado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {importPreview.movements.slice(0, 50).map((m, i) => (
                        <tr key={i} className={m.is_duplicate ? 'bg-amber-50/50' : ''}>
                          <td className="px-3 py-2">{formatDateShort(m.posted_at)}</td>
                          <td className="px-3 py-2 font-medium">{formatCurrency(m.amount)}</td>
                          <td className="px-3 py-2 truncate max-w-[150px]">{m.sender_name || '-'}</td>
                          <td className="px-3 py-2">
                            {m.is_duplicate ? (
                              <span className="text-amber-600 font-medium">Duplicado</span>
                            ) : (
                              <span className="text-emerald-600 font-medium">Nuevo</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex gap-2 justify-end">
                <Button
                  variant="secondary"
                  onClick={() => { setImportPreview(null); setImportFile(null); setImportData(null); }}
                >
                  Cancelar
                </Button>
                <Button
                  onClick={handleApplyImport}
                  disabled={importApplying || importPreview.summary.total_new === 0}
                  leftIcon={importApplying ? <RefreshCw size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                >
                  {importApplying ? 'Importando...' : `Importar ${importPreview.summary.total_new} movimientos`}
                </Button>
              </div>
            </div>
          )}

          {/* Result */}
          {importResult && (
            <div className="space-y-4">
              <div className="bg-emerald-50 rounded-xl p-4 border border-emerald-200">
                <h4 className="text-sm font-semibold text-emerald-800 mb-2 flex items-center gap-2">
                  <CheckCircle2 size={16} /> Importacion completada
                </h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div>
                    <span className="text-emerald-600">Insertados:</span>
                    <span className="ml-1 font-semibold">{importResult.summary.total_inserted}</span>
                  </div>
                  <div>
                    <span className="text-amber-600">Duplicados:</span>
                    <span className="ml-1 font-semibold">{importResult.summary.total_duplicated}</span>
                  </div>
                  <div>
                    <span className="text-emerald-600">Asignados:</span>
                    <span className="ml-1 font-semibold">{importResult.summary.total_assigned}</span>
                  </div>
                  <div>
                    <span className="text-amber-600">Sin asignar:</span>
                    <span className="ml-1 font-semibold">{importResult.summary.total_unassigned}</span>
                  </div>
                </div>
              </div>
              <div className="flex justify-end">
                <Button onClick={() => { setShowImport(false); setImportResult(null); }}>
                  Cerrar
                </Button>
              </div>
            </div>
          )}
        </div>
      </Modal>

      {/* History Modal */}
      <Modal isOpen={showHistory} onClose={() => setShowHistory(false)} title="Historial de Importaciones" size="xl">
        {importsLoading ? (
          <div className="flex items-center justify-center p-8 text-neutral-400">
            <RefreshCw size={20} className="animate-spin mr-2" /> Cargando...
          </div>
        ) : imports.length === 0 ? (
          <p className="text-neutral-400 text-sm text-center py-8">No hay importaciones registradas.</p>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">ID</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Archivo</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Usuario</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Fecha</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Filas</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Insertados</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Duplicados</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {imports.map(imp => (
                  <tr key={imp.id} className="hover:bg-neutral-50">
                    <td className="px-3 py-2 font-mono text-xs">#{imp.id}</td>
                    <td className="px-3 py-2 truncate max-w-[200px]">{imp.filename}</td>
                    <td className="px-3 py-2">{imp.uploaded_by_name || '-'}</td>
                    <td className="px-3 py-2 text-xs">{formatDate(imp.uploaded_at)}</td>
                    <td className="px-3 py-2">{imp.total_rows}</td>
                    <td className="px-3 py-2 text-emerald-600 font-medium">{imp.total_inserted}</td>
                    <td className="px-3 py-2 text-amber-600">{imp.total_duplicated}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}
