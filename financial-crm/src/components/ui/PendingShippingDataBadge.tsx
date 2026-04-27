import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Truck } from 'lucide-react';
import { fetchPendingShippingDataCount } from '../../services/api';

// Botón con badge que muestra cuántos pedidos están pendientes de datos de
// envío (requieren formulario + tienen comprobante = ya se les pidió + aún
// no cargaron). Click navega al listado filtrado por "Pendiente".
export function PendingShippingDataBadge() {
  const navigate = useNavigate();
  const [count, setCount] = useState(0);

  const loadCount = async () => {
    try {
      const c = await fetchPendingShippingDataCount();
      setCount(c);
    } catch {
      // silencioso: si falla, no mostramos badge.
    }
  };

  useEffect(() => {
    loadCount();
    const interval = setInterval(loadCount, 60000); // refrescar cada minuto
    return () => clearInterval(interval);
  }, []);

  const handleClick = () => {
    navigate('/pedidos?shipping_data=pending');
  };

  return (
    <button
      onClick={handleClick}
      className="relative p-2 text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 rounded-lg transition-colors"
      title="Pedidos pendientes de datos de envío"
    >
      <Truck size={20} />
      {count > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center text-xs font-semibold text-white bg-amber-500 rounded-full px-1">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}
