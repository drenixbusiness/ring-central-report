// PM2 process file.
//   pm2 start ecosystem.config.cjs --env production
// Exactly one instance in fork mode: the scheduler must not run twice.

const path = require('node:path');

// Absolute project directory on the server. Override with RC_REPORT_APP_DIR if the
// file is used from another location; by default it is the folder of this file.
const APP_DIR = process.env.RC_REPORT_APP_DIR || path.resolve(__dirname);

module.exports = {
  apps: [
    {
      name: 'rc-hr-daily-report',
      cwd: APP_DIR,
      script: 'src/index.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      min_uptime: '30s',
      max_restarts: 20,
      exp_backoff_restart_delay: 2000,
      kill_timeout: 30000,
      max_memory_restart: '512M',
      out_file: path.join(APP_DIR, 'logs', 'out.log'),
      error_file: path.join(APP_DIR, 'logs', 'error.log'),
      merge_logs: true,
      // The app prints its own ISO timestamps.
      time: false,
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
