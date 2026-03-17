/**
 * AI Bot Rules Engine
 *
 * Decision logic for whether the bot should respond, skip, or flag an event.
 * Rules are evaluated in order; the first match wins.
 */

const { integrationLogger: log } = require('../logger');
const pool = require('../../db');

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

// Matches most Unicode emoji (including skin-tone modifiers, ZWJ sequences, etc.)
const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;

const TAG_REGEX = /@[\w.]+/g;

const QUESTION_KEYWORDS = [
  'precio', 'envío', 'envio', 'info', 'información', 'informacion',
  'catálogo', 'catalogo', 'dirección', 'direccion', 'horario',
  'whatsapp', 'wsp', 'mayorista', 'mayor', 'mínimo', 'minimo',
  'medida', 'material', 'stock', 'disponible', 'comprar',
  'pago', 'tarjeta', 'transferencia', 'efectivo',
  'envían', 'hacen envío', 'hacen envio',
  'de donde son', 'de dónde', 'abierto', 'abren', 'tienen',
];

const SPAM_PATTERNS = [
  /https?:\/\/\S+/i,                      // URLs
  /(.)\1{5,}/,                             // same char repeated 6+ times
  /(\b\w+\b)(\s+\1){3,}/i,                // same word repeated 4+ times
  /[A-ZÁÉÍÓÚÑ\s]{20,}/,                   // excessive caps (20+ uppercase chars)
  /ganá|sorteo|regalamos|link en bio/i,    // common spam phrases
];

const TESTIMONIAL_PATTERNS = [
  /graci?as|genial|excelente|hermoso|divino|bello|increíble|increible|lo mejor|los amo|las amo|re lindo|espectacular|buenísimo|buenisimo|que lindo|me encanta|me encantan|muy bueno|muy linda|re buena|recomiendo|excelentes|maravilloso/i,
];

const EMOJI_RESPONSES = [
  '❤🔥🔥',
  '🙌❤',
  'te esperamos ❤️🙌',
  '🔥🔥🙌',
];

// ---------------------------------------------------------------------------
// Helper checks
// ---------------------------------------------------------------------------

/**
 * True when the message contains ONLY emojis and/or whitespace.
 */
function isEmojiOnly(text) {
  if (!text || !text.trim()) return true;
  const stripped = text.replace(EMOJI_REGEX, '').replace(/\s+/g, '');
  return stripped.length === 0;
}

/**
 * True when the message is only @mentions (with optional emojis/whitespace) and
 * contains no real question or keyword.
 */
function isTagOnly(text) {
  if (!text) return false;
  const withoutTags = text.replace(TAG_REGEX, '').replace(EMOJI_REGEX, '').replace(/\s+/g, '');
  return withoutTags.length === 0;
}

/**
 * Basic spam detection against known patterns.
 */
function isSpam(text) {
  if (!text) return false;
  return SPAM_PATTERNS.some((p) => p.test(text));
}

/**
 * Detect positive testimonials / praise that don't contain a question.
 */
function isTestimonial(text) {
  if (!text) return false;
  const hasTestimonialWord = TESTIMONIAL_PATTERNS.some((p) => p.test(text));
  if (!hasTestimonialWord) return false;
  // If it also contains a question mark or a keyword, it's not purely a testimonial
  if (text.includes('?')) return false;
  const lower = text.toLowerCase();
  const hasKeyword = QUESTION_KEYWORDS.some((kw) => lower.includes(kw));
  return !hasKeyword;
}

/**
 * True when the message looks like a question (has ? or question-style phrasing).
 */
function isQuestion(text) {
  if (!text) return false;
  if (text.includes('?')) return true;
  const lower = text.toLowerCase();
  return /^(cómo|como|cuánto|cuanto|dónde|donde|cuál|cual|qué|que|tienen|hacen|venden|aceptan|puedo|se puede|hay)\b/.test(lower.trim());
}

/**
 * Check if the text contains any business-related keyword.
 */
function hasKeywords(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return QUESTION_KEYWORDS.some((kw) => lower.includes(kw));
}

// ---------------------------------------------------------------------------
// DB checks
// ---------------------------------------------------------------------------

/**
 * Check whether we already replied to this event (by event_id), or to the same
 * sender on the same media (to avoid double-replying on the same post).
 */
async function alreadyReplied(eventId, mediaId, senderId) {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM ai_bot_events e
       JOIN ai_bot_replies r ON r.event_id = e.id
       WHERE (e.event_id = $1)
          OR (e.media_id = $2 AND e.sender_id = $3 AND r.status = 'sent')
       LIMIT 1`,
      [eventId, mediaId, senderId],
    );
    return rows.length > 0;
  } catch (err) {
    log.error({ err }, 'rules-engine: alreadyReplied query failed');
    return false; // fail open — let other rules decide
  }
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

/**
 * Read rate-limit config and compare against recent reply counts.
 * Returns { allowed: boolean, reason: string }.
 */
async function checkRateLimits(channel) {
  try {
    // Fetch config
    const { rows: cfgRows } = await pool.query(
      `SELECT value FROM ai_bot_config WHERE key = 'rate_limits'`,
    );

    const defaults = { max_replies_per_minute: 10, max_replies_per_hour: 200, max_tokens_per_day: 100000 };
    const limits = cfgRows.length > 0 ? { ...defaults, ...cfgRows[0].value } : defaults;

    // Count replies in last minute
    const { rows: minRows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM ai_bot_replies
       WHERE status = 'sent'
         AND channel = COALESCE($1, channel)
         AND sent_at >= NOW() - INTERVAL '1 minute'`,
      [channel || null],
    );

    if (minRows[0].cnt >= limits.max_replies_per_minute) {
      return { allowed: false, reason: `rate_limit: ${minRows[0].cnt}/${limits.max_replies_per_minute} replies/min` };
    }

    // Count replies in last hour
    const { rows: hrRows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM ai_bot_replies
       WHERE status = 'sent'
         AND channel = COALESCE($1, channel)
         AND sent_at >= NOW() - INTERVAL '1 hour'`,
      [channel || null],
    );

    if (hrRows[0].cnt >= limits.max_replies_per_hour) {
      return { allowed: false, reason: `rate_limit: ${hrRows[0].cnt}/${limits.max_replies_per_hour} replies/hr` };
    }

    // Count tokens today
    const { rows: tokRows } = await pool.query(
      `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0)::int AS total
       FROM ai_bot_messages
       WHERE created_at >= CURRENT_DATE`,
    );

    if (tokRows[0].total >= limits.max_tokens_per_day) {
      return { allowed: false, reason: `rate_limit: ${tokRows[0].total}/${limits.max_tokens_per_day} tokens/day` };
    }

    return { allowed: true, reason: 'within_limits' };
  } catch (err) {
    log.error({ err }, 'rules-engine: checkRateLimits failed');
    // Fail open — don't block replies because of a DB hiccup
    return { allowed: true, reason: 'rate_limit_check_failed_open' };
  }
}

// ---------------------------------------------------------------------------
// Emoji response for testimonials
// ---------------------------------------------------------------------------

function getEmojiResponse() {
  return EMOJI_RESPONSES[Math.floor(Math.random() * EMOJI_RESPONSES.length)];
}

// ---------------------------------------------------------------------------
// Main decision function
// ---------------------------------------------------------------------------

/**
 * Evaluate an incoming event and decide whether the bot should respond.
 *
 * @param {object} event
 * @param {string} event.eventId
 * @param {string} event.channel
 * @param {string} event.platform
 * @param {string} event.eventType
 * @param {string} event.senderId
 * @param {string} event.senderName
 * @param {string} event.contentText
 * @param {string} event.mediaId
 * @param {string} event.parentId
 * @returns {Promise<{respond: boolean, reason: string, action: 'respond'|'skip'|'emoji_only'}>}
 */
async function shouldRespond(event) {
  const { eventId, channel, senderId, contentText: text, mediaId } = event;

  log.debug({ eventId, channel }, 'rules-engine: evaluating event');

  // a. Emoji-only → skip
  if (isEmojiOnly(text)) {
    log.info({ eventId }, 'rules-engine: skip (emoji_only)');
    return { respond: false, reason: 'emoji_only', action: 'skip' };
  }

  // b. Tag-only → skip
  if (isTagOnly(text)) {
    log.info({ eventId }, 'rules-engine: skip (tag_only)');
    return { respond: false, reason: 'tag_only', action: 'skip' };
  }

  // c. Spam → skip
  if (isSpam(text)) {
    log.info({ eventId }, 'rules-engine: skip (spam)');
    return { respond: false, reason: 'spam', action: 'skip' };
  }

  // d. Already replied → skip
  if (await alreadyReplied(eventId, mediaId, senderId)) {
    log.info({ eventId }, 'rules-engine: skip (already_replied)');
    return { respond: false, reason: 'already_replied', action: 'skip' };
  }

  // e. Testimonial → emoji only
  if (isTestimonial(text)) {
    log.info({ eventId }, 'rules-engine: emoji_only (testimonial)');
    return { respond: true, reason: 'testimonial', action: 'emoji_only' };
  }

  // f. Explicit question → respond
  if (isQuestion(text)) {
    log.info({ eventId }, 'rules-engine: respond (question)');
    return { respond: true, reason: 'question', action: 'respond' };
  }

  // g. Business keywords → respond
  if (hasKeywords(text)) {
    log.info({ eventId }, 'rules-engine: respond (keyword_match)');
    return { respond: true, reason: 'keyword_match', action: 'respond' };
  }

  // h. Default: respond if > 3 real words
  const words = (text || '')
    .replace(EMOJI_REGEX, '')
    .replace(TAG_REGEX, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length > 3) {
    log.info({ eventId }, 'rules-engine: respond (default, >3 words)');
    return { respond: true, reason: 'default_long_enough', action: 'respond' };
  }

  // Too short / ambiguous → skip
  log.info({ eventId }, 'rules-engine: skip (too_short)');
  return { respond: false, reason: 'too_short', action: 'skip' };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  shouldRespond,
  checkRateLimits,
  getEmojiResponse,
  // Expose helpers for testing
  isEmojiOnly,
  isTagOnly,
  isSpam,
  isTestimonial,
  isQuestion,
  hasKeywords,
  alreadyReplied,
  QUESTION_KEYWORDS,
  EMOJI_REGEX,
  TAG_REGEX,
  SPAM_PATTERNS,
};
