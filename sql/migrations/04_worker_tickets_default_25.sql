-- ============================================================
--  Migration 04: เปลี่ยน worker_job_tickets default = 25
--  Created: 2026-06-04
--
--  Rule: ช่างที่สมัครใหม่จะได้ตั๋วรับงานเริ่มต้น 25 ใบ
--  (ของเดิม default=0 - แต่ user เก่าจะไม่ถูกเปลี่ยนค่าที่มีอยู่)
-- ============================================================

USE chaungthai;

ALTER TABLE worker_chaungthai
  MODIFY COLUMN worker_job_tickets INT UNSIGNED NOT NULL DEFAULT 25
    COMMENT 'จำนวนบัตรรับงานคงเหลือ (default 25 ใบตอนสมัครใหม่)';
