-- ============================================================
--  Migration 11: ตัดระบบพื้นที่ (จังหวัด/อำเภอ/ตำบล) ออก → ใช้พิกัดแผนที่แทน
--  Created: 2026-07-21
--
--  เหตุผล: ทิศทางใหม่คือ "แผนที่คือหน้าแรก" (docs/01, docs/04)
--          ช่างปักหมุดเอง ไม่ต้องเลือก dropdown 3 ชั้น
--          + เปิดบริการทั้งประเทศ (เลิกแนวคิดเปิดทีละจังหวัด)
--
--  ⚠️ migration นี้ลบข้อมูล 8,459 แถว (77 จังหวัด / 930 อำเภอ / 7,452 ตำบล)
--     ถ้าต้องการกลับ ให้รัน 01_locations_schema.sql + 02_locations_data.sql ใหม่
-- ============================================================

USE chaungthai;

-- ------------------------------------------------------------
--  1) ตัด FK + คอลัมน์พื้นที่ ออกจาก user_chaungthai
--     (index idx_user_* หายอัตโนมัติเมื่อ drop คอลัมน์)
--     user_address (free text) เก็บไว้ — ใช้เป็นที่อยู่เต็มของคู่งานที่จับคู่แล้ว
-- ------------------------------------------------------------
ALTER TABLE user_chaungthai
  DROP FOREIGN KEY fk_user_province,
  DROP FOREIGN KEY fk_user_district,
  DROP FOREIGN KEY fk_user_subdistrict;

ALTER TABLE user_chaungthai
  DROP COLUMN user_province_id,
  DROP COLUMN user_district_id,
  DROP COLUMN user_subdistrict_id,
  ADD COLUMN user_lat DECIMAL(10,7) DEFAULT NULL
    COMMENT 'ละติจูดที่อยู่ผู้ใช้ — ใช้เปิดแผนที่ที่ตำแหน่งตัวเอง (NULL = ยังไม่ปักหมุด)'
    AFTER user_address,
  ADD COLUMN user_lng DECIMAL(10,7) DEFAULT NULL
    COMMENT 'ลองจิจูดที่อยู่ผู้ใช้'
    AFTER user_lat;

-- ------------------------------------------------------------
--  2) ทิ้งตารางพื้นที่ทั้ง 3 ระดับ
--     (ลบลูกก่อนพ่อ: subdistrict → district → province)
-- ------------------------------------------------------------
DROP TABLE IF EXISTS location_subdistrict_chaungthai;
DROP TABLE IF EXISTS location_district_chaungthai;
DROP TABLE IF EXISTS location_province_chaungthai;

-- ------------------------------------------------------------
--  3) ช่าง = หมุดบนแผนที่
--     - lat/lng    : จุดที่ช่างรับงาน (ปักหมุดเอง)
--     - radius_km  : รัศมีที่ยอมเดินทาง
--     - availability: busy = กำลังรับงานอยู่ → หายจากแผนที่ (docs/04 ข้อ 4.5)
-- ------------------------------------------------------------
ALTER TABLE worker_chaungthai
  ADD COLUMN worker_lat DECIMAL(10,7) DEFAULT NULL
    COMMENT 'ละติจูดจุดรับงานของช่าง (NULL = ยังไม่ปักหมุด → ไม่ขึ้นแผนที่)'
    AFTER worker_user_id,
  ADD COLUMN worker_lng DECIMAL(10,7) DEFAULT NULL
    COMMENT 'ลองจิจูดจุดรับงานของช่าง'
    AFTER worker_lat,
  ADD COLUMN worker_service_radius_km SMALLINT UNSIGNED NOT NULL DEFAULT 10
    COMMENT 'รัศมีที่ยอมเดินทางไปทำงาน (กม.)'
    AFTER worker_lng,
  ADD COLUMN worker_availability ENUM('free','busy') NOT NULL DEFAULT 'free'
    COMMENT 'free=ว่างรับงาน (โชว์บนแผนที่) / busy=ติดงานอยู่ (ซ่อนจากแผนที่)'
    AFTER worker_service_radius_km,
  ADD INDEX idx_worker_geo (worker_lat, worker_lng)
    COMMENT 'ค้นหาช่างในกรอบแผนที่ (bounding box)',
  ADD INDEX idx_worker_avail (worker_availability);
