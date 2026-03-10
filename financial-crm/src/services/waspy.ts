import { authFetch } from './api';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// ── Types ─────────────────────────────────────────────────────────────

export interface WaspyChannelStatus {
  status: 'connected' | 'disconnected' | 'degraded';
  phoneNumber: string | null;
  wabaId: string | null;
  qualityRating: string | null;
  lastSync: string | null;
}

export interface ConnectStartResponse {
  redirectUrl?: string;
  code?: string;
  status: string;
}

export interface LinkedOrder {
  order_number: string;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  monto_tiendanube: number;
  total_pagado: number | null;
  estado_pago: string | null;
  estado_pedido: string | null;
  created_at: string;
  source?: 'phone' | 'manual';
}

export interface WaspyConfig {
  tenantId: string;
  tenantName: string;
  waspyUrl: string;
  embedUrl: string;
  apiKeyPrefix: string;
  verifiedAt: string | null;
}

// ── Config ────────────────────────────────────────────────────────────

export async function fetchWaspyConfig(): Promise<WaspyConfig | null> {
  const res = await authFetch(`${API_BASE_URL}/waspy/config`);
  const data = await res.json();
  return data.config;
}

export async function saveWaspyConfig(
  apiKey: string,
  waspyUrl?: string,
  embedUrl?: string
): Promise<{ ok: boolean; tenant: { id: string; name: string; slug: string; plan: string }; phoneNumbers: { number: string; status: string }[] }> {
  const res = await authFetch(`${API_BASE_URL}/waspy/config`, {
    method: 'POST',
    body: JSON.stringify({ apiKey, waspyUrl, embedUrl }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  return data;
}

export async function deleteWaspyConfig(): Promise<void> {
  await authFetch(`${API_BASE_URL}/waspy/config`, { method: 'DELETE' });
}

// ── Auth ──────────────────────────────────────────────────────────────

export async function fetchWaspyToken(): Promise<string> {
  const response = await authFetch(`${API_BASE_URL}/waspy/token`);
  if (!response.ok) throw new Error('Error al obtener token de Waspy');
  const data = await response.json();
  return data.token;
}

// ── Channel status (used by WhatsAppSettings + InboxPage banner) ─────

export async function fetchChannelStatus(): Promise<WaspyChannelStatus> {
  const response = await authFetch(`${API_BASE_URL}/waspy/channel/status`);
  if (!response.ok) throw new Error('Error al obtener estado del canal');
  const data = await response.json();
  return data.data || data;
}

// ── WhatsApp connection flow (used by WhatsAppSettings) ──────────────

export async function startWhatsAppConnect(): Promise<ConnectStartResponse> {
  const response = await authFetch(`${API_BASE_URL}/waspy/channel/connect/start`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error('Error al iniciar conexión de WhatsApp');
  const data = await response.json();
  return data.data || data;
}

export async function fetchConnectStatus(): Promise<{ status: string; message?: string }> {
  const response = await authFetch(`${API_BASE_URL}/waspy/channel/connect/status`);
  if (!response.ok) throw new Error('Error al verificar estado de conexión');
  const data = await response.json();
  return data.data || data;
}

// ── CRM order lookups (used by OrderPanel) ───────────────────────────

export async function fetchOrdersByPhone(phone: string): Promise<LinkedOrder[]> {
  const response = await authFetch(
    `${API_BASE_URL}/waspy/orders/by-phone?phone=${encodeURIComponent(phone)}`
  );
  if (!response.ok) throw new Error('Error al buscar pedidos por teléfono');
  const data = await response.json();
  return data.orders || [];
}

export async function fetchLinkedOrders(conversationId: string): Promise<LinkedOrder[]> {
  const response = await authFetch(
    `${API_BASE_URL}/waspy/conversations/${conversationId}/orders`
  );
  if (!response.ok) throw new Error('Error al obtener pedidos vinculados');
  const data = await response.json();
  return data.orders || [];
}

export async function linkOrderToConversation(
  conversationId: string,
  orderNumber: string
): Promise<void> {
  const response = await authFetch(
    `${API_BASE_URL}/waspy/conversations/${conversationId}/orders`,
    {
      method: 'POST',
      body: JSON.stringify({ order_number: orderNumber }),
    }
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Error al vincular pedido');
  }
}

export async function unlinkOrderFromConversation(
  conversationId: string,
  orderNumber: string
): Promise<void> {
  const response = await authFetch(
    `${API_BASE_URL}/waspy/conversations/${conversationId}/orders/${orderNumber}`,
    { method: 'DELETE' }
  );
  if (!response.ok) throw new Error('Error al desvincular pedido');
}
