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
  conv_id              INT UNSIGNED    NOT NULL AUTO_INCREMENT
    COMMENT 'รหัสห้องแชต (PK, auto-increment) — ใช้อ้างถึงห้องในทุก endpoint',

  conv_user1_id        INT UNSIGNED    NOT NULL
    COMMENT 'user_id ของคู่สนทนาคนที่ 1 (ค่าเล็กกว่าเสมอ) — บังคับเรียงเพื่อทำ unique pair ป้องกันห้องซ้ำเมื่อสลับฝั่ง',

  conv_user2_id        INT UNSIGNED    NOT NULL
    COMMENT 'user_id ของคู่สนทนาคนที่ 2 (ค่ามากกว่าเสมอ) — เห็นคู่กับ conv_user1_id ใน UNIQUE (conv_user1_id, conv_user2_id)',

  conv_last_message_id BIGINT UNSIGNED NULL
    COMMENT 'msg_id ของข้อความล่าสุดในห้องนี้ (denormalize เพื่อ inbox โหลดเร็ว) — NULL = ห้องยังว่าง ไม่มีข้อความ',

  conv_last_message_at DATETIME        NULL
    COMMENT 'เวลาที่ข้อความล่าสุดถูกส่ง — ใช้ ORDER BY สำหรับเรียง inbox (ห้องที่คุยล่าสุดอยู่บนสุด)',

  conv_created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
    COMMENT 'เวลาที่สร้างห้องนี้ครั้งแรก (ตอนที่ผู้ใช้สองคนเริ่มแชตกันครั้งแรก)',

  PRIMARY KEY (conv_id),
  UNIQUE KEY uniq_conv_pair (conv_user1_id, conv_user2_id)
    COMMENT 'กันไม่ให้มีห้องซ้ำระหว่างผู้ใช้คู่เดียวกัน (เพราะ user1<user2 บังคับเรียง)',
  KEY idx_conv_u1_recent (conv_user1_id, conv_last_message_at DESC)
    COMMENT 'เร่ง query inbox ของ user1 — เรียงตามข้อความล่าสุดได้เลย',
  KEY idx_conv_u2_recent (conv_user2_id, conv_last_message_at DESC)
    COMMENT 'เร่ง query inbox ของ user2 (กรณีเป็นคู่สนทนาที่ user_id ใหญ่กว่า)',

  CONSTRAINT fk_conv_u1 FOREIGN KEY (conv_user1_id)
    REFERENCES user_chaungthai (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_conv_u2 FOREIGN KEY (conv_user2_id)
    REFERENCES user_chaungthai (user_id) ON DELETE CASCADE,
  CONSTRAINT chk_conv_user_order CHECK (conv_user1_id < conv_user2_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='ห้องแชต 1-on-1 ระหว่างผู้ใช้สองคน (no group chat)';

-- ============================================================
--  message_chaungthai - ข้อความในแชต
-- ============================================================
CREATE TABLE message_chaungthai (
  msg_id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT
    COMMENT 'รหัสข้อความ (PK, BIGINT เพราะมีโอกาสเยอะมาก) — ใช้เป็น cursor pagination ด้วย',

  msg_conv_id    INT UNSIGNED    NOT NULL
    COMMENT 'อ้างถึง conv_id ใน conversation_chaungthai — ข้อความนี้อยู่ในห้องไหน',

  msg_sender_id  INT UNSIGNED    NOT NULL
    COMMENT 'user_id ของคนที่ส่งข้อความ (ต้องเป็น user1 หรือ user2 ของห้องนั้น) — application ตรวจเอง',

  msg_content    TEXT            NOT NULL
    COMMENT 'เนื้อหาข้อความ: text=ตัวอักษร (สูงสุด 4000), image=URL/path ของรูป, system=ข้อความระบบ',

  msg_type       ENUM('text','image','system') NOT NULL DEFAULT 'text'
    COMMENT 'ชนิดข้อความ — text: ข้อความปกติ, image: รูปภาพ (msg_content เป็น URL), system: ข้อความระบบ (เช่น แจ้งเตือน)',

  msg_read_at    DATETIME        NULL
    COMMENT 'ฝั่งตรงข้ามอ่านข้อความนี้เมื่อไหร่ — NULL = ยังไม่อ่าน, มีค่า = อ่านแล้วตอนนั้น (ใช้แสดง ✓✓ และนับ unread)',

  msg_created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
    COMMENT 'เวลาที่ส่งข้อความ — ใช้ ORDER BY ในการโหลดประวัติ และแสดงเวลาในห้องแชต',

  PRIMARY KEY (msg_id),
  KEY idx_msg_conv_time   (msg_conv_id, msg_id DESC)
    COMMENT 'เร่งโหลดข้อความล่าสุดของห้อง (LIMIT N) — ใช้สำหรับ cursor pagination (msg_id < before_id)',
  KEY idx_msg_unread      (msg_conv_id, msg_sender_id, msg_read_at)
    COMMENT 'เร่งการนับ unread (msg_read_at IS NULL AND msg_sender_id <> me)',

  CONSTRAINT fk_msg_conv FOREIGN KEY (msg_conv_id)
    REFERENCES conversation_chaungthai (conv_id) ON DELETE CASCADE,
  CONSTRAINT fk_msg_sender FOREIGN KEY (msg_sender_id)
    REFERENCES user_chaungthai (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='ข้อความในห้องแชต — ทุกข้อความผูกกับ conv_id หนึ่งห้อง';

-- ตรวจสอบ:
-- SHOW FULL COLUMNS FROM conversation_chaungthai;
-- SHOW FULL COLUMNS FROM message_chaungthai;
