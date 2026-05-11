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
  created_at?: string;
  permissions_count?: number;
  last_action_at?: string | null;
}

export interface EmployeesResponse {
  ok: true;
  items: EmployeeRow[];
}

export interface CreateEmployeeResponse {
  ok: true;
  employee: {
    id: number;
    nombre: string;
    active: boolean;
    codigo: string;
    permissions: string[];
  };
}

export interface UpdateEmployeeResponse {
  ok: true;
  employee: { id: number; nombre: string; active: boolean };
}

export interface PermissionsResponse {
  ok: true;
  permissions: string[];
}

export interface CodeResponse {
  ok: true;
  codigo: string;
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

export async function fetchEmployeePermissions(id: number): Promise<PermissionsResponse> {
  const r = await authFetch(`${API_BASE_URL}/admin/deposito/employees/${id}/permissions`);
  if (!r.ok) throw new Error(`Error ${r.status} al cargar permisos`);
  return r.json();
}

export async function createEmployee(payload: { nombre: string; permissions: string[] }): Promise<CreateEmployeeResponse> {
  const r = await authFetch(`${API_BASE_URL}/admin/deposito/employees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `Error ${r.status} al crear empleado`);
  }
  return r.json();
}

export async function updateEmployee(id: number, payload: { nombre?: string; active?: boolean }): Promise<UpdateEmployeeResponse> {
  const r = await authFetch(`${API_BASE_URL}/admin/deposito/employees/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `Error ${r.status} al actualizar empleado`);
  }
  return r.json();
}

export async function updateEmployeePermissions(id: number, permissions: string[]): Promise<PermissionsResponse> {
  const r = await authFetch(`${API_BASE_URL}/admin/deposito/employees/${id}/permissions`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permissions }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `Error ${r.status} al actualizar permisos`);
  }
  return r.json();
}

export async function fetchEmployeeCode(id: number): Promise<CodeResponse> {
  const r = await authFetch(`${API_BASE_URL}/admin/deposito/employees/${id}/code`);
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `Error ${r.status} al obtener código`);
  }
  return r.json();
}

// ─── Stock Issues (PR 7c) ──────────────────────────────────

export interface StockIssue {
  id: number;
  order_number: string;
  order_product_id: number | null;
  product_name: string;
  variant: string | null;
  sku: string | null;
  quantity_missing: number;
  created_at: string;
  resolved_at: string | null;
  resolved_by_user_id: string | null;
  reported_by_id: number | null;
  reported_by_nombre: string | null;
  resolved_by_user_name: string | null;
}

export interface StockIssuesFilters {
  status?: 'open' | 'resolved' | 'all';
  orderNumber?: string;
  sku?: string;
  productSearch?: string;
  fromDate?: string;
  toDate?: string;
}

export interface StockIssuesResponse {
  ok: true;
  items: StockIssue[];
  total: number;
  open_count: number;
  page: number;
  pageSize: number;
  pages: number;
}

export async function fetchStockIssues(
  filters: StockIssuesFilters = {},
  opts: { page?: number; limit?: number } = {}
): Promise<StockIssuesResponse> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.orderNumber) params.set('order_number', filters.orderNumber);
  if (filters.sku) params.set('sku', filters.sku);
  if (filters.productSearch) params.set('product_search', filters.productSearch);
  if (filters.fromDate) params.set('from_date', filters.fromDate);
  if (filters.toDate) params.set('to_date', filters.toDate);
  if (opts.page) params.set('page', String(opts.page));
  if (opts.limit) params.set('limit', String(opts.limit));
  const r = await authFetch(`${API_BASE_URL}/admin/deposito/stock-issues?${params.toString()}`);
  if (!r.ok) throw new Error(`Error ${r.status} al cargar issues`);
  return r.json();
}

export async function resolveStockIssue(id: number): Promise<{ ok: true; issue: { id: number; order_number: string; resolved_at: string } }> {
  const r = await authFetch(`${API_BASE_URL}/admin/deposito/stock-issues/${id}/resolve`, { method: 'PATCH' });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `Error ${r.status} al resolver issue`);
  }
  return r.json();
}

export async function regenerateEmployeeCode(id: number): Promise<CodeResponse> {
  const r = await authFetch(`${API_BASE_URL}/admin/deposito/employees/${id}/regenerate-code`, { method: 'POST' });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error || `Error ${r.status} al regenerar código`);
  }
  return r.json();
}
