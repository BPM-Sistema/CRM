// Estados de pago
export type PaymentStatus = 'pendiente' | 'a_confirmar' | 'parcial' | 'total' | 'rechazado' | 'anulado' | 'reembolsado';

// Estados del pedido — definidos en constants/estadoPedido.ts (punto único de verdad).
// Import + re-export: el alias se usa abajo en este archivo Y queda disponible para los que importen desde 'types'.
import type { OrderStatus } from '../constants/estadoPedido';
export type { OrderStatus };

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

