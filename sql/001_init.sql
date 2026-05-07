-- ChaungThai API — Initial Schema
-- MySQL 8.0+ / utf8mb4
-- Run order: 001 first, then 002, ...

-- =========================
-- USERS (customer + worker + admin in one table)
-- =========================
CREATE TABLE IF NOT EXISTS users (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email             VARCHAR(255) NOT NULL UNIQUE,
    phone             VARCHAR(20)  UNIQUE,
    password_hash     VARCHAR(255) NOT NULL,
    first_name        VARCHAR(100) NOT NULL,
    last_name         VARCHAR(100) NOT NULL,
    role              ENUM('customer','worker','admin') NOT NULL DEFAULT 'customer',
    email_verified_at DATETIME     NULL,
    phone_verified_at DATETIME     NULL,
    is_active         TINYINT(1)   NOT NULL DEFAULT 1,
    newsletter_opt_in TINYINT(1)   NOT NULL DEFAULT 0,
    last_login_at     DATETIME     NULL,
    created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_role   (role),
    INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================
-- WORKER PROFILES (1:1 with users where role='worker')
-- =========================
CREATE TABLE IF NOT EXISTS worker_profiles (
    user_id          BIGINT UNSIGNED PRIMARY KEY,
    bio              TEXT,
    skills           JSON,             -- ["electrical","plumbing"]
    service_areas    JSON,             -- ["bangkok","nonthaburi"]
    avatar_url       VARCHAR(500),
    rating_avg       DECIMAL(3,2)    NOT NULL DEFAULT 0,
    rating_count     INT UNSIGNED    NOT NULL DEFAULT 0,
    tickets_balance  INT UNSIGNED    NOT NULL DEFAULT 5,
    is_verified      TINYINT(1)      NOT NULL DEFAULT 0,
    verified_at      DATETIME        NULL,
    created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_worker_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================
-- REFRESH TOKENS (rotated, hashed in DB)
-- =========================
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    token_hash  CHAR(64)        NOT NULL UNIQUE,  -- sha256 hex
    user_agent  VARCHAR(255),
    ip          VARCHAR(45),
    expires_at  DATETIME        NOT NULL,
    revoked_at  DATETIME        NULL,
    created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user    (user_id),
    INDEX idx_expires (expires_at),
    CONSTRAINT fk_token_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================
-- OTP CODES (verify email/phone, password reset)
-- =========================
CREATE TABLE IF NOT EXISTS otp_codes (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED  NULL,
    target      VARCHAR(255)     NOT NULL,        -- email or phone
    code_hash   CHAR(64)         NOT NULL,        -- sha256(code)
    purpose     ENUM('verify_email','verify_phone','reset_password') NOT NULL,
    attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
    used_at     DATETIME         NULL,
    expires_at  DATETIME         NOT NULL,
    created_at  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_target  (target),
    INDEX idx_expires (expires_at),
    CONSTRAINT fk_otp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =========================
-- AUDIT LOG (login attempts, sensitive actions)
-- =========================
CREATE TABLE IF NOT EXISTS audit_log (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT UNSIGNED NULL,
    action     VARCHAR(64)     NOT NULL,           -- 'login_success','login_failed','register'
    ip         VARCHAR(45),
    user_agent VARCHAR(255),
    metadata   JSON,
    created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_action (user_id, action),
    INDEX idx_created     (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
