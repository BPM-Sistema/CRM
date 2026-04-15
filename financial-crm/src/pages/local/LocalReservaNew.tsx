import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { ProductSearch } from '../../components/local/ProductSearch';
import { createLocalOrder, type ProductSearchResult } from '../../services/local-api';
import { AccessDenied } from '../../components/AccessDenied';

interface LineItem {
  key: string;
  product_id: number;
  variant_id?: string;
  product_name: string;
  variant_name?: string;
  sku?: string;
  qty: number;
  line_notes?: string;
}

export default function LocalReservaNew() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();

  const [items, setItems] = useState<LineItem[]>([]);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!hasPermission('local.orders.create')) return <AccessDenied />;

  const handleAddProduct = (product: ProductSearchResult) => {
    const key = `${product.product_id}-${product.variant_id || 'null'}`;
    const existing = items.find((i) => i.key === key);
    if (existing) {
      setItems(items.map((i) => i.key === key ? { ...i, qty: i.qty + 1 } : i));
    } else {
      setItems([...items, {
        key,
        product_id: product.product_id,
        variant_id: product.variant_id || undefined,
        product_name: product.product_name,
        variant_name: product.variant_name || undefined,
        sku: product.sku || undefined,
        qty: 1,
      }]);
    }
  };

  const handleUpdateQty = (key: string, qty: number) => {
    if (qty < 1) return;
    setItems(items.map((i) => i.key === key ? { ...i, qty } : i));
  };

  const handleRemove = (key: string) => {
    setItems(items.filter((i) => i.key !== key));
  };

  const handleSubmit = async () => {
    if (items.length === 0) {
      setError('Agregá al menos un producto');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const order = await createLocalOrder(
        items.map((i) => ({
          product_id: i.product_id,
          variant_id: i.variant_id,
          product_name: i.product_name,
          variant_name: i.variant_name,
          sku: i.sku,
          qty: i.qty,
          line_notes: i.line_notes,
        })),
        notes || undefined
      );
      navigate(`/local/reservas/${order.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al crear');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/local/reservas')}>
          <ArrowLeft size={16} />
        </Button>
        <div>
          <h1 className="text-xl font-bold text-neutral-900">Nueva Reserva</h1>
          <p className="text-sm text-neutral-500">Crear pedido interno al depósito</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-xl text-sm">{error}</div>
      )}

      <Card>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">Agregar productos</label>
            <ProductSearch onSelect={handleAddProduct} />
          </div>

          {items.length > 0 && (
            <div className="border border-neutral-200 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 border-b border-neutral-200">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium text-neutral-600">Producto</th>
                    <th className="px-4 py-2.5 text-left font-medium text-neutral-600">Variante</th>
                    <th className="px-4 py-2.5 text-center font-medium text-neutral-600 w-28">Cantidad</th>
                    <th className="px-4 py-2.5 text-right font-medium text-neutral-600 w-16"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.key} className="border-b border-neutral-100 last:border-0">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-neutral-900">{item.product_name}</div>
                        {item.sku && <div className="text-xs font-mono text-neutral-400">SKU: {item.sku}</div>}
                      </td>
                      <td className="px-4 py-2.5 text-neutral-600">{item.variant_name || '-'}</td>
                      <td className="px-4 py-2.5 text-center">
                        <input
                          type="number"
                          min={1}
                          value={item.qty}
                          onChange={(e) => handleUpdateQty(item.key, parseInt(e.target.value) || 1)}
                          className="w-20 text-center border border-neutral-300 rounded-lg px-2 py-1 text-sm focus:ring-2 focus:ring-sky-200 focus:border-sky-400 outline-none"
                        />
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button onClick={() => handleRemove(item.key)} className="text-red-400 hover:text-red-600 transition-colors">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">Notas internas (opcional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notas para el depósito..."
              rows={3}
              className="w-full border border-neutral-300 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-sky-200 focus:border-sky-400 outline-none resize-none"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => navigate('/local/reservas')}>
              Cancelar
            </Button>
            <Button onClick={handleSubmit} isLoading={loading} disabled={items.length === 0}>
              <Plus size={16} />
              Crear Reserva ({items.length} {items.length === 1 ? 'ítem' : 'items'})
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
