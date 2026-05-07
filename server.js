const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const config = require('./src/config');
const db = require('./src/db');
const errorMw = require('./src/middleware/error');
const authRoute = require('./src/routes/auth');
const healthRoute = require('./src/routes/health');

const app = express();

// trust X-Forwarded-* when behind a reverse proxy (nginx, etc.)
app.set('trust proxy', 1);

// Security headers (XSS, clickjacking, MIME-sniff, etc.)
app.use(helmet({
    contentSecurityPolicy: false,         // API only, no HTML — CSP not needed
    crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// Body parser
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// CORS — whitelist + dev-friendly localhost matching
const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
app.use(cors({
    origin: (origin, cb) => {
        // curl / Postman — no Origin header
        if (!origin) return cb(null, true);
        if (config.corsOrigins.includes('*')) return cb(null, true);
        if (config.corsOrigins.includes(origin)) return cb(null, true);
        // In development, also allow:
        //   - any localhost / 127.0.0.1 port
        //   - file:// pages (browser sends Origin: "null" string)
        if (config.env !== 'production') {
            if (origin === 'null') return cb(null, true);
            if (LOCAL_RE.test(origin)) return cb(null, true);
        }
        cb(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
}));

// Routes
app.use('/api/health', healthRoute);
app.use('/api/auth', authRoute);

// 404 + error handlers (must be last)
app.use(errorMw.notFound);
app.use(errorMw.handler);

// Start server
const server = app.listen(config.port, () => {
    console.log(`[api] listening on http://localhost:${config.port} (${config.env})`);
    console.log(`[api] DB: ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
});

// Graceful shutdown
function shutdown(signal) {
    console.log(`\n[api] received ${signal}, shutting down...`);
    server.close(() => {
        db.pool.end().then(() => {
            console.log('[api] DB pool closed, bye.');
            process.exit(0);
        });
    });
    setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
