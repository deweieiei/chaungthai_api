-- ChaungThai API — Migration 002: New Features
-- Email/Phone verify, Worker ID verify, File uploads, Reports

-- =========================
-- WORKER VERIFICATIONS (ยืนยันตัวตนช่างด้วยบัตรประชาชน)
-- =========================
CREATE TABLE IF NOT EXISTS worker_verifications (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    worker_id       BIGINT UNSIGNED NOT NULL,
    id_card_front   VARCHAR(500)    NOT NULL,
    id_card_back    VARCHAR(500)    NULL,
    selfie_url      VARCHAR(500)    NULL,
    status          ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    reject_reason   VARCHAR(500)    NULL,
    reviewed_by     BIGINT UNSIGNED NULL,
    reviewed_at     DATETIME        NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_worker (worker_id),
    INDEX idx_status (status),
    CONSTRAINT fk_wv_worker   FOREIGN KEY (worker_id)   REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_wv_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================
-- FILE UPLOADS (track uploaded images/documents)
-- =========================
CREATE TABLE IF NOT EXISTS file_uploads (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id       BIGINT UNSIGNED NOT NULL,
    filename      VARCHAR(255)    NOT NULL,
    original_name VARCHAR(255)    NULL,
    mime_type     VARCHAR(100)    NULL,
    size_bytes    INT UNSIGNED    NULL,
    purpose       ENUM('chat','avatar','verify_id','other') NOT NULL DEFAULT 'other',
    url           VARCHAR(500)    NOT NULL,
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user    (user_id),
    INDEX idx_purpose (purpose),
    CONSTRAINT fk_fu_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================
-- REPORTS (รายงานผู้ใช้ที่มีปัญหา)
-- =========================
CREATE TABLE IF NOT EXISTS reports (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    reporter_id     BIGINT UNSIGNED NOT NULL,
    target_user_id  BIGINT UNSIGNED NULL,
    target_type     ENUM('user','job','match','message') NOT NULL DEFAULT 'user',
    target_id       BIGINT UNSIGNED NULL,
    reason          VARCHAR(100)    NOT NULL,
    description     TEXT            NULL,
    status          ENUM('pending','reviewed','resolved','dismissed') NOT NULL DEFAULT 'pending',
    reviewed_by     BIGINT UNSIGNED NULL,
    reviewed_at     DATETIME        NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_reporter    (reporter_id),
    INDEX idx_target_user (target_user_id),
    INDEX idx_status      (status),
    CONSTRAINT fk_rep_reporter    FOREIGN KEY (reporter_id)    REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_rep_target_user FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
