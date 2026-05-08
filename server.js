const express = require('express');
const path    = require('path');
const cors    = require('cors');
const helmet  = require('helmet');

const config  = require('./src/config');
const db      = require('./src/db');
const errorMw = require('./src/middleware/error');
const ws      = require('./src/ws');

// Routes
const healthRoute        = require('./src/routes/health');
const authRoute          = require('./src/routes/auth');
const usersRoute         = require('./src/routes/users');
const skillsRoute        = require('./src/routes/skills');
const locationsRoute     = require('./src/routes/locations');
const workersRoute       = require('./src/routes/workers');
const jobsRoute          = require('./src/routes/jobs');
const matchesRoute       = require('./src/routes/matches');
const chatRoute          = require('./src/routes/chat');
const ratingsRoute       = require('./src/routes/ratings');
const ticketsRoute       = require('./src/routes/tickets');
const notificationsRoute = require('./src/routes/notifications');
const adminRoute         = require('./src/routes/admin');
const verifyRoute        = require('./src/routes/verify');
const uploadRoute        = require('./src/routes/upload');
const reportsRoute       = require('./src/routes/reports');

const app = express();

// trust X-Forwarded-* when behind a reverse proxy (nginx, etc.)
app.set('trust proxy', 1);

// Security headers (XSS, clickjacking, MIME-sniff, etc.)
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ── Static files: serve uploaded images ─────────────────────────────────
// GET /uploads/<purpose>/<filename>
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads'), {
    maxAge: '7d',
    immutable: false,
}));

// Body parser
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

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
app.use('/api/health',        healthRoute);
app.use('/api/auth',          authRoute);
app.use('/api/users',         usersRoute);
app.use('/api/skills',        skillsRoute);
app.use('/api/locations',     locationsRoute);
app.use('/api/workers',       workersRoute);
app.use('/api/jobs',          jobsRoute);
app.use('/api/matches',       matchesRoute);
app.use('/api/chat',          chatRoute);
app.use('/api/ratings',       ratingsRoute);
app.use('/api/tickets',       ticketsRoute);
app.use('/api/notifications', notificationsRoute);
app.use('/api/admin',         adminRoute);
app.use('/api/verify',        verifyRoute);
app.use('/api/upload',        uploadRoute);
app.use('/api/reports',       reportsRoute);

// 404 + error handlers (must be last)
app.use(errorMw.notFound);
app.use(errorMw.handler);

// Start server
const server = app.listen(config.port, () => {
    console.log(`[api] listening on http://localhost:${config.port} (${config.env})`);
    console.log(`[api] DB: ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
    console.log(`[api] Uploads dir: ${path.join(process.cwd(), 'uploads')}`);
});

// ── WebSocket server (real-time chat + notifications) ────────────────────
// Client เชื่อมต่อผ่าน ws://localhost:<port>/ws?token=<accessToken>
ws.setup(server);

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
