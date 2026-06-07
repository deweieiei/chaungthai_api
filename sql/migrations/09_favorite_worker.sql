-- ============================================================
--  Migration 09: ระบบติดดาวช่าง (favorite worker)
--  Date: 2026-06-07
--
--  ตาราง favorite_worker_chaungthai
--    ผู้ใช้คนนึงสามารถติดดาวช่างได้หลายคน
--    UNIQUE (user, worker) — กดดาวซ้ำไม่ได้
--    CASCADE ลบทั้งฝั่ง user และ worker
--
--  Rollback:
--    DROP TABLE IF EXISTS favorite_worker_chaungthai;
-- ============================================================

USE chaungthai;

DROP TABLE IF EXISTS favorite_worker_chaungthai;

CREATE TABLE favorite_worker_chaungthai (
  fav_id          INT UNSIGNED NOT NULL AUTO_INCREMENT
    COMMENT 'รหัสรายการติดดาว (PK)',

  fav_user_id     INT UNSIGNED NOT NULL
    COMMENT 'user_id ของคนที่กดดาว (เจ้าของรายการ)',

  fav_worker_id   INT UNSIGNED NOT NULL
    COMMENT 'worker_id ของช่างที่ถูกติดดาว — อ้างถึง worker_chaungthai.worker_id',

  fav_created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    COMMENT 'เวลาที่กดดาว — ใช้เรียงล่าสุดก่อนใน list',

  PRIMARY KEY (fav_id),
  UNIQUE KEY uniq_fav (fav_user_id, fav_worker_id)
    COMMENT 'กันกดดาวคนเดิมซ้ำ — INSERT ซ้ำจะ ER_DUP_ENTRY ให้ application handle',
  KEY idx_fav_user_recent (fav_user_id, fav_created_at DESC)
    COMMENT 'เร่ง query "รายการดาวของฉัน" เรียงล่าสุดก่อน',

  CONSTRAINT fk_fav_user FOREIGN KEY (fav_user_id)
    REFERENCES user_chaungthai (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_fav_worker FOREIGN KEY (fav_worker_id)
    REFERENCES worker_chaungthai (worker_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='ช่างที่ผู้ใช้ติดดาวไว้ — ดูได้เร็วโดยไม่ต้องค้นหา';

-- ตรวจสอบ:
-- SHOW FULL COLUMNS FROM favorite_worker_chaungthai;
