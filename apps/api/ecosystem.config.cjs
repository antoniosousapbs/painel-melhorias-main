module.exports = {
  apps: [{
    name: 'painelbacklog-api',
    script: './dist/index.js',
    cwd: process.cwd(),
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    },
    // O .env deve estar no mesmo diretório do cwd
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    watch: false,
    max_memory_restart: '500M',
    // Evita que o Node.js fique consumindo CPU em idle
    instance_var: 'INSTANCE_ID',
    // Merge logs de todas as instâncias (quando cluster)
    merge_logs: true
  }]
};
