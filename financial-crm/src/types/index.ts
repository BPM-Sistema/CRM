// Estados de pago
export type PaymentStatus = 'pendiente' | 'a_confirmar' | 'parcial' | 'total' | 'rechazado';

// Estados del pedido (flujo de trabajo)
// Flujo retiro: pendiente_pago → a_imprimir → hoja_impresa → armado → retirado
// Flujo envío: pendiente_pago → a_imprimir → hoja_impresa → armado → en_calle → enviado
// Cancelado: puede ocurrir desde cualquier estado
export type OrderStatus =
  | 'pendiente_pago'      // Pendiente de pago (default)
  | 'a_imprimir'          // Listo para imprimir
  | 'hoja_impresa'        // Etiqueta impresa (hoja de pedido)
  | 'armado'              // Armado/empaquetado
  | 'retirado'            // Retirado por cliente
  | 'en_calle'            // En calle (salió del depósito, en tránsito al correo)
  | 'enviado'             // Enviado (correo recibió el paquete, en camino al cliente)
  | 'cancelado';          // Pedido cancelado

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
}

export interface OrderProduct {
  id: string;
  name: string;
  sku: string;
  quantity: number;
  price: number;
}

export interface Receipt {
  id: string;
  orderId: string;
  imageUrl: string;
  uploadedAt: string;
  ocrText: string;
  detectedAmount: number | null;
  paymentStatus: PaymentStatus;
  isDuplicate: boolean;
  processedAt: string | null;
}

export interface Order {
  id: string;
  orderNumber: string;
  customer: Customer;
  totalAmount: number;
  amountPaid: number;
  paymentStatus: PaymentStatus;
  orderStatus: OrderStatus;
  products: OrderProduct[];
  receipts: Receipt[];
  createdAt: string;
  updatedAt: string;
  tiendanubeId: string;
  printedAt: string | null;
  packedAt: string | null;
  shippedAt: string | null;
}

export interface ActivityLogEntry {
  id: string;
  orderId: string;
  orderNumber: string;
  action: 'created' | 'validated' | 'rejected' | 'edited' | 'duplicate_flagged' | 'whatsapp_sent' | 'printed' | 'packed' | 'shipped';
  description: string;
  performedBy: string;
  timestamp: string;
}

export interface DailyStats {
  date: string;
  paid: number;
  pending: number;
  rejected: number;
  total: number;
}

export interface KPIData {
  totalOrdersToday: number;
  paidToday: number;
  pendingToday: number;
  rejectedToday: number;
  moneyCollected: number;
  avgValidationTime: number;
}
