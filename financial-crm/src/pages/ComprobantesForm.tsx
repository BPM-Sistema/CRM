import { useState, FormEvent, useRef } from 'react';
import { Check, AlertCircle, Loader2, FileImage } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || 'https://api.bpmadministrador.com';

export function ComprobantesForm() {
  const [orderNumber, setOrderNumber] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isOrderNotFound, setIsOrderNotFound] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleOrderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Solo permitir números
    const value = e.target.value.replace(/[^0-9]/g, '');
    setOrderNumber(value);
    // Limpiar errores al escribir
    if (isOrderNotFound) {
      setIsOrderNotFound(false);
      setSubmitError(null);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      setSubmitError(null);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const droppedFile = e.dataTransfer.files?.[0];
    if (droppedFile) {
      setFile(droppedFile);
      setSubmitError(null);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setIsOrderNotFound(false);

    if (!orderNumber.trim()) {
      setSubmitError('Ingresá un número de pedido válido');
      return;
    }

    if (!file) {
      setSubmitError('Seleccioná un comprobante');
      return;
    }

    setIsSubmitting(true);

    try {
      const formData = new FormData();
      formData.append('orderNumber', orderNumber);
      formData.append('file', file);

      const response = await fetch(`${API_BASE}/upload`, {
        method: 'POST',
        body: formData,
      });

      let data;
      try {
        data = await response.json();
      } catch {
        data = { error: 'Error al procesar comprobante' };
      }

      if (!response.ok) {
        const errorMsg = data.error || 'Error al procesar comprobante';
        if (errorMsg.toLowerCase().includes('no existe')) {
          setIsOrderNotFound(true);
        }
        throw new Error(errorMsg);
      }

      setSubmitSuccess(true);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Error al enviar el comprobante');
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
            Comprobante enviado
          </h2>
          <p className="text-neutral-600 mb-4">
            Recibimos tu comprobante correctamente. En breve vamos a verificar el pago.
          </p>
          <p className="text-neutral-600 mb-6">
            Si tenés alguna consulta, escribinos al WhatsApp
            <br />
            <a href="https://wa.me/5491154865530" className="font-semibold text-emerald-600 hover:underline">
              11-5486-5530
            </a>
          </p>
          <p className="text-sm text-neutral-500">
            Pedido: <span className="font-semibold">#{orderNumber}</span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-neutral-50 to-neutral-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <img src="/logo.webp" alt="Blanqueria" className="h-20 mx-auto mb-4" />
          <h1 className="text-3xl font-bold text-neutral-900 mb-2">
            Confirmar pago
          </h1>
          <p className="text-neutral-600">
            Ingresá tu número de pedido y subí el comprobante
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-xl p-6 md:p-8 space-y-6">
          {/* Número de pedido */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">
              Número de Pedido <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={orderNumber}
              onChange={handleOrderChange}
              placeholder="Ej: 12345"
              autoFocus
              className={`w-full rounded-lg border ${isOrderNotFound ? 'border-red-300 ring-2 ring-red-100' : 'border-neutral-200'} bg-white px-4 py-3 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:border-transparent transition-all`}
            />
            {isOrderNotFound && (
              <p className="mt-1.5 text-sm text-red-600 flex items-center gap-1">
                <AlertCircle size={14} />
                Pedido no encontrado. Verificá el número e intentá de nuevo.
              </p>
            )}
          </div>

          {/* Comprobante */}
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1.5">
              Comprobante de pago <span className="text-red-500">*</span>
            </label>
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`w-full rounded-lg border-2 border-dashed ${isDragging ? 'border-neutral-900 bg-neutral-100' : file ? 'border-emerald-300 bg-emerald-50' : 'border-neutral-200 bg-neutral-50'} px-4 py-6 text-center cursor-pointer hover:border-neutral-400 transition-all`}
            >
              <input
                ref={fileInputRef}
                type="file"
                onChange={handleFileChange}
                accept="image/*,application/pdf"
                className="hidden"
              />
              {file ? (
                <div className="flex items-center justify-center gap-2 text-emerald-700">
                  <FileImage size={20} />
                  <span className="font-medium truncate max-w-[200px]">{file.name}</span>
                </div>
              ) : (
                <div className="text-neutral-500">
                  <FileImage size={32} className="mx-auto mb-2 text-neutral-400" />
                  <p className="font-medium">{isDragging ? 'Soltá el archivo acá' : 'Arrastrá o tocá para seleccionar'}</p>
                  <p className="text-sm">Imagen o PDF</p>
                </div>
              )}
            </div>
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
                Validando pedido y procesando...
              </>
            ) : (
              'Enviar comprobante'
            )}
          </button>

          {/* Error */}
          {submitError && !isOrderNotFound && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3">
              <AlertCircle size={20} className="text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm font-medium text-red-800">{submitError}</p>
            </div>
          )}
        </form>

        {/* Footer */}
        <p className="text-center text-sm text-neutral-500 mt-6">
          BPM Administrador
        </p>
      </div>
    </div>
  );
}
