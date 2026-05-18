import { useEffect, useMemo, useState } from 'react';
import { Star, Send, RefreshCw, Copy } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { authFetch } from '../services/api';
import { AccessDenied } from '../components/AccessDenied';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

interface EligibleRow {
  order_number: number;
  customer_name: string | null;
  customer_phone: string;
  shipped_at: string;
  days_since_shipped: number;
}

interface SentLinkRow {
  id: number;
  order_number: number;
  customer_name: string | null;
  customer_phone: string;
  token: string;
  status: 'pending' | 'sent' | 'failed';
  send_error: string | null;
  created_at: string;
  sent_at: string | null;
  clicked_at: string | null;
  click_count: number;
}

interface Stats {
  total_sent: number;
  total_failed: number;
  total_clicked: number;
  sent_last_7d: number;
  clicked_last_7d: number;
  sent_last_30d: number;
  clicked_last_30d: number;
  conversion_rate: number;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function StatusBadge({ row }: { row: SentLinkRow }) {
  if (row.status === 'failed') return <Badge variant="danger">Falló</Badge>;
  if (row.clicked_at) return <Badge variant="success">Clickeado ({row.click_count})</Badge>;
  if (row.status === 'sent') return <Badge variant="info">Enviado</Badge>;
  return <Badge variant="default">Pendiente</Badge>;
}

export default function MarketingReviews() {
  const { hasPermission } = useAuth();
  const canSend = hasPermission('marketing.reviews.send');

  if (!hasPermission('marketing.reviews.view')) return <AccessDenied />;

  const [eligible, setEligible] = useState<EligibleRow[]>([]);
  const [selectedOrders, setSelectedOrders] = useState<Set<number>>(new Set());
  const [sentLinks, setSentLinks] = useState<SentLinkRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [eligibleRes, listRes, statsRes] = await Promise.all([
        authFetch(`${API_BASE_URL}/marketing/reviews/eligible`),
        authFetch(`${API_BASE_URL}/marketing/reviews/list?days=30`),
        authFetch(`${API_BASE_URL}/marketing/reviews/stats`),
      ]);

      if (!eligibleRes.ok) throw new Error('Error cargando elegibles');
      if (!listRes.ok) throw new Error('Error cargando historial');
      if (!statsRes.ok) throw new Error('Error cargando stats');

      const [eligibleJson, listJson, statsJson] = await Promise.all([
        eligibleRes.json(), listRes.json(), statsRes.json(),
      ]);

      setEligible(eligibleJson.eligible || []);
      setSentLinks(listJson.items || []);
      setStats(statsJson || null);
    } catch (e: any) {
      setError(e?.message || 'Error desconocido');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

  const toggleOrder = (orderNumber: number) => {
    const next = new Set(selectedOrders);
    if (next.has(orderNumber)) next.delete(orderNumber);
    else next.add(orderNumber);
    setSelectedOrders(next);
  };

  const toggleAll = () => {
    if (selectedOrders.size === eligible.length) {
      setSelectedOrders(new Set());
    } else {
      setSelectedOrders(new Set(eligible.map(e => e.order_number)));
    }
  };

  const sendBatch = async () => {
    if (selectedOrders.size === 0) {
      setMessage({ kind: 'err', text: 'Seleccioná al menos un pedido' });
      return;
    }
    const count = selectedOrders.size;
    const confirmText = `Vas a mandar ${count} mensaje${count === 1 ? '' : 's'} de WhatsApp pidiendo reseña. ¿Confirmás?`;
    if (!window.confirm(confirmText)) return;

    setSending(true);
    setMessage(null);
    try {
      const res = await authFetch(`${API_BASE_URL}/marketing/reviews/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_numbers: Array.from(selectedOrders) }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || 'Error al enviar');

      setMessage({
        kind: j.failed === 0 ? 'ok' : 'err',
        text: `Enviados: ${j.sent} · Fallaron: ${j.failed} (de ${j.attempted} intentos)`,
      });
      setSelectedOrders(new Set());
      await loadAll();
    } catch (e: any) {
      setMessage({ kind: 'err', text: e?.message || 'Error al enviar' });
    } finally {
      setSending(false);
    }
  };

  const conversionLast30 = useMemo(() => {
    if (!stats || stats.sent_last_30d === 0) return 0;
    return Math.round((stats.clicked_last_30d / stats.sent_last_30d) * 1000) / 10;
  }, [stats]);

  return (
    <div className="max-w-7xl mx-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900 flex items-center gap-2">
            <Star size={24} className="text-amber-500" />
            Reseñas Google
          </h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            Pedidos enviados hace ≤ 8 días reciben un WhatsApp con link de reseña trackeable
          </p>
        </div>
        <Button onClick={loadAll} variant="secondary" disabled={loading}>
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          <span className="ml-2">Refrescar</span>
        </Button>
      </div>

      {/* Mensaje de resultado */}
      {message && (
        <div className={`p-3 rounded-lg text-sm ${
          message.kind === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
        }`}>
          {message.text}
        </div>
      )}

      {error && (
        <div className="p-3 rounded-lg text-sm bg-red-50 text-red-700">{error}</div>
      )}

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="p-4">
            <div className="text-xs text-neutral-500">Enviados (total)</div>
            <div className="text-2xl font-semibold tabular-nums">{stats.total_sent}</div>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-neutral-500">Clickearon (total)</div>
            <div className="text-2xl font-semibold tabular-nums text-emerald-700">{stats.total_clicked}</div>
            <div className="text-xs text-neutral-400 mt-0.5">{stats.conversion_rate}% conversión</div>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-neutral-500">Últimos 7 días</div>
            <div className="text-2xl font-semibold tabular-nums">{stats.sent_last_7d}</div>
            <div className="text-xs text-neutral-400 mt-0.5">{stats.clicked_last_7d} clicks</div>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-neutral-500">Últimos 30 días</div>
            <div className="text-2xl font-semibold tabular-nums">{stats.sent_last_30d}</div>
            <div className="text-xs text-neutral-400 mt-0.5">
              {stats.clicked_last_30d} clicks · {conversionLast30}%
            </div>
          </Card>
        </div>
      )}

      {/* Elegibles */}
      <Card className="p-0 overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-neutral-100">
          <div>
            <h2 className="font-semibold text-neutral-900">Pedidos elegibles</h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              Enviados hace 0–8 días, con teléfono, sin pedido de reseña previo
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-neutral-500">
              {selectedOrders.size} / {eligible.length} seleccionados
            </span>
            {canSend && (
              <Button
                onClick={sendBatch}
                disabled={sending || selectedOrders.size === 0}
              >
                <Send size={16} />
                <span className="ml-2">
                  {sending ? 'Enviando...' : `Mandar a ${selectedOrders.size}`}
                </span>
              </Button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="p-8 text-center text-neutral-500">Cargando...</div>
        ) : eligible.length === 0 ? (
          <div className="p-8 text-center text-neutral-500">
            No hay pedidos elegibles ahora mismo.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-xs text-neutral-500 uppercase">
                <tr>
                  <th className="px-3 py-2 text-left w-10">
                    <input
                      type="checkbox"
                      checked={selectedOrders.size === eligible.length && eligible.length > 0}
                      onChange={toggleAll}
                    />
                  </th>
                  <th className="px-3 py-2 text-left">Pedido</th>
                  <th className="px-3 py-2 text-left">Cliente</th>
                  <th className="px-3 py-2 text-left">Teléfono</th>
                  <th className="px-3 py-2 text-left">Enviado</th>
                  <th className="px-3 py-2 text-right">Días</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {eligible.map(row => (
                  <tr key={row.order_number} className="hover:bg-neutral-50">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedOrders.has(row.order_number)}
                        onChange={() => toggleOrder(row.order_number)}
                      />
                    </td>
                    <td className="px-3 py-2 font-mono">#{row.order_number}</td>
                    <td className="px-3 py-2">{row.customer_name || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{row.customer_phone}</td>
                    <td className="px-3 py-2 text-neutral-500">{formatDate(row.shipped_at)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {Math.round(Number(row.days_since_shipped) * 10) / 10}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Historial */}
      <Card className="p-0 overflow-hidden">
        <div className="p-4 border-b border-neutral-100">
          <h2 className="font-semibold text-neutral-900">Historial (últimos 30 días)</h2>
          <p className="text-xs text-neutral-500 mt-0.5">
            {sentLinks.length} pedidos enviados
          </p>
        </div>
        {sentLinks.length === 0 ? (
          <div className="p-8 text-center text-neutral-500">Sin envíos aún.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 text-xs text-neutral-500 uppercase">
                <tr>
                  <th className="px-3 py-2 text-left">Pedido</th>
                  <th className="px-3 py-2 text-left">Cliente</th>
                  <th className="px-3 py-2 text-left">Estado</th>
                  <th className="px-3 py-2 text-left">Enviado</th>
                  <th className="px-3 py-2 text-left">Clickeado</th>
                  <th className="px-3 py-2 text-left">Link</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {sentLinks.map(row => (
                  <tr key={row.id} className="hover:bg-neutral-50">
                    <td className="px-3 py-2 font-mono">#{row.order_number}</td>
                    <td className="px-3 py-2">
                      <div>{row.customer_name || '—'}</div>
                      <div className="text-xs text-neutral-400 font-mono">{row.customer_phone}</div>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge row={row} />
                      {row.send_error && (
                        <div className="text-xs text-red-500 mt-0.5">{row.send_error}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-neutral-500">{formatDate(row.sent_at)}</td>
                    <td className="px-3 py-2 text-neutral-500">{formatDate(row.clicked_at)}</td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(`${window.location.origin}/resena/${row.token}`);
                          setMessage({ kind: 'ok', text: 'Link copiado' });
                        }}
                        className="text-neutral-400 hover:text-neutral-700"
                        title="Copiar link"
                      >
                        <Copy size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
