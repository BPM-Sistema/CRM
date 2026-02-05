import { useState, useEffect } from 'react';
import { Header } from '../components/layout';
import { RefreshCw, AlertCircle, Check, Save, ChevronDown, LayoutDashboard, ShoppingCart, Receipt, Users } from 'lucide-react';
import { fetchRoles, fetchPermissions, updateRolePermissions, Role, Permission } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

const PERMISSION_LABELS: Record<string, string> = {
  'dashboard.view': 'Ver dashboard',
  // Orders general
  'orders.view': 'Ver pedidos',
  'orders.print': 'Imprimir pedido',
  'orders.update_status': 'Cambiar estado logístico',
  'orders.create_cash_payment': 'Registrar pago en efectivo',
  // Orders por estado de pago
  'orders.view_pendiente': 'Pendiente',
  'orders.view_a_confirmar': 'A confirmar',
  'orders.view_parcial': 'Parcial',
  'orders.view_total': 'Total',
  'orders.view_rechazado': 'Rechazado',
  // Orders por estado de pedido
  'orders.view_pendiente_pago': 'Pendiente de pago',
  'orders.view_a_imprimir': 'A imprimir',
  'orders.view_armado': 'Armado',
  'orders.view_enviado': 'Enviado',
  'orders.view_en_calle': 'En calle',
  'orders.view_retirado': 'Retirado',
  // Receipts general
  'receipts.view': 'Ver comprobantes',
  'receipts.download': 'Descargar imágenes',
  'receipts.upload_manual': 'Subir manual',
  'receipts.confirm': 'Confirmar',
  'receipts.reject': 'Rechazar',
  // Receipts por estado
  'receipts.view_pendiente': 'Pendiente',
  'receipts.view_a_confirmar': 'A confirmar',
  'receipts.view_parcial': 'Parcial',
  'receipts.view_total': 'Total',
  'receipts.view_rechazado': 'Rechazado',
  // Users
  'users.view': 'Ver usuarios',
  'users.create': 'Crear usuario',
  'users.edit': 'Editar usuario',
  'users.disable': 'Desactivar usuario',
  'users.assign_role': 'Asignar rol',
};

// Estructura de secciones organizadas
const SECTIONS = [
  {
    id: 'dashboard',
    title: 'Dashboard',
    icon: LayoutDashboard,
    color: 'bg-blue-50 text-blue-600',
    subsections: [
      { title: 'Acceso', permissions: ['dashboard.view'] }
    ]
  },
  {
    id: 'orders',
    title: 'Pedidos',
    icon: ShoppingCart,
    color: 'bg-amber-50 text-amber-600',
    subsections: [
      { title: 'Acciones', permissions: ['orders.view', 'orders.print', 'orders.update_status', 'orders.create_cash_payment'] },
      { title: 'Filtro por Estado de Pago', permissions: ['orders.view_pendiente', 'orders.view_a_confirmar', 'orders.view_parcial', 'orders.view_total', 'orders.view_rechazado'] },
      { title: 'Filtro por Estado Logístico', permissions: ['orders.view_pendiente_pago', 'orders.view_a_imprimir', 'orders.view_armado', 'orders.view_enviado', 'orders.view_en_calle', 'orders.view_retirado'] }
    ]
  },
  {
    id: 'receipts',
    title: 'Comprobantes',
    icon: Receipt,
    color: 'bg-emerald-50 text-emerald-600',
    subsections: [
      { title: 'Acciones', permissions: ['receipts.view', 'receipts.download', 'receipts.upload_manual', 'receipts.confirm', 'receipts.reject'] },
      { title: 'Filtro por Estado', permissions: ['receipts.view_pendiente', 'receipts.view_a_confirmar', 'receipts.view_parcial', 'receipts.view_total', 'receipts.view_rechazado'] }
    ]
  },
  {
    id: 'users',
    title: 'Usuarios',
    icon: Users,
    color: 'bg-violet-50 text-violet-600',
    subsections: [
      { title: 'Gestión', permissions: ['users.view', 'users.create', 'users.edit', 'users.disable', 'users.assign_role'] }
    ]
  }
];

export function AdminRoles() {
  const { hasPermission } = useAuth();
  const [roles, setRoles] = useState<Role[]>([]);
  const [allPermissions, setAllPermissions] = useState<Permission[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<string>('');
  const [editedPermissions, setEditedPermissions] = useState<string[]>([]);
  const [originalPermissions, setOriginalPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);

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

      // Flatten permissions from grouped object
      const permsList: Permission[] = [];
      Object.values(permissionsData).forEach((perms) => {
        permsList.push(...(perms as Permission[]));
      });
      setAllPermissions(permsList);

      // Seleccionar primer rol por defecto
      if (rolesData.length > 0 && !selectedRoleId) {
        const firstRole = rolesData[0];
        setSelectedRoleId(firstRole.id);
        setEditedPermissions(firstRole.permissions);
        setOriginalPermissions(firstRole.permissions);
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
    setSelectedRoleId(role.id);
    setEditedPermissions(role.permissions);
    setOriginalPermissions(role.permissions);
    setSuccessMessage(null);
    setDropdownOpen(false);
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
    if (!selectedRoleId || !canEdit) return;

    setSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const updatedRole = await updateRolePermissions(selectedRoleId, editedPermissions);
      setRoles(prev => prev.map(r => r.id === updatedRole.id ? updatedRole : r));
      setOriginalPermissions(editedPermissions);
      setSuccessMessage('Permisos guardados correctamente');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar permisos');
    } finally {
      setSaving(false);
    }
  };

  const hasChanges = JSON.stringify([...editedPermissions].sort()) !== JSON.stringify([...originalPermissions].sort());
  const selectedRole = roles.find(r => r.id === selectedRoleId);

  // Función para seleccionar/deseleccionar todos los permisos de una subsección
  const toggleSubsection = (permissions: string[]) => {
    if (!canEdit) return;
    const allChecked = permissions.every(p => editedPermissions.includes(p));
    if (allChecked) {
      setEditedPermissions(prev => prev.filter(p => !permissions.includes(p)));
    } else {
      setEditedPermissions(prev => [...new Set([...prev, ...permissions])]);
    }
    setSuccessMessage(null);
  };

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
          <button onClick={loadData} className="px-4 py-2 bg-neutral-900 text-white rounded-lg hover:bg-neutral-800">
            Reintentar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header title="Permisos por Rol" subtitle="Configura los permisos de cada rol del sistema" />

      <div className="p-6 max-w-3xl mx-auto">
        {/* Selector de rol */}
        <div className="mb-8">
          <label className="block text-sm font-semibold text-neutral-600 mb-2 uppercase tracking-wide">
            Rol:
          </label>
          <div className="relative">
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="w-full flex items-center justify-between px-4 py-3 bg-white border border-neutral-200 rounded-xl text-left hover:border-neutral-300 transition-colors"
            >
              <span className="font-medium text-neutral-900 capitalize">
                {selectedRole?.name || 'Seleccionar rol'}
              </span>
              <ChevronDown size={20} className={`text-neutral-400 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
            </button>

            {dropdownOpen && (
              <div className="absolute z-10 w-full mt-2 bg-white border border-neutral-200 rounded-xl shadow-lg overflow-hidden">
                {roles.map(role => (
                  <button
                    key={role.id}
                    onClick={() => handleSelectRole(role)}
                    className={`w-full px-4 py-3 text-left hover:bg-neutral-50 transition-colors capitalize ${
                      role.id === selectedRoleId ? 'bg-neutral-100 font-medium' : ''
                    }`}
                  >
                    {role.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <hr className="border-neutral-200 mb-8" />

        {/* Mensajes */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 text-red-600 rounded-xl text-sm">
            {error}
          </div>
        )}

        {successMessage && (
          <div className="mb-6 p-4 bg-green-50 text-green-600 rounded-xl text-sm flex items-center gap-2">
            <Check size={18} />
            {successMessage}
          </div>
        )}

        {/* Lista de permisos por sección */}
        {selectedRole && (
          <div className="space-y-6">
            {SECTIONS.map(section => {
              const Icon = section.icon;
              const sectionPermissions = section.subsections.flatMap(s => s.permissions);
              const checkedCount = sectionPermissions.filter(p => editedPermissions.includes(p)).length;
              const totalCount = sectionPermissions.length;

              return (
                <div key={section.id} className="bg-white rounded-2xl border border-neutral-200/60 overflow-hidden">
                  {/* Header de sección */}
                  <div className={`flex items-center gap-3 px-5 py-4 border-b border-neutral-100 ${section.color}`}>
                    <Icon size={20} />
                    <h3 className="font-semibold">{section.title}</h3>
                    <span className="ml-auto text-sm opacity-70">
                      {checkedCount}/{totalCount}
                    </span>
                  </div>

                  {/* Subsecciones */}
                  <div className="p-5 space-y-6">
                    {section.subsections.map((subsection, idx) => {
                      const subsectionChecked = subsection.permissions.filter(p => editedPermissions.includes(p)).length;
                      const allSubsectionChecked = subsectionChecked === subsection.permissions.length;
                      const someSubsectionChecked = subsectionChecked > 0 && !allSubsectionChecked;

                      return (
                        <div key={idx}>
                          {/* Título de subsección con checkbox "seleccionar todos" */}
                          <div className="flex items-center gap-2 mb-3">
                            <button
                              onClick={() => toggleSubsection(subsection.permissions)}
                              disabled={!canEdit}
                              className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wider ${
                                canEdit ? 'hover:text-neutral-900 cursor-pointer' : 'cursor-not-allowed opacity-60'
                              } ${allSubsectionChecked ? 'text-neutral-900' : 'text-neutral-500'}`}
                            >
                              <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                                allSubsectionChecked
                                  ? 'bg-neutral-900 border-neutral-900'
                                  : someSubsectionChecked
                                    ? 'bg-neutral-400 border-neutral-400'
                                    : 'border-neutral-300'
                              }`}>
                                {(allSubsectionChecked || someSubsectionChecked) && (
                                  <Check size={12} className="text-white" />
                                )}
                              </div>
                              {subsection.title}
                            </button>
                          </div>

                          {/* Permisos en grid */}
                          <div className="grid grid-cols-2 gap-2 pl-6">
                            {subsection.permissions.map(permKey => {
                              const isChecked = editedPermissions.includes(permKey);
                              return (
                                <label
                                  key={permKey}
                                  className={`flex items-center gap-2 py-1.5 px-2 rounded-lg transition-colors ${
                                    !canEdit
                                      ? 'opacity-60 cursor-not-allowed'
                                      : 'cursor-pointer hover:bg-neutral-50'
                                  } ${isChecked ? 'bg-neutral-50' : ''}`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() => togglePermission(permKey)}
                                    disabled={!canEdit}
                                    className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900 focus:ring-offset-0"
                                  />
                                  <span className={`text-sm ${isChecked ? 'text-neutral-900' : 'text-neutral-600'}`}>
                                    {PERMISSION_LABELS[permKey] || permKey}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Botón guardar */}
            {canEdit && (
              <button
                onClick={handleSave}
                disabled={!hasChanges || saving}
                className={`w-full flex items-center justify-center gap-2 py-4 rounded-xl font-medium text-lg transition-all mt-8 ${
                  hasChanges && !saving
                    ? 'bg-neutral-900 text-white hover:bg-neutral-800'
                    : 'bg-neutral-100 text-neutral-400 cursor-not-allowed'
                }`}
              >
                {saving ? (
                  <>
                    <RefreshCw size={20} className="animate-spin" />
                    Guardando...
                  </>
                ) : (
                  <>
                    <Save size={20} />
                    Guardar cambios
                  </>
                )}
              </button>
            )}

            {!canEdit && (
              <div className="p-4 bg-amber-50 text-amber-700 rounded-xl text-sm text-center mt-8">
                No tienes permiso para editar roles. Contacta al administrador.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
