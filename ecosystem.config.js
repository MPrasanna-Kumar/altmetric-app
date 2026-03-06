// ══════════════════════════════════════════════════════════════════
//  PM2 ECOSYSTEM CONFIG — Altmetric Score Viewer
//  Usage:
//    pm2 start ecosystem.config.js          → start
//    pm2 stop ecosystem.config.js           → stop
//    pm2 restart ecosystem.config.js        → restart
//    pm2 reload ecosystem.config.js         → zero-downtime reload
//    pm2 delete ecosystem.config.js         → remove from pm2
//    pm2 logs altmetric-viewer              → view logs
//    pm2 monit                              → live monitor
// ══════════════════════════════════════════════════════════════════

module.exports = {
  apps: [
    {
      // ── Identity ──────────────────────────────────────────────
      name:         '8011-altmetric-viewer',
      script:       './server.js',

      // ── Runtime ───────────────────────────────────────────────
      instances:    1,               // single instance for local
      exec_mode:    'fork',          // fork mode (use 'cluster' for multi-core)
      autorestart:  true,            // restart on crash
      watch:        false,           // set true during dev if you want hot-reload
      max_memory_restart: '512M',    // restart if RAM exceeds this

      // ── Environment: Local (default) ──────────────────────────
      env: {
        NODE_ENV:           'development',
        HOST:               '0.0.0.0',
        PORT:               8011,
        BATCH_SIZE:         3,
        API_TIMEOUT:        8000,
        REQUEST_TIMEOUT:    600000,
        MAX_FILE_SIZE:      536870912,
        CORS_ORIGIN:        'http://localhost:8010,https://148.66.154.86:8011',
        CROSSREF_MAILTO:    'altmetric-viewer@app',
        CROSSREF_BASE_URL:  'https://api.crossref.org',
        ALTMETRIC_BASE_URL: 'https://www.altmetric.com',
        UPLOAD_DIR:         './uploads',
      },

      // ── Environment: Production ────────────────────────────────
      env_production: {
        NODE_ENV:           'production',
        HOST:               '0.0.0.0',
        PORT:               8011,
        BATCH_SIZE:         3,
        API_TIMEOUT:        10000,
        REQUEST_TIMEOUT:    600000,
        MAX_FILE_SIZE:      536870912,
        CORS_ORIGIN:        'https://148.66.154.86:8011',
        CROSSREF_MAILTO:    'altmetric-viewer@app',
        CROSSREF_BASE_URL:  'https://api.crossref.org',
        ALTMETRIC_BASE_URL: 'https://www.altmetric.com',
        UPLOAD_DIR:         './uploads',
      },

      // ── Logs ──────────────────────────────────────────────────
      out_file:     './logs/out.log',
      error_file:   './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:   true,
    }
  ]
};