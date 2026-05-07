const mysql = require('mysql2/promise');

async function run() {
  const conn = await mysql.createConnection({
    host: '110.171.128.44', port: 3306,
    user: 'dew_server1', password: 'Dew@1234', database: 'chaungthai'
  });

  await conn.query(`
    CREATE TABLE IF NOT EXISTS device_tokens (
      id           BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
      user_id      BIGINT UNSIGNED  NOT NULL,
      token        VARCHAR(255)     NOT NULL                      COMMENT 'FCM/APNs/Web push token',
      platform     ENUM('fcm','apns','web') NOT NULL DEFAULT 'fcm',
      device_name  VARCHAR(100)                                   COMMENT 'ชื่ออุปกรณ์ เช่น iPhone 15, Samsung S24',
      is_active    TINYINT(1)       NOT NULL DEFAULT 1,
      created_at   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_user_token (user_id, token),
      INDEX idx_user (user_id),
      CONSTRAINT fk_dt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('✓ device_tokens table ready');

  // Add job_views table for tracking
  await conn.query(`
    CREATE TABLE IF NOT EXISTS job_views (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      job_id     BIGINT UNSIGNED NOT NULL,
      user_id    BIGINT UNSIGNED,
      ip         VARCHAR(45),
      viewed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_job (job_id),
      CONSTRAINT fk_jv_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  console.log('✓ job_views table ready');

  await conn.end();
  console.log('Done.');
}
run().catch(e => { console.error('Error:', e.message); process.exit(1); });
