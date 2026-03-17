const { Queue } = require('bullmq');

const redisUrl = process.env.REDIS_URL;
const redisHost = process.env.REDIS_HOST;

let connection = null;

if (redisUrl) {
  // Parse REDIS_URL for BullMQ connection
  const url = new URL(redisUrl);
  connection = {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
    username: url.username || undefined,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {})
  };
} else if (redisHost) {
  connection = {
    host: redisHost,
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined
  };
}

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000
  },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 }
};

const QUEUE_NAMES = ['whatsapp', 'meta-events', 'ai-generate', 'ai-send-reply'];

// Custom job options per queue (falls back to defaultJobOptions)
const queueJobOptions = {
  'meta-events': {
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 }
  },
  'ai-generate': {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 }
  },
  'ai-send-reply': {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 2000 },
    removeOnFail: { count: 5000 }
  }
};

const queues = {};

if (connection) {
  for (const name of QUEUE_NAMES) {
    queues[name] = new Queue(name, {
      connection,
      defaultJobOptions: queueJobOptions[name] || defaultJobOptions
    });
  }
  console.log(`[Queues] Initialized ${QUEUE_NAMES.length} queues: ${QUEUE_NAMES.join(', ')}`);
} else {
  console.warn('[Queues] No Redis connection configured. Queues disabled.');
  for (const name of QUEUE_NAMES) {
    queues[name] = null;
  }
}

/**
 * Returns waiting/active/completed/failed counts for each queue.
 */
async function getQueueStats() {
  const stats = {};
  for (const name of QUEUE_NAMES) {
    const queue = queues[name];
    if (!queue) {
      stats[name] = { waiting: 0, active: 0, completed: 0, failed: 0, available: false };
      continue;
    }
    try {
      const [waiting, active, completed, failed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount()
      ]);
      stats[name] = { waiting, active, completed, failed, available: true };
    } catch (err) {
      stats[name] = { waiting: 0, active: 0, completed: 0, failed: 0, available: false, error: err.message };
    }
  }
  return stats;
}

module.exports = {
  queues,
  whatsappQueue: queues['whatsapp'],
  metaEventsQueue: queues['meta-events'],
  aiGenerateQueue: queues['ai-generate'],
  aiSendReplyQueue: queues['ai-send-reply'],
  getQueueStats,
  QUEUE_NAMES
};
