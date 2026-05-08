require('dotenv').config();

function required(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env var: ${name}`);
    return v;
}

const config = {
    env:  process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3001', 10),

    corsOrigins: (process.env.CORS_ORIGINS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),

    db: {
        host: required('DB_HOST'),
        port: parseInt(process.env.DB_PORT || '3306', 10),
        user: required('DB_USER'),
        password: required('DB_PASSWORD'),
        database: required('DB_NAME'),
        connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10),
    },

    jwt: {
        accessSecret:  required('JWT_ACCESS_SECRET'),
        refreshSecret: required('JWT_REFRESH_SECRET'),
        accessTTL:     process.env.JWT_ACCESS_TTL || '15m',
        refreshTTLDays: parseInt(process.env.JWT_REFRESH_TTL_DAYS || '30', 10),
    },

    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),

    // ── Email (SMTP) ───────────────────────────────────────────────────────
    // ถ้าไม่ตั้ง SMTP_HOST → dev mode (Ethereal + log to console)
    smtp: {
        host: process.env.SMTP_HOST || '',
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || '',
        from: process.env.SMTP_FROM || '"ChaungThai" <noreply@chaungthai.co.th>',
    },

    // ── SMS ────────────────────────────────────────────────────────────────
    // ถ้าไม่ตั้ง SMS_PROVIDER → dev mode (log to console เท่านั้น)
    sms: {
        provider:   process.env.SMS_PROVIDER || '',     // 'twilio' | 'thaibulksms' | ''
        accountSid: process.env.SMS_ACCOUNT_SID || '',  // Twilio
        authToken:  process.env.SMS_AUTH_TOKEN  || '',  // Twilio
        from:       process.env.SMS_FROM        || '',  // Twilio
        key:        process.env.SMS_KEY         || '',  // Thaibulksms
        secret:     process.env.SMS_SECRET      || '',  // Thaibulksms
    },

    // ── Upload ─────────────────────────────────────────────────────────────
    upload: {
        // URL prefix ที่ client ใช้เข้าถึงไฟล์
        // Dev  : http://localhost:<port>/uploads
        // Prod : ใส่ CDN URL เช่น https://cdn.chaungthai.co.th
        baseUrl: process.env.UPLOAD_BASE_URL || '',
    },
};

module.exports = config;
