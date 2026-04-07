const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// Helper para obtener el token de autenticación
function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('auth_token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
}

// Flag para evitar loops al refrescar permisos
let isRefreshingPermissions = false;

// Callback para notificar cambios de permisos al contexto de Auth
let onPermissionsChangeCallback: (() => void) | null = null;

export function setOnPermissionsChangeCallback(callback: () => void) {
  onPermissionsChangeCallback = callback;
}

// Fetch con autenticación (sin cache para datos en tiempo real)
export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, {
    ...options,
    cache: 'no-store', // Forzar datos frescos, nunca usar cache
    headers: {
      ...getAuthHeaders(),
      ...options.headers,
    },
  });

  if (response.status === 401) {
    // Token expirado o inválido
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    window.location.href = '/login';
  }

  // Verificar si los permisos cambiaron (comparar hash)
  const newHash = response.headers.get('X-Permissions-Hash');
  if (newHash && !isRefreshingPermissions) {
    const storedHash = localStorage.getItem('permissions_hash');
    if (storedHash && storedHash !== newHash) {
      console.log('[API] Permissions changed, refreshing...', { old: storedHash, new: newHash });
      // Actualizar hash y notificar al contexto
      localStorage.setItem('permissions_hash', newHash);
      if (onPermissionsChangeCallback) {
        onPermissionsChangeCallback();
      }
    } else if (!storedHash) {
      // Primera vez, guardar el hash
      localStorage.setItem('permissions_hash', newHash);
    }
  }

  return response;
}

// Tipos de estado
export type PaymentStatus = 'pendiente' | 'a_confirmar' | 'parcial' | 'total' | 'rechazado';
export type OrderStatus = 'pendiente_pago' | 'a_imprimir' | 'hoja_impresa' | 'armado' | 'retirado' | 'en_calle' | 'enviado' | 'cancelado';

// Tipos para las respuestas de la API
export interface ApiOrder {
  order_number: string;
  monto_tiendanube: number;
  total_pagado: number | null;
  saldo: number | null;
  estado_pago: string | null;
  estado_pedido: OrderStatus | null;
  currency: string;
  created_at: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  printed_at: string | null;
  packed_at: string | null;
  shipped_at: string | null;
  monto_original: number | null;
  comprobantes_count: string;
  pending_receipts_count: number;
  productos_count: number;
  shipping_type: string | null;
  requires_shipping_form: boolean;
  has_shipping_data: boolean;
}

export interface ApiComprobante {
  id: number;
  monto: number;
  estado: string;
  tipo: string | null;
  file_url: string | null;
  texto_ocr: string | null;
  registrado_por: string | null;
  created_at: string;
}

export interface ApiComprobanteList {
  id: number;
  order_number: string;
  monto: number;
  monto_tiendanube: number | null;
  estado: string;
  tipo: string | null;
  file_url: string | null;
  registrado_por: string | null;
  created_at: string;
  customer_name: string | null;
  orden_estado_pago: string | null;
  financiera_id: number | null;
  financiera_nombre: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  confirmed_by_name: string | null;
}

export interface ApiComprobanteDetail {
  id: number;
  order_number: string;
  monto: number;
  monto_tiendanube: number | null;
  estado: string;
  tipo: string | null;
  file_url: string | null;
  texto_ocr: string | null;
  registrado_por: string | null;
  created_at: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  orden_total: number | null;
  orden_pagado: number | null;
  orden_saldo: number | null;
  orden_estado_pago: string | null;
  financiera_id: number | null;
  financiera_nombre: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  confirmed_by_name: string | null;
}

export interface ApiLog {
  id: number;
  accion: string;
  origen: string;
  username: string | null;
  created_at: string;
}

export interface ApiPagoEfectivo {
  id: number;
  monto: number;
  registrado_por: string | null;
  notas: string | null;
  created_at: string;
}

export interface ApiOrderProduct {
  id: number;
  name: string;
  variant: string | null;
  quantity: number;
  price: number;
  total: number;
  sku: string | null;
}

// Helper: suma total de unidades de productos
export function getTotalUnits(products: { quantity: number }[]): number {
  return products.reduce((sum, p) => sum + p.quantity, 0);
}

export interface ApiOrderInconsistency {
  id: string;
  type: 'product_missing' | 'product_extra' | 'quantity_mismatch' | 'total_mismatch';
  detail: {
    message: string;
    product_id?: string;
    variant_id?: string | null;
    name?: string;
    quantity_db?: number;
    quantity_tn?: number;
    expected_quantity?: number;
    quantity_in_db?: number;
    total_db?: number;
    total_tn?: number;
    difference?: number;
  };
  detected_at: string;
}

export interface ApiOrderDetail {
  order: ApiOrder;
  comprobantes: ApiComprobante[];
  pagos_efectivo: ApiPagoEfectivo[];
  logs: ApiLog[];
  productos: ApiOrderProduct[];
  has_inconsistency: boolean;
  inconsistencies: ApiOrderInconsistency[];
}

// Notificaciones
export interface ApiNotification {
  id: string;
  tipo: string;
  titulo: string;
  descripcion: string | null;
  referencia_tipo: string | null;
  referencia_id: string | null;
  leida: boolean;
  created_at: string;
}

export interface ApiNotificationsResponse {
  ok: boolean;
  notifications: ApiNotification[];
  unread_count: number;
}

// Datos para impresión de pedido
export interface ApiOrderPrintProduct {
  id: number;
  name: string;
  variant: string | null;
  quantity: number;
  price: number;
  total: number;
  sku: string | null;
}

export interface ApiOrderPrintData {
  order_number: string;
  created_at: string;
  payment_status: string;
  shipping_status: string;
  customer: {
    name: string;
    email: string | null;
    phone: string | null;
    identification: string | null;
  };
  shipping_address: {
    name: string;
    address: string;
    number: string;
    floor: string | null;
    locality: string;
    city: string;
    province: string;
    zipcode: string;
    phone: string | null;
    between_streets: string | null;
    reference: string | null;
  } | null;
  shipping: {
    type: string;
    pickup_type: 'pickup' | 'ship';
    cost: number;
    tracking_number: string | null;
  };
  products: ApiOrderPrintProduct[];
  totals: {
    subtotal: number;
    discount: number;
    shipping: number;
    total: number;
  };
  note: string | null;
  owner_note: string | null;
  internal: {
    estado_pago: string;
    estado_pedido: string;
    total_pagado: number;
    saldo: number;
  } | null;
}

// Mapear estado de pago de la API a nuestro PaymentStatus
export function mapEstadoPago(estadoPago: string | null): 'pendiente' | 'a_confirmar' | 'parcial' | 'total' | 'rechazado' {
  if (!estadoPago) return 'pendiente';

  switch (estadoPago) {
    case 'a_confirmar':
      return 'a_confirmar';
    case 'confirmado_total':
      return 'total';
    case 'confirmado_parcial':
      return 'parcial';
    case 'a_favor':
      return 'total'; // Si está a favor, está pagado
    case 'rechazado':
      return 'rechazado';
    case 'pendiente':
    default:
      return 'pendiente';
  }
}

// Tipos de paginación
export interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationInfo;
}

// Tipos de envío para filtro
export type ShippingTypeFilter = 'all' | 'envio_nube' | 'via_cargo' | 'expreso' | 'retiro';

// Filtros para pedidos
export interface OrderFilters {
  estado_pago?: string;
  estado_pedido?: string;
  search?: string;
  fecha?: string;
  shipping_data?: 'pending' | 'complete';
  shipping_type?: ShippingTypeFilter;
}

// Mapeo inverso: de UI a DB
function mapEstadoPagoToDB(uiValue: string): string {
  switch (uiValue) {
    case 'parcial': return 'confirmado_parcial';
    case 'total': return 'confirmado_total';
    default: return uiValue; // pendiente, a_confirmar, rechazado ya coinciden
  }
}

// Obtener todos los pedidos (con paginación y filtros)
export async function fetchOrders(page = 1, limit = 50, filters?: OrderFilters): Promise<PaginatedResponse<ApiOrder>> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });

  if (filters?.estado_pago && filters.estado_pago !== 'all') {
    params.append('estado_pago', mapEstadoPagoToDB(filters.estado_pago));
  }
  if (filters?.estado_pedido && filters.estado_pedido !== 'all') {
    params.append('estado_pedido', filters.estado_pedido);
  }
  if (filters?.search) {
    params.append('search', filters.search);
  }
  if (filters?.fecha && filters.fecha !== 'all') {
    params.append('fecha', filters.fecha);
  }
  if (filters?.shipping_data) {
    params.append('shipping_data', filters.shipping_data);
  }
  if (filters?.shipping_type && filters.shipping_type !== 'all') {
    params.append('shipping_type', filters.shipping_type);
  }

  const response = await authFetch(`${API_BASE_URL}/orders?${params.toString()}`);

  if (!response.ok) {
    throw new Error('Error al obtener pedidos');
  }

  const data = await response.json();
  return {
    data: data.orders,
    pagination: data.pagination
  };
}

// Obtener conteos para modal de impresión (sin filtros)
export async function fetchPrintCounts(): Promise<Record<OrderStatus, number>> {
  // Cache-buster para forzar datos frescos
  const timestamp = Date.now();
  const response = await authFetch(`${API_BASE_URL}/orders/print-counts?_t=${timestamp}`);

  if (!response.ok) {
    throw new Error('Error al obtener conteos de impresión');
  }

  const data = await response.json();
  return data.counts;
}

// Obtener pedidos para imprimir (por estados seleccionados)
export async function fetchOrdersToPrint(statuses: OrderStatus[]): Promise<{
  orderNumbers: string[];
  count: number;
  excluded: string[];
  excludedCount: number;
}> {
  // Cache-buster para forzar datos frescos
  const timestamp = Date.now();
  const response = await authFetch(`${API_BASE_URL}/orders/to-print?_t=${timestamp}`, {
    method: 'POST',
    body: JSON.stringify({ statuses }),
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || 'Error al obtener pedidos para imprimir');
  }

  const data = await response.json();
  return {
    orderNumbers: data.orderNumbers,
    count: data.count,
    excluded: data.excluded || [],
    excludedCount: data.excludedCount || 0
  };
}

// Obtener detalle de un pedido
export async function fetchOrderDetail(orderNumber: string): Promise<ApiOrderDetail> {
  const response = await authFetch(`${API_BASE_URL}/orders/${orderNumber}`);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Pedido no encontrado');
    }
    throw new Error('Error al obtener pedido');
  }

  const data = await response.json();
  return {
    order: data.order,
    comprobantes: data.comprobantes,
    pagos_efectivo: data.pagos_efectivo || [],
    logs: data.logs,
    productos: data.productos || [],
    has_inconsistency: data.has_inconsistency || false,
    inconsistencies: data.inconsistencies || []
  };
}

// Re-sincronizar pedido desde TiendaNube
export async function resyncOrder(orderNumber: string): Promise<{ ok: boolean; productos_actualizados: number }> {
  const response = await authFetch(`${API_BASE_URL}/orders/${orderNumber}/resync`, {
    method: 'POST'
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || 'Error al re-sincronizar pedido');
  }

  return response.json();
}

// Obtener datos para impresión de pedido
export async function fetchOrderPrintData(orderNumber: string): Promise<ApiOrderPrintData> {
  const response = await authFetch(`${API_BASE_URL}/orders/${orderNumber}/print`);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Pedido no encontrado en Tiendanube');
    }
    throw new Error('Error al obtener datos de impresión');
  }

  const data = await response.json();
  return data.print_data;
}

// Registrar pago en efectivo
export async function registerCashPayment(
  orderNumber: string,
  monto: number,
  registradoPor: string = 'operador'
): Promise<{
  ok: boolean;
  comprobante_id: number;
  total_pagado: number;
  saldo: number;
  estado_pago: string;
}> {
  const response = await authFetch(`${API_BASE_URL}/pago-efectivo`, {
    method: 'POST',
    body: JSON.stringify({
      orderNumber,
      monto,
      registradoPor,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al registrar pago');
  }

  return data;
}

// Obtener historial de pagos
export async function fetchPaymentHistory(orderNumber: string): Promise<{
  pedido: ApiOrder;
  pagos: ApiComprobante[];
}> {
  const response = await authFetch(`${API_BASE_URL}/pagos/${orderNumber}`);

  if (!response.ok) {
    throw new Error('Error al obtener historial de pagos');
  }

  const data = await response.json();
  return {
    pedido: data.pedido,
    pagos: data.pagos
  };
}

// Actualizar estado del pedido
export async function updateOrderStatus(
  orderNumber: string,
  estadoPedido: OrderStatus
): Promise<{
  ok: boolean;
  order: ApiOrder;
}> {
  const response = await authFetch(`${API_BASE_URL}/orders/${orderNumber}/status`, {
    method: 'PATCH',
    body: JSON.stringify({
      estado_pedido: estadoPedido,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al actualizar estado');
  }

  return data;
}

// Mapear estado de pedido del backend
export function mapEstadoPedido(estadoPedido: string | null): OrderStatus {
  if (!estadoPedido) return 'pendiente_pago';

  const estados: Record<string, OrderStatus> = {
    'pendiente_pago': 'pendiente_pago',
    'a_imprimir': 'a_imprimir',
    'hoja_impresa': 'hoja_impresa',
    'armado': 'armado',
    'retirado': 'retirado',
    'en_calle': 'en_calle',
    'enviado': 'enviado',
    'cancelado': 'cancelado',
  };

  return estados[estadoPedido] || 'pendiente_pago';
}

// Filtros para comprobantes
export interface ComprobantesFilters {
  financieraId?: number | null;
  estado?: 'a_confirmar' | 'confirmado' | 'rechazado' | null;
  fecha?: 'hoy' | string | null; // 'hoy' o 'YYYY-MM-DD'
}

// Obtener todos los comprobantes (con paginación y filtros server-side)
export async function fetchComprobantes(
  page = 1,
  limit = 50,
  filters?: ComprobantesFilters
): Promise<PaginatedResponse<ApiComprobanteList>> {
  const params = new URLSearchParams({
    page: page.toString(),
    limit: limit.toString()
  });

  if (filters?.financieraId) {
    params.append('financiera_id', filters.financieraId.toString());
  }
  if (filters?.estado) {
    params.append('estado', filters.estado);
  }
  if (filters?.fecha) {
    params.append('fecha', filters.fecha);
  }

  const response = await authFetch(`${API_BASE_URL}/comprobantes?${params}`);

  if (!response.ok) {
    throw new Error('Error al obtener comprobantes');
  }

  const data = await response.json();
  return {
    data: data.comprobantes,
    pagination: data.pagination
  };
}

// Mapear estado de comprobante
export function mapEstadoComprobante(estado: string | null): 'pendiente' | 'confirmado' | 'rechazado' {
  if (!estado) return 'pendiente';

  switch (estado) {
    case 'confirmado':
      return 'confirmado';
    case 'rechazado':
      return 'rechazado';
    default:
      return 'pendiente';
  }
}

// Obtener detalle de un comprobante
export async function fetchComprobanteDetail(id: string): Promise<{
  comprobante: ApiComprobanteDetail;
  logs: ApiLog[];
}> {
  const response = await authFetch(`${API_BASE_URL}/comprobantes/${id}`);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('Comprobante no encontrado');
    }
    throw new Error('Error al obtener comprobante');
  }

  const data = await response.json();
  return {
    comprobante: data.comprobante,
    logs: data.logs
  };
}

// Confirmar comprobante
export async function confirmComprobante(id: string): Promise<{
  ok: boolean;
  comprobante_id: string;
  order_number: string;
  total_pagado: number;
  saldo: number;
  estado_pago: string;
}> {
  const response = await authFetch(`${API_BASE_URL}/comprobantes/${id}/confirmar`, {
    method: 'POST',
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al confirmar comprobante');
  }

  return data;
}

// Rechazar comprobante
export async function rejectComprobante(id: string, motivo?: string): Promise<{
  ok: boolean;
  comprobante_id: string;
  order_number: string;
}> {
  const response = await authFetch(`${API_BASE_URL}/comprobantes/${id}/rechazar`, {
    method: 'POST',
    body: JSON.stringify({ motivo }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al rechazar comprobante');
  }

  return data;
}

// ============================================
// RBAC - Tipos y funciones de autenticación
// ============================================

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role_id: string;
  role_name: string;
  is_active: boolean;
  permissions: string[];
}

export interface Permission {
  id: string;
  key: string;
  module: string;
}

export interface Role {
  id: string;
  name: string;
  created_at: string;
  permissions: string[];
}

export interface User {
  id: string;
  name: string;
  email: string;
  is_active: boolean;
  created_at: string;
  permissions: string[];
}

// Login
export async function login(email: string, password: string): Promise<{
  token: string;
  user: AuthUser;
}> {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al iniciar sesión');
  }

  // Guardar token y usuario en localStorage
  localStorage.setItem('auth_token', data.token);
  localStorage.setItem('auth_user', JSON.stringify(data.user));

  return data;
}

// Cerrar sesión
export function logout(): void {
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_user');
  window.location.href = '/login';
}

// Obtener usuario actual
export async function getMe(): Promise<AuthUser> {
  const response = await authFetch(`${API_BASE_URL}/auth/me`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener usuario');
  }

  return data.user;
}

// Cambiar contraseña
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const response = await authFetch(`${API_BASE_URL}/auth/change-password`, {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al cambiar contraseña');
  }
}

// Obtener usuario guardado localmente
export function getStoredUser(): AuthUser | null {
  const stored = localStorage.getItem('auth_user');
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

// Verificar si hay token
export function isAuthenticated(): boolean {
  return !!localStorage.getItem('auth_token');
}

// Verificar permiso
export function hasPermission(permission: string): boolean {
  const user = getStoredUser();
  if (!user) return false;
  return user.permissions.includes(permission);
}

// Refrescar permisos del usuario desde el backend
export async function refreshUserPermissions(): Promise<AuthUser | null> {
  if (isRefreshingPermissions) {
    console.log('[API] Already refreshing permissions, skipping');
    return null;
  }

  try {
    isRefreshingPermissions = true;

    const currentUser = getStoredUser();
    if (!currentUser) {
      console.log('[API] No current user, skipping refresh');
      return null;
    }

    console.log('[API] Calling /auth/me...');
    const freshUser = await getMe();
    console.log('[API] Got fresh user:', freshUser);

    // Actualizar localStorage con los nuevos permisos
    localStorage.setItem('auth_user', JSON.stringify(freshUser));

    return freshUser;
  } catch (error) {
    console.error('[API] Error refreshing permissions:', error);
    return null;
  } finally {
    isRefreshingPermissions = false;
  }
}

// ============================================
// RBAC - Gestión de roles
// ============================================

// Obtener todos los roles
export async function fetchRoles(): Promise<Role[]> {
  const response = await authFetch(`${API_BASE_URL}/roles`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener roles');
  }

  return data.roles;
}

// Obtener todos los permisos (agrupados por módulo)
export async function fetchPermissions(): Promise<Record<string, Permission[]>> {
  const response = await authFetch(`${API_BASE_URL}/roles/permissions`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener permisos');
  }

  return data.grouped;
}

// Obtener detalle de un rol
export async function fetchRoleDetail(id: string): Promise<Role> {
  const response = await authFetch(`${API_BASE_URL}/roles/${id}`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener rol');
  }

  return data.role;
}

// Actualizar permisos de un rol
export async function updateRolePermissions(roleId: string, permissions: string[]): Promise<Role> {
  const response = await authFetch(`${API_BASE_URL}/roles/${roleId}/permissions`, {
    method: 'PATCH',
    body: JSON.stringify({ permissions }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al actualizar permisos');
  }

  return data.role;
}

// ============================================
// RBAC - Gestión de usuarios
// ============================================

// Obtener todos los usuarios
export async function fetchUsers(): Promise<User[]> {
  const response = await authFetch(`${API_BASE_URL}/users`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener usuarios');
  }

  return data.users;
}

// Obtener detalle de un usuario
export async function fetchUserDetail(id: string): Promise<User> {
  const response = await authFetch(`${API_BASE_URL}/users/${id}`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener usuario');
  }

  return data.user;
}

// Crear usuario
export async function createUser(userData: {
  name: string;
  email: string;
  password: string;
  permissions?: string[];
}): Promise<User> {
  const response = await authFetch(`${API_BASE_URL}/users`, {
    method: 'POST',
    body: JSON.stringify(userData),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al crear usuario');
  }

  return data.user;
}

// Editar usuario (nombre y email)
export async function updateUser(id: string, userData: {
  name?: string;
  email?: string;
}): Promise<User> {
  const response = await authFetch(`${API_BASE_URL}/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(userData),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al actualizar usuario');
  }

  return data.user;
}

// Activar/desactivar usuario
export async function toggleUserActive(id: string, isActive: boolean): Promise<User> {
  const response = await authFetch(`${API_BASE_URL}/users/${id}/disable`, {
    method: 'PATCH',
    body: JSON.stringify({ is_active: isActive }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al cambiar estado de usuario');
  }

  return data.user;
}

// Actualizar permisos de usuario
export async function updateUserPermissions(id: string, permissions: string[]): Promise<User> {
  const response = await authFetch(`${API_BASE_URL}/users/${id}/permissions`, {
    method: 'PATCH',
    body: JSON.stringify({ permissions }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al actualizar permisos');
  }

  return data.user;
}

// Eliminar usuario
export async function deleteUser(id: string): Promise<void> {
  const response = await authFetch(`${API_BASE_URL}/users/${id}`, {
    method: 'DELETE',
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al eliminar usuario');
  }
}

// ============================================
// ACTIVITY LOG - Historial de actividad
// ============================================

export interface ActivityLog {
  id: number;
  comprobante_id: string | null;
  order_number: string | null;
  accion: string;
  origen: string;
  user_id: string | null;
  username: string | null;
  created_at: string;
  user_name: string | null;
  user_email: string | null;
}

export interface ActivityLogFilters {
  user_id?: string;
  accion?: string;
  order_number?: string;
  fecha_desde?: string;
  fecha_hasta?: string;
}

export interface ActivityLogResponse {
  logs: ActivityLog[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  filters: {
    users: Array<{ user_id: string; username: string; name: string; email: string }>;
    acciones: string[];
  };
}

// Obtener historial de actividad
export async function fetchActivityLog(
  page: number = 1,
  limit: number = 50,
  filters: ActivityLogFilters = {}
): Promise<ActivityLogResponse> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });

  if (filters.user_id) params.append('user_id', filters.user_id);
  if (filters.accion) params.append('accion', filters.accion);
  if (filters.order_number) params.append('order_number', filters.order_number);
  if (filters.fecha_desde) params.append('fecha_desde', filters.fecha_desde);
  if (filters.fecha_hasta) params.append('fecha_hasta', filters.fecha_hasta);

  const response = await authFetch(`${API_BASE_URL}/activity-log?${params.toString()}`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener historial de actividad');
  }

  return data;
}

// ============================================
// DASHBOARD STATS - KPIs agrupados por elemento
// ============================================

export interface DashboardStats {
  comprobantes: {
    a_confirmar: number;
    confirmados_hoy: number;
    rechazados_hoy: number;
    monto_confirmado_hoy: number;
  };
  remitos: {
    procesando: number;
    listos: number;
    confirmados_hoy: number;
    con_error: number;
  };
  pedidos: {
    nuevos_hoy: number;
    a_imprimir: number;
    armados: number;
    enviados: number;
    cancelados_hoy: number;
  };
  pagos: {
    recaudado_hoy: number;
    efectivo_hoy: number;
    saldo_pendiente: number;
    parciales: number;
  };
}

export async function fetchDashboardStats(): Promise<DashboardStats> {
  const response = await authFetch(`${API_BASE_URL}/dashboard/stats`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener estadísticas del dashboard');
  }

  return data;
}

// ============================================
// FINANCIERAS - Gestión de entidades financieras
// ============================================

export interface PlantillaTipo {
  id: number;
  key: string;
  nombre: string;
  descripcion: string | null;
  requiere_variante: boolean;
  plantilla_default: string;
}

export interface PlantillaMapping {
  tipo_id: number;
  tipo_key: string;
  tipo_nombre: string;
  tipo_descripcion: string | null;
  requiere_variante: boolean;
  plantilla_default: string;
  nombre_botmaker: string | null;
}

export interface Financiera {
  id: number;
  nombre: string;
  titular_principal: string | null;
  celular: string | null;
  palabras_clave: string[];
  activa: boolean;
  created_at: string;
  cbu: string | null;
  porcentaje: number | null;
  alias: string | null;
  is_default: boolean;
  plantilla_mappings?: PlantillaMapping[];
}

// Listar financieras
export async function fetchFinancieras(): Promise<Financiera[]> {
  const response = await authFetch(`${API_BASE_URL}/financieras`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener financieras');
  }

  return data.financieras;
}

// Obtener tipos de plantilla (catalog)
export async function fetchPlantillaTipos(): Promise<PlantillaTipo[]> {
  const response = await authFetch(`${API_BASE_URL}/financieras/plantilla-tipos`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener tipos de plantilla');
  }

  return data.tipos;
}

// Obtener una financiera
export async function fetchFinanciera(id: number): Promise<Financiera> {
  const response = await authFetch(`${API_BASE_URL}/financieras/${id}`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener financiera');
  }

  return data.financiera;
}

// Crear financiera
export async function createFinanciera(financieraData: {
  nombre: string;
  titular_principal?: string;
  celular?: string;
  palabras_clave?: string[];
  cbu?: string;
  porcentaje?: number;
  alias?: string;
  plantilla_mappings?: { tipoId: number; nombreBotmaker: string }[];
}): Promise<Financiera> {
  const response = await authFetch(`${API_BASE_URL}/financieras`, {
    method: 'POST',
    body: JSON.stringify(financieraData),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al crear financiera');
  }

  return data.financiera;
}

// Actualizar financiera
export async function updateFinanciera(id: number, financieraData: {
  nombre: string;
  titular_principal?: string;
  celular?: string;
  palabras_clave?: string[];
  cbu?: string;
  porcentaje?: number;
  alias?: string;
  plantilla_mappings?: { tipoId: number; nombreBotmaker: string }[];
}): Promise<Financiera> {
  const response = await authFetch(`${API_BASE_URL}/financieras/${id}`, {
    method: 'PUT',
    body: JSON.stringify(financieraData),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al actualizar financiera');
  }

  return data.financiera;
}

// Eliminar financiera
export async function deleteFinanciera(id: number): Promise<void> {
  const response = await authFetch(`${API_BASE_URL}/financieras/${id}`, {
    method: 'DELETE',
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al eliminar financiera');
  }
}

// Activar/desactivar financiera
export async function toggleFinancieraActiva(id: number, activa: boolean): Promise<Financiera> {
  const response = await authFetch(`${API_BASE_URL}/financieras/${id}/activar`, {
    method: 'PATCH',
    body: JSON.stringify({ activa }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al cambiar estado de financiera');
  }

  return data.financiera;
}

// Marcar financiera como default
export async function setFinancieraDefault(id: number): Promise<Financiera> {
  const response = await authFetch(`${API_BASE_URL}/financieras/${id}/default`, {
    method: 'PATCH',
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al marcar financiera como predeterminada');
  }

  return data.financiera;
}

// ============================================
// NOTIFICACIONES
// ============================================

// Obtener notificaciones del usuario
export async function fetchNotifications(): Promise<ApiNotificationsResponse> {
  const response = await authFetch(`${API_BASE_URL}/notifications`);

  if (!response.ok) {
    throw new Error('Error al obtener notificaciones');
  }

  return response.json();
}

// Marcar notificación como leída
export async function markNotificationRead(id: string): Promise<void> {
  const response = await authFetch(`${API_BASE_URL}/notifications/${id}/read`, {
    method: 'PATCH',
  });

  if (!response.ok) {
    throw new Error('Error al marcar notificación como leída');
  }
}

// Marcar todas las notificaciones como leídas
export async function markAllNotificationsRead(): Promise<void> {
  const response = await authFetch(`${API_BASE_URL}/notifications/read-all`, {
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error('Error al marcar notificaciones como leídas');
  }
}

// Eliminar una notificación
export async function deleteNotification(id: string): Promise<void> {
  const response = await authFetch(`${API_BASE_URL}/notifications/${id}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error('Error al eliminar notificación');
  }
}

// Eliminar todas las notificaciones leídas
export async function deleteReadNotifications(): Promise<{ deleted: number }> {
  const response = await authFetch(`${API_BASE_URL}/notifications/read`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error('Error al eliminar notificaciones leídas');
  }

  return response.json();
}

// Eliminar TODAS las notificaciones
export async function deleteAllNotifications(): Promise<{ deleted: number }> {
  const response = await authFetch(`${API_BASE_URL}/notifications/all`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error('Error al eliminar notificaciones');
  }

  return response.json();
}

// ============================================
// SHIPPING REQUESTS - Datos de envío
// ============================================

export interface ShippingRequest {
  id: string;
  order_number: string;
  empresa_envio: 'VIA_CARGO' | 'OTRO';
  empresa_envio_otro: string | null;
  destino_tipo: 'SUCURSAL' | 'DOMICILIO';
  direccion_entrega: string;
  nombre_apellido: string;
  dni: string;
  email: string;
  codigo_postal: string;
  provincia: string;
  localidad: string;
  telefono: string;
  comentarios: string | null;
  created_at: string;
  label_printed_at: string | null;
  label_bultos: number;
}

// Obtener datos de envío de un pedido
export async function fetchShippingRequest(orderNumber: string): Promise<ShippingRequest | null> {
  const response = await authFetch(`${API_BASE_URL}/orders/${orderNumber}/shipping-request`);

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error('Error al obtener datos de envío');
  }

  const data = await response.json();
  return data.shipping_request;
}

// Obtener URL del PDF de etiqueta de envío
export function getShippingLabelUrl(orderNumber: string, bultos: number = 1): string {
  const token = localStorage.getItem('auth_token');
  return `${API_BASE_URL}/orders/${orderNumber}/shipping-label?bultos=${bultos}&token=${token}`;
}

// ============================================
// REMITOS - Carga masiva de documentos de envío
// ============================================

export type RemitoStatus = 'pending' | 'processing' | 'ready' | 'confirmed' | 'rejected' | 'error';

export interface Remito {
  id: number;
  file_url: string;
  file_name: string | null;
  file_type: string | null;
  ocr_text: string | null;
  ocr_processed_at: string | null;
  detected_name: string | null;
  detected_address: string | null;
  detected_city: string | null;
  suggested_order_number: string | null;
  match_score: number | null;
  match_details: {
    name?: number;
    address?: number;
    city?: number;
    candidates?: Array<{
      orderNumber: string;
      customerName: string;
      score: number;
      createdAt: string;
    }>;
  } | null;
  confirmed_order_number: string | null;
  confirmed_by: number | null;
  confirmed_at: string | null;
  status: RemitoStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  // Joined from orders_validated
  order_customer_name?: string | null;
  order_address?: string | null;
  order_status?: string | null;
}

export interface RemitosStats {
  pending: number;
  processing: number;
  ready: number;
  confirmed: number;
  rejected: number;
  error: number;
  total: number;
}

export interface RemitosFilters {
  status?: RemitoStatus | null;
}

// Subir remitos (múltiples archivos)
export async function uploadRemitos(files: File[]): Promise<{
  ok: boolean;
  uploaded: number;
  errors: number;
  results: Array<{ id: number; fileName: string; status: string }>;
  errorDetails: Array<{ fileName: string; error: string }>;
}> {
  const formData = new FormData();
  files.forEach(file => formData.append('files', file));

  const token = localStorage.getItem('auth_token');
  const response = await fetch(`${API_BASE_URL}/remitos/upload`, {
    method: 'POST',
    headers: {
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    body: formData,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al subir remitos');
  }

  return data;
}

// Listar remitos con paginación y filtros
export async function fetchRemitos(
  page = 1,
  limit = 50,
  filters?: RemitosFilters
): Promise<PaginatedResponse<Remito>> {
  const params = new URLSearchParams({
    page: page.toString(),
    limit: limit.toString()
  });

  if (filters?.status) {
    params.append('status', filters.status);
  }

  const response = await authFetch(`${API_BASE_URL}/remitos?${params.toString()}`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener remitos');
  }

  return {
    data: data.remitos,
    pagination: data.pagination
  };
}

// Obtener estadísticas de remitos
export async function fetchRemitosStats(): Promise<RemitosStats> {
  const response = await authFetch(`${API_BASE_URL}/remitos/stats`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener estadísticas');
  }

  return data.stats;
}

// Obtener detalle de un remito
export async function fetchRemito(id: number): Promise<Remito> {
  const response = await authFetch(`${API_BASE_URL}/remitos/${id}`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener remito');
  }

  return data.remito;
}

// Obtener remito confirmado por número de pedido
export async function fetchRemitoByOrder(orderNumber: string): Promise<Remito | null> {
  const response = await authFetch(`${API_BASE_URL}/remitos/by-order/${orderNumber}`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener remito');
  }

  return data.remito;
}

// Confirmar match de remito
export async function confirmRemito(id: number, orderNumber?: string): Promise<{
  ok: boolean;
  remito_id: number;
  confirmed_order: string;
}> {
  const response = await authFetch(`${API_BASE_URL}/remitos/${id}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ orderNumber }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al confirmar remito');
  }

  return data;
}

// Eliminar un remito
export async function deleteRemito(id: number): Promise<{
  ok: boolean;
  remito_id: number;
}> {
  const response = await authFetch(`${API_BASE_URL}/remitos/${id}`, {
    method: 'DELETE',
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al eliminar remito');
  }

  return data;
}

// =====================================================
// ENVÍO NUBE - ETIQUETAS
// =====================================================

export interface EnvioNubeLabelPreview {
  order: string;
  customer?: string;
  labels_count?: number;
  tracking?: string;
  reason?: string;
  shipping_type?: string;
}

export interface EnvioNubePreviewResponse {
  total_requested: number;
  available: number;
  unavailable: number;
  details: {
    available: EnvioNubeLabelPreview[];
    unavailable: EnvioNubeLabelPreview[];
  };
}

// Obtener etiqueta individual de Envío Nube (retorna URL del blob)
export async function getEnvioNubeLabel(orderNumber: string): Promise<string> {
  const response = await authFetch(`${API_BASE_URL}/orders/${orderNumber}/envio-nube-label`);

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || 'Error al obtener etiqueta');
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

// Obtener etiquetas masivas de Envío Nube (retorna URL del blob con PDF combinado)
export async function getEnvioNubeLabels(orders: string[]): Promise<{
  url: string;
  success: number;
  failed: number;
}> {
  const response = await authFetch(`${API_BASE_URL}/orders/envio-nube-labels`, {
    method: 'POST',
    body: JSON.stringify({ orders }),
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || 'Error al obtener etiquetas');
  }

  const success = parseInt(response.headers.get('X-Labels-Success') || '0');
  const failed = parseInt(response.headers.get('X-Labels-Failed') || '0');

  const blob = await response.blob();
  return {
    url: URL.createObjectURL(blob),
    success,
    failed
  };
}

// Preview de qué pedidos tienen etiquetas disponibles
export async function previewEnvioNubeLabels(orders: string[]): Promise<EnvioNubePreviewResponse> {
  const response = await authFetch(`${API_BASE_URL}/orders/envio-nube-labels/preview`, {
    method: 'POST',
    body: JSON.stringify({ orders }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al verificar etiquetas');
  }

  return data;
}

// ============================================
// Integraciones - Feature Flags
// ============================================

export interface IntegrationConfig {
  key: string;
  enabled: boolean;
  description: string;
  category: string;
  metadata?: Record<string, unknown>;
  updated_at: string;
  updated_by_email?: string;
}

export interface IntegrationConfigHistory {
  config_key: string;
  old_value: boolean | null;
  new_value: boolean;
  reason?: string;
  changed_at: string;
  changed_by_email?: string;
}

export interface IntegrationsResponse {
  configs: IntegrationConfig[];
  grouped: Record<string, IntegrationConfig[]>;
  cache: {
    size: number;
    age_ms: number;
    valid: boolean;
    ttl_ms: number;
  };
}

export interface PlantillaResuelta {
  key: string;
  nombre: string;
  descripcion: string;
  requiere_variante: boolean;
  plantilla_default: string;
  plantilla_resuelta: string;
  usa_default: boolean;
}

export interface PlantillasResponse {
  ok: boolean;
  plantillas: PlantillaResuelta[];
  byKey: Record<string, PlantillaResuelta>;
}

// Obtener plantillas resueltas para mostrar en integraciones
export async function fetchPlantillasResueltas(): Promise<PlantillasResponse> {
  const response = await authFetch(`${API_BASE_URL}/integrations/plantillas`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener plantillas');
  }

  return data;
}

// ─── Plantilla Tipos CRUD ─────────────────────────────────

export interface PlantillaTipoCRUD {
  id: number;
  key: string;
  nombre: string;
  descripcion: string | null;
  requiere_variante: boolean;
  plantilla_default: string;
  created_at: string;
}

export interface CreatePlantillaTipoInput {
  key: string;
  nombre: string;
  descripcion?: string;
  requiere_variante?: boolean;
  plantilla_default: string;
}

export interface UpdatePlantillaTipoInput {
  nombre: string;
  descripcion?: string;
  plantilla_default: string;
}

// Listar todos los tipos de plantilla
export async function fetchPlantillaTiposCRUD(): Promise<PlantillaTipoCRUD[]> {
  const response = await authFetch(`${API_BASE_URL}/integrations/plantilla-tipos`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al obtener tipos');
  return data.tipos;
}

// Crear un nuevo tipo de plantilla
export async function createPlantillaTipo(input: CreatePlantillaTipoInput): Promise<PlantillaTipoCRUD> {
  const response = await authFetch(`${API_BASE_URL}/integrations/plantilla-tipos`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al crear tipo');
  return data.tipo;
}

// Actualizar un tipo de plantilla
export async function updatePlantillaTipo(id: number, input: UpdatePlantillaTipoInput): Promise<PlantillaTipoCRUD> {
  const response = await authFetch(`${API_BASE_URL}/integrations/plantilla-tipos/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al actualizar tipo');
  return data.tipo;
}

// Eliminar un tipo de plantilla
export async function deletePlantillaTipo(id: number): Promise<void> {
  const response = await authFetch(`${API_BASE_URL}/integrations/plantilla-tipos/${id}`, {
    method: 'DELETE',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al eliminar tipo');
}

// Obtener todas las configuraciones de integraciones
export async function fetchIntegrations(): Promise<IntegrationsResponse> {
  const response = await authFetch(`${API_BASE_URL}/integrations`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener configuraciones');
  }

  return data;
}

// Actualizar una configuración
export async function updateIntegration(
  key: string,
  enabled: boolean,
  reason?: string
): Promise<IntegrationConfig> {
  const response = await authFetch(`${API_BASE_URL}/integrations/${key}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled, reason }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al actualizar configuración');
  }

  return data.config;
}

// Actualizar metadata de una configuración
export async function updateIntegrationMetadata(
  key: string,
  metadata: Record<string, unknown>
): Promise<IntegrationConfig> {
  const response = await authFetch(`${API_BASE_URL}/integrations/${key}/metadata`, {
    method: 'PATCH',
    body: JSON.stringify({ metadata }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al actualizar metadata');
  }

  return data.config;
}

// Obtener historial de cambios
export async function fetchIntegrationHistory(
  key?: string,
  limit: number = 50
): Promise<IntegrationConfigHistory[]> {
  const url = key
    ? `${API_BASE_URL}/integrations/${key}/history?limit=${limit}`
    : `${API_BASE_URL}/integrations/history?limit=${limit}`;

  const response = await authFetch(url);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al obtener historial');
  }

  return data.history;
}

// Invalidar cache
export async function invalidateIntegrationCache(): Promise<void> {
  const response = await authFetch(`${API_BASE_URL}/integrations/cache/invalidate`, {
    method: 'POST',
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || 'Error al invalidar cache');
  }
}

// ─── Health Check ────────────────────────────────────────

export interface ServiceHealth {
  name: string;
  status: 'ok' | 'error';
  latency: number;
  error?: string;
}

export interface HealthCheckResponse {
  status: 'healthy' | 'degraded';
  timestamp: string;
  totalLatency: number;
  services: ServiceHealth[];
}

export async function fetchIntegrationHealth(): Promise<HealthCheckResponse> {
  const response = await authFetch(`${API_BASE_URL}/integrations/health`);

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al verificar conexiones');
  }

  return data;
}

// ─── Customer Segmentation ────────────────────────────────────────

export interface Customer {
  id: string;
  tn_customer_id: number | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  orders_count: number;
  total_spent: number;
  first_order_at: string | null;
  last_order_at: string | null;
  avg_order_value: number | null;
  segment: string | null;
  segment_updated_at: string | null;
  created_at: string;
}

export interface SegmentDefinition {
  segment: string;
  label: string;
  description: string;
}

export interface CustomerSyncStatus {
  lastSync: string | null;
  total: number;
  synced: number;
  segmented: number;
}

export interface CustomerMetrics {
  total_customers: number;
  customers_with_orders: number;
  avg_orders_per_customer: number;
  avg_total_spent: number;
  total_revenue: number;
  avg_days_since_last_order: number;
}

// Obtener estado del sync de clientes
export async function fetchCustomerSyncStatus(): Promise<CustomerSyncStatus> {
  const response = await authFetch(`${API_BASE_URL}/sync/customers/status`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al obtener estado de sync');
  return data;
}

// Iniciar sync completo de clientes
export async function startCustomerFullSync(): Promise<{ ok: boolean; message: string }> {
  const response = await authFetch(`${API_BASE_URL}/sync/customers/full`, { method: 'POST' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al iniciar sync');
  return data;
}

// Iniciar sync incremental de clientes
export async function startCustomerIncrementalSync(): Promise<{ ok: boolean; message: string }> {
  const response = await authFetch(`${API_BASE_URL}/sync/customers/incremental`, { method: 'POST' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al iniciar sync incremental');
  return data;
}

// Sincronizar orders_count desde TN (obtiene compras reales de cada cliente)
export async function syncCustomerOrdersCount(): Promise<{ ok: boolean; updated: number; totalOrders: number }> {
  const response = await authFetch(`${API_BASE_URL}/sync/customers/orders-count`, { method: 'POST' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al sincronizar compras');
  return data;
}

// Recalcular métricas de clientes
export async function recalculateCustomerMetrics(): Promise<{ ok: boolean; updated: number }> {
  const response = await authFetch(`${API_BASE_URL}/customers/metrics/recalculate`, { method: 'POST' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al recalcular métricas');
  return data;
}

// Recalcular segmentos de clientes
export async function recalculateCustomerSegments(): Promise<{ ok: boolean; updated: number; bySegment: Record<string, number> }> {
  const response = await authFetch(`${API_BASE_URL}/customers/segments/recalculate`, { method: 'POST' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al recalcular segmentos');
  return data;
}

// Obtener métricas globales
export async function fetchCustomerMetrics(): Promise<CustomerMetrics> {
  const response = await authFetch(`${API_BASE_URL}/customers/metrics`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al obtener métricas');
  return data.metrics;
}

// Tipo de modo de segmentación
export type SegmentMode = 'lifecycle' | 'top_spenders' | 'top_buyers';

// Obtener conteo por segmento
export async function fetchCustomerSegments(mode: SegmentMode = 'lifecycle'): Promise<{
  counts: Record<string, number>;
  definitions: SegmentDefinition[];
  mode: SegmentMode;
}> {
  const response = await authFetch(`${API_BASE_URL}/customers/segments?mode=${mode}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al obtener segmentos');
  return { counts: data.counts, definitions: data.definitions, mode: data.mode };
}

// Obtener clientes de un segmento
export async function fetchCustomersBySegment(
  segment: string,
  page: number = 1,
  limit: number = 50
): Promise<{ customers: Customer[]; total: number; page: number; limit: number }> {
  const response = await authFetch(
    `${API_BASE_URL}/customers/segments/${segment}?page=${page}&limit=${limit}`
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al obtener clientes');
  return data;
}

// Listar todos los clientes
export async function fetchCustomers(
  page: number = 1,
  limit: number = 50,
  segment?: string,
  search?: string,
  sort?: string,
  dir?: 'asc' | 'desc',
  mode: SegmentMode = 'lifecycle'
): Promise<{ customers: Customer[]; total: number; page: number; limit: number }> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit), mode });
  if (segment) params.append('segment', segment);
  if (search) params.append('search', search);
  if (sort) params.append('sortBy', sort);
  if (dir) params.append('sortDir', dir);

  const response = await authFetch(`${API_BASE_URL}/customers?${params.toString()}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al obtener clientes');
  return data;
}

// ============================================
// Conciliación bancaria (2 pasos: preview + aplicar)
// ============================================

export interface ConciliacionMatch {
  banco_id: string;
  comprobante_id: number;
  order_number: string;
  monto: number;
  nombre_banco: string;
  nombre_cliente: string;
  fecha_banco: string;
  hora_banco: string;
  fecha_comprobante: string;
}

export interface ConciliacionUnmatched {
  banco_id: string;
  importe: number;
  fecha: string;
  hora: string;
  nombre: string;
  posible_match: {
    comprobante_id: number;
    order_number: string;
    nombre_cliente: string;
    fecha_comprobante: string;
  } | null;
}

export interface ConciliacionPreviewResult {
  ok: boolean;
  preview: true;
  summary: {
    total_movimientos: number;
    transferencias_entrantes: number;
    matched: number;
    unmatched: number;
  };
  matched: ConciliacionMatch[];
  unmatched: ConciliacionUnmatched[];
}

export interface ConciliacionAplicarResult {
  ok: boolean;
  summary: {
    confirmed: number;
    errors: number;
  };
  confirmed: Array<{ banco_id: string; comprobante_id: number; order_number: string; monto: number }>;
  errors: Array<{ comprobante_id: number; banco_id: string; error: string }>;
}

export async function conciliacionPreview(movimientos: unknown[]): Promise<ConciliacionPreviewResult> {
  const response = await authFetch(`${API_BASE_URL}/comprobantes/conciliacion-preview`, {
    method: 'POST',
    body: JSON.stringify({ movimientos }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al procesar preview');
  return data;
}

export async function conciliacionAplicar(matches: Array<{ comprobante_id: number; banco_id: string }>): Promise<ConciliacionAplicarResult> {
  const response = await authFetch(`${API_BASE_URL}/comprobantes/conciliacion-aplicar`, {
    method: 'POST',
    body: JSON.stringify({ matches }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al aplicar conciliación');
  return data;
}

// =====================================================
// System Alerts
// =====================================================

export interface SystemAlert {
  id: number;
  level: 'info' | 'warning' | 'critical';
  category: string;
  title: string;
  message: string;
  service: string | null;
  metadata: Record<string, any>;
  status: 'open' | 'acknowledged' | 'resolved';
  acknowledged_by_name: string | null;
  resolved_by_name: string | null;
  created_at: string;
}

export interface AlertSummary {
  open_count: number;
  critical_open: number;
  warning_open: number;
  acknowledged_count: number;
  last_24h: number;
}

export async function fetchSystemAlerts(params?: { status?: string; level?: string; limit?: number }): Promise<{ total: number; alerts: SystemAlert[] }> {
  const query = new URLSearchParams();
  if (params?.status) query.set('status', params.status);
  if (params?.level) query.set('level', params.level);
  if (params?.limit) query.set('limit', String(params.limit));
  const response = await authFetch(`${API_BASE_URL}/system-alerts?${query.toString()}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al obtener alertas');
  return data;
}

export async function fetchAlertSummary(): Promise<AlertSummary> {
  const response = await authFetch(`${API_BASE_URL}/system-alerts/summary`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error al obtener resumen de alertas');
  return data;
}

export async function acknowledgeAlert(id: number): Promise<void> {
  const response = await authFetch(`${API_BASE_URL}/system-alerts/${id}/acknowledge`, { method: 'PATCH' });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || 'Error al reconocer alerta');
  }
}

export async function resolveAlert(id: number): Promise<void> {
  const response = await authFetch(`${API_BASE_URL}/system-alerts/${id}/resolve`, { method: 'PATCH' });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || 'Error al resolver alerta');
  }
}

export async function resolveAllAlerts(): Promise<void> {
  const response = await authFetch(`${API_BASE_URL}/system-alerts/resolve-all`, { method: 'POST' });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || 'Error al resolver alertas');
  }
}
