import { ShieldX } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from './ui/Button';

interface AccessDeniedProps {
  message?: string;
}

export function AccessDenied({ message = 'No tenés permiso para acceder a esta sección.' }: AccessDeniedProps) {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-neutral-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
        <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <ShieldX size={32} className="text-red-600" />
        </div>
        <h2 className="text-xl font-bold text-neutral-900 mb-2">
          Acceso Denegado
        </h2>
        <p className="text-neutral-600 mb-6">
          {message}
        </p>
        <Button onClick={() => navigate('/')} className="w-full">
          Volver al inicio
        </Button>
      </div>
    </div>
  );
}
