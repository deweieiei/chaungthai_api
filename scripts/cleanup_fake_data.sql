-- ============================================================
--  Cleanup Fake Data
--  ลบ user/worker/skills ที่สร้างจาก seed scripts
--  Recognize: email = "fake_*@chaungthai-test.com"
-- ============================================================

USE chaungthai;

SELECT '=== BEFORE ===' AS info;
SELECT
  (SELECT COUNT(*) FROM user_chaungthai WHERE user_email LIKE 'fake_%@chaungthai-test.com') AS fake_users,
  (SELECT COUNT(*) FROM worker_chaungthai WHERE worker_user_id IN
    (SELECT user_id FROM user_chaungthai WHERE user_email LIKE 'fake_%@chaungthai-test.com')) AS fake_workers,
  (SELECT COUNT(*) FROM workerskill_chaungthai WHERE workerskill_worker_id IN
    (SELECT worker_id FROM worker_chaungthai WHERE worker_user_id IN
      (SELECT user_id FROM user_chaungthai WHERE user_email LIKE 'fake_%@chaungthai-test.com'))) AS fake_skills;

SET autocommit = 0;
START TRANSACTION;

-- 1. ลบ workerskill ของ fake workers
DELETE FROM workerskill_chaungthai
 WHERE workerskill_worker_id IN
   (SELECT worker_id FROM worker_chaungthai
    WHERE worker_user_id IN
     (SELECT user_id FROM user_chaungthai
      WHERE user_email LIKE 'fake_%@chaungthai-test.com'));

-- 2. ลบ worker ของ fake users
DELETE FROM worker_chaungthai
 WHERE worker_user_id IN
   (SELECT user_id FROM user_chaungthai
    WHERE user_email LIKE 'fake_%@chaungthai-test.com');

-- 3. ลบ fake users
DELETE FROM user_chaungthai
 WHERE user_email LIKE 'fake_%@chaungthai-test.com';

COMMIT;
SET autocommit = 1;

SELECT '=== AFTER ===' AS info;
SELECT
  (SELECT COUNT(*) FROM user_chaungthai WHERE user_email LIKE 'fake_%@chaungthai-test.com') AS fake_users_remaining,
  (SELECT COUNT(*) FROM user_chaungthai) AS total_users,
  (SELECT COUNT(*) FROM worker_chaungthai) AS total_workers,
  (SELECT COUNT(*) FROM workerskill_chaungthai) AS total_workerskills;
