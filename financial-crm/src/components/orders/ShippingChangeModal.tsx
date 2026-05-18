import { useState, useEffect, useMemo } from 'react';
import { AlertCircle, Loader2, Truck, Store } from 'lucide-react';
import { Modal, Button } from '../ui';
import { updateOrderShipping } from '../../services/api';

/**
 * Modal para cambiar el método de envío de un pedido.
 *
 * Importante: este form es UNA DUPLICACIÓN intencional del de
 * `src/pages/ShippingForm.tsx` (carga inicial vía link público). Decisión
 * tomada para que ambos flujos puedan evolucionar independientes: el form
 * automático para clientes que aún no cargaron datos, y este modal para
 * admin que está cambiando un método ya cargado o moviéndolo a/desde Retiro.
 *
 * Compartido entre admin (este modal) y futuro link público de PR 2.
 */

// Lista exhaustiva de carriers prohibidos. Sincronizada con
// src/pages/ShippingForm.tsx y backend/lib/payment-helpers.js — si agregás
// uno acá, agregalo en los otros dos lugares.
const FORBIDDEN_CARRIERS: string[] = [
  'correo argentino', 'correos argentinos', 'correo arg', 'correos arg',
  'correoarg', 'correoargentino', 'correosargentinos',
  'correo argetino', 'correos argetinos', 'correo argntino', 'correos argntinos',
  'correo argentno', 'correos argentnos', 'correo argentnio', 'correos argentnios',
  'correo argentinno', 'correo arjentino', 'correos arjentinos',
  'correo agentino', 'correos agentinos', 'correo argentina', 'correos argentinas',
  'andreani', 'andreani sa', 'andreani s.a.', 'andreni', 'andreny',
  'andriani', 'andereani', 'andreanis', 'andreans', 'andrean',
  'oca', 'oca sa', 'oca s.a.', 'oca express', 'o c a', 'o.c.a',
];
const FORBIDDEN_CARRIER_PATTERNS: RegExp[] = FORBIDDEN_CARRIERS.map(
  c => new RegExp('\\b' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i')
);
function normalizeCarrierName(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[._\-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function isForbiddenCarrier(value: string): boolean {
  if (!value) return false;
  const normalized = normalizeCarrierName(value);
  return FORBIDDEN_CARRIER_PATTERNS.some(p => p.test(normalized));
}

type ModeOption = 'RETIRO' | 'VIA_CARGO' | 'OTRO';
type DestinoTipo = 'SUCURSAL' | 'DOMICILIO' | '';

interface FormData {
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

const emptyFormData: FormData = {
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

interface ShippingRequestSnapshot {
  empresa_envio?: 'VIA_CARGO' | 'OTRO';
  empresa_envio_otro?: string | null;
  destino_tipo?: 'SUCURSAL' | 'DOMICILIO';
  direccion_entrega?: string;
  nombre_apellido?: string;
  dni?: string;
  email?: string;
  codigo_postal?: string;
  provincia?: string;
  localidad?: string;
  telefono?: string;
  comentarios?: string | null;
}

interface TnAddress {
  name?: string | null;
  address?: string | null;
  number?: string | null;
  floor?: string | null;
  locality?: string | null;
  city?: string | null;
  province?: string | null;
  zipcode?: string | null;
  phone?: string | null;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  orderNumber: string;
  isPickupOrder: boolean;
  currentShippingType: string | null;
  shippingRequest: ShippingRequestSnapshot | null;
  tnAddress: TnAddress | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  onSuccess: () => void;
}

export function ShippingChangeModal({
  isOpen, onClose, orderNumber,
  isPickupOrder, currentShippingType, shippingRequest, tnAddress,
  customerName, customerPhone, customerEmail,
  onSuccess,
}: Props) {
  // Modo inicial según método actual.
  const initialMode: ModeOption = useMemo(() => {
    if (isPickupOrder) return 'RETIRO';
    if (shippingRequest?.empresa_envio === 'OTRO') return 'OTRO';
    return 'VIA_CARGO';
  }, [isPickupOrder, shippingRequest]);

  const [mode, setMode] = useState<ModeOption>(initialMode);
  const [formData, setFormData] = useState<FormData>(emptyFormData);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Pre-populate cada vez que el modal se abre.
  useEffect(() => {
    if (!isOpen) return;
    setMode(initialMode);
    setErrors({});
    setSubmitError(null);

    if (shippingRequest) {
      // Tenía datos de envío cargados → pre-llenar con los actuales.
      setFormData({
        empresa_envio_otro: shippingRequest.empresa_envio_otro || '',
        destino_tipo: shippingRequest.destino_tipo || '',
        direccion_entrega: shippingRequest.direccion_entrega || '',
        nombre_apellido: shippingRequest.nombre_apellido || '',
        dni: shippingRequest.dni || '',
        email: shippingRequest.email || '',
        codigo_postal: shippingRequest.codigo_postal || '',
        provincia: shippingRequest.provincia || '',
        localidad: shippingRequest.localidad || '',
        telefono: shippingRequest.telefono || '',
        comentarios: shippingRequest.comentarios || '',
      });
    } else if (tnAddress) {
      // Venía de Envío Nube u otro: extraer datos del shipping_address de TN.
      const addrParts = [tnAddress.address, tnAddress.number, tnAddress.floor]
        .filter(Boolean)
        .join(' ')
        .trim();
      setFormData({
        empresa_envio_otro: '',
        destino_tipo: 'DOMICILIO',
        direccion_entrega: addrParts,
        nombre_apellido: tnAddress.name || customerName || '',
        dni: '',
        email: customerEmail || '',
        codigo_postal: tnAddress.zipcode || '',
        provincia: tnAddress.province || '',
        localidad: tnAddress.locality || tnAddress.city || '',
        telefono: tnAddress.phone || customerPhone || '',
        comentarios: '',
      });
    } else {
      // Retiro previo → form vacío salvo datos del cliente.
      setFormData({
        ...emptyFormData,
        nombre_apellido: customerName || '',
        email: customerEmail || '',
        telefono: customerPhone || '',
      });
    }
  }, [isOpen, initialMode, shippingRequest, tnAddress, customerName, customerPhone, customerEmail]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    if (errors[name]) setErrors(prev => ({ ...prev, [name]: '' }));
  }

  function validate(): boolean {
    if (mode === 'RETIRO') return true;
    const newErrors: Record<string, string> = {};
    if (mode === 'OTRO') {
      if (!formData.empresa_envio_otro.trim()) {
        newErrors.empresa_envio_otro = 'Ingresá la empresa';
      } else if (isForbiddenCarrier(formData.empresa_envio_otro)) {
        newErrors.empresa_envio_otro = 'No despachamos por Andreani / OCA / Correo Argentino. Elegí otro transporte.';
      }
    }
    if (!formData.destino_tipo) newErrors.destino_tipo = 'Elegí sucursal o domicilio';
    if (!formData.direccion_entrega.trim()) newErrors.direccion_entrega = 'Ingresá la dirección';
    if (!formData.nombre_apellido.trim()) newErrors.nombre_apellido = 'Ingresá nombre y apellido';
    if (!formData.dni.trim()) newErrors.dni = 'Ingresá el DNI';
    if (!formData.email.trim()) newErrors.email = 'Ingresá el email';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) newErrors.email = 'Email inválido';
    if (!formData.codigo_postal.trim()) newErrors.codigo_postal = 'Ingresá el CP';
    if (!formData.provincia.trim()) newErrors.provincia = 'Ingresá la provincia';
    if (!formData.localidad.trim()) newErrors.localidad = 'Ingresá la localidad';
    if (!formData.telefono.trim()) newErrors.telefono = 'Ingresá el teléfono';

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  async function handleSubmit() {
    setSubmitError(null);
    if (!validate()) return;

    setSubmitting(true);
    try {
      const payload = mode === 'RETIRO'
        ? { method: 'RETIRO' as const }
        : {
            method: mode,
            shipping_request: {
              empresa_envio: mode === 'VIA_CARGO' ? 'VIA_CARGO' as const : 'OTRO' as const,
              empresa_envio_otro: mode === 'OTRO' ? formData.empresa_envio_otro.trim() : null,
              destino_tipo: formData.destino_tipo as 'SUCURSAL' | 'DOMICILIO',
              direccion_entrega: formData.direccion_entrega.trim(),
              nombre_apellido: formData.nombre_apellido.trim(),
              dni: formData.dni.trim(),
              email: formData.email.trim().toLowerCase(),
              codigo_postal: formData.codigo_postal.trim(),
              provincia: formData.provincia.trim(),
              localidad: formData.localidad.trim(),
              telefono: formData.telefono.trim(),
              comentarios: formData.comentarios.trim() || null,
            },
          };

      await updateOrderShipping(orderNumber, payload);
      onSuccess();
      onClose();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Error al cambiar método de envío');
    } finally {
      setSubmitting(false);
    }
  }

  const isOtroForbidden = mode === 'OTRO' && formData.empresa_envio_otro
    ? isForbiddenCarrier(formData.empresa_envio_otro)
    : false;

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !submitting && onClose()}
      title="Cambiar método de envío"
      size="lg"
    >
      <div className="space-y-5">
        {/* Banner: método actual */}
        <div className="p-3 bg-neutral-50 rounded-lg text-sm">
          <span className="text-neutral-500">Método actual: </span>
          <span className="font-medium text-neutral-900">{currentShippingType || '(sin método)'}</span>
        </div>

        {/* Toggle Retiro / Envío */}
        <div>
          <label className="block text-sm font-medium text-neutral-700 mb-2">
            ¿Cómo recibe el pedido el cliente?
          </label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setMode('RETIRO')}
              disabled={submitting}
              className={`p-4 rounded-xl border-2 text-center transition-all flex flex-col items-center gap-2 ${
                mode === 'RETIRO'
                  ? 'border-neutral-900 bg-neutral-900 text-white'
                  : 'border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300'
              }`}
            >
              <Store size={22} />
              <span className="font-medium">Retiro en local</span>
            </button>
            <button
              type="button"
              onClick={() => setMode(mode === 'RETIRO' ? 'VIA_CARGO' : mode)}
              disabled={submitting}
              className={`p-4 rounded-xl border-2 text-center transition-all flex flex-col items-center gap-2 ${
                mode !== 'RETIRO'
                  ? 'border-neutral-900 bg-neutral-900 text-white'
                  : 'border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300'
              }`}
            >
              <Truck size={22} />
              <span className="font-medium">Envío</span>
            </button>
          </div>
        </div>

        {/* Si Envío: dropdown empresa + form completo */}
        {mode !== 'RETIRO' && (
          <>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                Empresa de envío <span className="text-red-500">*</span>
              </label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as ModeOption)}
                disabled={submitting}
                className="w-full rounded-lg border border-neutral-200 bg-white px-4 py-3 text-neutral-900 focus:outline-none focus:ring-2 focus:ring-neutral-900"
              >
                <option value="VIA_CARGO">Vía Cargo</option>
                <option value="OTRO">Otra empresa</option>
              </select>
            </div>

            {mode === 'OTRO' && (
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                  Nombre de la empresa <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="empresa_envio_otro"
                  value={formData.empresa_envio_otro}
                  onChange={handleChange}
                  disabled={submitting}
                  placeholder="Ej: Cruz del Sur"
                  className={`w-full rounded-lg border ${errors.empresa_envio_otro || isOtroForbidden ? 'border-red-300' : 'border-neutral-200'} bg-white px-4 py-3 focus:outline-none focus:ring-2 focus:ring-neutral-900`}
                />
                {isOtroForbidden ? (
                  <div className="mt-2 bg-red-50 border border-red-300 text-red-900 text-sm px-3 py-2 rounded-lg flex items-start gap-2">
                    <AlertCircle size={16} className="flex-shrink-0 mt-0.5 text-red-600" />
                    <span>No despachamos por Correo Argentino, Andreani ni OCA. Elegí otro transporte.</span>
                  </div>
                ) : (
                  errors.empresa_envio_otro && <p className="mt-1.5 text-sm text-red-600">{errors.empresa_envio_otro}</p>
                )}
              </div>
            )}

            {/* Destino */}
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                Tipo de destino <span className="text-red-500">*</span>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setFormData(p => ({ ...p, destino_tipo: 'SUCURSAL' }))}
                  disabled={submitting}
                  className={`p-3 rounded-xl border-2 text-center transition-all ${
                    formData.destino_tipo === 'SUCURSAL'
                      ? 'border-neutral-900 bg-neutral-900 text-white'
                      : 'border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300'
                  }`}
                >
                  Sucursal
                </button>
                <button
                  type="button"
                  onClick={() => setFormData(p => ({ ...p, destino_tipo: 'DOMICILIO' }))}
                  disabled={submitting}
                  className={`p-3 rounded-xl border-2 text-center transition-all ${
                    formData.destino_tipo === 'DOMICILIO'
                      ? 'border-neutral-900 bg-neutral-900 text-white'
                      : 'border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300'
                  }`}
                >
                  Domicilio
                </button>
              </div>
              {errors.destino_tipo && <p className="mt-1.5 text-sm text-red-600">{errors.destino_tipo}</p>}
            </div>

            {/* Resto del form */}
            {([
              { name: 'direccion_entrega', label: 'Dirección de entrega', placeholder: 'Calle, número, piso, depto o sucursal', type: 'text' },
              { name: 'nombre_apellido', label: 'Nombre y apellido', placeholder: 'Juan Pérez', type: 'text' },
              { name: 'dni', label: 'DNI', placeholder: '12345678', type: 'text' },
              { name: 'email', label: 'Email', placeholder: 'ejemplo@email.com', type: 'email' },
            ] as const).map(f => (
              <div key={f.name}>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                  {f.label} <span className="text-red-500">*</span>
                </label>
                <input
                  type={f.type}
                  name={f.name}
                  value={formData[f.name as keyof FormData]}
                  onChange={handleChange}
                  disabled={submitting}
                  placeholder={f.placeholder}
                  className={`w-full rounded-lg border ${errors[f.name] ? 'border-red-300' : 'border-neutral-200'} bg-white px-4 py-3 focus:outline-none focus:ring-2 focus:ring-neutral-900`}
                />
                {errors[f.name] && <p className="mt-1.5 text-sm text-red-600">{errors[f.name]}</p>}
              </div>
            ))}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                  Código postal <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  name="codigo_postal"
                  value={formData.codigo_postal}
                  onChange={handleChange}
                  disabled={submitting}
                  placeholder="1234"
                  className={`w-full rounded-lg border ${errors.codigo_postal ? 'border-red-300' : 'border-neutral-200'} bg-white px-4 py-3 focus:outline-none focus:ring-2 focus:ring-neutral-900`}
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
                  disabled={submitting}
                  placeholder="Buenos Aires"
                  className={`w-full rounded-lg border ${errors.provincia ? 'border-red-300' : 'border-neutral-200'} bg-white px-4 py-3 focus:outline-none focus:ring-2 focus:ring-neutral-900`}
                />
                {errors.provincia && <p className="mt-1.5 text-sm text-red-600">{errors.provincia}</p>}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                Localidad <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                name="localidad"
                value={formData.localidad}
                onChange={handleChange}
                disabled={submitting}
                placeholder="Ciudad"
                className={`w-full rounded-lg border ${errors.localidad ? 'border-red-300' : 'border-neutral-200'} bg-white px-4 py-3 focus:outline-none focus:ring-2 focus:ring-neutral-900`}
              />
              {errors.localidad && <p className="mt-1.5 text-sm text-red-600">{errors.localidad}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                Teléfono <span className="text-red-500">*</span>
              </label>
              <input
                type="tel"
                name="telefono"
                value={formData.telefono}
                onChange={handleChange}
                disabled={submitting}
                placeholder="11 12345678"
                className={`w-full rounded-lg border ${errors.telefono ? 'border-red-300' : 'border-neutral-200'} bg-white px-4 py-3 focus:outline-none focus:ring-2 focus:ring-neutral-900`}
              />
              {errors.telefono && <p className="mt-1.5 text-sm text-red-600">{errors.telefono}</p>}
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                Comentarios (opcional)
              </label>
              <textarea
                name="comentarios"
                value={formData.comentarios}
                onChange={handleChange}
                disabled={submitting}
                rows={2}
                placeholder="Algo extra que quieras agregar"
                className="w-full rounded-lg border border-neutral-200 bg-white px-4 py-3 focus:outline-none focus:ring-2 focus:ring-neutral-900"
              />
            </div>
          </>
        )}

        {/* Error global */}
        {submitError && (
          <div className="p-3 bg-red-50 rounded-lg text-sm text-red-700">{submitError}</div>
        )}

        {/* Botones */}
        <div className="flex gap-3 pt-2">
          <Button
            variant="secondary"
            className="flex-1"
            onClick={onClose}
            disabled={submitting}
          >
            Cancelar
          </Button>
          <Button
            className="flex-1"
            onClick={handleSubmit}
            disabled={submitting || isOtroForbidden}
            leftIcon={submitting ? <Loader2 size={16} className="animate-spin" /> : undefined}
          >
            {submitting ? 'Guardando...' : 'Guardar cambios'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
