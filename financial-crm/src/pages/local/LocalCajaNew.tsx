import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { ProductSearch } from '../../components/local/ProductSearch';
import { fetchLocalStock, createBoxOrder, type LocalStockItem, type ProductSearchResult } from '../../services/local-api';
import { AccessDenied } from '../../components/AccessDenied';

interface LineItem {
  key: string;
  product_id: number;
  variant_id?: string;
  product_name: string;
  variant_name?: string;
  sku?: string;
  qty: number;
  unit_price: number;
  available: number;
}

export default function LocalCajaNew() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();

  const [items, setItems] = useState<LineItem[]>([]);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stockMap, setStockMap] = useState<Map<string, LocalStockItem>>(new Map());

  if (!hasPermission('local.box.create')) return <AccessDenied />;

  useEffect(() => {
    fetchLocalStock().then((stock) => {
      const map = new Map<string, LocalStockItem>();
      for (const item of stock) {
        const key = `${item.product_id}-${item.variant_id || 'null'}`;
        map.set(key, item);
      }
      setStockMap(map);
    }).catch(() => {});
  }, []);

  const handleAddProduct = (product: ProductSearchResult) => {
    const key = `${product.product_id}-${product.variant_id || 'null'}`;
    const stockItem = stockMap.get(key);
    const available = stockItem?.qty || 0;

    if (available <= 0) {
      setError(`${product.product_name} no tiene stock asignado al local`);
      return;
    }

    const existing = items.find((i) => i.key === key);
    if (existing) {
      if (existing.qty >= available) {
        setError(`Stock máximo alcanzado para ${product.product_name}: ${available}`);
        return;
      }
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
        unit_price: product.price || 0,
        available,
      }]);
    }
    setError(null);
  };

  const handleUpdateQty = (key: string, qty: number) => {
    const item = items.find((i) => i.key === key);
    if (!item || qty < 1 || qty > item.available) return;
    setItems(items.map((i) => i.key === key ? { ...i, qty } : i));
  };

  const handleUpdatePrice = (key: string, price: number) => {
    setItems(items.map((i) => i.key === key ? { ...i, unit_price: price } : i));
  };

  const handleRemove = (key: string) => {
    setItems(items.filter((i) => i.key !== key));
  };

  const total = items.reduce((s, i) => s + i.qty * i.unit_price, 0);

  const handleSubmit = async () => {
    if (items.length === 0) {
      setError('Agregá al menos un producto');
      return;
    }
    for (const item of items) {
      if (!item.unit_price || item.unit_price <= 0) {
        setError(`El precio de "${item.product_name}" debe ser mayor a 0`);
        return;
      }
    }
    setLoading(true);
    setError(null);
    try {
      const order = await createBoxOrder(
        items.map((i) => ({
          product_id: i.product_id,
          variant_id: i.variant_id,
          product_name: i.product_name,
          variant_name: i.variant_name,
          sku: i.sku,
          qty: i.qty,
          unit_price: i.unit_price,
        })),
        notes || undefined
      );
      navigate(`/local/caja/${order.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al crear');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/local/caja')}>
          <ArrowLeft size={16} />
        </Button>
        <div>
          <h1 className="text-xl font-bold text-neutral-900">Nuevo Pedido de Caja</h1>
          <p className="text-sm text-neutral-500">Venta con stock asignado al local</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-xl text-sm">{error}</div>
      )}

      <Card>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">Agregar productos (stock del local)</label>
            <ProductSearch onSelect={handleAddProduct} placeholder="Buscar en stock del local..." />
          </div>

          {items.length > 0 && (
            <div className="border border-neutral-200 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 border-b border-neutral-200">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium text-neutral-600">Producto</th>
                    <th className="px-4 py-2.5 text-left font-medium text-neutral-600">Variante</th>
                    <th className="px-4 py-2.5 text-center font-medium text-neutral-600 w-20">Stock</th>
                    <th className="px-4 py-2.5 text-center font-medium text-neutral-600 w-24">Qty</th>
                    <th className="px-4 py-2.5 text-right font-medium text-neutral-600 w-28">Precio</th>
                    <th className="px-4 py-2.5 text-right font-medium text-neutral-600 w-28">Total</th>
                    <th className="px-4 py-2.5 w-12"></th>
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
                        <span className="text-xs bg-neutral-100 px-2 py-0.5 rounded font-medium">{item.available}</span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <input
                          type="number"
                          min={1}
                          max={item.available}
                          value={item.qty}
                          onChange={(e) => handleUpdateQty(item.key, parseInt(e.target.value) || 1)}
                          className="w-20 text-center border border-neutral-300 rounded-lg px-2 py-1 text-sm focus:ring-2 focus:ring-sky-200 focus:border-sky-400 outline-none"
                        />
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <span className="text-neutral-400">$</span>
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            value={item.unit_price}
                            onChange={(e) => handleUpdatePrice(item.key, parseFloat(e.target.value) || 0)}
                            className="w-24 text-right border border-neutral-300 rounded-lg px-2 py-1 text-sm font-mono focus:ring-2 focus:ring-sky-200 focus:border-sky-400 outline-none"
                          />
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-semibold">
                        ${(item.qty * item.unit_price).toLocaleString('es-AR')}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <button onClick={() => handleRemove(item.key)} className="text-red-400 hover:text-red-600 transition-colors">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-neutral-50 border-t border-neutral-200">
                    <td colSpan={5} className="px-4 py-3 text-right font-semibold text-neutral-700">TOTAL</td>
                    <td className="px-4 py-3 text-right font-mono font-bold text-lg text-neutral-900">
                      ${total.toLocaleString('es-AR')}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">Notas (opcional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notas del pedido..."
              rows={2}
              className="w-full border border-neutral-300 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-sky-200 focus:border-sky-400 outline-none resize-none"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => navigate('/local/caja')}>Cancelar</Button>
            <Button onClick={handleSubmit} isLoading={loading} disabled={items.length === 0}>
              <Plus size={16} />
              Crear Pedido (${total.toLocaleString('es-AR')})
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
