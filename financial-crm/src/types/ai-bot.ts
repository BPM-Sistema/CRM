export type AiBotMode = 'off' | 'suggestion' | 'automatic';
export type AiBotChannel = 'instagram_comment' | 'facebook_comment' | 'messenger';
export type AiBotEventStatus = 'received' | 'processing' | 'responded' | 'ignored' | 'failed' | 'skipped';
export type AiBotReplyStatus = 'pending' | 'pending_approval' | 'sent' | 'failed' | 'rejected_by_human';

export interface AiBotConfig {
  id: number;
  key: string;
  value: unknown;
  description: string;
  updated_at: string;
}

export interface AiBotEvent {
  id: number;
  event_id: string;
  channel: AiBotChannel;
  platform: string;
  event_type: string;
  sender_id: string;
  sender_name: string;
  content_text: string;
  media_id: string;
  parent_id: string | null;
  status: AiBotEventStatus;
  skip_reason: string | null;
  processed_at: string | null;
  created_at: string;
  replies?: AiBotReply[];
  messages?: AiBotMessage[];
}

export interface AiBotMessage {
  id: number;
  event_id: number;
  prompt_tokens: number;
  completion_tokens: number;
  model: string;
  generated_text: string;
  confidence: number;
  generation_time_ms: number;
  created_at: string;
}

export interface AiBotReply {
  id: number;
  event_id: number;
  message_id: number;
  meta_reply_id: string | null;
  reply_text: string;
  channel: AiBotChannel;
  status: AiBotReplyStatus;
  sent_at: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
}

export interface AiBotFailure {
  id: number;
  event_id: number | null;
  stage: string;
  error_code: string;
  error_message: string;
  context: unknown;
  resolved: boolean;
  resolved_at: string | null;
  created_at: string;
}

export interface AiBotMetrics {
  period_start: string;
  channel: string | null;
  events_received: number;
  events_processed: number;
  events_skipped: number;
  events_failed: number;
  replies_sent: number;
  avg_response_time_ms: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
}

export interface AiBotDashboard {
  config: { enabled: boolean; mode: AiBotMode };
  stats_24h: { events: number; replies: number; failures: number; skipped: number };
  stats_7d: { events: number; replies: number; failures: number; skipped: number };
  channels: Record<AiBotChannel, boolean>;
  queue_stats: { meta_events: number; ai_generate: number; ai_send_reply: number };
}
