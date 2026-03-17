/**
 * Cron Authentication Middleware
 *
 * Validates requests from Google Cloud Scheduler using either:
 * 1. OIDC token (preferred - Google Cloud Scheduler sends this)
 * 2. Shared secret header (fallback)
 *
 * Cloud Scheduler sends: Authorization: Bearer <OIDC_TOKEN>
 * The token is verified against Google's public keys.
 */

const { OAuth2Client } = require('google-auth-library');

const oauthClient = new OAuth2Client();

async function verifyCronAuth(req, res, next) {
  // Method 1: OIDC token from Cloud Scheduler
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    const audience = process.env.CRON_OIDC_AUDIENCE;

    if (audience) {
      try {
        const ticket = await oauthClient.verifyIdToken({
          idToken: token,
          audience: audience
        });
        const payload = ticket.getPayload();

        // Optionally verify email of the service account
        const expectedEmail = process.env.CRON_SERVICE_ACCOUNT_EMAIL;
        if (expectedEmail && payload.email !== expectedEmail) {
          console.error(JSON.stringify({
            level: 'error',
            msg: 'Cron OIDC: email mismatch',
            expected: expectedEmail,
            got: payload.email
          }));
          return res.status(403).json({ error: 'Forbidden - invalid service account' });
        }

        req.cronAuth = { method: 'oidc', email: payload.email };
        return next();
      } catch (err) {
        console.error(JSON.stringify({
          level: 'error',
          msg: 'Cron OIDC verification failed',
          error: err.message
        }));
        // Fall through to secret check
      }
    }
  }

  // Method 2: Shared secret header (fallback)
  const secret = req.headers['x-cron-secret'];
  const expectedSecret = process.env.CRON_SECRET;

  if (!expectedSecret) {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'CRON_SECRET not configured and no OIDC audience set'
    }));
    return res.status(500).json({ error: 'Cron authentication not configured' });
  }

  if (!secret || secret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized - invalid cron credentials' });
  }

  req.cronAuth = { method: 'secret' };
  next();
}

module.exports = { verifyCronAuth };
