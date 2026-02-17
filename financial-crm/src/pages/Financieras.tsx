import { useState, useEffect } from 'react';
import { Header } from '../components/layout';
import {
  RefreshCw,
  AlertCircle,
  Building2,
  Plus,
  Edit2,
  X,
  Check,
  Trash2,
  Star,
  ToggleLeft,
  ToggleRight,
  Tag,
  Percent,
} from 'lucide-react';
import {
  fetchFinancieras,
  createFinanciera,
  updateFinanciera,
  deleteFinanciera,
  toggleFinancieraActiva,
  setFinancieraDefault,
  Financiera,
} from '../services/api';
import { useAuth } from '../contexts/AuthContext';

export function Financieras() {
  const { hasPermission } = useAuth();
  const [financieras, setFinancieras] = useState<Financiera[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal de crear/editar
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [editingFinanciera, setEditingFinanciera] = useState<Financiera | null>(null);
  const [formData, setFormData] = useState({
    nombre: '',
    titular_principal: '',
    celular: '',
    cbu: '',
    alias: '',
    porcentaje: '',
    palabras_clave: [] as string[],
  });
  const [newTag, setNewTag] = useState('');
  const [formError, setFormError] = useState('');
  const [formLoading, setFormLoading] = useState(false);

  const canCreate = hasPermission('financieras.create');
  const canUpdate = hasPermission('financieras.update');
  const canDelete = hasPermission('financieras.delete');
  const canSetDefault = hasPermission('financieras.set_default');

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchFinancieras();
      setFinancieras(data);
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
    setEditingFinanciera(null);
    setFormData({
      nombre: '',
      titular_principal: '',
      celular: '',
      cbu: '',
      alias: '',
      porcentaje: '',
      palabras_clave: [],
    });
    setNewTag('');
    setFormError('');
    setShowModal(true);
  };

  const openEditModal = (financiera: Financiera) => {
    setModalMode('edit');
    setEditingFinanciera(financiera);
    setFormData({
      nombre: financiera.nombre,
      titular_principal: financiera.titular_principal || '',
      celular: financiera.celular || '',
      cbu: financiera.cbu || '',
      alias: financiera.alias || '',
      porcentaje: financiera.porcentaje?.toString() || '',
      palabras_clave: financiera.palabras_clave || [],
    });
    setNewTag('');
    setFormError('');
    setShowModal(true);
  };

  const handleAddTag = () => {
    const tag = newTag.trim().toLowerCase();
    if (tag && !formData.palabras_clave.includes(tag)) {
      setFormData(prev => ({
        ...prev,
        palabras_clave: [...prev.palabras_clave, tag],
      }));
      setNewTag('');
    }
  };

  const handleRemoveTag = (tag: string) => {
    setFormData(prev => ({
      ...prev,
      palabras_clave: prev.palabras_clave.filter(t => t !== tag),
    }));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setFormLoading(true);

    try {
      const payload = {
        nombre: formData.nombre,
        titular_principal: formData.titular_principal || undefined,
        celular: formData.celular || undefined,
        cbu: formData.cbu || undefined,
        alias: formData.alias || undefined,
        porcentaje: formData.porcentaje ? parseFloat(formData.porcentaje) : undefined,
        palabras_clave: formData.palabras_clave,
      };

      if (modalMode === 'create') {
        const newFinanciera = await createFinanciera(payload);
        setFinancieras(prev => [...prev, newFinanciera]);
      } else if (editingFinanciera) {
        const updated = await updateFinanciera(editingFinanciera.id, payload);
        setFinancieras(prev => prev.map(f => f.id === updated.id ? updated : f));
      }
      setShowModal(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Error al guardar');
    } finally {
      setFormLoading(false);
    }
  };

  const handleToggleActiva = async (financiera: Financiera) => {
    if (!canUpdate) return;

    try {
      const updated = await toggleFinancieraActiva(financiera.id, !financiera.activa);
      setFinancieras(prev => prev.map(f => f.id === updated.id ? updated : f));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cambiar estado');
    }
  };

  const handleSetDefault = async (financiera: Financiera) => {
    if (!canSetDefault || financiera.is_default) return;

    try {
      const updated = await setFinancieraDefault(financiera.id);
      // Actualizar todas: quitar default de las demás
      setFinancieras(prev => prev.map(f => ({
        ...f,
        is_default: f.id === updated.id,
      })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al marcar como predeterminada');
    }
  };

  const handleDelete = async (financiera: Financiera) => {
    if (!canDelete) return;

    if (!confirm(`¿Estás seguro de eliminar "${financiera.nombre}"? Esta acción no se puede deshacer.`)) {
      return;
    }

    try {
      await deleteFinanciera(financiera.id);
      setFinancieras(prev => prev.filter(f => f.id !== financiera.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al eliminar');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <RefreshCw size={32} className="animate-spin text-neutral-400" />
      </div>
    );
  }

  if (error && financieras.length === 0) {
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
        title="Financieras"
        subtitle="Administra las entidades financieras"
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
                Nueva Financiera
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
                <th className="px-4 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                  ID
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                  Financiera
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                  Titular / CBU
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                  Palabras Clave
                </th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                  %
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
              {financieras.map(financiera => (
                <tr key={financiera.id} className={`hover:bg-neutral-50 ${!financiera.activa ? 'opacity-60' : ''}`}>
                  <td className="px-4 py-4">
                    <span className="inline-flex items-center justify-center w-8 h-8 bg-neutral-100 text-neutral-600 rounded-full text-sm font-mono font-medium">
                      {financiera.id}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                        financiera.is_default ? 'bg-amber-100' : 'bg-neutral-200'
                      }`}>
                        {financiera.is_default ? (
                          <Star size={18} className="text-amber-600 fill-amber-600" />
                        ) : (
                          <Building2 size={18} className="text-neutral-500" />
                        )}
                      </div>
                      <div>
                        <p className="font-medium text-neutral-900">{financiera.nombre}</p>
                        {financiera.celular && (
                          <p className="text-xs text-neutral-500">{financiera.celular}</p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm">
                      {financiera.titular_principal && (
                        <p className="text-neutral-900">{financiera.titular_principal}</p>
                      )}
                      {financiera.cbu && (
                        <p className="text-neutral-500 font-mono text-xs">{financiera.cbu}</p>
                      )}
                      {financiera.alias && (
                        <p className="text-neutral-400 text-xs">Alias: {financiera.alias}</p>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-wrap gap-1 max-w-xs">
                      {financiera.palabras_clave?.slice(0, 3).map((tag, idx) => (
                        <span
                          key={idx}
                          className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full text-xs"
                        >
                          <Tag size={10} />
                          {tag}
                        </span>
                      ))}
                      {financiera.palabras_clave?.length > 3 && (
                        <span className="text-xs text-neutral-400">
                          +{financiera.palabras_clave.length - 3}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    {financiera.porcentaje !== null && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-50 text-emerald-700 rounded-lg text-sm font-medium">
                        <Percent size={14} />
                        {financiera.porcentaje}
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                      financiera.activa
                        ? 'bg-green-50 text-green-700'
                        : 'bg-red-50 text-red-700'
                    }`}>
                      {financiera.activa ? 'Activa' : 'Inactiva'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {canSetDefault && !financiera.is_default && (
                        <button
                          onClick={() => handleSetDefault(financiera)}
                          className="p-2 text-amber-500 hover:text-amber-700 hover:bg-amber-50 rounded-lg transition-colors"
                          title="Marcar como predeterminada"
                        >
                          <Star size={16} />
                        </button>
                      )}
                      {canUpdate && (
                        <>
                          <button
                            onClick={() => openEditModal(financiera)}
                            className="p-2 text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100 rounded-lg transition-colors"
                            title="Editar"
                          >
                            <Edit2 size={16} />
                          </button>
                          <button
                            onClick={() => handleToggleActiva(financiera)}
                            className={`p-2 rounded-lg transition-colors ${
                              financiera.activa
                                ? 'text-red-500 hover:text-red-700 hover:bg-red-50'
                                : 'text-green-500 hover:text-green-700 hover:bg-green-50'
                            }`}
                            title={financiera.activa ? 'Desactivar' : 'Activar'}
                          >
                            {financiera.activa ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                          </button>
                        </>
                      )}
                      {canDelete && (
                        <button
                          onClick={() => handleDelete(financiera)}
                          className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                          title="Eliminar"
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

          {financieras.length === 0 && (
            <div className="p-8 text-center">
              <Building2 size={48} className="mx-auto text-neutral-300 mb-4" />
              <p className="text-neutral-500">No hay financieras registradas</p>
            </div>
          )}
        </div>
      </div>

      {/* Modal de crear/editar financiera */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-neutral-200">
              <h2 className="text-lg font-semibold text-neutral-900">
                {modalMode === 'create' ? 'Nueva Financiera' : 'Editar Financiera'}
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="p-2 text-neutral-400 hover:text-neutral-600 rounded-lg transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                  Nombre *
                </label>
                <input
                  type="text"
                  value={formData.nombre}
                  onChange={(e) => setFormData(prev => ({ ...prev, nombre: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                  placeholder="Nombre de la financiera"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                  Titular Principal
                </label>
                <input
                  type="text"
                  value={formData.titular_principal}
                  onChange={(e) => setFormData(prev => ({ ...prev, titular_principal: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                  placeholder="Nombre del titular"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                    Celular
                  </label>
                  <input
                    type="text"
                    value={formData.celular}
                    onChange={(e) => setFormData(prev => ({ ...prev, celular: e.target.value }))}
                    className="w-full px-4 py-2.5 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                    placeholder="+54..."
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                    Porcentaje
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={formData.porcentaje}
                    onChange={(e) => setFormData(prev => ({ ...prev, porcentaje: e.target.value }))}
                    className="w-full px-4 py-2.5 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                    placeholder="0.00"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                  CBU
                </label>
                <input
                  type="text"
                  value={formData.cbu}
                  onChange={(e) => setFormData(prev => ({ ...prev, cbu: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none font-mono"
                  placeholder="0000000000000000000000"
                  maxLength={22}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                  Alias
                </label>
                <input
                  type="text"
                  value={formData.alias}
                  onChange={(e) => setFormData(prev => ({ ...prev, alias: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                  placeholder="alias.cuenta.mp"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                  Palabras Clave (para deteccion OCR)
                </label>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className="flex-1 px-4 py-2.5 border border-neutral-200 rounded-lg focus:ring-2 focus:ring-neutral-900 focus:border-transparent outline-none"
                    placeholder="Agregar palabra clave..."
                  />
                  <button
                    type="button"
                    onClick={handleAddTag}
                    className="px-4 py-2.5 bg-neutral-100 text-neutral-700 rounded-lg hover:bg-neutral-200 transition-colors"
                  >
                    <Plus size={16} />
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {formData.palabras_clave.map((tag, idx) => (
                    <span
                      key={idx}
                      className="inline-flex items-center gap-1 px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-sm"
                    >
                      <Tag size={12} />
                      {tag}
                      <button
                        type="button"
                        onClick={() => handleRemoveTag(tag)}
                        className="ml-1 text-blue-400 hover:text-blue-600"
                      >
                        <X size={14} />
                      </button>
                    </span>
                  ))}
                </div>
              </div>

              {formError && (
                <div className="p-3 bg-red-50 text-red-600 rounded-lg text-sm">
                  {formError}
                </div>
              )}

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
                  {modalMode === 'create' ? 'Crear' : 'Guardar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
