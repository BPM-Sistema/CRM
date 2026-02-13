const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// Helper para obtener el token de autenticación
function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('auth_token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
}

// Fetch con autenticación (sin cache para datos en tiempo real)
async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
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

  return response;
}

// Tipos de estado
export type PaymentStatus = 'pendiente' | 'a_confirmar' | 'parcial' | 'total' | 'rechazado';
export type OrderStatus = 'pendiente_pago' | 'a_imprimir' | 'hoja_impresa' | 'armado' | 'retirado' | 'enviado' | 'en_calle';

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
  comprobantes_count: string;
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
}

export interface ApiLog {
  id: number;
  accion: string;
  origen: string;
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

export interface ApiOrderDetail {
  order: ApiOrder;
  comprobantes: ApiComprobante[];
  pagos_efectivo: ApiPagoEfectivo[];
  logs: ApiLog[];
  productos: ApiOrderProduct[];
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

// Filtros para pedidos
export interface OrderFilters {
  estado_pago?: string;
  estado_pedido?: string;
  search?: string;
  fecha?: string;
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
export async function fetchOrdersToPrint(statuses: OrderStatus[]): Promise<{ orderNumbers: string[]; count: number }> {
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
  return { orderNumbers: data.orderNumbers, count: data.count };
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
    productos: data.productos || []
  };
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
    'enviado': 'enviado',
    'en_calle': 'en_calle',
  };

  return estados[estadoPedido] || 'pendiente_pago';
}

// Obtener todos los comprobantes (con paginación)
export async function fetchComprobantes(page = 1, limit = 50): Promise<PaginatedResponse<ApiComprobanteList>> {
  const response = await authFetch(`${API_BASE_URL}/comprobantes?page=${page}&limit=${limit}`);

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
  try {
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
// FINANCIERAS - Gestión de entidades financieras
// ============================================

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
