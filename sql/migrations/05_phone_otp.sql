-- ============================================================
--  Migration 05: phone_otp_chaungthai
--  Created: 2026-06-05
--  เก็บ OTP 6 หลัก สำหรับยืนยันเบอร์โทร
-- ============================================================

USE chaungthai;

DROP TABLE IF EXISTS phone_otp_chaungthai;

CREATE TABLE phone_otp_chaungthai (
  otp_id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  otp_user_id     INT UNSIGNED NOT NULL,
  otp_phone       VARCHAR(20)  NOT NULL COMMENT 'เบอร์โทรที่ขอ OTP',
  otp_code        CHAR(6)      NOT NULL COMMENT '6 digit',
  otp_expires_at  TIMESTAMP    NOT NULL COMMENT 'หมดอายุเมื่อ',
  otp_used_at     TIMESTAMP    NULL DEFAULT NULL COMMENT 'ใช้แล้วเมื่อ (NULL = ยังไม่ใช้)',
  otp_created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (otp_id),
  KEY idx_otp_user (otp_user_id),
  KEY idx_otp_lookup (otp_user_id, otp_code, otp_used_at),
  KEY idx_otp_expires (otp_expires_at),
  CONSTRAINT fk_otp_user FOREIGN KEY (otp_user_id)
    REFERENCES user_chaungthai (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='OTP ยืนยันเบอร์โทร';
