-- ============================================================
--  Migration 13: index ผสมสำหรับค้นหาช่างบนแผนที่
--  Created: 2026-07-21
--
--  ที่มา: ทดสอบด้วยช่างปลอม 1,000,000 คนทั่วประเทศแล้วพบว่า
--  query แผนที่กรองด้วย availability + กรอบ lat/lng พร้อมกันเสมอ
--  แต่ index เดิมแยกกันอยู่ (idx_worker_geo กับ idx_worker_avail)
--  MySQL เลือกได้ทีละอัน → อ่านแถวทิ้งเยอะ
--
--  index นี้เรียง availability ก่อน (ค่าเท่ากันเป๊ะ) แล้วตามด้วยพิกัด
--  ทำให้กรองช่างที่ว่างในกรอบแผนที่ได้จาก index ตรง ๆ
-- ============================================================

USE chaungthai;

ALTER TABLE worker_chaungthai
  ADD INDEX idx_worker_avail_geo (worker_availability, worker_lat, worker_lng)
    COMMENT 'ค้นช่างว่างในกรอบแผนที่ — ใช้โดย GET /api/workers/search';
