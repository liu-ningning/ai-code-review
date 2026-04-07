const path = require('node:path');

const cwd = __dirname;
const port = Number(process.env.PORT || 9527);

module.exports = {
  apps: [
    {
      name: 'ai-review-server',
      cwd,
      script: path.join(cwd, 'dist/entry/index.js'),
      interpreter: 'node',
      node_args: '--enable-source-maps',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      kill_timeout: 10000,
      listen_timeout: 10000,
      merge_logs: true,
      out_file: path.join(cwd, 'logs/out.log'),
      error_file: path.join(cwd, 'logs/error.log'),
      env: {
        NODE_ENV: 'development',
        PORT: port,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: port,
      },
    },
  ],
};
