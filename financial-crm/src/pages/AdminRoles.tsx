import { useState, useEffect } from 'react';
import { Header } from '../components/layout';
import { RefreshCw, AlertCircle, Shield, Check, Save } from 'lucide-react';
import { fetchRoles, fetchPermissions, updateRolePermissions, Role, Permission } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

const MODULE_LABELS: Record<string, string> = {
  dashboard: 'Panel',
  orders: 'Pedidos',
  receipts: 'Comprobantes',
  users: 'Usuarios',
};

const PERMISSION_LABELS: Record<string, string> = {
  'dashboard.view': 'Ver panel',
  'orders.view': 'Ver pedidos',
  'orders.print': 'Imprimir pedidos',
  'orders.update_status': 'Cambiar estado de pedidos',
  'orders.create_cash_payment': 'Registrar pago en efectivo',
  'receipts.view': 'Ver comprobantes',
  'receipts.download': 'Descargar comprobantes',
  'receipts.upload_manual': 'Subir comprobante manual',
  'receipts.confirm': 'Confirmar comprobantes',
  'receipts.reject': 'Rechazar comprobantes',
  'users.view': 'Ver usuarios',
  'users.create': 'Crear usuarios',
  'users.edit': 'Editar usuarios',
  'users.disable': 'Desactivar usuarios',
  'users.assign_role': 'Asignar roles',
};

export function AdminRoles() {
  const { hasPermission } = useAuth();
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissions, setPermissions] = useState<Record<string, Permission[]>>({});
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
  const [editedPermissions, setEditedPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const canEdit = hasPermission('users.assign_role');

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [rolesData, permissionsData] = await Promise.all([
        fetchRoles(),
        fetchPermissions()
      ]);
      setRoles(rolesData);
      setPermissions(permissionsData);
      if (rolesData.length > 0 && !selectedRole) {
        setSelectedRole(rolesData[0]);
        setEditedPermissions(rolesData[0].permissions);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar datos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSelectRole = (role: Role) => {
    setSelectedRole(role);
    setEditedPermissions(role.permissions);
    setSuccessMessage(null);
  };

  const togglePermission = (permissionKey: string) => {
    if (!canEdit) return;

    setEditedPermissions(prev => {
      if (prev.includes(permissionKey)) {
        return prev.filter(p => p !== permissionKey);
      } else {
        return [...prev, permissionKey];
      }
    });
    setSuccessMessage(null);
  };

  const handleSave = async () => {
    if (!selectedRole || !canEdit) return;

    setSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const updatedRole = await updateRolePermissions(selectedRole.id, editedPermissions);

      // Actualizar el rol en la lista
      setRoles(prev => prev.map(r => r.id === updatedRole.id ? updatedRole : r));
      setSelectedRole(updatedRole);
      setSuccessMessage('Permisos guardados correctamente');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar permisos');
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = selectedRole &&
    JSON.stringify([...editedPermissions].sort()) !== JSON.stringify([...selectedRole.permissions].sort());

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <RefreshCw size={32} className="animate-spin text-neutral-400" />
      </div>
    );
  }

  if (error && roles.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl border border-neutral-200/60 p-8 text-center max-w-md">
          <AlertCircle size={48} className="mx-auto text-red-400 mb-4" />
          <h3 className="text-lg font-semibold text-neutral-900 mb-2">Error al cargar datos</h3>
          <p className="text-neutral-500 mb-4">{error}</p>
          <button
            onClick={loadData}
            className="px-4 py-2 bg-neutral-900 text-white rounded-lg hover:bg-neutral-800"
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header
        title="Gestión de Roles"
        subtitle="Administra los permisos de cada rol"
        actions={
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded-lg transition-colors"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Actualizar
          </button>
        }
      />

      <div className="p-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Lista de roles */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-2xl border border-neutral-200/60 p-4 shadow-soft">
              <h3 className="text-sm font-semibold text-neutral-700 mb-3">Roles</h3>
              <div className="space-y-2">
                {roles.map(role => (
                  <button
                    key={role.id}
                    onClick={() => handleSelectRole(role)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                      selectedRole?.id === role.id
                        ? 'bg-neutral-900 text-white'
                        : 'hover:bg-neutral-100 text-neutral-700'
                    }`}
                  >
                    <Shield size={18} />
                    <span className="font-medium capitalize">{role.name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Editor de permisos */}
          <div className="lg:col-span-3">
            {selectedRole ? (
              <div className="bg-white rounded-2xl border border-neutral-200/60 p-6 shadow-soft">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h2 className="text-lg font-semibold text-neutral-900 capitalize">
                      Rol: {selectedRole.name}
                    </h2>
                    <p className="text-sm text-neutral-500">
                      {editedPermissions.length} permisos asignados
                    </p>
                  </div>
                  {canEdit && (
                    <button
                      onClick={handleSave}
                      disabled={!hasChanges || saving}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                        hasChanges && !saving
                          ? 'bg-neutral-900 text-white hover:bg-neutral-800'
                          : 'bg-neutral-100 text-neutral-400 cursor-not-allowed'
                      }`}
                    >
                      <Save size={18} />
                      {saving ? 'Guardando...' : 'Guardar cambios'}
                    </button>
                  )}
                </div>

                {error && (
                  <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm">
                    {error}
                  </div>
                )}

                {successMessage && (
                  <div className="mb-4 p-3 bg-green-50 text-green-600 rounded-lg text-sm flex items-center gap-2">
                    <Check size={16} />
                    {successMessage}
                  </div>
                )}

                <div className="space-y-6">
                  {Object.entries(permissions).map(([module, modulePermissions]) => (
                    <div key={module}>
                      <h4 className="text-sm font-semibold text-neutral-700 mb-3 uppercase tracking-wider">
                        {MODULE_LABELS[module] || module}
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {modulePermissions.map(permission => {
                          const isChecked = editedPermissions.includes(permission.key);
                          return (
                            <label
                              key={permission.id}
                              className={`flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer ${
                                isChecked
                                  ? 'border-neutral-900 bg-neutral-50'
                                  : 'border-neutral-200 hover:border-neutral-300'
                              } ${!canEdit ? 'opacity-60 cursor-not-allowed' : ''}`}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => togglePermission(permission.key)}
                                disabled={!canEdit}
                                className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900"
                              />
                              <span className="text-sm text-neutral-700">
                                {PERMISSION_LABELS[permission.key] || permission.key}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                {!canEdit && (
                  <div className="mt-6 p-4 bg-amber-50 text-amber-700 rounded-lg text-sm">
                    No tienes permiso para editar roles. Contacta al administrador.
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-neutral-200/60 p-8 text-center shadow-soft">
                <Shield size={48} className="mx-auto text-neutral-300 mb-4" />
                <p className="text-neutral-500">Selecciona un rol para ver sus permisos</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
