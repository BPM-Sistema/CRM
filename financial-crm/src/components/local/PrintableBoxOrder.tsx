import { forwardRef } from 'react';
import type { LocalBoxOrder, LocalBoxOrderItem } from '../../services/local-api';

interface Props {
  order: LocalBoxOrder;
  items: LocalBoxOrderItem[];
}

export const PrintableBoxOrder = forwardRef<HTMLDivElement, Props>(
  ({ order, items }, ref) => {
    return (
      <div ref={ref} className="bg-white p-6">
        <style>{`
          @media print {
            @page { size: A4; margin: 10mm; }
            body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          }
        `}</style>

        <div className="border-b-2 border-black pb-3 mb-4">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-2xl font-bold font-mono">VENTA LOCAL #{order.local_box_order_number}</h1>
              <p className="text-sm text-gray-600 mt-1">Pedido de caja</p>
            </div>
            <div className="text-right text-sm">
              <p>{new Date(order.created_at).toLocaleDateString('es-AR')}</p>
              <p>{new Date(order.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</p>
            </div>
          </div>
        </div>

        <table className="w-full border-collapse border border-gray-400 text-sm mb-4">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-400 px-3 py-2 text-left">#</th>
              <th className="border border-gray-400 px-3 py-2 text-left">Producto</th>
              <th className="border border-gray-400 px-3 py-2 text-left">Variante</th>
              <th className="border border-gray-400 px-3 py-2 text-center">Qty</th>
              <th className="border border-gray-400 px-3 py-2 text-right">Precio</th>
              <th className="border border-gray-400 px-3 py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => (
              <tr key={item.id}>
                <td className="border border-gray-400 px-3 py-2">{idx + 1}</td>
                <td className="border border-gray-400 px-3 py-2 font-medium">{item.product_name_snapshot}</td>
                <td className="border border-gray-400 px-3 py-2">{item.variant_name_snapshot || '-'}</td>
                <td className="border border-gray-400 px-3 py-2 text-center font-bold">{item.qty}</td>
                <td className="border border-gray-400 px-3 py-2 text-right font-mono">${Number(item.unit_price).toLocaleString('es-AR')}</td>
                <td className="border border-gray-400 px-3 py-2 text-right font-mono font-bold">${Number(item.line_total).toLocaleString('es-AR')}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-gray-100 font-bold">
              <td colSpan={5} className="border border-gray-400 px-3 py-2 text-right">TOTAL</td>
              <td className="border border-gray-400 px-3 py-2 text-right font-mono text-lg">
                ${Number(order.total_amount).toLocaleString('es-AR')}
              </td>
            </tr>
          </tfoot>
        </table>

        {order.notes && (
          <div className="border border-gray-400 p-3 mb-4 text-sm">
            <span className="font-bold">Notas: </span>{order.notes}
          </div>
        )}

        <div className="mt-6 pt-4 border-t border-gray-300 text-xs text-gray-500">
          <p>Venta Local #{order.local_box_order_number} — {new Date(order.created_at).toLocaleDateString('es-AR')}</p>
        </div>
      </div>
    );
  }
);

PrintableBoxOrder.displayName = 'PrintableBoxOrder';
