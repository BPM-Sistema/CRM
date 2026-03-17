/**
 * AI Engine - Claude API integration for ai-bot reply generation
 *
 * Handles: config caching, system prompt, message building,
 * response validation, and structured logging.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { integrationLogger: log } = require('../logger');
const pool = require('../../db');

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let _client = null;

function getClient() {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set');
    }
    _client = new Anthropic({ apiKey });
    log.info('Anthropic client initialized');
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Config cache (60 s TTL)
// ---------------------------------------------------------------------------

const _cache = {
  config: { data: null, ts: 0 },
  systemPrompt: { data: null, ts: 0 }
};

const CACHE_TTL_MS = 60_000;

function isFresh(entry) {
  return entry.data !== null && Date.now() - entry.ts < CACHE_TTL_MS;
}

/**
 * Read model / max_tokens / temperature from ai_bot_config table.
 * Falls back to sensible defaults when the table is empty.
 */
async function getConfig() {
  if (isFresh(_cache.config)) return _cache.config.data;

  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM ai_bot_config WHERE key IN ('model', 'max_tokens', 'temperature')`
    );

    const map = {};
    for (const r of rows) map[r.key] = r.value;

    const config = {
      model: map.model || 'claude-haiku-4-5-20251001',
      max_tokens: parseInt(map.max_tokens, 10) || 1024,
      temperature: parseFloat(map.temperature) || 0.4
    };

    _cache.config = { data: config, ts: Date.now() };
    log.info({ config }, 'ai-engine config loaded');
    return config;
  } catch (err) {
    log.error({ err }, 'Failed to load ai_bot_config — using defaults');
    const fallback = { model: 'claude-haiku-4-5-20251001', max_tokens: 1024, temperature: 0.4 };
    _cache.config = { data: fallback, ts: Date.now() };
    return fallback;
  }
}

/**
 * Read system_prompt from ai_bot_config table.
 */
async function getSystemPrompt() {
  if (isFresh(_cache.systemPrompt)) return _cache.systemPrompt.data;

  try {
    const { rows } = await pool.query(
      `SELECT value FROM ai_bot_config WHERE key = 'system_prompt' LIMIT 1`
    );

    const prompt = rows[0]?.value || 'Sos un asistente virtual de atención al cliente. Respondé de forma breve, amable y útil.';

    _cache.systemPrompt = { data: prompt, ts: Date.now() };
    log.info('ai-engine system prompt loaded');
    return prompt;
  } catch (err) {
    log.error({ err }, 'Failed to load system_prompt — using default');
    const fallback = 'Sos un asistente virtual de atención al cliente. Respondé de forma breve, amable y útil.';
    _cache.systemPrompt = { data: fallback, ts: Date.now() };
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Message building
// ---------------------------------------------------------------------------

/**
 * Build the user-facing message that is sent to Claude.
 * @param {object} event - { channel, contentText, senderName, mediaId, platform }
 */
function buildUserMessage(event) {
  const parts = [
    `Canal: ${event.channel || 'desconocido'}`,
    `Usuario: ${event.senderName || 'Sin nombre'}`,
    `Mensaje: ${event.contentText || ''}`
  ];

  if (event.platform) {
    parts.unshift(`Plataforma: ${event.platform}`);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

const FORBIDDEN_PHRASES = [
  'lamentablemente',
  'por supuesto',
  'buenos días',
  'buenas tardes',
  'buenas noches',
  'no dude en',
  'no dudes en',
  'quedo a disposición',
  'quedo a tu disposición'
];

const WHATSAPP_PHONE_RE = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/;

const MAX_COMMENT_LENGTH = 500;

/**
 * Validate / sanitise Claude's raw output.
 * @returns {{ valid: boolean, reason: string|null, sanitizedText: string }}
 */
function validateResponse(text) {
  if (!text || typeof text !== 'string') {
    return { valid: false, reason: 'empty_response', sanitizedText: '' };
  }

  let sanitized = text.trim();

  // Strip markdown wrappers Claude sometimes adds
  if (sanitized.startsWith('```')) {
    sanitized = sanitized.replace(/```[\s\S]*?\n?/g, '').trim();
  }

  // Length check
  if (sanitized.length > MAX_COMMENT_LENGTH) {
    return {
      valid: false,
      reason: `exceeds_max_length (${sanitized.length}/${MAX_COMMENT_LENGTH})`,
      sanitizedText: sanitized.slice(0, MAX_COMMENT_LENGTH)
    };
  }

  // Forbidden phrases
  const lower = sanitized.toLowerCase();
  for (const phrase of FORBIDDEN_PHRASES) {
    if (lower.includes(phrase)) {
      return { valid: false, reason: `forbidden_phrase: "${phrase}"`, sanitizedText: sanitized };
    }
  }

  // WhatsApp number / phone leak
  if (WHATSAPP_PHONE_RE.test(sanitized)) {
    return { valid: false, reason: 'contains_phone_number', sanitizedText: sanitized };
  }

  // Full price list detection (heuristic: 3+ lines with $ signs)
  const priceLines = sanitized.split('\n').filter(l => /\$\s*\d/.test(l));
  if (priceLines.length >= 3) {
    return { valid: false, reason: 'contains_price_list', sanitizedText: sanitized };
  }

  return { valid: true, reason: null, sanitizedText: sanitized };
}

// ---------------------------------------------------------------------------
// Confidence estimation
// ---------------------------------------------------------------------------

/**
 * Heuristic confidence score [0-1] based on response characteristics.
 */
function estimateConfidence(text, event) {
  let score = 0.7; // baseline

  // Short replies are usually more confident (direct answers)
  if (text.length < 100) score += 0.1;
  if (text.length > 400) score -= 0.1;

  // If the response references something from the user message, boost
  if (event.contentText) {
    const words = event.contentText.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const respLower = text.toLowerCase();
    const matchCount = words.filter(w => respLower.includes(w)).length;
    if (matchCount >= 2) score += 0.1;
  }

  // Contains a question mark → less certain
  if (text.includes('?')) score -= 0.05;

  return Math.max(0, Math.min(1, parseFloat(score.toFixed(2))));
}

// ---------------------------------------------------------------------------
// Main generation
// ---------------------------------------------------------------------------

/**
 * Generate a reply for an incoming event using Claude.
 *
 * @param {object} event - { channel, contentText, senderName, mediaId, platform }
 * @returns {{ text: string, promptTokens: number, completionTokens: number,
 *             model: string, generationTimeMs: number, confidence: number }}
 */
async function generateReply(event) {
  const client = getClient();
  const [config, systemPrompt] = await Promise.all([getConfig(), getSystemPrompt()]);

  const userMessage = buildUserMessage(event);

  log.info({ channel: event.channel, sender: event.senderName, platform: event.platform }, 'ai-engine generating reply');

  const startTime = Date.now();

  try {
    const response = await client.messages.create({
      model: config.model,
      max_tokens: config.max_tokens,
      temperature: config.temperature,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userMessage }
      ]
    });

    const generationTimeMs = Date.now() - startTime;

    const textBlock = response.content.find(c => c.type === 'text');
    const rawText = textBlock?.text || '';

    const { valid, reason, sanitizedText } = validateResponse(rawText);

    if (!valid) {
      log.warn({ reason, rawLength: rawText.length }, 'ai-engine response validation failed');
    }

    const confidence = estimateConfidence(sanitizedText, event);

    const result = {
      text: sanitizedText,
      promptTokens: response.usage?.input_tokens || 0,
      completionTokens: response.usage?.output_tokens || 0,
      model: config.model,
      generationTimeMs,
      confidence
    };

    log.info({
      model: config.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      generationTimeMs,
      confidence,
      valid,
      reason
    }, 'ai-engine reply generated');

    return result;
  } catch (err) {
    const generationTimeMs = Date.now() - startTime;
    log.error({ err, generationTimeMs, model: config.model }, 'ai-engine Claude API call failed');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getClient,
  getConfig,
  getSystemPrompt,
  buildUserMessage,
  validateResponse,
  generateReply
};
