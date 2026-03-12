import { useSearchParams } from 'react-router-dom';
import { useCallback, useMemo } from 'react';

type FilterValue = string | number | boolean | null;

type FilterDefaults<T extends Record<string, FilterValue>> = T;

type FilterSetters<T extends Record<string, FilterValue>> = {
  [K in keyof T]: (value: T[K]) => void;
};

interface UseUrlFiltersReturn<T extends Record<string, FilterValue>> {
  filters: T;
  setFilter: <K extends keyof T>(key: K, value: T[K]) => void;
  setFilters: (updates: Partial<T>) => void;
  resetFilters: () => void;
  /** Individual setters for each filter (e.g., setEstadoPago, setSearch) */
  setters: FilterSetters<T>;
}

/**
 * Hook for persisting filters in URL query params.
 *
 * Features:
 * - Reads initial values from URL
 * - Updates URL when filters change
 * - Default values are NOT shown in URL (keeps it clean)
 * - Type-safe: infers types from defaults
 * - Works with browser back/forward
 *
 * Usage:
 * ```tsx
 * const { filters, setFilter, setFilters, resetFilters } = useUrlFilters({
 *   estado_pago: 'all',
 *   estado_pedido: 'all',
 *   search: '',
 *   page: 1,
 * });
 *
 * // Read
 * filters.estado_pago // 'all' | string from URL
 *
 * // Update single
 * setFilter('estado_pago', 'pendiente');
 *
 * // Update multiple
 * setFilters({ estado_pago: 'pendiente', page: 1 });
 *
 * // Reset all to defaults
 * resetFilters();
 * ```
 */
export function useUrlFilters<T extends Record<string, FilterValue>>(
  defaults: FilterDefaults<T>
): UseUrlFiltersReturn<T> {
  const [searchParams, setSearchParams] = useSearchParams();

  // Parse value from URL string based on default type
  const parseValue = useCallback((urlValue: string | null, defaultValue: FilterValue): FilterValue => {
    if (urlValue === null) return defaultValue;

    if (typeof defaultValue === 'number') {
      const parsed = Number(urlValue);
      return isNaN(parsed) ? defaultValue : parsed;
    }

    if (typeof defaultValue === 'boolean') {
      return urlValue === 'true';
    }

    return urlValue;
  }, []);

  // Get current filter values (from URL or defaults)
  const filters = useMemo(() => {
    const result = {} as T;

    for (const key of Object.keys(defaults) as Array<keyof T>) {
      const urlValue = searchParams.get(key as string);
      result[key] = parseValue(urlValue, defaults[key]) as T[keyof T];
    }

    return result;
  }, [searchParams, defaults, parseValue]);

  // Update URL params, omitting default values
  const updateParams = useCallback((updates: Partial<T>) => {
    setSearchParams((prev) => {
      const newParams = new URLSearchParams(prev);

      for (const [key, value] of Object.entries(updates)) {
        const defaultValue = defaults[key as keyof T];

        // Remove param if it equals default value (keep URL clean)
        if (value === defaultValue || value === '' || value === null) {
          newParams.delete(key);
        } else {
          newParams.set(key, String(value));
        }
      }

      return newParams;
    }, { replace: true }); // replace: true to avoid polluting history
  }, [setSearchParams, defaults]);

  // Set single filter
  const setFilter = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    updateParams({ [key]: value } as unknown as Partial<T>);
  }, [updateParams]);

  // Set multiple filters at once
  const setFilters = useCallback((updates: Partial<T>) => {
    updateParams(updates);
  }, [updateParams]);

  // Reset all filters to defaults
  const resetFilters = useCallback(() => {
    setSearchParams({}, { replace: true });
  }, [setSearchParams]);

  // Generate individual setters for convenience
  const setters = useMemo(() => {
    const result = {} as FilterSetters<T>;

    for (const key of Object.keys(defaults) as Array<keyof T>) {
      result[key] = ((value: T[keyof T]) => setFilter(key, value)) as FilterSetters<T>[keyof T];
    }

    return result;
  }, [defaults, setFilter]);

  return {
    filters,
    setFilter,
    setFilters,
    resetFilters,
    setters,
  };
}

// Re-export for convenience
export default useUrlFilters;
