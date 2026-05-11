/**
 * ABM de empleados del depósito (Fase 2 PR 7b).
 *
 * Tabla con: nombre / estado / count permisos / última acción / acciones.
 * Toggle "Mostrar inactivos" (default oculto).
 * Modal crear: nombre + matriz de permisos → al confirmar muestra el código.
 * Acciones por fila (visibles según permisos del admin):
 *   - Ver código (deposito.ver_codigos)
 *   - Regenerar código (deposito.modificar_codigos)
 *   - Editar permisos (deposito.modificar_actividades)
 *   - Editar nombre / Desactivar / Reactivar (deposito.gestionar_empleados)
 */

import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { parseISO, formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import { Plus, ArrowLeft } from 'lucide-react';
import { Header } from '../components/layout';
import { useAuth } from '../contexts/AuthContext';
import {
  fetchEmployees,
  fetchEmployeePermissions,
  createEmployee,
  updateEmployee,
  updateEmployeePermissions,
  fetchEmployeeCode,
  regenerateEmployeeCode,
  EmployeeRow,
} from '../services/deposito-api';

const TRANSITIONS = [
  { value: 'en_preparacion',  label: 'En Preparación'  },
  { value: 'en_revision',     label: 'En Revisión'     },
  { value: 'pendiente_stock', label: 'Pend. Stock'     },
  { value: 'por_empaquetar',  label: 'Por Empaquetar'  },
  { value: 'empaquetado',     label: 'Empaquetado'     },
];

interface ModalState {
  type: 'create' | 'edit-name' | 'edit-perms' | 'show-code' | 'confirm-regenerate' | 'confirm-deactivate' | 'show-new-code' | null;
  employee?: EmployeeRow;
  code?: string;
  permissions?: string[];
}

export function DepositoEmpleados() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('deposito.gestionar_empleados');
  const canModifyPerms = hasPermission('deposito.modificar_actividades');
  const canViewPerms = hasPermission('deposito.ver_actividades');
  const canViewCode = hasPermission('deposito.ver_codigos');
  const canRegenCode = hasPermission('deposito.modificar_codigos');

  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>({ type: null });

  // Form state.
  const [formNombre, setFormNombre] = useState('');
  const [formPermissions, setFormPermissions] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchEmployees();
      setEmployees(r.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al cargar empleados');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = employees.filter(e => showInactive || e.active);

  // ─── Handlers ──────────────────────────────────────────

  const openCreate = () => {
    setFormNombre('');
    setFormPermissions(TRANSITIONS.map(t => t.value)); // por default todas tildadas
    setModal({ type: 'create' });
    setError(null);
  };

  const openEditName = (e: EmployeeRow) => {
    setFormNombre(e.nombre);
    setModal({ type: 'edit-name', employee: e });
    setError(null);
  };

  const openEditPerms = async (e: EmployeeRow) => {
    setSubmitting(true);
    try {
      const r = await fetchEmployeePermissions(e.id);
      setFormPermissions(r.permissions);
      setModal({ type: 'edit-perms', employee: e });
      setError(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error al cargar permisos');
    } finally {
      setSubmitting(false);
    }
  };

  const openShowCode = async (e: EmployeeRow) => {
    setSubmitting(true);
    try {
      const r = await fetchEmployeeCode(e.id);
      setModal({ type: 'show-code', employee: e, code: r.codigo });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error al obtener código');
    } finally {
      setSubmitting(false);
    }
  };

  const submitCreate = async () => {
    if (!formNombre.trim()) { setError('El nombre es obligatorio'); return; }
    setSubmitting(true);
    setError(null);
    try {
      const r = await createEmployee({ nombre: formNombre.trim(), permissions: formPermissions });
      await load();
      setModal({ type: 'show-new-code', code: r.employee.codigo, employee: { id: r.employee.id, nombre: r.employee.nombre, active: r.employee.active } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al crear');
    } finally {
      setSubmitting(false);
    }
  };

  const submitEditName = async () => {
    if (!modal.employee) return;
    if (!formNombre.trim()) { setError('El nombre no puede estar vacío'); return; }
    setSubmitting(true);
    setError(null);
    try {
      await updateEmployee(modal.employee.id, { nombre: formNombre.trim() });
      await load();
      setModal({ type: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al actualizar');
    } finally {
      setSubmitting(false);
    }
  };

  const submitEditPerms = async () => {
    if (!modal.employee) return;
    setSubmitting(true);
    setError(null);
    try {
      await updateEmployeePermissions(modal.employee.id, formPermissions);
      await load();
      setModal({ type: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar permisos');
    } finally {
      setSubmitting(false);
    }
  };

  const confirmRegenerate = async () => {
    if (!modal.employee) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await regenerateEmployeeCode(modal.employee.id);
      setModal({ type: 'show-new-code', employee: modal.employee, code: r.codigo });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al regenerar');
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDeactivate = async () => {
    if (!modal.employee) return;
    setSubmitting(true);
    setError(null);
    try {
      await updateEmployee(modal.employee.id, { active: !modal.employee.active });
      await load();
      setModal({ type: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al actualizar estado');
    } finally {
      setSubmitting(false);
    }
  };

  const togglePermission = (t: string) => {
    setFormPermissions(prev =>
      prev.includes(t) ? prev.filter(p => p !== t) : [...prev, t]
    );
  };

  // ─── Render ────────────────────────────────────────────

  return (
    <>
      <Header
        title="Empleados del Depósito"
        subtitle="Gestión de empleados, códigos y permisos"
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
        {/* Header de la tabla */}
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={e => setShowInactive(e.target.checked)}
              className="w-4 h-4"
            />
            Mostrar inactivos
          </label>
          {canManage && (
            <button
              onClick={openCreate}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg"
            >
              <Plus size={16} /> Nuevo empleado
            </button>
          )}
        </div>

        {/* Tabla */}
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 border-b border-neutral-200">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-neutral-600">Nombre</th>
                <th className="px-4 py-3 text-left font-semibold text-neutral-600">Estado</th>
                <th className="px-4 py-3 text-left font-semibold text-neutral-600">Permisos</th>
                <th className="px-4 py-3 text-left font-semibold text-neutral-600">Última acción</th>
                <th className="px-4 py-3 text-right font-semibold text-neutral-600">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-neutral-400">Cargando…</td></tr>
              )}
              {!loading && error && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-red-600">{error}</td></tr>
              )}
              {!loading && !error && visible.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-neutral-400">Sin empleados {showInactive ? '' : 'activos'}</td></tr>
              )}
              {!loading && visible.map(e => (
                <tr key={e.id} className={`border-b border-neutral-100 ${!e.active ? 'opacity-60' : ''}`}>
                  <td className="px-4 py-2 font-medium">{e.nombre}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${e.active ? 'bg-emerald-100 text-emerald-700' : 'bg-neutral-200 text-neutral-600'}`}>
                      {e.active ? 'Activo' : 'Inactivo'}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-neutral-700">{e.permissions_count ?? 0} / {TRANSITIONS.length}</td>
                  <td className="px-4 py-2 text-neutral-500">
                    {e.last_action_at
                      ? formatDistanceToNow(parseISO(e.last_action_at), { addSuffix: true, locale: es })
                      : <span className="italic">nunca</span>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex justify-end gap-1 flex-wrap">
                      {canViewCode && (
                        <button onClick={() => openShowCode(e)} disabled={submitting} className="px-2 py-1 text-xs bg-neutral-100 hover:bg-neutral-200 rounded">Ver código</button>
                      )}
                      {canRegenCode && (
                        <button onClick={() => setModal({ type: 'confirm-regenerate', employee: e })} className="px-2 py-1 text-xs bg-amber-100 hover:bg-amber-200 text-amber-800 rounded">Regenerar</button>
                      )}
                      {canViewPerms && (
                        <button onClick={() => openEditPerms(e)} disabled={submitting || !canModifyPerms} className="px-2 py-1 text-xs bg-neutral-100 hover:bg-neutral-200 rounded">Permisos</button>
                      )}
                      {canManage && (
                        <>
                          <button onClick={() => openEditName(e)} className="px-2 py-1 text-xs bg-neutral-100 hover:bg-neutral-200 rounded">Editar</button>
                          <button onClick={() => setModal({ type: 'confirm-deactivate', employee: e })} className={`px-2 py-1 text-xs rounded ${e.active ? 'bg-red-100 hover:bg-red-200 text-red-700' : 'bg-emerald-100 hover:bg-emerald-200 text-emerald-700'}`}>
                            {e.active ? 'Desactivar' : 'Reactivar'}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── MODAL ─── */}
      {modal.type && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto">
            {/* CREATE */}
            {modal.type === 'create' && (
              <div className="p-5 space-y-4">
                <h2 className="text-lg font-bold">Nuevo empleado</h2>
                {error && <div className="bg-red-50 border border-red-200 rounded p-2 text-sm text-red-700">{error}</div>}
                <div>
                  <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-1">Nombre</label>
                  <input
                    type="text"
                    value={formNombre}
                    onChange={e => setFormNombre(e.target.value)}
                    className="w-full border border-neutral-300 rounded-lg px-3 py-2"
                    placeholder="Nombre del empleado"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-2">Permisos</label>
                  <div className="space-y-2">
                    {TRANSITIONS.map(t => (
                      <label key={t.value} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formPermissions.includes(t.value)}
                          onChange={() => togglePermission(t.value)}
                          className="w-4 h-4"
                        />
                        <span className="text-sm">{t.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2 pt-2">
                  <button onClick={() => setModal({ type: null })} disabled={submitting} className="flex-1 py-2 bg-neutral-200 rounded-lg">Cancelar</button>
                  <button onClick={submitCreate} disabled={submitting} className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white font-semibold rounded-lg">
                    {submitting ? 'Creando…' : 'Crear'}
                  </button>
                </div>
              </div>
            )}

            {/* EDIT NAME */}
            {modal.type === 'edit-name' && modal.employee && (
              <div className="p-5 space-y-4">
                <h2 className="text-lg font-bold">Editar nombre</h2>
                {error && <div className="bg-red-50 border border-red-200 rounded p-2 text-sm text-red-700">{error}</div>}
                <input
                  type="text"
                  value={formNombre}
                  onChange={e => setFormNombre(e.target.value)}
                  className="w-full border border-neutral-300 rounded-lg px-3 py-2"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button onClick={() => setModal({ type: null })} disabled={submitting} className="flex-1 py-2 bg-neutral-200 rounded-lg">Cancelar</button>
                  <button onClick={submitEditName} disabled={submitting} className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white font-semibold rounded-lg">Guardar</button>
                </div>
              </div>
            )}

            {/* EDIT PERMS */}
            {modal.type === 'edit-perms' && modal.employee && (
              <div className="p-5 space-y-4">
                <h2 className="text-lg font-bold">Permisos de {modal.employee.nombre}</h2>
                {error && <div className="bg-red-50 border border-red-200 rounded p-2 text-sm text-red-700">{error}</div>}
                <p className="text-xs text-neutral-500">Tildá las transiciones que este empleado puede disparar desde el QR.</p>
                <div className="space-y-2">
                  {TRANSITIONS.map(t => (
                    <label key={t.value} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formPermissions.includes(t.value)}
                        onChange={() => togglePermission(t.value)}
                        disabled={!canModifyPerms}
                        className="w-4 h-4"
                      />
                      <span className="text-sm">{t.label}</span>
                    </label>
                  ))}
                </div>
                <div className="flex gap-2 pt-2">
                  <button onClick={() => setModal({ type: null })} disabled={submitting} className="flex-1 py-2 bg-neutral-200 rounded-lg">Cancelar</button>
                  {canModifyPerms && (
                    <button onClick={submitEditPerms} disabled={submitting} className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white font-semibold rounded-lg">Guardar</button>
                  )}
                </div>
              </div>
            )}

            {/* SHOW CODE */}
            {modal.type === 'show-code' && modal.employee && modal.code && (
              <div className="p-5 space-y-4 text-center">
                <h2 className="text-lg font-bold">Código de {modal.employee.nombre}</h2>
                <p className="text-5xl font-mono font-bold tracking-widest text-neutral-900 py-4">{modal.code}</p>
                <button onClick={() => setModal({ type: null })} className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg">Cerrar</button>
              </div>
            )}

            {/* SHOW NEW CODE (después de crear o regenerar) */}
            {modal.type === 'show-new-code' && modal.employee && modal.code && (
              <div className="p-5 space-y-4 text-center">
                <h2 className="text-lg font-bold">Código de {modal.employee.nombre}</h2>
                <p className="text-sm text-neutral-600">Anotá este código. El empleado lo va a usar en el QR.</p>
                <div className="bg-amber-50 border-2 border-amber-300 rounded-xl py-4">
                  <p className="text-5xl font-mono font-bold tracking-widest text-amber-900">{modal.code}</p>
                </div>
                <button onClick={() => setModal({ type: null })} className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg">Entendido</button>
              </div>
            )}

            {/* CONFIRM REGENERATE */}
            {modal.type === 'confirm-regenerate' && modal.employee && (
              <div className="p-5 space-y-4">
                <h2 className="text-lg font-bold">¿Regenerar código?</h2>
                {error && <div className="bg-red-50 border border-red-200 rounded p-2 text-sm text-red-700">{error}</div>}
                <p className="text-sm text-neutral-700">
                  El código actual de <strong>{modal.employee.nombre}</strong> va a dejar de funcionar inmediatamente. Vas a tener que avisarle el código nuevo.
                </p>
                <div className="flex gap-2">
                  <button onClick={() => setModal({ type: null })} disabled={submitting} className="flex-1 py-2 bg-neutral-200 rounded-lg">Cancelar</button>
                  <button onClick={confirmRegenerate} disabled={submitting} className="flex-1 py-2 bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300 text-white font-semibold rounded-lg">
                    {submitting ? 'Regenerando…' : 'Regenerar'}
                  </button>
                </div>
              </div>
            )}

            {/* CONFIRM DEACTIVATE */}
            {modal.type === 'confirm-deactivate' && modal.employee && (
              <div className="p-5 space-y-4">
                <h2 className="text-lg font-bold">
                  ¿{modal.employee.active ? 'Desactivar' : 'Reactivar'} a {modal.employee.nombre}?
                </h2>
                {error && <div className="bg-red-50 border border-red-200 rounded p-2 text-sm text-red-700">{error}</div>}
                <p className="text-sm text-neutral-700">
                  {modal.employee.active
                    ? 'No va a poder usar su código para operar el QR. Los logs históricos se preservan.'
                    : 'Va a volver a poder usar su código (si no se reasignó a otro empleado activo).'}
                </p>
                <div className="flex gap-2">
                  <button onClick={() => setModal({ type: null })} disabled={submitting} className="flex-1 py-2 bg-neutral-200 rounded-lg">Cancelar</button>
                  <button onClick={confirmDeactivate} disabled={submitting} className={`flex-1 py-2 disabled:opacity-60 text-white font-semibold rounded-lg ${modal.employee.active ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
                    {submitting ? 'Procesando…' : (modal.employee.active ? 'Desactivar' : 'Reactivar')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
