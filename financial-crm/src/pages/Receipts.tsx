import { useState, useMemo } from 'react';
import { Header } from '../components/layout';
import { ReceiptCard, ReceiptViewer } from '../components/receipts';
import { Input } from '../components/ui';
import { getAllReceipts } from '../data/mockData';
import { Receipt, PaymentStatus } from '../types';
import { Search } from 'lucide-react';
import { clsx } from 'clsx';
import { useAuth } from '../contexts/AuthContext';

// Mapeo de estados a permisos
const receiptStatusPermissions: Record<PaymentStatus, string> = {
  pendiente: 'receipts.view_pendiente',
  a_confirmar: 'receipts.view_a_confirmar',
  parcial: 'receipts.view_parcial',
  total: 'receipts.view_total',
  rechazado: 'receipts.view_rechazado',
  anulado: 'receipts.view_anulado',
  reembolsado: 'receipts.view_reembolsado',
};

const statusFilters: { value: PaymentStatus | 'all'; label: string; color: string; permission?: string }[] = [
  { value: 'all', label: 'Todos', color: 'bg-neutral-100 text-neutral-700' },
  { value: 'pendiente', label: 'Pendiente', color: 'bg-amber-50 text-amber-700', permission: 'receipts.view_pendiente' },
  { value: 'a_confirmar', label: 'A confirmar', color: 'bg-blue-50 text-blue-700', permission: 'receipts.view_a_confirmar' },
  { value: 'parcial', label: 'Parcial', color: 'bg-violet-50 text-violet-700', permission: 'receipts.view_parcial' },
  { value: 'total', label: 'Total', color: 'bg-emerald-50 text-emerald-700', permission: 'receipts.view_total' },
  { value: 'rechazado', label: 'Rechazado', color: 'bg-red-50 text-red-700', permission: 'receipts.view_rechazado' },
];

export function Receipts() {
  const { hasPermission } = useAuth();
  const [selectedReceipt, setSelectedReceipt] = useState<Receipt | null>(null);
  const [statusFilter, setStatusFilter] = useState<PaymentStatus | 'all'>('all');
  const [search, setSearch] = useState('');

  const receipts = getAllReceipts();

  // Filtrar comprobantes según permisos del usuario
  const permittedReceipts = useMemo(() => {
    return receipts.filter((receipt) => {
      return hasPermission(receiptStatusPermissions[receipt.paymentStatus]);
    });
  }, [receipts, hasPermission]);

  // Filtrar botones de estado según permisos
  const visibleStatusFilters = statusFilters.filter(filter =>
    filter.value === 'all' || !filter.permission || hasPermission(filter.permission)
  );

  const filteredReceipts = useMemo(() => {
    return permittedReceipts.filter((receipt) => {
      const matchesStatus = statusFilter === 'all' || receipt.paymentStatus === statusFilter;
      const matchesSearch =
        search === '' ||
        receipt.id.toLowerCase().includes(search.toLowerCase()) ||
        receipt.orderId.toLowerCase().includes(search.toLowerCase());

      return matchesStatus && matchesSearch;
    });
  }, [permittedReceipts, statusFilter, search]);

  const statusCounts = useMemo(() => {
    return permittedReceipts.reduce(
      (acc, receipt) => {
        acc[receipt.paymentStatus] = (acc[receipt.paymentStatus] || 0) + 1;
        acc.total += 1;
        return acc;
      },
      { total: 0 } as Record<string, number>
    );
  }, [permittedReceipts]);

  return (
    <div className="min-h-screen">
      <Header
        title="Comprobantes"
        subtitle={`${statusCounts.total} comprobantes · ${statusCounts.pendiente || 0} pendientes de revisión`}
      />

      <div className="p-6 space-y-6">
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
          {visibleStatusFilters.length > 1 && (
            <div className="flex items-center gap-2 overflow-x-auto pb-2 sm:pb-0">
              {visibleStatusFilters.map((filter) => (
                <button
                  key={filter.value}
                  onClick={() => setStatusFilter(filter.value)}
                  className={clsx(
                    'px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap',
                    statusFilter === filter.value
                      ? clsx(filter.color, 'ring-2 ring-neutral-900/10')
                      : 'bg-white text-neutral-600 hover:bg-neutral-50 border border-neutral-200'
                  )}
                >
                  {filter.label}
                  <span className="ml-1.5 text-xs opacity-60">
                    {filter.value === 'all' ? statusCounts.total : statusCounts[filter.value] || 0}
                  </span>
                </button>
              ))}
            </div>
          )}

          <Input
            placeholder="Buscar comprobantes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leftIcon={<Search size={16} />}
            className="w-full sm:w-64"
          />
        </div>

        {filteredReceipts.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-neutral-400 mb-2">No se encontraron comprobantes</div>
            <p className="text-sm text-neutral-500">
              Intentá ajustar los filtros o la búsqueda
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {filteredReceipts.map((receipt) => (
              <ReceiptCard
                key={receipt.id}
                receipt={receipt}
                onClick={() => setSelectedReceipt(receipt)}
              />
            ))}
          </div>
        )}
      </div>

      <ReceiptViewer
        receipt={selectedReceipt}
        isOpen={!!selectedReceipt}
        onClose={() => setSelectedReceipt(null)}
      />
    </div>
  );
}
