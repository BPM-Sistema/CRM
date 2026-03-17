/**
 * AI Bot Queue Helpers
 *
 * Funciones para encolar jobs en las colas del AI bot:
 * - meta-events: eventos entrantes del webhook de Meta
 * - ai-generate: generacion de respuestas con Claude AI
 * - ai-send-reply: envio de respuestas a Meta
 */

const { metaEventsQueue, aiGenerateQueue, aiSendReplyQueue } = require('./queues');
const { apiLogger: log } = require('./logger');

/**
 * Encola un evento entrante de Meta (webhook) para procesamiento.
 * @param {object} params
 * @param {string} params.waId - WhatsApp ID del contacto
 * @param {string} params.message - Texto del mensaje recibido
 * @param {string} params.messageId - ID del mensaje de Meta
 * @param {string} [params.phoneNumberId] - Phone number ID de la cuenta de negocio
 * @param {object} [params.metadata] - Metadata adicional del evento
 * @returns {Promise<import('bullmq').Job|null>}
 */
async function enqueueMetaEvent({ waId, message, messageId, phoneNumberId, metadata = {} }) {
  if (!metaEventsQueue) {
    log.warn({ waId, messageId }, 'meta-events queue not available (Redis not configured)');
    return null;
  }

  const job = await metaEventsQueue.add('incoming-message', {
    waId,
    message,
    messageId,
    phoneNumberId,
    metadata,
    receivedAt: new Date().toISOString()
  }, {
    jobId: `meta-${messageId}`,
    deduplication: { id: messageId }
  });

  log.info({ jobId: job.id, waId, messageId }, 'Meta event enqueued');
  return job;
}

/**
 * Encola un job de generacion de respuesta con Claude AI.
 * @param {object} params
 * @param {string} params.waId - WhatsApp ID del contacto
 * @param {string} params.message - Mensaje del usuario
 * @param {string} params.messageId - ID del mensaje original
 * @param {object} [params.conversationContext] - Contexto de la conversacion
 * @param {string} [params.systemPrompt] - System prompt override
 * @returns {Promise<import('bullmq').Job|null>}
 */
async function enqueueAIGeneration({ waId, message, messageId, conversationContext = {}, systemPrompt }) {
  if (!aiGenerateQueue) {
    log.warn({ waId, messageId }, 'ai-generate queue not available (Redis not configured)');
    return null;
  }

  const job = await aiGenerateQueue.add('generate-reply', {
    waId,
    message,
    messageId,
    conversationContext,
    systemPrompt,
    enqueuedAt: new Date().toISOString()
  });

  log.info({ jobId: job.id, waId, messageId }, 'AI generation job enqueued');
  return job;
}

/**
 * Encola el envio de una respuesta generada a Meta (WhatsApp).
 * @param {object} params
 * @param {string} params.waId - WhatsApp ID del destinatario
 * @param {string} params.replyText - Texto de la respuesta a enviar
 * @param {string} params.originalMessageId - ID del mensaje original al que se responde
 * @param {string} [params.phoneNumberId] - Phone number ID de la cuenta de negocio
 * @returns {Promise<import('bullmq').Job|null>}
 */
async function enqueueAISendReply({ waId, replyText, originalMessageId, phoneNumberId }) {
  if (!aiSendReplyQueue) {
    log.warn({ waId, originalMessageId }, 'ai-send-reply queue not available (Redis not configured)');
    return null;
  }

  const job = await aiSendReplyQueue.add('send-reply', {
    waId,
    replyText,
    originalMessageId,
    phoneNumberId,
    enqueuedAt: new Date().toISOString()
  });

  log.info({ jobId: job.id, waId, originalMessageId }, 'AI send-reply job enqueued');
  return job;
}

module.exports = {
  enqueueMetaEvent,
  enqueueAIGeneration,
  enqueueAISendReply
};
