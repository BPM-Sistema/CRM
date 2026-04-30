import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  showCloseButton?: boolean;
}

const sizeStyles = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-[90vw]',
};

export function Modal({ isOpen, onClose, title, children, size = 'md', showCloseButton = true }: ModalProps) {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const hasHeader = !!(title || showCloseButton);

  // Usamos portal a document.body para escapar cualquier stacking context
  // creado por ancestros (ej: Header con backdrop-blur). Sin esto, los z-index
  // del modal quedan encerrados dentro del padre y otros elementos de la
  // pagina pueden taparlo.
  return createPortal(
    <>
      <div
        className="fixed inset-0 bg-neutral-900/50 backdrop-blur-sm z-[100] transition-opacity duration-200"
        onClick={onClose}
      />
      <div
        className="fixed inset-0 z-[101] overflow-y-auto"
        onClick={onClose}
      >
        <div className="flex justify-center px-4 py-8 min-h-full">
        <div
          className={clsx(
            'relative w-full bg-white rounded-2xl shadow-large grid self-start',
            hasHeader ? 'grid-rows-[auto_minmax(0,1fr)]' : 'grid-rows-[minmax(0,1fr)]',
            'max-h-[calc(100vh-4rem)]',
            'animate-in fade-in-0 zoom-in-95 duration-200',
            sizeStyles[size]
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {hasHeader && (
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100">
              {title && (
                <h2 className="text-lg font-semibold text-neutral-900">{title}</h2>
              )}
              {showCloseButton && (
                <button
                  onClick={onClose}
                  className="p-2 -m-2 text-neutral-400 hover:text-neutral-600 transition-colors rounded-lg hover:bg-neutral-100"
                >
                  <X size={20} />
                </button>
              )}
            </div>
          )}
          <div className="p-6 overflow-y-auto">{children}</div>
        </div>
        </div>
      </div>
    </>,
    document.body
  );
}
