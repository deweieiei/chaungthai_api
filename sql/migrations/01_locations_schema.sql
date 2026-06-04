-- ============================================================
--  Migration 01: Locations master tables
--  Created: 2026-06-04
--
--  3 ตาราง: province / district / subdistrict
--  ใช้ ID มาตรฐานไทย:
--    province_id  = 1-99   (1=กทม, 2=สมุทรปราการ, ...)
--    district_id  = 4 หลัก (1001=เขตพระนคร, ...)
--    subdistrict_id = 6 หลัก (100101=พระบรมมหาราชวัง, ...)
-- ============================================================

USE chaungthai;

DROP TABLE IF EXISTS location_subdistrict_chaungthai;
DROP TABLE IF EXISTS location_district_chaungthai;
DROP TABLE IF EXISTS location_province_chaungthai;

-- ------------------------------------------------------------
--  province (77 records)
-- ------------------------------------------------------------
CREATE TABLE location_province_chaungthai (
  province_id        INT UNSIGNED NOT NULL,
  province_name_th   VARCHAR(150) NOT NULL,
  province_name_en   VARCHAR(150) DEFAULT NULL,
  PRIMARY KEY (province_id),
  KEY idx_province_name_th (province_name_th)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='จังหวัด';

-- ------------------------------------------------------------
--  district (~930 records)
-- ------------------------------------------------------------
CREATE TABLE location_district_chaungthai (
  district_id            INT UNSIGNED NOT NULL,
  district_province_id   INT UNSIGNED NOT NULL,
  district_name_th       VARCHAR(150) NOT NULL,
  district_name_en       VARCHAR(150) DEFAULT NULL,
  PRIMARY KEY (district_id),
  KEY idx_district_province (district_province_id),
  KEY idx_district_name_th (district_name_th),
  CONSTRAINT fk_district_province
    FOREIGN KEY (district_province_id)
    REFERENCES location_province_chaungthai (province_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='อำเภอ';

-- ------------------------------------------------------------
--  subdistrict (~7,452 records)
-- ------------------------------------------------------------
CREATE TABLE location_subdistrict_chaungthai (
  subdistrict_id           INT UNSIGNED NOT NULL,
  subdistrict_district_id  INT UNSIGNED NOT NULL,
  subdistrict_name_th      VARCHAR(150) NOT NULL,
  subdistrict_name_en      VARCHAR(150) DEFAULT NULL,
  subdistrict_zip_code     INT UNSIGNED DEFAULT NULL,
  PRIMARY KEY (subdistrict_id),
  KEY idx_subdistrict_district (subdistrict_district_id),
  KEY idx_subdistrict_zip (subdistrict_zip_code),
  KEY idx_subdistrict_name_th (subdistrict_name_th),
  CONSTRAINT fk_subdistrict_district
    FOREIGN KEY (subdistrict_district_id)
    REFERENCES location_district_chaungthai (district_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='ตำบล';
