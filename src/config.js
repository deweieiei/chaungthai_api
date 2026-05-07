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
};

module.exports = config;
