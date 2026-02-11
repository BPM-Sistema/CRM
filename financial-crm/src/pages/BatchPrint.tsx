import { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { RefreshCw, Printer, ArrowLeft, AlertCircle } from 'lucide-react';
import { fetchOrderPrintData, ApiOrderPrintData, updateOrderStatus } from '../services/api';
import { PrintableOrder } from '../components/orders/PrintableOrder';
import { Button } from '../components/ui';

export default function BatchPrint() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const printRef = useRef<HTMLDivElement>(null);

  const [orders, setOrders] = useState<ApiOrderPrintData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [failedOrders, setFailedOrders] = useState<string[]>([]);
  const [isPrinting, setIsPrinting] = useState(false);

  const orderNumbers = searchParams.get('orders')?.split(',').filter(Boolean) || [];

  useEffect(() => {
    if (orderNumbers.length === 0) {
      setError('No se especificaron pedidos para imprimir');
      setLoading(false);
      return;
    }

    loadOrdersData();
  }, []);

  const loadOrdersData = async () => {
    setLoading(true);
    setError(null);
    setProgress({ current: 0, total: orderNumbers.length });
    setFailedOrders([]);

    const loadedOrders: ApiOrderPrintData[] = [];
    const failed: string[] = [];

    for (let i = 0; i < orderNumbers.length; i++) {
      const orderNumber = orderNumbers[i];
      setProgress({ current: i + 1, total: orderNumbers.length });

      try {
        const data = await fetchOrderPrintData(orderNumber);
        loadedOrders.push(data);
      } catch (err) {
        console.error(`Error cargando pedido ${orderNumber}:`, err);
        failed.push(orderNumber);
      }
    }

    setOrders(loadedOrders);
    setFailedOrders(failed);
    setLoading(false);

    if (loadedOrders.length === 0) {
      setError('No se pudo cargar ningún pedido');
    }
  };

  const handlePrint = async () => {
    setIsPrinting(true);

    try {
      // Marcar todos los pedidos como impresos (estado: hoja_impresa)
      const markPromises = orders.map(order =>
        updateOrderStatus(order.order_number, 'hoja_impresa').catch((error: Error) => {
          console.error(`Error marcando pedido ${order.order_number} como impreso:`, error);
        })
      );
      await Promise.all(markPromises);

      // Abrir diálogo de impresión
      window.print();
    } catch (error) {
      console.error('Error al imprimir:', error);
    } finally {
      setIsPrinting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <RefreshCw size={48} className="animate-spin text-neutral-400 mx-auto mb-4" />
          <p className="text-lg font-medium text-neutral-700">
            Cargando pedidos... ({progress.current}/{progress.total})
          </p>
          <p className="text-sm text-neutral-500 mt-2">
            Preparando hojas de picking
          </p>
        </div>
      </div>
    );
  }

  if (error && orders.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center max-w-md">
          <AlertCircle size={48} className="text-red-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-neutral-900 mb-2">Error</h2>
          <p className="text-neutral-600 mb-4">{error}</p>
          <Button onClick={() => navigate('/orders')}>
            <ArrowLeft size={16} className="mr-2" />
            Volver a Pedidos
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Header - Solo visible en pantalla, no en impresión */}
      <div className="print:hidden bg-white border-b border-neutral-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="secondary" onClick={() => navigate('/orders')}>
              <ArrowLeft size={16} className="mr-2" />
              Volver
            </Button>
            <div>
              <h1 className="text-lg font-semibold text-neutral-900">
                Impresión de Pedidos
              </h1>
              <p className="text-sm text-neutral-500">
                {orders.length} pedidos listos para imprimir
                {failedOrders.length > 0 && (
                  <span className="text-amber-600 ml-2">
                    ({failedOrders.length} fallaron)
                  </span>
                )}
              </p>
            </div>
          </div>
          <Button
            onClick={handlePrint}
            disabled={isPrinting || orders.length === 0}
            leftIcon={isPrinting ? <RefreshCw size={16} className="animate-spin" /> : <Printer size={16} />}
          >
            {isPrinting ? 'Preparando...' : `Imprimir ${orders.length} pedidos`}
          </Button>
        </div>

        {failedOrders.length > 0 && (
          <div className="max-w-7xl mx-auto px-4 pb-4">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
              <p className="text-amber-800">
                <strong>Pedidos que no se pudieron cargar:</strong> {failedOrders.join(', ')}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Contenido para imprimir */}
      <div ref={printRef} className="print:p-0">
        <style>
          {`
            @media print {
              @page {
                size: A4;
                margin: 8mm;
              }
              body {
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
              }
              .page-break {
                page-break-after: always;
              }
              .page-break:last-child {
                page-break-after: avoid;
              }
            }
          `}
        </style>

        {orders.map((order, index) => (
          <div key={order.order_number} className={index < orders.length - 1 ? 'page-break' : ''}>
            <PrintableOrder data={order} />
          </div>
        ))}
      </div>
    </>
  );
}
