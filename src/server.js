const config = require('./config');
const { createApp } = require('./app');
const scheduler = require('./scheduler/escalation');

if (config.env === 'production' && config.sessionSecret === 'dev-only-secret') { console.error('SESSION_SECRET must be set in production'); process.exit(1); }
const app = createApp();
app.listen(config.port, () => {
  console.log(`Complaint Management System listening on port ${config.port}`);
  scheduler.start();
});
