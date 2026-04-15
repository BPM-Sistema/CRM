import { useState, useRef, useEffect } from 'react';
import { Search } from 'lucide-react';
import { Input } from '../ui/Input';
import { searchProducts, type ProductSearchResult } from '../../services/local-api';

interface ProductSearchProps {
  onSelect: (product: ProductSearchResult) => void;
  placeholder?: string;
}

export function ProductSearch({ onSelect, placeholder = 'Buscar producto por nombre o SKU...' }: ProductSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductSearchResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearch = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (value.length < 2) {
      setResults([]);
      setIsOpen(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const products = await searchProducts(value);
        setResults(products);
        setIsOpen(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
  };

  const handleSelect = (product: ProductSearchResult) => {
    onSelect(product);
    setQuery('');
    setResults([]);
    setIsOpen(false);
  };

  return (
    <div ref={wrapperRef} className="relative">
      <Input
        value={query}
        onChange={(e) => handleSearch(e.target.value)}
        placeholder={placeholder}
        leftIcon={<Search size={16} />}
      />
      {loading && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <div className="w-4 h-4 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {isOpen && results.length > 0 && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-neutral-200 rounded-xl shadow-lg max-h-64 overflow-y-auto">
          {results.map((product, idx) => (
            <button
              key={`${product.product_id}-${product.variant_id || idx}`}
              onClick={() => handleSelect(product)}
              className="w-full text-left px-4 py-2.5 hover:bg-sky-50 border-b border-neutral-100 last:border-0 transition-colors"
            >
              <div className="font-medium text-sm text-neutral-900">{product.product_name}</div>
              <div className="flex items-center gap-2 mt-0.5">
                {product.variant_name && (
                  <span className="text-xs text-neutral-500">{product.variant_name}</span>
                )}
                {product.sku && (
                  <span className="text-xs font-mono text-neutral-400">SKU: {product.sku}</span>
                )}
                {product.price && (
                  <span className="text-xs text-emerald-600 font-medium">${Number(product.price).toLocaleString('es-AR')}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
      {isOpen && results.length === 0 && !loading && query.length >= 2 && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-neutral-200 rounded-xl shadow-lg p-4 text-sm text-neutral-500 text-center">
          No se encontraron productos
        </div>
      )}
    </div>
  );
}
