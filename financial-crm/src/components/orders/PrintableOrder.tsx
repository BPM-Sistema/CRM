import { forwardRef } from 'react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { ApiOrderPrintData } from '../../services/api';

interface PrintableOrderProps {
  data: ApiOrderPrintData;
}

export const PrintableOrder = forwardRef<HTMLDivElement, PrintableOrderProps>(
  ({ data }, ref) => {
    const formatCurrency = (amount: number) => {
      return new Intl.NumberFormat('es-AR', {
        style: 'currency',
        currency: 'ARS',
        maximumFractionDigits: 0,
      }).format(amount);
    };

    const formatDate = (dateString: string) => {
      return format(new Date(dateString), "dd 'de' MMMM 'de' yyyy - HH:mm", { locale: es });
    };

    return (
      <div ref={ref} className="print-container bg-white p-8 max-w-[800px] mx-auto">
        <style>
          {`
            @media print {
              @page {
                size: A4;
                margin: 15mm;
              }
              body * {
                visibility: hidden;
              }
              .print-container, .print-container * {
                visibility: visible;
              }
              .print-container {
                position: absolute;
                left: 0;
                top: 0;
                width: 100%;
                padding: 0 !important;
              }
              .no-print {
                display: none !important;
              }
            }
          `}
        </style>

        {/* Header */}
        <div className="border-b-2 border-neutral-900 pb-4 mb-6">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-2xl font-bold text-neutral-900">HOJA DE PEDIDO</h1>
              <p className="text-lg font-mono font-semibold text-neutral-700 mt-1">
                #{data.order_number}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm text-neutral-600">Fecha del pedido:</p>
              <p className="font-medium">{formatDate(data.created_at)}</p>
            </div>
          </div>
        </div>

        {/* Cliente y Envío en dos columnas */}
        <div className="grid grid-cols-2 gap-6 mb-6">
          {/* Cliente */}
          <div className="border border-neutral-300 rounded-lg p-4">
            <h2 className="text-sm font-bold text-neutral-500 uppercase tracking-wider mb-3">
              Cliente
            </h2>
            <p className="font-semibold text-lg">{data.customer.name}</p>
            {data.customer.phone && (
              <p className="text-neutral-700">Tel: {data.customer.phone}</p>
            )}
            {data.customer.email && (
              <p className="text-neutral-600 text-sm">{data.customer.email}</p>
            )}
            {data.customer.identification && (
              <p className="text-neutral-600 text-sm">DNI/CUIT: {data.customer.identification}</p>
            )}
          </div>

          {/* Dirección de Envío */}
          <div className="border border-neutral-300 rounded-lg p-4">
            <h2 className="text-sm font-bold text-neutral-500 uppercase tracking-wider mb-3">
              Dirección de Envío
            </h2>
            {data.shipping_address ? (
              <>
                <p className="font-semibold">{data.shipping_address.name}</p>
                <p className="text-neutral-700">
                  {data.shipping_address.address} {data.shipping_address.number}
                  {data.shipping_address.floor && `, ${data.shipping_address.floor}`}
                </p>
                <p className="text-neutral-700">
                  {data.shipping_address.locality}, {data.shipping_address.city}
                </p>
                <p className="text-neutral-700">
                  {data.shipping_address.province} - CP {data.shipping_address.zipcode}
                </p>
                {data.shipping_address.phone && (
                  <p className="text-neutral-600 text-sm">Tel: {data.shipping_address.phone}</p>
                )}
                {data.shipping_address.between_streets && (
                  <p className="text-neutral-600 text-sm mt-1">
                    Entre calles: {data.shipping_address.between_streets}
                  </p>
                )}
                {data.shipping_address.reference && (
                  <p className="text-neutral-600 text-sm">
                    Referencia: {data.shipping_address.reference}
                  </p>
                )}
              </>
            ) : (
              <p className="text-neutral-500 italic">Retiro en local</p>
            )}
          </div>
        </div>

        {/* Método de envío */}
        <div className="mb-6 p-3 bg-neutral-100 rounded-lg">
          <span className="text-sm font-medium text-neutral-500">Método de envío: </span>
          <span className="font-semibold">{data.shipping.type}</span>
          {data.shipping.tracking_number && (
            <span className="ml-4 text-sm text-neutral-600">
              Tracking: {data.shipping.tracking_number}
            </span>
          )}
        </div>

        {/* Productos */}
        <div className="mb-6">
          <h2 className="text-sm font-bold text-neutral-500 uppercase tracking-wider mb-3">
            Productos ({data.products.length})
          </h2>
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-neutral-900 text-white">
                <th className="text-left p-2 text-sm font-medium">Cant.</th>
                <th className="text-left p-2 text-sm font-medium">Producto</th>
                <th className="text-left p-2 text-sm font-medium">SKU</th>
                <th className="text-right p-2 text-sm font-medium">Precio</th>
                <th className="text-right p-2 text-sm font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.products.map((product, index) => (
                <tr
                  key={product.id}
                  className={index % 2 === 0 ? 'bg-white' : 'bg-neutral-50'}
                >
                  <td className="p-2 border-b border-neutral-200 font-mono font-bold text-center">
                    {product.quantity}
                  </td>
                  <td className="p-2 border-b border-neutral-200">
                    <p className="font-medium">{product.name}</p>
                    {product.variant && (
                      <p className="text-sm text-neutral-500">{product.variant}</p>
                    )}
                  </td>
                  <td className="p-2 border-b border-neutral-200 font-mono text-sm text-neutral-500">
                    {product.sku || '-'}
                  </td>
                  <td className="p-2 border-b border-neutral-200 text-right font-mono">
                    {formatCurrency(product.price)}
                  </td>
                  <td className="p-2 border-b border-neutral-200 text-right font-mono font-medium">
                    {formatCurrency(product.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Totales */}
        <div className="flex justify-end mb-6">
          <div className="w-64">
            <div className="flex justify-between py-1 text-neutral-600">
              <span>Subtotal:</span>
              <span className="font-mono">{formatCurrency(data.totals.subtotal)}</span>
            </div>
            {data.totals.discount > 0 && (
              <div className="flex justify-between py-1 text-green-600">
                <span>Descuento:</span>
                <span className="font-mono">-{formatCurrency(data.totals.discount)}</span>
              </div>
            )}
            <div className="flex justify-between py-1 text-neutral-600">
              <span>Envío:</span>
              <span className="font-mono">{formatCurrency(data.totals.shipping)}</span>
            </div>
            <div className="flex justify-between py-2 border-t-2 border-neutral-900 font-bold text-lg">
              <span>TOTAL:</span>
              <span className="font-mono">{formatCurrency(data.totals.total)}</span>
            </div>
          </div>
        </div>

        {/* Notas */}
        {(data.note || data.owner_note) && (
          <div className="border-t border-neutral-300 pt-4">
            {data.note && (
              <div className="mb-3">
                <h3 className="text-sm font-bold text-neutral-500 uppercase">Nota del cliente:</h3>
                <p className="text-neutral-700 mt-1 p-2 bg-yellow-50 rounded">{data.note}</p>
              </div>
            )}
            {data.owner_note && (
              <div>
                <h3 className="text-sm font-bold text-neutral-500 uppercase">Nota interna:</h3>
                <p className="text-neutral-700 mt-1 p-2 bg-blue-50 rounded">{data.owner_note}</p>
              </div>
            )}
          </div>
        )}

        {/* Estado de pago interno */}
        {data.internal && (
          <div className="mt-6 pt-4 border-t border-dashed border-neutral-300">
            <div className="flex justify-between items-center text-sm">
              <span className="text-neutral-500">Estado interno:</span>
              <div className="flex gap-4">
                <span>
                  Pagado: <strong className="text-emerald-600">{formatCurrency(data.internal.total_pagado || 0)}</strong>
                </span>
                <span>
                  Saldo: <strong className={data.internal.saldo > 0 ? 'text-red-600' : 'text-emerald-600'}>
                    {formatCurrency(data.internal.saldo || 0)}
                  </strong>
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Espacio para firma / verificación */}
        <div className="mt-8 pt-4 border-t border-neutral-300">
          <div className="grid grid-cols-2 gap-8">
            <div>
              <p className="text-sm text-neutral-500 mb-8">Armado por:</p>
              <div className="border-b border-neutral-400 w-full"></div>
            </div>
            <div>
              <p className="text-sm text-neutral-500 mb-8">Verificado por:</p>
              <div className="border-b border-neutral-400 w-full"></div>
            </div>
          </div>
        </div>

        {/* Checkbox para marcar productos */}
        <div className="mt-6 text-xs text-neutral-400 text-center">
          Impreso el {format(new Date(), "dd/MM/yyyy 'a las' HH:mm", { locale: es })}
        </div>
      </div>
    );
  }
);

PrintableOrder.displayName = 'PrintableOrder';
