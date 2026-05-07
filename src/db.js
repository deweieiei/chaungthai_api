const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
    host:            config.db.host,
    port:            config.db.port,
    user:            config.db.user,
    password:        config.db.password,
    database:        config.db.database,
    connectionLimit: config.db.connectionLimit,
    waitForConnections: true,
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: '+07:00',
    dateStrings: false,
    namedPlaceholders: true,
});

async function query(sql, params) {
    const [rows] = await pool.execute(sql, params);
    return rows;
}

async function queryOne(sql, params) {
    const rows = await query(sql, params);
    return rows[0] || null;
}

async function withTransaction(fn) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const result = await fn(conn);
        await conn.commit();
        return result;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

module.exports = { pool, query, queryOne, withTransaction };
