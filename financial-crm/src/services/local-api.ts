import { authFetch } from './api';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// =====================================================
// TIPOS
// =====================================================

export interface LocalOrderItem {
  id: string;
  local_order_id: string;
  product_id: number;
  variant_id: string | null;
  sku_snapshot: string | null;
  product_name_snapshot: string;
  variant_name_snapshot: string | null;
  reserved_qty: number;
  sent_qty: number | null;
  received_qty: number | null;
  control_status: 'pendiente' | 'ok' | 'error';
  control_checked_at: string | null;
  line_notes: string | null;
}

export interface LocalOrderPrint {
  id: string;
  local_order_id: string;
  printed_by: string;
  printed_by_name: string;
  printed_at: string;
  print_version: number;
}

export interface LocalOrder {
  id: string;
  local_order_number: number;
  status: string;
  created_by_user_id: string;
  created_by_name: string;
  created_by_role: string;
  notes_internal: string | null;
  print_count: number;
  last_printed_by: string | null;
  last_printed_by_name: string | null;
  last_edited_by: string | null;
  last_edited_by_name: string | null;
  printed_at: string | null;
  packed_at: string | null;
  shipped_at: string | null;
  received_at: string | null;
  confirmed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  items_count?: number;
  total_qty?: number;
  items?: LocalOrderItem[];
  prints?: LocalOrderPrint[];
  logs?: LocalLog[];
}

export interface LocalBoxOrderItem {
  id: string;
  local_box_order_id: string;
  product_id: number;
  variant_id: string | null;
  sku_snapshot: string | null;
  product_name_snapshot: string;
  variant_name_snapshot: string | null;
  qty: number;
  unit_price: number;
  line_total: number;
}

export interface LocalBoxOrder {
  id: string;
  local_box_order_number: number;
  status: string;
  created_by_user_id: string;
  created_by_name: string;
  notes: string | null;
  total_amount: number;
  paid_amount: number;
  payment_status: string;
  printed_at: string | null;
  paid_at: string | null;
  confirmed_paid_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  items_count?: number;
  items?: LocalBoxOrderItem[];
  logs?: LocalLog[];
}

export interface LocalLog {
  id: number;
  action: string;
  entity_type: string;
  entity_id: string;
  user_id: string;
  user_role: string;
  username: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface LocalAlert {
  type: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  entity_type: string;
  entity_id: string;
  created_at: string;
  link: string;
}

export interface ProductSearchResult {
  product_id: number;
  variant_id: string | null;
  product_name: string;
  variant_name: string | null;
  sku: string | null;
  price: number;
}

export interface LocalStockItem {
  id: string;
  product_id: number;
  variant_id: string | null;
  product_name: string;
  variant_name: string | null;
  qty: number;
}

export interface DailySummary {
  total_orders: number;
  paid_orders: number;
  pending_orders: number;
  partial_orders: number;
  total_sold: number;
  total_collected: number;
  pending_amount: number;
}

// =====================================================
// PRODUCTOS
// =====================================================

export async function searchProducts(q: string): Promise<ProductSearchResult[]> {
  const response = await authFetch(`${API_BASE_URL}/local/products/search?q=${encodeURIComponent(q)}`);
  if (!response.ok) throw new Error('Error al buscar productos');
  const data = await response.json();
  return data.products;
}

// =====================================================
// RESERVAS
// =====================================================

export async function createLocalOrder(items: Array<{
  product_id: number;
  variant_id?: string;
  product_name: string;
  variant_name?: string;
  sku?: string;
  qty: number;
  line_notes?: string;
}>, notes_internal?: string): Promise<LocalOrder> {
  const response = await authFetch(`${API_BASE_URL}/local/orders`, {
    method: 'POST',
    body: JSON.stringify({ items, notes_internal }),
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Error al crear reserva');
  }
  const data = await response.json();
  return data.order;
}

export async function fetchLocalOrders(params: {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
}): Promise<{ orders: LocalOrder[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
  const query = new URLSearchParams();
  if (params.status && params.status !== 'all') query.set('status', params.status);
  if (params.search) query.set('search', params.search);
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));

  const response = await authFetch(`${API_BASE_URL}/local/orders?${query}`);
  if (!response.ok) throw new Error('Error al listar reservas');
  return await response.json();
}

export async function fetchLocalOrderDetail(id: string): Promise<LocalOrder> {
  const response = await authFetch(`${API_BASE_URL}/local/orders/${id}`);
  if (!response.ok) throw new Error('Error al obtener detalle');
  const data = await response.json();
  return data.order;
}

export async function updateLocalOrder(id: string, body: {
  items?: Array<{
    product_id: number;
    variant_id?: string;
    product_name: string;
    variant_name?: string;
    sku?: string;
    qty: number;
    line_notes?: string;
  }>;
  notes_internal?: string;
}): Promise<LocalOrder> {
  const response = await authFetch(`${API_BASE_URL}/local/orders/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Error al editar reserva');
  }
  const data = await response.json();
  return data.order;
}

export async function printLocalOrder(id: string): Promise<{
  version: number;
  order: LocalOrder;
  items: LocalOrderItem[];
}> {
  const response = await authFetch(`${API_BASE_URL}/local/orders/${id}/print`, { method: 'POST' });
  if (!response.ok) throw new Error('Error al imprimir');
  const data = await response.json();
  return data.print;
}

export async function packLocalOrder(id: string): Promise<void> {
  const response = await authFetch(`${API_BASE_URL}/local/orders/${id}/pack`, { method: 'POST' });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Error al marcar armado');
  }
}

export async function shipLocalOrder(id: string): Promise<void> {
  const response = await authFetch(`${API_BASE_URL}/local/orders/${id}/ship`, { method: 'POST' });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Error al marcar enviado');
  }
}

export async function startControlLocalOrder(id: string): Promise<void> {
  const response = await authFetch(`${API_BASE_URL}/local/orders/${id}/start-control`, { method: 'POST' });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Error al iniciar control');
  }
}

export async function controlLocalOrder(id: string, items: Array<{
  item_id: string;
  received_qty: number;
}>): Promise<{ all_ok: boolean; status: string; items: Array<{ item_id: string; received_qty: number; control_status: string }> }> {
  const response = await authFetch(`${API_BASE_URL}/local/orders/${id}/control`, {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Error al procesar control');
  }
  return await response.json();
}

export async function confirmLocalOrder(id: string): Promise<void> {
  const response = await authFetch(`${API_BASE_URL}/local/orders/${id}/confirm`, { method: 'POST' });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Error al confirmar');
  }
}

export async function cancelLocalOrder(id: string): Promise<void> {
  const response = await authFetch(`${API_BASE_URL}/local/orders/${id}/cancel`, { method: 'POST' });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Error al cancelar');
  }
}

// =====================================================
// STOCK LOCAL
// =====================================================

export async function fetchLocalStock(q?: string): Promise<LocalStockItem[]> {
  const query = q ? `?q=${encodeURIComponent(q)}` : '';
  const response = await authFetch(`${API_BASE_URL}/local/stock${query}`);
  if (!response.ok) throw new Error('Error al obtener stock');
  const data = await response.json();
  return data.stock;
}

// =====================================================
// CAJA
// =====================================================

export async function createBoxOrder(items: Array<{
  product_id: number;
  variant_id?: string;
  product_name: string;
  variant_name?: string;
  sku?: string;
  qty: number;
  unit_price: number;
}>, notes?: string): Promise<LocalBoxOrder> {
  const response = await authFetch(`${API_BASE_URL}/local/box-orders`, {
    method: 'POST',
    body: JSON.stringify({ items, notes }),
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Error al crear pedido de caja');
  }
  const data = await response.json();
  return data.order;
}

export async function fetchBoxOrders(params: {
  status?: string;
  payment_status?: string;
  search?: string;
  date?: string;
  page?: number;
  limit?: number;
}): Promise<{ orders: LocalBoxOrder[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
  const query = new URLSearchParams();
  if (params.status && params.status !== 'all') query.set('status', params.status);
  if (params.payment_status && params.payment_status !== 'all') query.set('payment_status', params.payment_status);
  if (params.search) query.set('search', params.search);
  if (params.date) query.set('date', params.date);
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));

  const response = await authFetch(`${API_BASE_URL}/local/box-orders?${query}`);
  if (!response.ok) throw new Error('Error al listar pedidos de caja');
  return await response.json();
}

export async function fetchBoxOrderDetail(id: string): Promise<LocalBoxOrder> {
  const response = await authFetch(`${API_BASE_URL}/local/box-orders/${id}`);
  if (!response.ok) throw new Error('Error al obtener detalle');
  const data = await response.json();
  return data.order;
}

export async function updateBoxOrder(id: string, body: {
  items?: Array<{
    product_id: number;
    variant_id?: string;
    product_name: string;
    variant_name?: string;
    sku?: string;
    qty: number;
    unit_price: number;
  }>;
  notes?: string;
}): Promise<LocalBoxOrder> {
  const response = await authFetch(`${API_BASE_URL}/local/box-orders/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Error al editar pedido');
  }
  const data = await response.json();
  return data.order;
}

export async function printBoxOrder(id: string): Promise<{ order: LocalBoxOrder; items: LocalBoxOrderItem[] }> {
  const response = await authFetch(`${API_BASE_URL}/local/box-orders/${id}/print`, { method: 'POST' });
  if (!response.ok) throw new Error('Error al imprimir');
  const data = await response.json();
  return data.print;
}

export async function payBoxOrder(id: string, amount: number): Promise<{
  paid_amount: number;
  total_amount: number;
  payment_status: string;
  remaining: number;
}> {
  const response = await authFetch(`${API_BASE_URL}/local/box-orders/${id}/pay`, {
    method: 'POST',
    body: JSON.stringify({ amount }),
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Error al registrar pago');
  }
  return await response.json();
}

export async function cancelBoxOrder(id: string): Promise<void> {
  const response = await authFetch(`${API_BASE_URL}/local/box-orders/${id}/cancel`, { method: 'POST' });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Error al cancelar');
  }
}

export async function fetchDailySummary(date?: string): Promise<{ date: string; summary: DailySummary; orders: LocalBoxOrder[] }> {
  const query = date ? `?date=${date}` : '';
  const response = await authFetch(`${API_BASE_URL}/local/box-orders/daily${query}`);
  if (!response.ok) throw new Error('Error al obtener caja diaria');
  return await response.json();
}

// =====================================================
// ALERTAS
// =====================================================

export async function fetchLocalAlerts(): Promise<{ alerts: LocalAlert[]; total: number }> {
  const response = await authFetch(`${API_BASE_URL}/local/alerts`);
  if (!response.ok) throw new Error('Error al obtener alertas');
  return await response.json();
}
