import { authFetch } from './api';
import type {
  AiBotDashboard,
  AiBotConfig,
  AiBotEvent,
  AiBotReply,
  AiBotFailure,
  AiBotMetrics,
} from '../types/ai-bot';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// ── Dashboard ───────────────────────────────────────────────────────────────

export async function fetchAiBotDashboard(): Promise<AiBotDashboard> {
  const res = await authFetch(`${API_BASE_URL}/ai-bot/dashboard`);
  if (!res.ok) throw new Error('Error al obtener dashboard del AI Bot');
  return res.json();
}

// ── Config ──────────────────────────────────────────────────────────────────

export async function fetchAiBotConfig(): Promise<AiBotConfig[]> {
  const res = await authFetch(`${API_BASE_URL}/ai-bot/config`);
  if (!res.ok) throw new Error('Error al obtener configuración del AI Bot');
  return res.json();
}

export async function updateAiBotConfig(key: string, value: unknown): Promise<AiBotConfig> {
  const res = await authFetch(`${API_BASE_URL}/ai-bot/config/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
  if (!res.ok) throw new Error('Error al actualizar configuración del AI Bot');
  return res.json();
}

// ── Events ──────────────────────────────────────────────────────────────────

export interface EventFilters {
  page?: number;
  limit?: number;
  status?: string;
  channel?: string;
  search?: string;
  from?: string;
  to?: string;
}

export async function fetchAiBotEvents(params: EventFilters = {}): Promise<{ data: AiBotEvent[]; total: number }> {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') query.append(k, String(v));
  });
  const res = await authFetch(`${API_BASE_URL}/ai-bot/events?${query.toString()}`);
  if (!res.ok) throw new Error('Error al obtener eventos del AI Bot');
  return res.json();
}

export async function fetchAiBotEvent(id: number): Promise<AiBotEvent> {
  const res = await authFetch(`${API_BASE_URL}/ai-bot/events/${id}`);
  if (!res.ok) throw new Error('Error al obtener evento del AI Bot');
  return res.json();
}

export async function approveAiBotReply(eventId: number): Promise<{ success: boolean }> {
  const res = await authFetch(`${API_BASE_URL}/ai-bot/events/${eventId}/approve`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Error al aprobar respuesta del AI Bot');
  return res.json();
}

export async function rejectAiBotReply(eventId: number): Promise<{ success: boolean }> {
  const res = await authFetch(`${API_BASE_URL}/ai-bot/events/${eventId}/reject`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Error al rechazar respuesta del AI Bot');
  return res.json();
}

// ── Replies ─────────────────────────────────────────────────────────────────

export interface ReplyFilters {
  page?: number;
  limit?: number;
  status?: string;
  channel?: string;
  from?: string;
  to?: string;
}

export async function fetchAiBotReplies(params: ReplyFilters = {}): Promise<{ data: AiBotReply[]; total: number }> {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') query.append(k, String(v));
  });
  const res = await authFetch(`${API_BASE_URL}/ai-bot/replies?${query.toString()}`);
  if (!res.ok) throw new Error('Error al obtener respuestas del AI Bot');
  return res.json();
}

// ── Failures ────────────────────────────────────────────────────────────────

export interface FailureFilters {
  page?: number;
  limit?: number;
  resolved?: boolean;
  stage?: string;
  from?: string;
  to?: string;
}

export async function fetchAiBotFailures(params: FailureFilters = {}): Promise<{ data: AiBotFailure[]; total: number }> {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') query.append(k, String(v));
  });
  const res = await authFetch(`${API_BASE_URL}/ai-bot/failures?${query.toString()}`);
  if (!res.ok) throw new Error('Error al obtener fallos del AI Bot');
  return res.json();
}

export async function resolveAiBotFailure(id: number): Promise<{ success: boolean }> {
  const res = await authFetch(`${API_BASE_URL}/ai-bot/failures/${id}/resolve`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Error al resolver fallo del AI Bot');
  return res.json();
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export async function fetchAiBotMetrics(period: string): Promise<AiBotMetrics[]> {
  const res = await authFetch(`${API_BASE_URL}/ai-bot/metrics?period=${encodeURIComponent(period)}`);
  if (!res.ok) throw new Error('Error al obtener métricas del AI Bot');
  return res.json();
}

// ── System Prompt ───────────────────────────────────────────────────────────

export async function fetchAiBotSystemPrompt(): Promise<{ prompt: string }> {
  const res = await authFetch(`${API_BASE_URL}/ai-bot/system-prompt`);
  if (!res.ok) throw new Error('Error al obtener system prompt del AI Bot');
  const data = await res.json();
  return { prompt: data.system_prompt || '' };
}

export async function updateAiBotSystemPrompt(prompt: string): Promise<{ success: boolean }> {
  const res = await authFetch(`${API_BASE_URL}/ai-bot/system-prompt`, {
    method: 'PUT',
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) throw new Error('Error al actualizar system prompt del AI Bot');
  return res.json();
}
