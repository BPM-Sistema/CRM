/**
 * Email notifications via nodemailer + Gmail SMTP
 *
 * Env vars:
 *   GMAIL_USER        — cuenta Gmail (default: blanqueriaxmayorista@gmail.com)
 *   GMAIL_APP_PASSWORD — App Password de Gmail (16 chars, sin espacios)
 *   NOTIFY_EMAIL       — destino de alertas (default: asaieg26@gmail.com)
 */

const nodemailer = require('nodemailer');
const { apiLogger: log } = require('./logger');

const GMAIL_USER = process.env.GMAIL_USER || 'blanqueriaxmayorista@gmail.com';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'asaieg26@gmail.com';

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  if (!GMAIL_APP_PASSWORD) {
    log.warn('GMAIL_APP_PASSWORD not set — email notifications disabled');
    return null;
  }

  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
  });
  return _transporter;
}

/**
 * Envía un email de notificación.
 * No lanza excepciones — loguea errores internamente.
 */
async function sendNotification({ to = NOTIFY_EMAIL, subject, body }) {
  const transporter = getTransporter();
  if (!transporter) return;

  try {
    await transporter.sendMail({
      from: GMAIL_USER,
      to,
      subject,
      text: body,
    });
    log.info({ to, subject }, 'Email notification sent');
  } catch (err) {
    log.error({ err: err.message, to, subject }, 'Error sending email notification');
  }
}

module.exports = { sendNotification };
