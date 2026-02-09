import { useState, useEffect } from 'react';
import { Header } from '../components/layout';
import {
  RefreshCw,
  AlertCircle,
  Users,
  Plus,
  UserCheck,
  UserX,
  Edit2,
  X,
  Check,
  Shield,
  LayoutDashboard,
  ShoppingCart,
  Receipt,
  Trash2,
} from 'lucide-react';
import {
  fetchUsers,
  createUser,
  updateUser,
  toggleUserActive,
  updateUserPermissions,
  deleteUser,
  User,
} from '../services/api';
import { useAuth } from '../contexts/AuthContext';

const PERMISSION_LABELS: Record<string, string> = {
  'dashboard.view': 'Ver dashboard',
  'orders.view': 'Ver pedidos',
  'orders.print': 'Imprimir pedido',
  'orders.update_status': 'Cambiar estado logístico',
  'orders.create_cash_payment': 'Registrar pago en efectivo',
  'orders.view_pendiente': 'Pendiente',
  'orders.view_a_confirmar': 'A confirmar',
  'orders.view_parcial': 'Parcial',
  'orders.view_total': 'Total',
  'orders.view_rechazado': 'Rechazado',
  'orders.view_pendiente_pago': 'Pendiente de pago',
  'orders.view_a_imprimir': 'A imprimir',
  'orders.view_armado': 'Armado',
  'orders.view_enviado': 'Enviado',
  'orders.view_en_calle': 'En calle',
  'orders.view_retirado': 'Retirado',
  'receipts.view': 'Ver comprobantes',
  'receipts.download': 'Descargar imágenes',
  'receipts.upload_manual': 'Subir manual',
  'receipts.confirm': 'Confirmar',
  'receipts.reject': 'Rechazar',
  'receipts.view_pendiente': 'Pendiente',
  'receipts.view_a_confirmar': 'A confirmar',
  'receipts.view_parcial': 'Parcial',
  'receipts.view_total': 'Total',
  'receipts.view_rechazado': 'Rechazado',
  'users.view': 'Ver usuarios',
  'users.create': 'Crear usuario',
  'users.edit': 'Editar usuario',
  'users.disable': 'Desactivar usuario',
  'users.assign_role': 'Gestionar permisos',
};

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

export function AdminUsers() {
  const { hasPermission, user: currentUser } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal de crear/editar usuario
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
  });
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [formError, setFormError] = useState('');
  const [formLoading, setFormLoading] = useState(false);

  // Modal de permisos
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);
  const [permissionsUser, setPermissionsUser] = useState<User | null>(null);
  const [editingPermissions, setEditingPermissions] = useState<string[]>([]);
  const [savingPermissions, setSavingPermissions] = useState(false);

  const canCreate = hasPermission('users.create');
  const canEdit = hasPermission('users.edit');
  const canDisable = hasPermission('users.disable');
  const canManagePermissions = hasPermission('users.assign_role');

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const usersData = await fetchUsers();
      setUsers(usersData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar datos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const openCreateModal = () => {
    setModalMode('create');
    setEditingUser(null);
    setFormData({ name: '', email: '', password: '' });
    setSelectedPermissions([]);
    setFormError('');
    setShowModal(true);
  };

  const openEditModal = (user: User) => {
    setModalMode('edit');
    setEditingUser(user);
    setFormData({
      name: user.name,
      email: user.email,
      password: '',
    });
    setFormError('');
    setShowModal(true);
  };

  const openPermissionsModal = (user: User) => {
    setPermissionsUser(user);
    setEditingPermissions(user.permissions || []);
    setShowPermissionsModal(true);
  };

  const togglePermission = (permKey: string) => {
    setSelectedPermissions(prev =>
      prev.includes(permKey)
        ? prev.filter(p => p !== permKey)
        : [...prev, permKey]
    );
  };

  const toggleEditingPermission = (permKey: string) => {
    setEditingPermissions(prev =>
      prev.includes(permKey)
        ? prev.filter(p => p !== permKey)
        : [...prev, permKey]
    );
  };

  const toggleSubsectionPermissions = (permissions: string[], isEditing: boolean) => {
    const current = isEditing ? editingPermissions : selectedPermissions;
    const setter = isEditing ? setEditingPermissions : setSelectedPermissions;
    const allChecked = permissions.every(p => current.includes(p));

    if (allChecked) {
      setter(prev => prev.filter(p => !permissions.includes(p)));
    } else {
      setter(prev => [...new Set([...prev, ...permissions])]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setFormLoading(true);

    try {
      if (modalMode === 'create') {
        if (!formData.password) {
          setFormError('La contraseña es requerida');
          setFormLoading(false);
          return;
        }
        const newUser = await createUser({
          name: formData.name,
          email: formData.email,
          password: formData.password,
          permissions: selectedPermissions.length > 0 ? selectedPermissions : undefined,
        });
        setUsers(prev => [...prev, newUser]);
      } else if (editingUser) {
        const updatedUser = await updateUser(editingUser.id, {
          name: formData.name,
          email: formData.email,
        });
        setUsers(prev => prev.map(u => u.id === updatedUser.id ? updatedUser : u));
      }
      setShowModal(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setFormLoading(false);
    }
  };

  const handleSavePermissions = async () => {
    if (!permissionsUser) return;

    setSavingPermissions(true);
    try {
      const updatedUser = await updateUserPermissions(permissionsUser.id, editingPermissions);
      setUsers(prev => prev.map(u => u.id === updatedUser.id ? updatedUser : u));
      setShowPermissionsModal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar permisos');
    } finally {
      setSavingPermissions(false);
    }
  };

  const handleToggleActive = async (user: User) => {
    if (!canDisable || user.id === currentUser?.id) return;

    try {
      const updatedUser = await toggleUserActive(user.id, !user.is_active);
      setUsers(prev => prev.map(u => u.id === updatedUser.id ? updatedUser : u));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cambiar estado');
    }
  };

  const handleDeleteUser = async (user: User) => {
    if (!canDisable || user.id === currentUser?.id) return;

    if (!confirm(`¿Estás seguro de eliminar a ${user.name}? Esta acción no se puede deshacer.`)) {
      return;
    }

    try {
      await deleteUser(user.id);
      setUsers(prev => prev.filter(u => u.id !== user.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al eliminar usuario');
    }
  };


  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <RefreshCw size={32} className="animate-spin text-neutral-400" />
      </div>
    );
  }

  if (error && users.length === 0) {
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
        title="Gestión de Usuarios"
        subtitle="Administra usuarios y sus permisos"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={loadData}
              disabled={loading}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded-lg transition-colors"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              Actualizar
            </button>
            {canCreate && (
              <button
                onClick={openCreateModal}
                className="flex items-center gap-2 px-4 py-1.5 text-sm font-medium bg-neutral-900 text-white rounded-lg hover:bg-neutral-800 transition-colors"
              >
                <Plus size={16} />
                Nuevo Usuario
              </button>
            )}
          </div>
        }
      />

      <div className="p-6">
        {error && (
          <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="bg-white rounded-2xl border border-neutral-200/60 shadow-soft overflow-hidden">
          <table className="w-full">
            <thead className="bg-neutral-50 border-b border-neutral-200">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                  Usuario
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                  Email
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                  Permisos
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                  Estado
                </th>
                <th className="px-6 py-3 text-right text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {users.map(user => (
                <tr key={user.id} className={`hover:bg-neutral-50 ${!user.is_active ? 'opacity-60' : ''}`}>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-neutral-200 rounded-full flex items-center justify-center">
                        <Users size={18} className="text-neutral-500" />
                      </div>
                      <div>
                        <p className="font-medium text-neutral-900">{user.name}</p>
                        {user.id === currentUser?.id && (
                          <span className="text-xs text-neutral-500">(Tú)</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-neutral-600">{user.email}</span>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                      user.permissions?.length > 0
                        ? 'bg-violet-50 text-violet-700'
                        : 'bg-neutral-50 text-neutral-400'
                    }`}>
                      {user.permissions?.length || 0} permisos
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                      user.is_active
                        ? 'bg-green-50 text-green-700'
                        : 'bg-red-50 text-red-700'
                    }`}>
                      {user.is_active ? <UserCheck size={14} /> : <UserX size={14} />}
                      {user.is_active ? 'Activo' : 'Inactivo'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {canManagePermissions && (
                        <button
                          onClick={() => openPermissionsModal(user)}
                          className="p-2 text-violet-500 hover:text-violet-700 hover:bg-violet-50 rounded-lg transition-colors"
                          title="Gestionar permisos"
                        >
                          <Shield size={16} />
                        </button>
                      )}
                      {canEdit && (
                        <button
                          onClick={() => openEditModal(user)}
                          className="p-2 text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 rounded-lg transition-colors"
                          title="Editar"
                        >
                          <Edit2 size={16} />
                        </button>
                      )}
                      {canDisable && user.id !== currentUser?.id && (
                        <button
                          onClick={() => handleToggleActive(user)}
                          className={`p-2 rounded-lg transition-colors ${
                            user.is_active
                              ? 'text-red-500 hover:text-red-700 hover:bg-red-50'
                              : 'text-green-500 hover:text-green-700 hover:bg-green-50'
                          }`}
                          title={user.is_active ? 'Desactivar' : 'Activar'}
                        >
                          {user.is_active ? <UserX size={16} /> : <UserCheck size={16} />}
                        </button>
                      )}
                      {canDisable && user.id !== currentUser?.id && (
                        <button
                          onClick={() => handleDeleteUser(user)}
                          className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                          title="Eliminar usuario"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {users.length === 0 && (
            <div className="p-8 text-center">
              <Users size={48} className="mx-auto text-neutral-300 mb-4" />
              <p className="text-neutral-500">No hay usuarios registrados</p>
            </div>
          )}
        </div>
      </div>

      {/* Modal de crear/editar usuario */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className={`bg-white rounded-2xl w-full shadow-xl max-h-[90vh] flex flex-col ${
            modalMode === 'create' && canManagePermissions ? 'max-w-5xl' : 'max-w-md'
          }`}>
            <div className="flex items-center justify-between p-6 border-b border-neutral-200">
              <h2 className="text-lg font-semibold text-neutral-900">
                {modalMode === 'create' ? 'Nuevo Usuario' : 'Editar Usuario'}
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="p-2 text-neutral-400 hover:text-neutral-600 rounded-lg transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex-1 overflow-hidden flex flex-col">
              <div className={`flex-1 overflow-y-auto p-6 ${
                modalMode === 'create' && canManagePermissions ? 'grid grid-cols-[320px_1fr] gap-8' : ''
              }`}>
                {/* Datos del usuario */}
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                      Nombre
                    </label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                      className="w-full px-4 py-2.5 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                      placeholder="Nombre completo"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                      Correo electrónico
                    </label>
                    <input
                      type="email"
                      value={formData.email}
                      onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                      className="w-full px-4 py-2.5 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                      placeholder="usuario@ejemplo.com"
                      required
                    />
                  </div>

                  {modalMode === 'create' && (
                    <div>
                      <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                        Contraseña
                      </label>
                      <input
                        type="password"
                        value={formData.password}
                        onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
                        className="w-full px-4 py-2.5 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                        placeholder="Mínimo 6 caracteres"
                        required
                        minLength={6}
                      />
                    </div>
                  )}

                  {formError && (
                    <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">
                      {formError}
                    </div>
                  )}

                  {/* Botones en modo edit (sin permisos) */}
                  {modalMode === 'edit' && (
                    <div className="flex gap-3 pt-4">
                      <button
                        type="button"
                        onClick={() => setShowModal(false)}
                        className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-lg text-neutral-700 font-medium hover:bg-neutral-50 transition-colors"
                      >
                        Cancelar
                      </button>
                      <button
                        type="submit"
                        disabled={formLoading}
                        className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-neutral-900 text-white rounded-lg font-medium hover:bg-neutral-800 disabled:opacity-50 transition-colors"
                      >
                        {formLoading ? (
                          <RefreshCw size={16} className="animate-spin" />
                        ) : (
                          <Check size={16} />
                        )}
                        Guardar
                      </button>
                    </div>
                  )}
                </div>

                {/* Panel de permisos (solo en modo crear) */}
                {modalMode === 'create' && canManagePermissions && (
                  <div className="border-l border-neutral-200 pl-8">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold text-neutral-900">
                        Permisos
                      </h3>
                      <span className="text-sm text-neutral-500">
                        {selectedPermissions.length} seleccionados
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      {SECTIONS.map(section => {
                        const Icon = section.icon;
                        const sectionPerms = section.subsections.flatMap(s => s.permissions);
                        const checkedCount = sectionPerms.filter(p => selectedPermissions.includes(p)).length;

                        return (
                          <div key={section.id} className="border border-neutral-200 rounded-xl overflow-hidden">
                            <div className={`flex items-center gap-2 px-4 py-2.5 ${section.color}`}>
                              <Icon size={16} />
                              <span className="font-semibold text-sm">{section.title}</span>
                              <span className="ml-auto text-xs opacity-70">{checkedCount}/{sectionPerms.length}</span>
                            </div>
                            <div className="p-3 space-y-3">
                              {section.subsections.map((sub, idx) => {
                                const allChecked = sub.permissions.every(p => selectedPermissions.includes(p));
                                const someChecked = sub.permissions.some(p => selectedPermissions.includes(p)) && !allChecked;

                                return (
                                  <div key={idx}>
                                    <button
                                      type="button"
                                      onClick={() => toggleSubsectionPermissions(sub.permissions, false)}
                                      className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-500 hover:text-neutral-900 mb-2"
                                    >
                                      <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                                        allChecked
                                          ? 'bg-neutral-900 border-neutral-900'
                                          : someChecked
                                            ? 'bg-neutral-400 border-neutral-400'
                                            : 'border-neutral-300'
                                      }`}>
                                        {(allChecked || someChecked) && <Check size={12} className="text-white" />}
                                      </div>
                                      {sub.title}
                                    </button>
                                    <div className="space-y-1 pl-6">
                                      {sub.permissions.map(perm => (
                                        <label
                                          key={perm}
                                          className={`flex items-center gap-2.5 py-1.5 px-2 rounded-lg cursor-pointer transition-colors hover:bg-neutral-50 ${
                                            selectedPermissions.includes(perm) ? 'bg-neutral-50' : ''
                                          }`}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={selectedPermissions.includes(perm)}
                                            onChange={() => togglePermission(perm)}
                                            className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900"
                                          />
                                          <span className={`text-sm ${selectedPermissions.includes(perm) ? 'text-neutral-900' : 'text-neutral-600'}`}>
                                            {PERMISSION_LABELS[perm] || perm}
                                          </span>
                                        </label>
                                      ))}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Footer con botones (solo en modo crear con permisos) */}
              {modalMode === 'create' && canManagePermissions && (
                <div className="p-6 border-t border-neutral-200 flex gap-3">
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-lg text-neutral-700 font-medium hover:bg-neutral-50 transition-colors"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={formLoading}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-neutral-900 text-white rounded-lg font-medium hover:bg-neutral-800 disabled:opacity-50 transition-colors"
                  >
                    {formLoading ? (
                      <RefreshCw size={16} className="animate-spin" />
                    ) : (
                      <Check size={16} />
                    )}
                    Crear Usuario
                  </button>
                </div>
              )}

              {/* Botones para modo crear sin permisos */}
              {modalMode === 'create' && !canManagePermissions && (
                <div className="p-6 border-t border-neutral-200 flex gap-3">
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-lg text-neutral-700 font-medium hover:bg-neutral-50 transition-colors"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={formLoading}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-neutral-900 text-white rounded-lg font-medium hover:bg-neutral-800 disabled:opacity-50 transition-colors"
                  >
                    {formLoading ? (
                      <RefreshCw size={16} className="animate-spin" />
                    ) : (
                      <Check size={16} />
                    )}
                    Crear
                  </button>
                </div>
              )}
            </form>
          </div>
        </div>
      )}

      {/* Modal de editar permisos */}
      {showPermissionsModal && permissionsUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-neutral-200">
              <div>
                <h2 className="text-lg font-semibold text-neutral-900">
                  Permisos de {permissionsUser.name}
                </h2>
                <p className="text-sm text-neutral-500">{permissionsUser.email}</p>
              </div>
              <button
                onClick={() => setShowPermissionsModal(false)}
                className="p-2 text-neutral-400 hover:text-neutral-600 rounded-lg transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {SECTIONS.map(section => {
                const Icon = section.icon;
                const sectionPerms = section.subsections.flatMap(s => s.permissions);
                const checkedCount = sectionPerms.filter(p => editingPermissions.includes(p)).length;

                return (
                  <div key={section.id} className="border border-neutral-200 rounded-xl overflow-hidden">
                    <div className={`flex items-center gap-3 px-4 py-3 ${section.color}`}>
                      <Icon size={18} />
                      <span className="font-semibold">{section.title}</span>
                      <span className="ml-auto text-sm opacity-70">{checkedCount}/{sectionPerms.length}</span>
                    </div>
                    <div className="p-4 space-y-4">
                      {section.subsections.map((sub, idx) => {
                        const allChecked = sub.permissions.every(p => editingPermissions.includes(p));
                        const someChecked = sub.permissions.some(p => editingPermissions.includes(p)) && !allChecked;

                        return (
                          <div key={idx}>
                            <button
                              type="button"
                              onClick={() => toggleSubsectionPermissions(sub.permissions, true)}
                              className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-500 hover:text-neutral-900 mb-2"
                            >
                              <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                                allChecked
                                  ? 'bg-neutral-900 border-neutral-900'
                                  : someChecked
                                    ? 'bg-neutral-400 border-neutral-400'
                                    : 'border-neutral-300'
                              }`}>
                                {(allChecked || someChecked) && <Check size={12} className="text-white" />}
                              </div>
                              {sub.title}
                            </button>
                            <div className="grid grid-cols-2 gap-2 pl-6">
                              {sub.permissions.map(perm => (
                                <label
                                  key={perm}
                                  className={`flex items-center gap-2 py-1.5 px-2 rounded-lg cursor-pointer transition-colors hover:bg-neutral-50 ${
                                    editingPermissions.includes(perm) ? 'bg-neutral-50' : ''
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={editingPermissions.includes(perm)}
                                    onChange={() => toggleEditingPermission(perm)}
                                    className="w-4 h-4 rounded border-neutral-300 text-neutral-900 focus:ring-neutral-900"
                                  />
                                  <span className={`text-sm ${editingPermissions.includes(perm) ? 'text-neutral-900' : 'text-neutral-600'}`}>
                                    {PERMISSION_LABELS[perm] || perm}
                                  </span>
                                </label>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="p-6 border-t border-neutral-200 flex gap-3">
              <button
                type="button"
                onClick={() => setShowPermissionsModal(false)}
                className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-lg text-neutral-700 font-medium hover:bg-neutral-50 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleSavePermissions}
                disabled={savingPermissions}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-neutral-900 text-white rounded-lg font-medium hover:bg-neutral-800 disabled:opacity-50 transition-colors"
              >
                {savingPermissions ? (
                  <RefreshCw size={16} className="animate-spin" />
                ) : (
                  <Check size={16} />
                )}
                Guardar permisos
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
