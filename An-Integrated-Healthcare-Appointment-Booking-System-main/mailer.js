// mailer.js
require('dotenv').config();
const nodemailer = require('nodemailer');

let transporter = null;

if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      : undefined
  });
}

async function sendMail({ to, subject, html, text }) {
  if (!to) return;

  // Agar SMTP configure nahi kiya, to sirf console me log (SMS jaisa)
  if (!transporter) {
    console.log('EMAIL (mock):', { to, subject, body: html || text });
    return;
  }

  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
      html
    });
  } catch (err) {
    console.error('Error sending email:', err.message);
  }
}

module.exports = { sendMail };