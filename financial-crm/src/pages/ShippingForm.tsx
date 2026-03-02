import { useState, FormEvent } from 'react';
import { Check, AlertCircle, Loader2, Truck } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || 'https://api.petlovearg.com';

type EmpresaEnvio = 'VIA_CARGO' | 'OTRO' | '';
type DestinoTipo = 'SUCURSAL' | 'DOMICILIO' | '';

interface FormData {
  order_number: string;
  empresa_envio: EmpresaEnvio;
  empresa_envio_otro: string;
  destino_tipo: DestinoTipo;
  direccion_entrega: string;
  nombre_apellido: string;
  dni: string;
  email: string;
  codigo_postal: string;
  provincia: string;
  localidad: string;
  telefono: string;
  comentarios: string;
}

interface FormErrors {
  [key: string]: string;
}

const initialFormData: FormData = {
  order_number: '',
  empresa_envio: '',
  empresa_envio_otro: '',
  destino_tipo: '',
  direccion_entrega: '',
  nombre_apellido: '',
  dni: '',
  email: '',
  codigo_postal: '',
  provincia: '',
  localidad: '',
  telefono: '',
  comentarios: '',
};

export function ShippingForm() {
  const [formData, setFormData] = useState<FormData>(initialFormData);
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};

    if (!formData.order_number.trim()) {
      newErrors.order_number = 'Ingresá el número de pedido';
    }
    if (!formData.empresa_envio) {
      newErrors.empresa_envio = 'Seleccioná una empresa de envío';
    }
    if (formData.empresa_envio === 'OTRO' && !formData.empresa_envio_otro.trim()) {
      newErrors.empresa_envio_otro = 'Ingresá el nombre de la empresa';
    }
    if (!formData.destino_tipo) {
      newErrors.destino_tipo = 'Seleccioná el tipo de destino';
    }
    if (!formData.direccion_entrega.trim()) {
      newErrors.direccion_entrega = 'Ingresá la dirección de entrega';
    }
    if (!formData.nombre_apellido.trim()) {
      newErrors.nombre_apellido = 'Ingresá nombre y apellido';
    }
    if (!formData.dni.trim()) {
      newErrors.dni = 'Ingresá el DNI';
    }
    if (!formData.email.trim()) {
      newErrors.email = 'Ingresá el email';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'El email no es válido';
    }
    if (!formData.codigo_postal.trim()) {
      newErrors.codigo_postal = 'Ingresá el código postal';
    }
    if (!formData.provincia.trim()) {
      newErrors.provincia = 'Ingresá la provincia';
    }
    if (!formData.localidad.trim()) {
      newErrors.localidad = 'Ingresá la localidad';
    }
    if (!formData.telefono.trim()) {
      newErrors.telefono = 'Ingresá el teléfono';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;

    // Sanitizar número de pedido: solo números
    const sanitizedValue = name === 'order_number'
      ? value.replace(/[^0-9]/g, '')
      : value;

    setFormData(prev => ({ ...prev, [name]: sanitizedValue }));
    // Limpiar error del campo cuando el usuario escribe
    if (errors[name]) {
      setErrors(prev => ({ ...prev, [name]: '' }));
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch(`${API_BASE}/shipping-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Error al enviar los datos');
      }

      setSubmitSuccess(true);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Error al enviar los datos');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Pantalla de éxito
  if (submitSuccess) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-teal-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Check size={32} className="text-emerald-600" />
          </div>
          <h2 className="text-2xl font-bold text-neutral-900 mb-2">
            ¡Datos enviados!
          </h2>
          <p className="text-neutral-600 mb-6">
            Recibimos tus datos de envío correctamente. Nos pondremos en contacto a la brevedad.
          </p>
          <p className="text-sm text-neutral-500">
            Pedido: <span className="font-semibold">#{formData.order_number}</span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-neutral-50 to-neutral-100 py-8 px-4">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-neutral-900 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Truck size={32} className="text-white" />
          </div>
          <h1 className="text-3xl font-bold text-neutral-900 mb-2">
            Datos de Envío
          </h1>
          <div className="inline-block bg-amber-100 text-amber-800 text-sm font-medium px-4 py-2 rounded-full">
            Este formulario NO sirve para Correo Argentino ni Andreani
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-xl p-6 md:p-8 space-y-6">
          {/* Error general */}
          {submitError && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3">
              <AlertCircle size={20} className="text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">{submitError}</p>
            </div>
          )}

          {/* Número de pedido */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">
              Número de Pedido <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              name="order_number"
              value={formData.order_number}
              onChange={handleChange}
              placeholder="Ej: 12345"
              className={`w-full rounded-lg border ${errors.order_number ? 'border-red-300' : 'border-neutral-200'} bg-white px-4 py-3 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent`}
            />
            {errors.order_number && <p className="mt-1.5 text-sm text-red-600">{errors.order_number}</p>}
          </div>

          {/* Empresa de envío */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">
              Empresa de Envío <span className="text-red-500">*</span>
            </label>
            <select
              name="empresa_envio"
              value={formData.empresa_envio}
              onChange={handleChange}
              className={`w-full rounded-lg border ${errors.empresa_envio ? 'border-red-300' : 'border-neutral-200'} bg-white px-4 py-3 text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent`}
            >
              <option value="">Seleccioná una opción</option>
              <option value="VIA_CARGO">Vía Cargo</option>
              <option value="OTRO">Otra empresa</option>
            </select>
            {errors.empresa_envio && <p className="mt-1.5 text-sm text-red-600">{errors.empresa_envio}</p>}
          </div>

          {/* Empresa otro (condicional) */}
          {formData.empresa_envio === 'OTRO' && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                Nombre de la Empresa <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                name="empresa_envio_otro"
                value={formData.empresa_envio_otro}
                onChange={handleChange}
                placeholder="Ej: Cruz del Sur"
                className={`w-full rounded-lg border ${errors.empresa_envio_otro ? 'border-red-300' : 'border-neutral-200'} bg-white px-4 py-3 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent`}
              />
              {errors.empresa_envio_otro && <p className="mt-1.5 text-sm text-red-600">{errors.empresa_envio_otro}</p>}
            </div>
          )}

          {/* Tipo de destino */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">
              Tipo de Destino <span className="text-red-500">*</span>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => {
                  setFormData(prev => ({ ...prev, destino_tipo: 'SUCURSAL' }));
                  if (errors.destino_tipo) setErrors(prev => ({ ...prev, destino_tipo: '' }));
                }}
                className={`p-4 rounded-xl border-2 text-center transition-all ${
                  formData.destino_tipo === 'SUCURSAL'
                    ? 'border-neutral-900 bg-neutral-900 text-white'
                    : 'border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300'
                }`}
              >
                <span className="font-medium">Sucursal</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setFormData(prev => ({ ...prev, destino_tipo: 'DOMICILIO' }));
                  if (errors.destino_tipo) setErrors(prev => ({ ...prev, destino_tipo: '' }));
                }}
                className={`p-4 rounded-xl border-2 text-center transition-all ${
                  formData.destino_tipo === 'DOMICILIO'
                    ? 'border-neutral-900 bg-neutral-900 text-white'
                    : 'border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300'
                }`}
              >
                <span className="font-medium">Domicilio</span>
              </button>
            </div>
            {errors.destino_tipo && <p className="mt-1.5 text-sm text-red-600">{errors.destino_tipo}</p>}
          </div>

          {/* Dirección de entrega */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">
              Dirección de Entrega <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              name="direccion_entrega"
              value={formData.direccion_entrega}
              onChange={handleChange}
              placeholder="Calle, número, piso, depto o sucursal"
              className={`w-full rounded-lg border ${errors.direccion_entrega ? 'border-red-300' : 'border-neutral-200'} bg-white px-4 py-3 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent`}
            />
            {errors.direccion_entrega && <p className="mt-1.5 text-sm text-red-600">{errors.direccion_entrega}</p>}
          </div>

          {/* Nombre y apellido */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">
              Nombre y Apellido <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              name="nombre_apellido"
              value={formData.nombre_apellido}
              onChange={handleChange}
              placeholder="Juan Pérez"
              className={`w-full rounded-lg border ${errors.nombre_apellido ? 'border-red-300' : 'border-neutral-200'} bg-white px-4 py-3 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent`}
            />
            {errors.nombre_apellido && <p className="mt-1.5 text-sm text-red-600">{errors.nombre_apellido}</p>}
          </div>

          {/* DNI */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">
              DNI <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              name="dni"
              value={formData.dni}
              onChange={handleChange}
              placeholder="12345678"
              className={`w-full rounded-lg border ${errors.dni ? 'border-red-300' : 'border-neutral-200'} bg-white px-4 py-3 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent`}
            />
            {errors.dni && <p className="mt-1.5 text-sm text-red-600">{errors.dni}</p>}
          </div>

          {/* Email */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">
              Email <span className="text-red-500">*</span>
            </label>
            <input
              type="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              placeholder="ejemplo@email.com"
              className={`w-full rounded-lg border ${errors.email ? 'border-red-300' : 'border-neutral-200'} bg-white px-4 py-3 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent`}
            />
            {errors.email && <p className="mt-1.5 text-sm text-red-600">{errors.email}</p>}
          </div>

          {/* Grid 2 cols: CP + Provincia */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                Código Postal <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                name="codigo_postal"
                value={formData.codigo_postal}
                onChange={handleChange}
                placeholder="1234"
                className={`w-full rounded-lg border ${errors.codigo_postal ? 'border-red-300' : 'border-neutral-200'} bg-white px-4 py-3 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent`}
              />
              {errors.codigo_postal && <p className="mt-1.5 text-sm text-red-600">{errors.codigo_postal}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                Provincia <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                name="provincia"
                value={formData.provincia}
                onChange={handleChange}
                placeholder="Buenos Aires"
                className={`w-full rounded-lg border ${errors.provincia ? 'border-red-300' : 'border-neutral-200'} bg-white px-4 py-3 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent`}
              />
              {errors.provincia && <p className="mt-1.5 text-sm text-red-600">{errors.provincia}</p>}
            </div>
          </div>

          {/* Localidad */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">
              Localidad <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              name="localidad"
              value={formData.localidad}
              onChange={handleChange}
              placeholder="Ciudad"
              className={`w-full rounded-lg border ${errors.localidad ? 'border-red-300' : 'border-neutral-200'} bg-white px-4 py-3 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent`}
            />
            {errors.localidad && <p className="mt-1.5 text-sm text-red-600">{errors.localidad}</p>}
          </div>

          {/* Teléfono */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">
              Teléfono <span className="text-red-500">*</span>
            </label>
            <input
              type="tel"
              name="telefono"
              value={formData.telefono}
              onChange={handleChange}
              placeholder="11 1234-5678"
              className={`w-full rounded-lg border ${errors.telefono ? 'border-red-300' : 'border-neutral-200'} bg-white px-4 py-3 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent`}
            />
            {errors.telefono && <p className="mt-1.5 text-sm text-red-600">{errors.telefono}</p>}
          </div>

          {/* Comentarios */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">
              Comentarios <span className="text-neutral-400">(opcional)</span>
            </label>
            <textarea
              name="comentarios"
              value={formData.comentarios}
              onChange={handleChange}
              rows={3}
              placeholder="Información adicional..."
              className="w-full rounded-lg border border-neutral-200 bg-white px-4 py-3 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent resize-none"
            />
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-neutral-900 text-white font-medium py-4 px-6 rounded-xl hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <>
                <Loader2 size={20} className="animate-spin" />
                Enviando...
              </>
            ) : (
              'Enviar Datos de Envío'
            )}
          </button>
        </form>

        {/* Footer */}
        <p className="text-center text-sm text-neutral-500 mt-6">
          Pet Love Argentina
        </p>
      </div>
    </div>
  );
}
