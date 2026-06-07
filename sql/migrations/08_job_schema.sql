-- ============================================================
--  Migration 08: ระบบจ้างงาน (Job)
--  Date: 2026-06-07
--
--  สร้างตาราง job_chaungthai — ผู้ว่าจ้างจ้างช่างทำงาน 1 งาน
--
--  State machine:
--    pending → not_started → in_progress → completed
--                              ↘ cancelled (จากทุก state ก่อน completed)
--           ↘ declined (ช่างปฏิเสธ)
--
--  ตอนช่างกด "รับงาน" (pending → not_started):
--    - หัก worker_job_tickets 1 ใบ (atomic ใน transaction)
--    - ถ้าเหลือ 0 ใบ → block
--    - ยกเลิกหลังรับแล้ว → ไม่คืนบัตร (กัน abuse)
--
--  Rollback:
--    DROP TABLE IF EXISTS job_chaungthai;
-- ============================================================

USE chaungthai;

DROP TABLE IF EXISTS job_chaungthai;

CREATE TABLE job_chaungthai (
  job_id            INT UNSIGNED NOT NULL AUTO_INCREMENT
    COMMENT 'รหัสงาน (PK, auto-increment)',

  job_employer_id   INT UNSIGNED NOT NULL
    COMMENT 'user_id ของผู้ว่าจ้าง (คนที่กดปุ่ม "จ้างงาน")',

  job_worker_id     INT UNSIGNED NOT NULL
    COMMENT 'user_id ของช่างที่ถูกจ้าง (ต้องมี row ใน worker_chaungthai)',

  job_conv_id       INT UNSIGNED NULL
    COMMENT 'อ้างถึงห้องแชต (conversation_chaungthai.conv_id) ที่เกิดการจ้าง — NULL = จ้างจากหน้าโปรไฟล์โดยตรง',

  job_detail        TEXT NOT NULL
    COMMENT 'รายละเอียดงาน (free text) — เช่น "ทาสีห้องนั่งเล่น 4x5 เมตร สีขาวด้าน"',

  job_price         DECIMAL(10,2) NOT NULL
    COMMENT 'ราคาที่ตกลงกัน (บาท) — ใช้ DECIMAL กัน floating point error, สูงสุด 99,999,999.99',

  job_start_date    DATE NOT NULL
    COMMENT 'วันที่กำหนดเริ่มงาน',

  job_deadline      DATE NOT NULL
    COMMENT 'วันที่ต้องเสร็จ (deadline) — บังคับ >= job_start_date',

  job_status        ENUM('pending','not_started','in_progress','completed','declined','cancelled')
                    NOT NULL DEFAULT 'pending'
    COMMENT 'pending=รอช่างตอบ, not_started=ช่างรับแล้วยังไม่เริ่ม, in_progress=ระหว่างดำเนินงาน, completed=เสร็จ, declined=ช่างปฏิเสธ, cancelled=ยกเลิก',

  job_responded_at  DATETIME NULL
    COMMENT 'เวลาที่ช่างตอบรับครั้งแรก (กด accept/decline) — ไว้คำนวณ response time',

  job_started_at    DATETIME NULL
    COMMENT 'เวลาที่ช่างกด "ระหว่างดำเนินงาน" (เริ่มทำจริง)',

  job_completed_at  DATETIME NULL
    COMMENT 'เวลาที่งานเสร็จ (status=completed)',

  job_cancelled_at  DATETIME NULL
    COMMENT 'เวลาที่ยกเลิก (status=cancelled หรือ declined)',

  job_cancelled_by  INT UNSIGNED NULL
    COMMENT 'user_id ของคนที่ยกเลิก (employer หรือ worker) — NULL ถ้าไม่ใช่ cancelled/declined',

  job_created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    COMMENT 'เวลาที่สร้างงาน (ผู้จ้างกดปุ่มจ้าง)',

  job_updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    COMMENT 'อัปเดตอัตโนมัติทุกครั้งที่มีการเปลี่ยน status',

  PRIMARY KEY (job_id),
  KEY idx_job_worker_status (job_worker_id, job_status, job_created_at DESC)
    COMMENT 'เร่ง query "งานที่ฉัน(ช่าง)รับ" + filter ตาม status',
  KEY idx_job_employer_status (job_employer_id, job_status, job_created_at DESC)
    COMMENT 'เร่ง query "งานที่ฉัน(ลูกค้า)จ้าง"',
  KEY idx_job_conv (job_conv_id)
    COMMENT 'หา job ที่ผูกกับห้องแชต (เผื่อแสดง list ในห้องแชต)',

  CONSTRAINT fk_job_employer FOREIGN KEY (job_employer_id)
    REFERENCES user_chaungthai(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_job_worker FOREIGN KEY (job_worker_id)
    REFERENCES user_chaungthai(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_job_conv FOREIGN KEY (job_conv_id)
    REFERENCES conversation_chaungthai(conv_id) ON DELETE SET NULL,

  CONSTRAINT chk_job_dates CHECK (job_deadline >= job_start_date),
  CONSTRAINT chk_job_price CHECK (job_price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='ระบบจ้างงาน 1-on-1 — ผู้ว่าจ้างจ้างช่างทำงาน 1 งาน';

-- ตรวจสอบ:
-- SHOW FULL COLUMNS FROM job_chaungthai;
