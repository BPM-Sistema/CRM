import { authFetch } from './api';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// Types
export interface WaspyConversation {
  id: string;
  contactName: string;
  contactPhone: string;
  phoneNumberId: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  status: 'open' | 'closed' | 'pending';
  assignedTo: string | null;
  metadata?: Record<string, unknown>;
}

export interface WaspyMessage {
  id: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'template' | 'interactive';
  content: {
    text?: string;
    caption?: string;
    url?: string;
    filename?: string;
    templateName?: string;
    templateParams?: string[];
  };
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'pending';
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface WaspyTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: Array<{
    type: string;
    text?: string;
    format?: string;
    parameters?: Array<{ type: string; text?: string }>;
  }>;
}

export interface WaspyChannelStatus {
  status: 'connected' | 'disconnected' | 'degraded';
  phoneNumber: string | null;
  wabaId: string | null;
  qualityRating: string | null;
  lastSync: string | null;
}

export interface WaspyConversationContext {
  contactName: string;
  contactPhone: string;
  metadata?: Record<string, unknown>;
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

export interface ConnectStartResponse {
  redirectUrl?: string;
  code?: string;
  status: string;
}

// API Functions

export async function fetchChannelStatus(): Promise<WaspyChannelStatus> {
  const response = await authFetch(`${API_BASE_URL}/waspy/channel/status`);
  if (!response.ok) throw new Error('Error al obtener estado del canal');
  const data = await response.json();
  return data.data || data;
}

export async function fetchConversations(params?: {
  limit?: number;
  offset?: number;
  status?: string;
}): Promise<{ conversations: WaspyConversation[]; total: number }> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.offset) searchParams.set('offset', String(params.offset));
  if (params?.status) searchParams.set('status', params.status);

  const url = `${API_BASE_URL}/waspy/conversations${searchParams.toString() ? '?' + searchParams : ''}`;
  const response = await authFetch(url);
  if (!response.ok) throw new Error('Error al obtener conversaciones');
  const data = await response.json();
  const raw = data.data || data;
  // Map Waspy response to our interface
  const conversations: WaspyConversation[] = (raw.conversations || []).map((c: Record<string, unknown>) => ({
    id: c.id,
    contactName: (c.contact as Record<string, unknown>)?.name || c.contactName || 'Sin nombre',
    contactPhone: (c.contact as Record<string, unknown>)?.phoneNumber || c.contactPhone || '',
    phoneNumberId: c.phoneNumberId || '',
    lastMessage: c.lastMessagePreview || c.lastMessage || null,
    lastMessageAt: c.lastMessageAt || null,
    unreadCount: c.unreadCount || 0,
    status: c.status || 'open',
    assignedTo: c.assignedTo || null,
    metadata: c.metadata || {},
  }));
  return { conversations, total: raw.total || conversations.length };
}

export async function fetchMessages(
  conversationId: string,
  params?: { limit?: number; before?: string }
): Promise<{ messages: WaspyMessage[] }> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.before) searchParams.set('before', params.before);

  const url = `${API_BASE_URL}/waspy/conversations/${conversationId}/messages${searchParams.toString() ? '?' + searchParams : ''}`;
  const response = await authFetch(url);
  if (!response.ok) throw new Error('Error al obtener mensajes');
  const data = await response.json();
  const raw = data.data || data;
  // Map Waspy messages to our interface
  const messages: WaspyMessage[] = (raw.messages || []).map((m: Record<string, unknown>) => {
    const content = m.content as Record<string, unknown> || {};
    return {
      id: m.id,
      conversationId: m.conversationId,
      direction: m.direction,
      type: m.type || 'text',
      content: {
        text: content.body || content.text || content.caption || '',
        caption: content.caption as string || undefined,
        url: content.url as string || (content.link as Record<string, unknown>)?.url as string || undefined,
        filename: content.filename as string || undefined,
        templateName: (m.templateNameSnapshot as string) || undefined,
      },
      status: m.status || 'sent',
      timestamp: (m.createdAt as string) || (m.timestamp as string) || '',
      metadata: m.metadata || {},
    };
  });
  return { messages };
}

export async function sendMessage(payload: {
  conversationId: string;
  phoneNumberId: string;
  to: string;
  type: 'text';
  content: { body: string };
}): Promise<WaspyMessage> {
  const response = await authFetch(`${API_BASE_URL}/waspy/messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Error al enviar mensaje');
  }
  const data = await response.json();
  return data.data || data;
}

export async function fetchTemplates(): Promise<WaspyTemplate[]> {
  const response = await authFetch(`${API_BASE_URL}/waspy/templates`);
  if (!response.ok) throw new Error('Error al obtener templates');
  const data = await response.json();
  return data.data || data.templates || data;
}

export async function sendTemplate(payload: {
  conversationId?: string;
  phone?: string;
  templateName: string;
  language: string;
  parameters?: Record<string, string[]>;
}): Promise<unknown> {
  const response = await authFetch(`${API_BASE_URL}/waspy/templates/send`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Error al enviar template');
  }
  return response.json();
}

export async function fetchConversationContext(
  conversationId: string
): Promise<WaspyConversationContext> {
  const response = await authFetch(`${API_BASE_URL}/waspy/conversations/${conversationId}/context`);
  if (!response.ok) throw new Error('Error al obtener contexto');
  const data = await response.json();
  return data.data || data;
}

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

// CRM-side order lookups (these hit the CRM backend, not Waspy)

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
