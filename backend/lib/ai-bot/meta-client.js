const axios = require('axios');
const crypto = require('crypto');
const { integrationLogger: log } = require('../logger');
const pool = require('../../db');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';
const PAGE_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_CODES = new Set([4, 17, 32]);

// ---------------------------------------------------------------------------
// In-memory token cache
// ---------------------------------------------------------------------------
let _pageTokenCache = { token: null, expiresAt: 0 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a successful result in a consistent envelope.
 */
function ok(data) {
  return { success: true, data, error: null };
}

/**
 * Wrap an error in a consistent envelope.
 * Detects Meta rate-limit error codes and attaches backoff info.
 */
function fail(err, context = '') {
  const metaError = err?.response?.data?.error || {};
  const code = metaError.code;
  const isRateLimit = RATE_LIMIT_CODES.has(code);

  const retryAfter = isRateLimit
    ? parseInt(err.response?.headers?.['retry-after'] || '60', 10)
    : null;

  const payload = {
    success: false,
    data: null,
    error: {
      message: metaError.message || err.message,
      code: code || null,
      type: metaError.type || null,
      isRateLimit,
      ...(retryAfter !== null && { retryAfterSeconds: retryAfter }),
    },
  };

  log.error({ err: payload.error, context }, `meta-client error: ${context}`);
  return payload;
}

// ---------------------------------------------------------------------------
// 1. getConfig
// ---------------------------------------------------------------------------

/**
 * Read Meta configuration from `ai_bot_config` table.
 * Falls back to env vars for page_id and ig_account_id.
 */
async function getConfig() {
  try {
    const { rows } = await pool.query(
      `SELECT config_value
         FROM ai_bot_config
        WHERE config_key = 'meta'
        LIMIT 1`
    );

    const dbConfig = rows.length ? rows[0].config_value : {};

    const config = {
      pageId: dbConfig.page_id || process.env.META_PAGE_ID || null,
      igAccountId: dbConfig.ig_account_id || process.env.META_IG_ACCOUNT_ID || null,
      userAccessToken: process.env.META_USER_ACCESS_TOKEN || null,
      appSecret: process.env.META_APP_SECRET || null,
      verifyToken: process.env.META_VERIFY_TOKEN || null,
    };

    return ok(config);
  } catch (err) {
    return fail(err, 'getConfig');
  }
}

// ---------------------------------------------------------------------------
// 2. getPageAccessToken
// ---------------------------------------------------------------------------

/**
 * Exchange the User Access Token for a Page Access Token via the Graph API.
 * Caches the result in memory for 1 hour.
 */
async function getPageAccessToken() {
  try {
    if (_pageTokenCache.token && Date.now() < _pageTokenCache.expiresAt) {
      return ok({ accessToken: _pageTokenCache.token, cached: true });
    }

    const configRes = await getConfig();
    if (!configRes.success) return configRes;

    const { pageId, userAccessToken } = configRes.data;
    if (!userAccessToken) return fail(new Error('META_USER_ACCESS_TOKEN not set'), 'getPageAccessToken');
    if (!pageId) return fail(new Error('pageId not configured'), 'getPageAccessToken');

    const { data } = await axios.get(`${GRAPH_API_BASE}/${pageId}`, {
      params: {
        fields: 'access_token',
        access_token: userAccessToken,
      },
    });

    const pageToken = data.access_token;
    if (!pageToken) {
      return fail(new Error('Page access_token missing from Graph API response'), 'getPageAccessToken');
    }

    _pageTokenCache = { token: pageToken, expiresAt: Date.now() + PAGE_TOKEN_TTL_MS };
    log.info('Page access token obtained and cached');

    return ok({ accessToken: pageToken, cached: false });
  } catch (err) {
    return fail(err, 'getPageAccessToken');
  }
}

// ---------------------------------------------------------------------------
// 3. replyToInstagramComment
// ---------------------------------------------------------------------------

/**
 * Reply to an Instagram comment.
 * Instagram Graph API requires the User Access Token (not Page Token).
 */
async function replyToInstagramComment(commentId, message) {
  try {
    if (!commentId || !message) {
      return fail(new Error('commentId and message are required'), 'replyToInstagramComment');
    }

    const configRes = await getConfig();
    if (!configRes.success) return configRes;

    const { userAccessToken } = configRes.data;
    if (!userAccessToken) return fail(new Error('META_USER_ACCESS_TOKEN not set'), 'replyToInstagramComment');

    const { data } = await axios.post(
      `${GRAPH_API_BASE}/${commentId}/replies`,
      { message },
      { params: { access_token: userAccessToken } }
    );

    log.info({ commentId, replyId: data.id }, 'Instagram comment reply sent');
    return ok({ replyId: data.id });
  } catch (err) {
    return fail(err, 'replyToInstagramComment');
  }
}

// ---------------------------------------------------------------------------
// 4. replyToFacebookComment
// ---------------------------------------------------------------------------

/**
 * Reply to a Facebook comment.
 * Facebook Graph API requires the Page Access Token.
 */
async function replyToFacebookComment(commentId, message) {
  try {
    if (!commentId || !message) {
      return fail(new Error('commentId and message are required'), 'replyToFacebookComment');
    }

    const tokenRes = await getPageAccessToken();
    if (!tokenRes.success) return tokenRes;

    const { accessToken } = tokenRes.data;

    const { data } = await axios.post(
      `${GRAPH_API_BASE}/${commentId}/comments`,
      { message },
      { params: { access_token: accessToken } }
    );

    log.info({ commentId, replyId: data.id }, 'Facebook comment reply sent');
    return ok({ replyId: data.id });
  } catch (err) {
    return fail(err, 'replyToFacebookComment');
  }
}

// ---------------------------------------------------------------------------
// 5. sendMessengerMessage
// ---------------------------------------------------------------------------

/**
 * Send a text message via Facebook Messenger.
 */
async function sendMessengerMessage(recipientId, message) {
  try {
    if (!recipientId || !message) {
      return fail(new Error('recipientId and message are required'), 'sendMessengerMessage');
    }

    const configRes = await getConfig();
    if (!configRes.success) return configRes;

    const { pageId } = configRes.data;
    if (!pageId) return fail(new Error('pageId not configured'), 'sendMessengerMessage');

    const tokenRes = await getPageAccessToken();
    if (!tokenRes.success) return tokenRes;

    const { accessToken } = tokenRes.data;

    const { data } = await axios.post(
      `${GRAPH_API_BASE}/${pageId}/messages`,
      {
        recipient: { id: recipientId },
        message: { text: message },
      },
      { params: { access_token: accessToken } }
    );

    log.info({ recipientId, messageId: data.message_id }, 'Messenger message sent');
    return ok({ messageId: data.message_id });
  } catch (err) {
    return fail(err, 'sendMessengerMessage');
  }
}

// ---------------------------------------------------------------------------
// 6. verifyWebhookSignature
// ---------------------------------------------------------------------------

/**
 * Verify the X-Hub-Signature-256 header on an incoming webhook request.
 * Returns { success: true } when valid, { success: false } otherwise.
 *
 * NOTE: Express must be configured with a raw-body parser so that
 *       req.rawBody (Buffer) is available.
 */
function verifyWebhookSignature(req) {
  try {
    const appSecret = process.env.META_APP_SECRET;
    if (!appSecret) return fail(new Error('META_APP_SECRET not set'), 'verifyWebhookSignature');

    const signature = req.headers['x-hub-signature-256'];
    if (!signature) return fail(new Error('Missing X-Hub-Signature-256 header'), 'verifyWebhookSignature');

    const rawBody = req.rawBody || req.body;
    if (!rawBody) return fail(new Error('Missing raw body for signature verification'), 'verifyWebhookSignature');

    const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody));

    const expectedHash = crypto
      .createHmac('sha256', appSecret)
      .update(buf)
      .digest('hex');

    const expectedSignature = `sha256=${expectedHash}`;
    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );

    if (!isValid) {
      log.warn('Webhook signature mismatch');
      return fail(new Error('Invalid webhook signature'), 'verifyWebhookSignature');
    }

    return ok({ verified: true });
  } catch (err) {
    return fail(err, 'verifyWebhookSignature');
  }
}

// ---------------------------------------------------------------------------
// 7. parseWebhookEvent
// ---------------------------------------------------------------------------

/**
 * Parse a single webhook `entry` object into a normalised event.
 * Supports: Instagram comments, Facebook comments, Messenger messages.
 *
 * Returns { success, data: { eventId, channel, platform, eventType,
 *           senderId, senderName, contentText, mediaId, parentId, rawPayload } }
 */
function parseWebhookEvent(entry) {
  try {
    // --- Instagram comment (changes with field = "comments") ---
    if (entry.changes) {
      for (const change of entry.changes) {
        if (change.field === 'comments') {
          const v = change.value || {};
          return ok({
            eventId: v.id || null,
            channel: 'instagram',
            platform: 'meta',
            eventType: 'comment',
            senderId: v.from?.id || null,
            senderName: v.from?.username || null,
            contentText: v.text || null,
            mediaId: v.media?.id || null,
            parentId: v.parent_id || null,
            rawPayload: entry,
          });
        }

        // --- Facebook comment (changes with field = "feed", item = "comment") ---
        if (change.field === 'feed' && change.value?.item === 'comment') {
          const v = change.value;
          return ok({
            eventId: v.comment_id || null,
            channel: 'facebook',
            platform: 'meta',
            eventType: 'comment',
            senderId: v.from?.id || null,
            senderName: v.from?.name || null,
            contentText: v.message || null,
            mediaId: v.post_id || null,
            parentId: v.parent_id || null,
            rawPayload: entry,
          });
        }
      }
    }

    // --- Messenger message ---
    if (entry.messaging) {
      for (const event of entry.messaging) {
        if (event.message) {
          return ok({
            eventId: event.message.mid || null,
            channel: 'messenger',
            platform: 'meta',
            eventType: 'message',
            senderId: event.sender?.id || null,
            senderName: null, // Messenger doesn't include name in webhook
            contentText: event.message.text || null,
            mediaId: null,
            parentId: null,
            rawPayload: entry,
          });
        }
      }
    }

    log.warn({ entryId: entry.id }, 'Unrecognised webhook entry — skipping');
    return ok(null);
  } catch (err) {
    return fail(err, 'parseWebhookEvent');
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  getConfig,
  getPageAccessToken,
  replyToInstagramComment,
  replyToFacebookComment,
  sendMessengerMessage,
  verifyWebhookSignature,
  parseWebhookEvent,
};
