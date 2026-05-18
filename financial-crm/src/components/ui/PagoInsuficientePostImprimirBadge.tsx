import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { DollarSign } from 'lucide-react';
import { authFetch } from '../../services/api';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

/**
 * Botón con badge en el header que muestra cuántos pedidos están en estado
 * post-impresión (hoja_impresa..por_enviar) con pago insuficiente para el
 * método actual. Cubre dos casos:
 *   1. Pago anulado / reembolsado después de imprimir la hoja.
 *   2. Cambio de método a Envío en un pedido con pago parcial.
 *
 * Al clickearlo navega a /orders con el filtro de alerta activo.
 */
export function PagoInsuficientePostImprimirBadge() {
  const navigate = useNavigate();
  const [count, setCount] = useState(0);

  const loadCount = useCallback(async () => {
    try {
      const response = await authFetch(`${API_BASE_URL}/orders/pago-insuficiente-post-imprimir-count`);
      if (!response.ok) return;
      const data = await response.json();
      setCount(data.count ?? 0);
    } catch {
      // silencioso — el badge desaparece si falla
    }
  }, []);

  useEffect(() => {
    loadCount();
    const interval = setInterval(loadCount, 60000);
    return () => clearInterval(interval);
  }, [loadCount]);

  const handleClick = () => {
    navigate('/orders?alert=pago_insuficiente_post_imprimir');
  };

  if (count === 0) return null;

  return (
    <button
      onClick={handleClick}
      className="relative p-2 text-red-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors"
      title="Pedidos impresos con pago insuficiente — ver lista"
    >
      <DollarSign size={20} />
      <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center text-xs font-semibold text-white bg-red-600 rounded-full px-1">
        {count > 99 ? '99+' : count}
      </span>
    </button>
  );
}
