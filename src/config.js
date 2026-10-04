require('dotenv').config({ quiet: true });
const env = process.env;
module.exports = {
  env: env.NODE_ENV || 'development',
  port: parseInt(env.PORT || '3000', 10),
  db: {
    host: env.DB_HOST || '127.0.0.1',
    database: env.DB_NAME || 'complaint_mgmt_db',
    user: env.DB_USER || 'ccms_app',
    password: env.DB_PASSWORD || '',
    adminUser: env.DB_ADMIN_USER || 'ccms_admin',
    adminPassword: env.DB_ADMIN_PASSWORD || '',
    poolSize: 10,
  },
  sessionSecret: env.SESSION_SECRET || 'dev-only-secret',
  smtp: { host: env.SMTP_HOST || '', port: parseInt(env.SMTP_PORT || '587', 10), user: env.SMTP_USER || '', pass: env.SMTP_PASS || '' },
  mailFrom: env.MAIL_FROM || 'complaints@example.org',
  escalationCron: env.ESCALATION_CRON || '*/15 * * * *',
  autoCloseDays: parseInt(env.AUTO_CLOSE_DAYS || '7', 10),
  limits: { minSubject: 5, maxSubject: 150, minDescription: 20, maxDescription: 4000, minNote: 10, minPassword: 8, maxPassword: 128 },
};
