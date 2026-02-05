const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// Tipos de estado
export type PaymentStatus = 'pendiente' | 'a_confirmar' | 'parcial' | 'total' | 'rechazado';
export type OrderStatus = 'pendiente_pago' | 'a_imprimir' | 'armado' | 'retirado' | 'enviado' | 'en_calle';

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

// Obtener todos los pedidos
export async function fetchOrders(): Promise<ApiOrder[]> {
  const response = await fetch(`${API_BASE_URL}/orders`);

  if (!response.ok) {
    throw new Error('Error al obtener pedidos');
  }

  const data = await response.json();
  return data.orders;
}

// Obtener detalle de un pedido
export async function fetchOrderDetail(orderNumber: string): Promise<ApiOrderDetail> {
  const response = await fetch(`${API_BASE_URL}/orders/${orderNumber}`);

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
  const response = await fetch(`${API_BASE_URL}/orders/${orderNumber}/print`);

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
  const response = await fetch(`${API_BASE_URL}/pago-efectivo`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
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
  const response = await fetch(`${API_BASE_URL}/pagos/${orderNumber}`);

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
  const response = await fetch(`${API_BASE_URL}/orders/${orderNumber}/status`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
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
    'armado': 'armado',
    'retirado': 'retirado',
    'enviado': 'enviado',
    'en_calle': 'en_calle',
  };

  return estados[estadoPedido] || 'pendiente_pago';
}

// Obtener todos los comprobantes
export async function fetchComprobantes(): Promise<ApiComprobanteList[]> {
  const response = await fetch(`${API_BASE_URL}/comprobantes`);

  if (!response.ok) {
    throw new Error('Error al obtener comprobantes');
  }

  const data = await response.json();
  return data.comprobantes;
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
  const response = await fetch(`${API_BASE_URL}/comprobantes/${id}`);

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
  const response = await fetch(`${API_BASE_URL}/comprobantes/${id}/confirmar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
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
  const response = await fetch(`${API_BASE_URL}/comprobantes/${id}/rechazar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ motivo }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Error al rechazar comprobante');
  }

  return data;
}
