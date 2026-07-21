-- ============================================================
--  Migration 14: เวลาทำงานของช่าง (จันทร์-อาทิตย์ + ช่วงเวลา)
--  Created: 2026-07-21
--
--  ช่างบอกได้ว่ารับงานวันไหน เวลาไหนบ้าง
--  1 วัน = 1 แถว (UNIQUE worker+day) → วันไหนไม่มีแถว = วันนั้นไม่รับงาน
--
--  เก็บเป็น TIME ไม่ใช่ DATETIME เพราะเป็นตารางประจำสัปดาห์ ไม่ผูกกับวันที่
--  sched_day: 0=อาทิตย์ ... 6=เสาร์ (ตรงกับ JS Date.getDay() จะได้ไม่ต้องแปลง)
-- ============================================================

USE chaungthai;

CREATE TABLE IF NOT EXISTS worker_schedule_chaungthai (
  sched_id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  sched_worker_id INT UNSIGNED NOT NULL COMMENT 'FK → worker_chaungthai',
  sched_day       TINYINT UNSIGNED NOT NULL
    COMMENT 'วันในสัปดาห์: 0=อาทิตย์ 1=จันทร์ ... 6=เสาร์ (ตรงกับ JS getDay())',
  sched_start     TIME NOT NULL COMMENT 'เวลาเริ่มรับงานของวันนั้น',
  sched_end       TIME NOT NULL COMMENT 'เวลาเลิกรับงานของวันนั้น (ต้องมากกว่า start)',
  sched_created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sched_updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (sched_id),
  UNIQUE KEY uniq_worker_day (sched_worker_id, sched_day)
    COMMENT 'วันละ 1 ช่วงเวลา — กันข้อมูลซ้ำวันเดียวกัน',
  CONSTRAINT fk_sched_worker
    FOREIGN KEY (sched_worker_id) REFERENCES worker_chaungthai (worker_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='เวลาทำงานประจำสัปดาห์ของช่าง';
