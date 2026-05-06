import { authFetch } from './api';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export interface ReminderStep {
  key: string;
  offsetHours: number;
  label: string;
}

export interface ReminderRow {
  order_number: string;
  customer_name: string | null;
  customer_phone: string | null;
  monto_tiendanube: string | number | null;
  created_at: string;
  estado_pedido: string;
  estado_pago: string;
  // Por cada step (pendiente_3hs, pendiente_10hs)
  [key: string]: any;
}

export interface RemindersListResponse {
  ok: boolean;
  orders: ReminderRow[];
  steps: ReminderStep[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface ReminderStats {
  vencidos_sin_enviar: string;
  programados: string;
  enviados_hoy: string;
  enviados_total: string;
  descartados: string;
}

export interface RemindersHistoryResponse {
  ok: boolean;
  order: {
    order_number: string;
    customer_name: string | null;
    customer_phone: string | null;
    monto_tiendanube: string | number | null;
    created_at: string;
    estado_pedido: string;
    estado_pago: string;
  };
  messages: {
    id: number;
    request_id: string;
    template: string;
    template_key: string | null;
    status: string;
    status_updated_at: string | null;
    error_message: string | null;
    created_at: string;
    variables: Record<string, string> | null;
  }[];
  scheduled: {
    id: number;
    plantilla: string;
    send_at: string;
    sent_at: string | null;
    error: string | null;
    created_at: string;
  }[];
  inbound: {
    id: number;
    contact_id: string;
    chat_id: string | null;
    message_id: string | null;
    message_type: string;
    message_text: string | null;
    button_id: string | null;
    url_clicked: string | null;
    received_at: string;
    order_number: number | null;
  }[];
}

export interface ListParams {
  page?: number;
  limit?: number;
  search?: string;
  step?: string; // '3hs' | '10hs'
  status?: 'any' | 'programado' | 'enviado' | 'descartado' | 'sin_programar';
}

export async function fetchReminders(params: ListParams = {}): Promise<RemindersListResponse> {
  const qs = new URLSearchParams();
  if (params.page) qs.set('page', String(params.page));
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.search) qs.set('search', params.search);
  if (params.step) qs.set('step', params.step);
  if (params.status) qs.set('status', params.status);
  const r = await authFetch(`${API_BASE_URL}/admin/payment-reminders?${qs.toString()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function fetchReminderStats(): Promise<{ ok: boolean; stats: Record<string, ReminderStats> }> {
  const r = await authFetch(`${API_BASE_URL}/admin/payment-reminders/stats`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function fetchReminderHistory(orderNumber: string): Promise<RemindersHistoryResponse> {
  const r = await authFetch(`${API_BASE_URL}/admin/payment-reminders/${orderNumber}/history`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function reprogramarReminder(scheduledId: number): Promise<{ ok: boolean; scheduled?: { id: number; send_at: string }; error?: string }> {
  const r = await authFetch(`${API_BASE_URL}/admin/payment-reminders/${scheduledId}/reprogramar`, {
    method: 'POST'
  });
  return r.json();
}
