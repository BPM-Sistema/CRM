import { forwardRef } from 'react';
import type { LocalOrder, LocalOrderItem } from '../../services/local-api';

interface PrintableLocalOrderProps {
  order: LocalOrder;
  items: LocalOrderItem[];
  version: number;
}

export const PrintableLocalOrder = forwardRef<HTMLDivElement, PrintableLocalOrderProps>(
  ({ order, items, version }, ref) => {
    return (
      <div ref={ref} className="bg-white p-6">
        <style>{`
          @media print {
            @page { size: A4; margin: 10mm; }
            body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            .print-no-break { page-break-inside: avoid; break-inside: avoid; }
          }
        `}</style>

        <div className="print-no-break border-b-2 border-black pb-3 mb-4">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-2xl font-bold font-mono">RESERVA #{order.local_order_number}</h1>
              <p className="text-sm text-gray-600 mt-1">Pedido interno — Depósito → Local</p>
            </div>
            <div className="text-right text-sm">
              <p className="font-bold">Impresión #{version}</p>
              <p>{new Date().toLocaleDateString('es-AR')} {new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</p>
            </div>
          </div>
        </div>

        <div className="print-no-break grid grid-cols-2 gap-4 mb-4 text-sm">
          <div className="border border-gray-400 p-3 rounded">
            <h2 className="font-bold uppercase text-xs text-gray-600 mb-1">Información</h2>
            <p><span className="font-semibold">Creada por:</span> {order.created_by_name}</p>
            <p><span className="font-semibold">Fecha:</span> {new Date(order.created_at).toLocaleDateString('es-AR')}</p>
            <p><span className="font-semibold">Estado:</span> {order.status.toUpperCase()}</p>
          </div>
          {order.notes_internal && (
            <div className="border-2 border-black p-3 rounded bg-yellow-50">
              <h2 className="font-bold uppercase text-xs text-gray-600 mb-1">Notas</h2>
              <p className="font-semibold">{order.notes_internal}</p>
            </div>
          )}
        </div>

        <table className="w-full border-collapse border border-gray-400 text-sm">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-400 px-3 py-2 text-left">#</th>
              <th className="border border-gray-400 px-3 py-2 text-left">Producto</th>
              <th className="border border-gray-400 px-3 py-2 text-left">Variante</th>
              <th className="border border-gray-400 px-3 py-2 text-left">SKU</th>
              <th className="border border-gray-400 px-3 py-2 text-center">Cantidad</th>
              <th className="border border-gray-400 px-3 py-2 text-center">Check</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => (
              <tr key={item.id} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                <td className="border border-gray-400 px-3 py-2">{idx + 1}</td>
                <td className="border border-gray-400 px-3 py-2 font-medium">{item.product_name_snapshot}</td>
                <td className="border border-gray-400 px-3 py-2">{item.variant_name_snapshot || '-'}</td>
                <td className="border border-gray-400 px-3 py-2 font-mono text-xs">{item.sku_snapshot || '-'}</td>
                <td className="border border-gray-400 px-3 py-2 text-center font-bold text-lg">{item.sent_qty || item.reserved_qty}</td>
                <td className="border border-gray-400 px-3 py-2 text-center">
                  <div className="w-6 h-6 border-2 border-gray-400 inline-block" />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-gray-100 font-bold">
              <td colSpan={4} className="border border-gray-400 px-3 py-2 text-right">TOTAL ÍTEMS</td>
              <td className="border border-gray-400 px-3 py-2 text-center text-lg">
                {items.reduce((s, i) => s + (i.sent_qty || i.reserved_qty), 0)}
              </td>
              <td className="border border-gray-400 px-3 py-2" />
            </tr>
          </tfoot>
        </table>

        <div className="mt-6 pt-4 border-t border-gray-300 text-xs text-gray-500">
          <p>Documento interno — Reserva #{order.local_order_number} — Impresión #{version}</p>
        </div>
      </div>
    );
  }
);

PrintableLocalOrder.displayName = 'PrintableLocalOrder';
