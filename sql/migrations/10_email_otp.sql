-- ============================================================
--  Migration 10: email_otp_chaungthai
--  Date: 2026-06-07
--
--  เก็บ OTP 6 หลัก สำหรับยืนยันอีเมล (เลียนแบบ phone_otp_chaungthai)
--  ใช้แทน flow JWT link เดิม
--
--  Rollback:
--    DROP TABLE IF EXISTS email_otp_chaungthai;
-- ============================================================

USE chaungthai;

DROP TABLE IF EXISTS email_otp_chaungthai;

CREATE TABLE email_otp_chaungthai (
  otp_id          INT UNSIGNED NOT NULL AUTO_INCREMENT
    COMMENT 'รหัส OTP record (PK)',
  otp_user_id     INT UNSIGNED NOT NULL
    COMMENT 'user_id ของผู้ขอ OTP',
  otp_email       VARCHAR(255) NOT NULL
    COMMENT 'อีเมลที่ขอ OTP (snapshot — เผื่อ user เปลี่ยน email หลังกด)',
  otp_code        CHAR(6) NOT NULL
    COMMENT 'รหัส OTP 6 หลัก (string เพื่อเก็บเลข 0 นำ)',
  otp_expires_at  TIMESTAMP NOT NULL
    COMMENT 'หมดอายุเมื่อ (gen + 5 นาที)',
  otp_used_at     TIMESTAMP NULL DEFAULT NULL
    COMMENT 'ใช้แล้วเมื่อ (NULL = ยังไม่ใช้)',
  otp_created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    COMMENT 'เวลาที่ขอ OTP (ใช้ตรวจ rate-limit 60 วินาที)',

  PRIMARY KEY (otp_id),
  KEY idx_otp_user (otp_user_id),
  KEY idx_otp_lookup (otp_user_id, otp_code, otp_used_at)
    COMMENT 'เร่ง verify: หา OTP ของ user + code + ยังไม่ใช้',
  KEY idx_otp_expires (otp_expires_at)
    COMMENT 'สำหรับ cleanup OTP ที่หมดอายุในอนาคต',

  CONSTRAINT fk_email_otp_user FOREIGN KEY (otp_user_id)
    REFERENCES user_chaungthai (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='OTP ยืนยันอีเมล (6 หลัก, exp 5 นาที, rate-limit 60s)';

-- ตรวจสอบ:
-- SHOW FULL COLUMNS FROM email_otp_chaungthai;
