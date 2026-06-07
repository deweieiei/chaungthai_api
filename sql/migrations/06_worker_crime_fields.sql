-- ============================================================
--  Migration 06: เพิ่ม field รูปประวัติอาชญากรรม + สถานะการตรวจสอบ
--  Date: 2026-06-07
-- ============================================================
--  เพิ่ม 2 field ใน worker_chaungthai:
--    worker_crime_document_url   : path/URL ของไฟล์ที่อัพโหลด
--    worker_crime_check_status   : 'pending' | 'approved' | 'rejected'
--                                  NULL = ยังไม่ได้ยื่นเอกสาร
--
--  Flow ใหม่:
--    1. ช่างอัพโหลด → status='pending', checked_at=NOW(), document_url=path
--    2. เจ้าหน้าที่ตรวจ → status='approved' (ผ่าน) / 'rejected' (ไม่ผ่าน)
--
--  Rollback:
--    ALTER TABLE worker_chaungthai
--      DROP COLUMN worker_crime_document_url,
--      DROP COLUMN worker_crime_check_status;
-- ============================================================

ALTER TABLE worker_chaungthai
  ADD COLUMN worker_crime_document_url VARCHAR(500) NULL
    COMMENT 'URL/path ของไฟล์ประวัติอาชญากรรมที่อัพโหลด'
    AFTER worker_crime_checked_at,
  ADD COLUMN worker_crime_check_status ENUM('pending','approved','rejected') NULL DEFAULT NULL
    COMMENT 'สถานะการตรวจสอบ: pending=รอเจ้าหน้าที่, approved=ผ่าน, rejected=ไม่ผ่าน'
    AFTER worker_crime_document_url;

-- ตรวจสอบผล (run แยก ถ้าอยากเช็ค):
-- DESCRIBE worker_chaungthai;
