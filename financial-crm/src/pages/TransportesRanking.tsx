import { useEffect, useMemo, useState } from 'react';
import { Truck, Search, Copy, Check } from 'lucide-react';
import { Header } from '../components/layout';
import { Card } from '../components/ui';
import { authFetch } from '../services/api';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

interface TransporteRow {
  transporte: string;
  cantidad: number;
}

interface RankingResponse {
  ok: boolean;
  provincias: string[];
  ranking: Record<string, TransporteRow[]>;
}

export function TransportesRanking() {
  const [data, setData] = useState<RankingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [provinciaSel, setProvinciaSel] = useState<string>('');
  const [search, setSearch] = useState('');
  const [copiadoProv, setCopiadoProv] = useState<string | null>(null);

  useEffect(() => {
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await authFetch(`${API_BASE_URL}/shipping-data/ranking`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: RankingResponse = await res.json();
        setData(json);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error al cargar datos');
      } finally {
        setLoading(false);
      }
    };
    run();
  }, []);

  const provincias = useMemo(() => {
    if (!data) return [];
    const filtered = search.trim()
      ? data.provincias.filter(p => p.toLowerCase().includes(search.trim().toLowerCase()))
      : data.provincias;
    return filtered;
  }, [data, search]);

  const rankingFiltrado = useMemo(() => {
    if (!data) return [];
    if (provinciaSel) {
      const filas = data.ranking[provinciaSel] || [];
      return [{ provincia: provinciaSel, filas }];
    }
    return provincias.map(p => ({ provincia: p, filas: data.ranking[p] || [] }));
  }, [data, provincias, provinciaSel]);

  const totalProvincia = (filas: TransporteRow[]) =>
    filas.reduce((sum, f) => sum + f.cantidad, 0);

  const mensajeParaCliente = (provincia: string, filas: TransporteRow[]): string => {
    const top = filas.slice(0, 10).map(f => `• ${f.transporte}`).join('\n');
    return `¡Mira! Tenemos estos expresos y transportes que recopilamos de pedidos de clientes de tu ${provincia}. Los más elegidos son:\n\n${top}\n\nSi querés, podés elegir uno de estos y nosotros se lo entregamos sin problemas!`;
  };

  const copiarMensaje = async (provincia: string, filas: TransporteRow[]) => {
    try {
      await navigator.clipboard.writeText(mensajeParaCliente(provincia, filas));
      setCopiadoProv(provincia);
      setTimeout(() => setCopiadoProv(prev => (prev === provincia ? null : prev)), 2000);
    } catch {
      alert('No se pudo copiar al portapapeles');
    }
  };

  return (
    <div className="min-h-screen bg-neutral-50">
      <Header
        title="Transportes por provincia"
        subtitle="Ranking histórico basado en los formularios de envío completados"
      />

      <div className="px-3 md:px-6 py-4 md:py-6 space-y-4 md:space-y-6">
        <Card padding="sm">
          <div className="flex flex-col md:flex-row gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-neutral-600 mb-1.5">
                Filtrar por provincia
              </label>
              <select
                value={provinciaSel}
                onChange={(e) => setProvinciaSel(e.target.value)}
                className="w-full appearance-none rounded-lg border border-neutral-200 bg-white px-3.5 py-2 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900"
              >
                <option value="">Todas las provincias</option>
                {data?.provincias.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>

            <div className="flex-1">
              <label className="block text-xs font-medium text-neutral-600 mb-1.5">
                Buscar provincia (cuando veo todas)
              </label>
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
                <input
                  type="text"
                  value={search}
                  disabled={!!provinciaSel}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Ej: buenos aires"
                  className="w-full rounded-lg border border-neutral-200 bg-white pl-9 pr-3 py-2 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900 disabled:bg-neutral-50"
                />
              </div>
            </div>
          </div>
        </Card>

        {loading && (
          <Card padding="md">
            <p className="text-sm text-neutral-500">Cargando ranking…</p>
          </Card>
        )}

        {error && (
          <Card padding="md">
            <p className="text-sm text-red-600">Error: {error}</p>
          </Card>
        )}

        {!loading && !error && rankingFiltrado.length === 0 && (
          <Card padding="md">
            <p className="text-sm text-neutral-500">Sin datos para mostrar.</p>
          </Card>
        )}

        {!loading && !error && rankingFiltrado.map(({ provincia, filas }) => (
          <Card key={provincia} padding="none">
            <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-100 gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <Truck size={18} className="text-neutral-500 flex-shrink-0" />
                <h3 className="font-semibold text-neutral-900 truncate">{provincia}</h3>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <span className="hidden md:inline text-xs text-neutral-500">
                  {totalProvincia(filas)} envíos · {filas.length} transportes
                </span>
                {filas.length > 0 && (
                  <button
                    onClick={() => copiarMensaje(provincia, filas)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      copiadoProv === provincia
                        ? 'bg-green-100 text-green-700'
                        : 'bg-neutral-900 text-white hover:bg-neutral-800'
                    }`}
                    title="Copiar mensaje para cliente"
                  >
                    {copiadoProv === provincia ? (
                      <><Check size={14} /> Copiado</>
                    ) : (
                      <><Copy size={14} /> Copiar mensaje</>
                    )}
                  </button>
                )}
              </div>
            </div>
            {filas.length === 0 ? (
              <div className="px-5 py-4 text-sm text-neutral-500">
                Sin registros.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-neutral-50 text-neutral-500">
                    <tr>
                      <th className="text-left px-5 py-2 font-medium w-10">#</th>
                      <th className="text-left px-5 py-2 font-medium">Transporte / Expreso</th>
                      <th className="text-right px-5 py-2 font-medium w-28">Elecciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filas.map((f, i) => (
                      <tr key={f.transporte} className="border-t border-neutral-100">
                        <td className="px-5 py-2 text-neutral-400">{i + 1}</td>
                        <td className="px-5 py-2 text-neutral-900">{f.transporte}</td>
                        <td className="px-5 py-2 text-right font-semibold text-neutral-900">
                          {f.cantidad}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
