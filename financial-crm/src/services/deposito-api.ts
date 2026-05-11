import { authFetch } from './api';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// ─── Types ─────────────────────────────────────────────────

export interface TransitionRow {
  id: number;
  order_number: string;
  from_status: string | null;
  to_status: string;
  source: string;
  created_at: string;
  employee_id: number | null;
  employee_name: string | null;
}

export interface TransitionsResponse {
  ok: true;
  items: TransitionRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export interface DepositoMetrics {
  total_transiciones: number;
  empaquetados: number;
  pasados_pendiente_stock: number;
  despachados: number;
  empleado_top: { id: number; nombre: string; count: number } | null;
}

export interface MetricsResponse {
  ok: true;
  metrics: DepositoMetrics;
}

export interface EmployeeRow {
  id: number;
  nombre: string;
  active: boolean;
}

export interface EmployeesResponse {
  ok: true;
  items: EmployeeRow[];
}

// ─── Filtros ───────────────────────────────────────────────

export interface DepositoFilters {
  employeeIds?: number[];
  transitions?: string[];
  fromDate?: string; // ISO
  toDate?: string;   // ISO
  source?: string;
}

function buildQuery(filters: DepositoFilters, extra?: Record<string, string | number>): string {
  const params = new URLSearchParams();
  if (filters.employeeIds?.length) params.set('employee_ids', filters.employeeIds.join(','));
  if (filters.transitions?.length) params.set('transitions', filters.transitions.join(','));
  if (filters.fromDate) params.set('from_date', filters.fromDate);
  if (filters.toDate) params.set('to_date', filters.toDate);
  if (filters.source) params.set('source', filters.source);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
  }
  return params.toString();
}

// ─── Calls ─────────────────────────────────────────────────

export async function fetchTransitions(
  filters: DepositoFilters,
  opts: { page?: number; limit?: number; orderBy?: string; orderDir?: 'asc' | 'desc' } = {}
): Promise<TransitionsResponse> {
  const extra: Record<string, string | number> = {};
  if (opts.page) extra.page = opts.page;
  if (opts.limit) extra.limit = opts.limit;
  if (opts.orderBy) extra.order_by = opts.orderBy;
  if (opts.orderDir) extra.order_dir = opts.orderDir;
  const qs = buildQuery(filters, extra);
  const r = await authFetch(`${API_BASE_URL}/admin/deposito/transitions?${qs}`);
  if (!r.ok) throw new Error(`Error ${r.status} al cargar transiciones`);
  return r.json();
}

export async function fetchMetrics(filters: DepositoFilters): Promise<MetricsResponse> {
  const qs = buildQuery(filters);
  const r = await authFetch(`${API_BASE_URL}/admin/deposito/metrics?${qs}`);
  if (!r.ok) throw new Error(`Error ${r.status} al cargar métricas`);
  return r.json();
}

export async function fetchEmployees(): Promise<EmployeesResponse> {
  const r = await authFetch(`${API_BASE_URL}/admin/deposito/employees`);
  if (!r.ok) throw new Error(`Error ${r.status} al cargar empleados`);
  return r.json();
}
