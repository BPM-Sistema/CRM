/**
 * Bull Board Integration
 *
 * Provides a visual dashboard for BullMQ queues at /admin/queues
 */

const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const { queues, QUEUE_NAMES } = require('../lib/queues');
const { authenticate, requirePermission } = require('../middleware/auth');

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

// Add all available queues to Bull Board
const queueAdapters = [];
for (const name of QUEUE_NAMES) {
  if (queues[name]) {
    queueAdapters.push(new BullMQAdapter(queues[name]));
  }
}

createBullBoard({
  queues: queueAdapters,
  serverAdapter
});

// Middleware to protect Bull Board with auth
function bullBoardAuth(req, res, next) {
  authenticate(req, res, (err) => {
    if (err) return;
    if (res.headersSent) return; // auth failed, response already sent
    requirePermission('integrations.view')(req, res, next);
  });
}

module.exports = {
  serverAdapter,
  bullBoardAuth
};
