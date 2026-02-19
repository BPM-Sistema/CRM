import { useState, useEffect, useCallback } from 'react';
import { Header } from '../components/layout';
import {
  RefreshCw,
  AlertCircle,
  Clock,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { authFetch } from '../services/api';

interface SyncQueueOrder {
  order_number: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  monto_tiendanube: number;
  total_pagado: number;
  saldo: number;
  estado_pago: string;
  estado_pedido: string;
  tn_payment_status: string | null;
  created_at: string;
  tn_created_at: string;
}

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
  }).format(amount);
}

export default function SyncQueue() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();

  const [orders, setOrders] = useState<SyncQueueOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await authFetch(`${API_BASE_URL}/sync-queue/payments`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Error al cargar datos');
      }

      setOrders(data.orders);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar datos');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hasPermission('activity.view')) {
      navigate('/');
      return;
    }
    loadData();
  }, [loadData, hasPermission, navigate]);

  if (!hasPermission('activity.view')) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header
        title="Cola de Sincronización"
        subtitle={`${orders.length} pedidos pendientes de sincronizar con Tiendanube`}
        actions={
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
        }
      />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Explicación */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-medium text-amber-800">Pedidos pagados en el sistema pero no en Tiendanube</h3>
              <p className="text-sm text-amber-700 mt-1">
                Estos pedidos fueron confirmados como pagados en nuestro CRM, pero Tiendanube aún no los tiene marcados como "paid".
                Desaparecerán automáticamente cuando Tiendanube actualice el estado de pago.
              </p>
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6 flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
            <p className="text-red-700">{error}</p>
          </div>
        )}

        {/* Tabla */}
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Pedido
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Cliente
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Monto
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Estado CRM
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Estado Tiendanube
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Fecha
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Acciones
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center">
                      <RefreshCw className="w-6 h-6 text-gray-400 animate-spin mx-auto mb-2" />
                      <p className="text-gray-500">Cargando...</p>
                    </td>
                  </tr>
                ) : orders.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center">
                      <CheckCircle2 className="w-12 h-12 text-green-400 mx-auto mb-3" />
                      <p className="text-gray-900 font-medium">Todo sincronizado</p>
                      <p className="text-gray-500 text-sm mt-1">No hay pedidos pendientes de sincronizar</p>
                    </td>
                  </tr>
                ) : (
                  orders.map((order) => (
                    <tr key={order.order_number} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <button
                          onClick={() => navigate(`/orders/${order.order_number}`)}
                          className="text-sm font-medium text-violet-600 hover:text-violet-700 hover:underline"
                        >
                          #{order.order_number}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm">
                          <p className="font-medium text-gray-900">{order.customer_name || '-'}</p>
                          {order.customer_email && (
                            <p className="text-gray-500 text-xs">{order.customer_email}</p>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm">
                          <p className="font-medium text-gray-900">{formatCurrency(order.monto_tiendanube)}</p>
                          <p className="text-gray-500 text-xs">Pagado: {formatCurrency(order.total_pagado)}</p>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700">
                          <CheckCircle2 className="w-3 h-3" />
                          {order.estado_pago === 'confirmado_total' ? 'Pagado' : 'Parcial'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                          <Clock className="w-3 h-3" />
                          {order.tn_payment_status || 'pending'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 text-sm text-gray-600">
                          <Clock className="w-4 h-4 text-gray-400" />
                          {formatDate(order.tn_created_at || order.created_at)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <a
                          href={`https://petlovearg.mitiendanube.com/admin/orders/${order.order_number}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-violet-600 bg-violet-50 rounded-lg hover:bg-violet-100 transition-colors"
                        >
                          <ExternalLink className="w-3 h-3" />
                          Ver en TN
                        </a>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
