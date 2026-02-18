import { forwardRef } from 'react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { ApiOrderPrintData, getTotalUnits } from '../../services/api';

interface PrintableOrderProps {
  data: ApiOrderPrintData;
}

export const PrintableOrder = forwardRef<HTMLDivElement, PrintableOrderProps>(
  ({ data }, ref) => {
    return (
      <div ref={ref} className="print-container bg-white">
        <style>
          {`
            @media print {
              @page {
                size: A4;
                margin: 15mm 10mm 18mm 10mm;
              }
              body {
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
              }
              .print-container {
                padding: 0 !important;
                max-width: 100% !important;
                font-size: 11px !important;
              }
              table { page-break-inside: auto; }
              thead { display: table-header-group; }
              tr { page-break-inside: avoid; }
              .print-no-break { page-break-inside: avoid; }

              /* Footer fijo - aparece en CADA página */
              .print-footer-fixed {
                position: fixed;
                bottom: 0;
                left: 0;
                right: 0;
                height: 12mm;
                display: flex !important;
                justify-content: center;
                align-items: center;
                border-top: 1px solid #ccc;
                background: white;
                font-size: 9px;
                color: #666;
              }
            }

            /* Ocultar footer en pantalla */
            .print-footer-fixed {
              display: none;
            }

            .print-container { font-size: 11px; padding: 12px; max-width: 800px; margin: 0 auto; }
            .print-container h1 { font-size: 28px; }
            .print-container h2 { font-size: 11px; }
            .print-container p { margin: 0; line-height: 1.3; }
            .print-container table { font-size: 13px; }
            .print-container th, .print-container td { padding: 5px 8px; }
          `}
        </style>

        {/* Footer fijo - aparece en CADA página con número */}
        <div className="print-footer-fixed"></div>

        {/* Header principal del documento */}
        <div className="print-no-break border-b border-black pb-2 mb-3 flex justify-between items-end">
          <div>
            <h1 className="font-bold font-mono">#{data.order_number}</h1>
            <p className="text-[10px] text-gray-600 uppercase">Hoja de Picking</p>
          </div>
          <p className="text-[10px] text-gray-600">
            {format(new Date(data.created_at), "dd/MM/yyyy HH:mm", { locale: es })}
          </p>
        </div>

        {/* Cliente y Envío en línea */}
        <div className="print-no-break grid grid-cols-2 gap-3 mb-3 text-[11px]">
          <div className="border border-gray-400 p-2">
            <h2 className="font-bold text-gray-500 uppercase mb-1">Cliente</h2>
            <p className="font-semibold">{data.customer.name}</p>
            {data.customer.phone && <p>Tel: {data.customer.phone}</p>}
          </div>

          <div className="border border-gray-400 p-2">
            <h2 className="font-bold text-gray-500 uppercase mb-1">Envío</h2>
            {data.shipping_address ? (
              <>
                <p>{data.shipping_address.address} {data.shipping_address.number}{data.shipping_address.floor && `, ${data.shipping_address.floor}`}</p>
                <p>{data.shipping_address.locality}, {data.shipping_address.city}</p>
                <p>{data.shipping_address.province} - CP {data.shipping_address.zipcode}</p>
                {data.shipping_address.phone && <p>Tel: {data.shipping_address.phone}</p>}
              </>
            ) : (
              <p className="font-semibold">RETIRO EN LOCAL</p>
            )}
          </div>
        </div>

        {/* Método de envío */}
        <div className="mb-3 py-1 px-2 bg-gray-100 text-[10px]">
          <span className="text-gray-500">Método: </span>
          <span className="font-semibold">{data.shipping.type}</span>
        </div>

        {/* Tabla de productos */}
        <div className="mb-3">
          <h2 className="font-bold text-gray-500 uppercase mb-1">
            Productos ({getTotalUnits(data.products)} unidades)
          </h2>
          <table className="w-full border-collapse border border-gray-400">
            <thead>
              <tr className="bg-black text-white">
                <th className="text-center border border-gray-400 w-8"></th>
                <th className="text-center border border-gray-400 w-12">Cant.</th>
                <th className="text-left border border-gray-400">Producto</th>
                <th className="text-left border border-gray-400 w-24">SKU</th>
              </tr>
            </thead>
            <tbody>
              {data.products.map((product, index) => (
                <tr key={product.id} className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                  <td className="text-center border border-gray-300">
                    <span className="inline-block w-4 h-4 border-2 border-gray-400"></span>
                  </td>
                  <td className="text-center border border-gray-300 font-mono font-bold">
                    {product.quantity}
                  </td>
                  <td className="border border-gray-300">
                    <span className="font-medium text-[13px]">{product.name}</span>
                    {product.variant && <span className="text-gray-500 text-[11px] ml-1">({product.variant})</span>}
                  </td>
                  <td className="border border-gray-300 font-mono text-[11px] text-gray-600">
                    {product.sku || '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Notas del cliente (si existen) */}
        {data.note && (
          <div className="print-no-break mb-3 p-2 border border-gray-400 bg-yellow-50 text-[10px]">
            <span className="font-bold">Nota cliente: </span>
            <span>{data.note}</span>
          </div>
        )}

        {/* Firma compacta */}
        <div className="print-no-break mt-4 pt-2 border-t border-gray-400">
          <div className="grid grid-cols-2 gap-4 text-[10px]">
            <div>
              <p className="text-gray-500 mb-4">Armado:</p>
              <div className="border-b border-gray-400"></div>
            </div>
            <div>
              <p className="text-gray-500 mb-4">Verificado:</p>
              <div className="border-b border-gray-400"></div>
            </div>
          </div>
        </div>

        <p className="mt-3 text-[9px] text-gray-400 text-center">
          {format(new Date(), "dd/MM/yyyy HH:mm", { locale: es })}
        </p>
      </div>
    );
  }
);

PrintableOrder.displayName = 'PrintableOrder';
