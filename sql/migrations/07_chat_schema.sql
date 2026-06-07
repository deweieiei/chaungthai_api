-- ============================================================
--  Migration 07: ระบบแชต 1-on-1
--  Date: 2026-06-07
--
--  สร้าง 2 ตาราง:
--    conversation_chaungthai - ห้องแชตระหว่าง 2 user (unique pair)
--    message_chaungthai      - ข้อความใน conversation
--
--  Design notes:
--    - conv_user1_id < conv_user2_id เสมอ (สลับฝั่งจะกลายเป็นห้องเดียวกัน)
--    - conv_last_message_id + conv_last_message_at = denormalize เพื่อ inbox query เร็ว
--    - msg_read_at = NULL → ยังไม่อ่าน, มีค่า → ฝั่งตรงข้ามอ่านเมื่อไหร่
--    - ไม่มี FK conv_last_message_id → message เพราะ circular dep ทำให้ DROP ยุ่ง
--      (application ดูแลให้ id ใน conv ชี้ไป msg ที่มีอยู่จริง — และ msg ถูก CASCADE DELETE
--       ตาม conv อยู่แล้ว)
--
--  Rollback:
--    DROP TABLE IF EXISTS message_chaungthai;
--    DROP TABLE IF EXISTS conversation_chaungthai;
-- ============================================================

USE chaungthai;

DROP TABLE IF EXISTS message_chaungthai;
DROP TABLE IF EXISTS conversation_chaungthai;

-- ============================================================
--  conversation_chaungthai - ห้องแชต 1-on-1
-- ============================================================
CREATE TABLE conversation_chaungthai (
  conv_id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  conv_user1_id        INT UNSIGNED    NOT NULL COMMENT 'user_id ที่เล็กกว่า (ใช้ทำ unique pair)',
  conv_user2_id        INT UNSIGNED    NOT NULL COMMENT 'user_id ที่ใหญ่กว่า',
  conv_last_message_id BIGINT UNSIGNED NULL     COMMENT 'msg_id ของข้อความล่าสุด (denormalize)',
  conv_last_message_at DATETIME        NULL     COMMENT 'เวลาข้อความล่าสุด (ใช้ sort inbox)',
  conv_created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (conv_id),
  UNIQUE KEY uniq_conv_pair (conv_user1_id, conv_user2_id),
  KEY idx_conv_u1_recent (conv_user1_id, conv_last_message_at DESC),
  KEY idx_conv_u2_recent (conv_user2_id, conv_last_message_at DESC),

  CONSTRAINT fk_conv_u1 FOREIGN KEY (conv_user1_id)
    REFERENCES user_chaungthai (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_conv_u2 FOREIGN KEY (conv_user2_id)
    REFERENCES user_chaungthai (user_id) ON DELETE CASCADE,
  CONSTRAINT chk_conv_user_order CHECK (conv_user1_id < conv_user2_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='ห้องแชต 1-on-1';

-- ============================================================
--  message_chaungthai - ข้อความในแชต
-- ============================================================
CREATE TABLE message_chaungthai (
  msg_id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  msg_conv_id    INT UNSIGNED    NOT NULL,
  msg_sender_id  INT UNSIGNED    NOT NULL,
  msg_content    TEXT            NOT NULL,
  msg_type       ENUM('text','image','system') NOT NULL DEFAULT 'text',
  msg_read_at    DATETIME        NULL     COMMENT 'ฝั่งตรงข้ามอ่านเมื่อไหร่ (NULL = ยังไม่อ่าน)',
  msg_created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (msg_id),
  KEY idx_msg_conv_time   (msg_conv_id, msg_id DESC),
  KEY idx_msg_unread      (msg_conv_id, msg_sender_id, msg_read_at),

  CONSTRAINT fk_msg_conv FOREIGN KEY (msg_conv_id)
    REFERENCES conversation_chaungthai (conv_id) ON DELETE CASCADE,
  CONSTRAINT fk_msg_sender FOREIGN KEY (msg_sender_id)
    REFERENCES user_chaungthai (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='ข้อความในแชต';

-- ตรวจสอบ:
-- DESCRIBE conversation_chaungthai;
-- DESCRIBE message_chaungthai;
