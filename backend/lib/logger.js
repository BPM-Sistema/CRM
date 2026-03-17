const pino = require('pino');
const crypto = require('crypto');

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname'
          }
        }
      }
    : {})
});

// Child loggers for different modules
const apiLogger = logger.child({ module: 'api' });
const workerLogger = logger.child({ module: 'worker' });
const queueLogger = logger.child({ module: 'queue' });
const integrationLogger = logger.child({ module: 'integration' });
const dbLogger = logger.child({ module: 'db' });
const authLogger = logger.child({ module: 'auth' });

/**
 * Express middleware that:
 * - Generates a requestId (crypto.randomUUID())
 * - Attaches it to req.requestId
 * - Logs request start and end with duration
 * - Sets X-Request-Id response header
 */
function requestLogger(req, res, next) {
  const requestId = crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const start = Date.now();

  apiLogger.info({
    requestId,
    method: req.method,
    url: req.originalUrl || req.url,
    msg: 'request start'
  });

  const onFinish = () => {
    const duration = Date.now() - start;
    apiLogger.info({
      requestId,
      method: req.method,
      url: req.originalUrl || req.url,
      statusCode: res.statusCode,
      duration,
      msg: 'request end'
    });
    res.removeListener('finish', onFinish);
  };

  res.on('finish', onFinish);
  next();
}

module.exports = {
  logger,
  apiLogger,
  workerLogger,
  queueLogger,
  integrationLogger,
  dbLogger,
  authLogger,
  requestLogger
};
