-- ============================================================
--  Migration 03: ALTER user_chaungthai เพิ่ม FK location 3 ระดับ
--  Created: 2026-06-04
--  Run AFTER 01_locations_schema.sql + 02_locations_data.sql
-- ============================================================

USE chaungthai;

ALTER TABLE user_chaungthai
  ADD COLUMN user_province_id    INT UNSIGNED DEFAULT NULL COMMENT 'จังหวัด (FK)' AFTER user_address,
  ADD COLUMN user_district_id    INT UNSIGNED DEFAULT NULL COMMENT 'อำเภอ (FK)' AFTER user_province_id,
  ADD COLUMN user_subdistrict_id INT UNSIGNED DEFAULT NULL COMMENT 'ตำบล (FK)' AFTER user_district_id,
  ADD INDEX idx_user_province (user_province_id),
  ADD INDEX idx_user_district (user_district_id),
  ADD INDEX idx_user_subdistrict (user_subdistrict_id),
  ADD CONSTRAINT fk_user_province
    FOREIGN KEY (user_province_id) REFERENCES location_province_chaungthai (province_id)
    ON DELETE SET NULL,
  ADD CONSTRAINT fk_user_district
    FOREIGN KEY (user_district_id) REFERENCES location_district_chaungthai (district_id)
    ON DELETE SET NULL,
  ADD CONSTRAINT fk_user_subdistrict
    FOREIGN KEY (user_subdistrict_id) REFERENCES location_subdistrict_chaungthai (subdistrict_id)
    ON DELETE SET NULL;
