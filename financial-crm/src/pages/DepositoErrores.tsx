/**
 * Panel de errores de revisión por empleado.
 *
 * Lista los empleados activos con: cantidad de pedidos que prepararon
 * (= transiciones únicas a en_revision) y total de errores que el revisor
 * encontró cuando los controló. Filtro por rango de fechas (default 30 días).
 */

import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Header } from '../components/layout';
import { Switch } from '../components/ui/Switch';
import {
  fetchRevisionErrors,
  RevisionErrorRow,
} from '../services/deposito-api';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const today = new Date();
const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

export function DepositoErrores() {
  const [desde, setDesde] = useState<string>(isoDate(thirtyDaysAgo));
  const [hasta, setHasta] = useState<string>(isoDate(today));
  const [rows, setRows] = useState<RevisionErrorRow[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const desdeISO = new Date(desde + 'T00:00:00').toISOString();
      const hastaISO = new Date(hasta + 'T23:59:59').toISOString();
      const r = await fetchRevisionErrors(desdeISO, hastaISO);
      setRows(r.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar errores');
    } finally {
      setLoading(false);
    }
  }, [desde, hasta]);

  useEffect(() => { load(); }, [load]);

  const visible = rows.filter(r => showInactive || r.active);
  const totalErrores = visible.reduce((sum, r) => sum + r.total_errores, 0);
  const totalPedidos = visible.reduce((sum, r) => sum + r.pedidos_preparados, 0);

  return (
    <>
      <Header
        title="Errores de revisión"
        subtitle="Cantidad de errores detectados por el encargado, por empleado preparador"
        actions={
          <Link
            to="/deposito"
            className="flex items-center gap-2 px-3 py-2 text-sm text-neutral-600 hover:text-neutral-900"
          >
            <ArrowLeft size={16} /> Volver al panel
          </Link>
        }
      />

      <div className="p-4 space-y-4">
        {/* Filtros de fecha */}
        <div className="bg-white rounded-2xl shadow-sm p-4 flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-1">Desde</label>
            <input
              type="date"
              value={desde}
              onChange={e => setDesde(e.target.value)}
              max={hasta}
              className="border border-neutral-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-1">Hasta</label>
            <input
              type="date"
              value={hasta}
              onChange={e => setHasta(e.target.value)}
              min={desde}
              max={isoDate(today)}
              className="border border-neutral-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div className="ml-auto text-sm text-neutral-600">
            <div><span className="text-neutral-400">Pedidos:</span> <strong>{totalPedidos}</strong></div>
            <div><span className="text-neutral-400">Errores totales:</span> <strong className={totalErrores > 0 ? 'text-red-600' : ''}>{totalErrores}</strong></div>
          </div>
        </div>

        {/* Toggle inactivos */}
        <div className="flex items-center">
          <label className="flex items-center gap-3 text-sm text-neutral-700 cursor-pointer select-none">
            <Switch checked={showInactive} onChange={() => setShowInactive(v => !v)} />
            Mostrar inactivos
          </label>
        </div>

        {/* Tabla */}
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-200">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-neutral-600">Empleado</th>
                <th className="px-4 py-3 text-right font-semibold text-neutral-600">Pedidos preparados</th>
                <th className="px-4 py-3 text-right font-semibold text-neutral-600">Errores totales</th>
                <th className="px-4 py-3 text-right font-semibold text-neutral-600">Promedio / pedido</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-neutral-400">Cargando…</td></tr>
              )}
              {!loading && error && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-red-600">{error}</td></tr>
              )}
              {!loading && !error && visible.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-neutral-400">Sin datos en el rango seleccionado</td></tr>
              )}
              {!loading && visible.map(r => (
                <tr key={r.warehouse_user_id} className={`border-b border-neutral-100 ${!r.active ? 'opacity-60' : ''}`}>
                  <td className="px-4 py-2 font-medium">{r.nombre}</td>
                  <td className="px-4 py-2 text-right text-neutral-700">{r.pedidos_preparados}</td>
                  <td className={`px-4 py-2 text-right font-semibold ${r.total_errores > 0 ? 'text-red-600' : 'text-neutral-400'}`}>
                    {r.total_errores}
                  </td>
                  <td className="px-4 py-2 text-right text-neutral-600">
                    {r.promedio !== null ? r.promedio.toFixed(2) : <span className="text-neutral-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
