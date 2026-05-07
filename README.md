# ChaungThai API

Backend สำหรับเว็บไซต์ ChaungThai (`C:\web\chaungthai`)
รัน Node.js + Express + MySQL2 — รันด้วย `node server.js` หรือ PM2

---

## 1. สเปคปัจจุบัน

| Component | Detail |
|---|---|
| Runtime | Node.js ≥ 20 (ทดสอบบน v24.13.0) |
| Framework | Express 4 |
| DB | MySQL 8.0.45 (remote: `110.171.128.44:3306`) |
| Auth | JWT (access 15m + refresh 30d, rotated) |
| Password hash | bcrypt (12 rounds) |
| Validation | zod |
| Default port | `3001` |

---

## 2. Quick start (เครื่องนี้, ครั้งแรก)

```bash
cd C:\api
npm install
npm run db:test       # ทดสอบเชื่อมต่อ DB
npm run db:migrate    # สร้างตาราง (ครั้งแรก)
node server.js        # รัน
```

จะเห็น:
```
[api] listening on http://localhost:3001 (development)
[api] DB: dew_server1@110.171.128.44:3306/chaungthai
```

ปิดด้วย `Ctrl+C`

---

## 3. ย้ายไปรันที่เครื่องอื่น

```bash
# 1. คัดลอกโฟลเดอร์ทั้งหมด (ยกเว้น node_modules) ไปเครื่องใหม่
# 2. ที่เครื่องใหม่:
cd <ไปยังโฟลเดอร์>
cp .env.example .env       # แล้วแก้ค่าใน .env
npm install
npm run db:test
node server.js
```

**ที่ต้องแก้ใน `.env`:**
- `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` (ถ้า DB อยู่ที่อื่น)
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — gen ใหม่ด้วย:
  ```bash
  node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
  ```
- `CORS_ORIGINS` — URL ของ frontend ที่จะเรียก API นี้
- `PORT` — ถ้าจะใช้พอร์ตอื่น

---

## 4. รันด้วย PM2 (production)

```bash
# ติดตั้ง PM2 ครั้งแรก (global)
npm install -g pm2

# รัน
cd C:\api
pm2 start ecosystem.config.cjs

# สั่งงาน
pm2 logs chaungthai-api      # ดู log
pm2 restart chaungthai-api
pm2 stop chaungthai-api
pm2 delete chaungthai-api
pm2 status                    # รายการทั้งหมด
```

PM2 จะ auto-restart ถ้าโปรเซสตาย และเขียน log ไปที่ `logs/out.log`, `logs/err.log`

---

## 5. โครงสร้างโฟลเดอร์

```
C:\api\
├── server.js              ← entry point (รันที่นี่)
├── ecosystem.config.cjs   ← PM2 config
├── package.json
├── .env                   ← config จริง (อย่า commit!)
├── .env.example           ← template
├── .gitignore
├── src/
│   ├── config.js          ← โหลดและ validate env
│   ├── db.js              ← MySQL connection pool
│   ├── middleware/
│   │   ├── auth.js        ← JWT verify
│   │   ├── error.js       ← central error handler
│   │   └── validate.js    ← zod validation
│   ├── routes/
│   │   ├── auth.js        ← /api/auth/*
│   │   └── health.js      ← /api/health/*
│   └── utils/
│       ├── http.js        ← HttpError + asyncHandler
│       └── tokens.js      ← JWT + sha256 helpers
├── sql/
│   └── 001_init.sql       ← schema (run via npm run db:migrate)
├── scripts/
│   ├── test-connection.js
│   └── migrate.js
└── logs/                  ← PM2 logs (สร้างเอง)
```

---

## 6. Database Schema

5 ตารางใน DB `chaungthai`:

| Table | Purpose |
|---|---|
| `users` | ลูกค้า + ช่าง + admin (ใช้ตารางเดียว, แยกด้วย `role`) |
| `worker_profiles` | ข้อมูลเสริมเฉพาะช่าง (skills, ratings, ตั๋ว) |
| `refresh_tokens` | refresh token (เก็บแบบ sha256, rotate ทุกครั้ง) |
| `otp_codes` | OTP สำหรับ verify email/phone และ reset password |
| `audit_log` | บันทึก login/register events + metadata |

ดูรายละเอียด field ที่ [`sql/001_init.sql`](sql/001_init.sql)

### เพิ่ม migration ใหม่

สร้าง `sql/002_xxx.sql` แล้วรัน `npm run db:migrate` — script จะรันไฟล์ที่ยังไม่เคยรันตามลำดับชื่อ

> **หมายเหตุ:** ตอนนี้ migration ยังไม่มี version tracking — รัน `db:migrate` ซ้ำได้ถ้า SQL ใช้ `CREATE TABLE IF NOT EXISTS` แต่ระวังถ้ามี ALTER

---

## 7. API Reference

### Base URL
- Dev: `http://localhost:3001`

### Format ตอบกลับมาตรฐาน

**สำเร็จ:**
```json
{ "ok": true, "data": ... }
```

**ผิดพลาด:**
```json
{
  "ok": false,
  "error": {
    "code": "user_exists",
    "message": "อีเมลหรือเบอร์นี้ถูกใช้แล้ว",
    "details": [...]   // optional
  }
}
```

---

### `GET /api/health`
ตรวจว่า API ยังรันอยู่ไหม

```bash
curl http://localhost:3001/api/health
# → { "ok": true, "service": "chaungthai-api", "uptime": 12.34 }
```

### `GET /api/health/db`
ทดสอบเชื่อมต่อ DB

```bash
curl http://localhost:3001/api/health/db
# → { "ok": true, "db": { "version": "8.0.45-...", "now": "2026-04-25T..." } }
```

---

### `POST /api/auth/register`
สมัครบัญชีใหม่ (limit 5 ครั้ง / ชั่วโมง / IP)

**Body:**
```json
{
  "firstName": "ทดสอบ",
  "lastName": "นามสกุล",
  "email": "test@example.com",
  "phone": "0812345678",
  "password": "secret123",
  "passwordConfirm": "secret123",
  "role": "customer",        // "customer" หรือ "worker"
  "acceptTerms": true,
  "newsletter": false        // optional
}
```

**Response 201:**
```json
{
  "ok": true,
  "user": { "id": 1, "email": "...", "firstName": "...", "role": "customer", ... },
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "expiresIn": "15m"
}
```

**Errors:**
- `409 user_exists` — อีเมล/เบอร์ซ้ำ
- `400 validation_error` — ข้อมูลไม่ถูกต้อง
- `429 too_many_requests` — สมัครเกิน 5 ครั้ง/ชม.

---

### `POST /api/auth/login`
เข้าสู่ระบบ (limit 10 ครั้ง / 15 นาที / IP)

**Body:**
```json
{
  "identifier": "test@example.com",  // อีเมลหรือเบอร์
  "password": "secret123",
  "remember": false                   // optional
}
```

**Response 200:** (เหมือน register)

**Errors:**
- `401 invalid_credentials` — รหัสไม่ถูก
- `429 too_many_requests`

---

### `GET /api/auth/me`
ดูข้อมูลบัญชีตัวเอง (ต้อง access token)

**Headers:** `Authorization: Bearer <accessToken>`

**Response 200:**
```json
{ "ok": true, "user": { "id": 1, ... } }
```

**Errors:**
- `401 missing_token` / `invalid_token` / `token_expired`

---

### `POST /api/auth/refresh`
ขอ access token ใหม่จาก refresh token

**Body:**
```json
{ "refreshToken": "eyJ..." }
```

**Response 200:**
```json
{ "ok": true, "accessToken": "eyJ...", "refreshToken": "eyJ...", "expiresIn": "15m" }
```

> Refresh token จะถูก rotate (อันเก่า revoke, ออกอันใหม่)

**Errors:**
- `401 invalid_refresh` — token หมดอายุ/ถูก revoke แล้ว

---

### `POST /api/auth/logout`
ออกจากระบบ (revoke refresh token)

**Body:**
```json
{ "refreshToken": "eyJ..." }
```

**Response 200:** `{ "ok": true }`

---

## 8. Frontend integration

ที่ `C:\web\chaungthai\auth.js`:

```js
const API_BASE = window.API_BASE || 'http://localhost:3001';
```

ถ้า API ไปรันที่อื่น (เช่น `https://api.chaungthai.com`) เพิ่มที่หน้า HTML ก่อน `<script src="auth.js">`:

```html
<script>window.API_BASE = 'https://api.chaungthai.com';</script>
<script src="auth.js"></script>
```

ตอนนี้ frontend ทำ:
- POST `/api/auth/register` ตอน submit form register → save token ลง `localStorage` → redirect ไป `index.html`
- POST `/api/auth/login` ตอน submit form login → เหมือนกัน
- มี `window.ChaungThaiAuth.getCurrentUser()`, `.isLoggedIn()`, `.handleLogout()`, `.api(path, opts)` ให้ใช้จากสคริปต์อื่น

LocalStorage keys:
- `ct_access`  — access token
- `ct_refresh` — refresh token
- `ct_user`    — JSON ของ user

---

## 9. ความปลอดภัย — สิ่งที่ทำไว้แล้ว

- ✅ Password ใช้ bcrypt (12 rounds)
- ✅ JWT แยก secret ระหว่าง access/refresh
- ✅ Refresh token เก็บ DB เป็น sha256 (ถ้า DB หลุดผู้โจมตียังใช้ token ไม่ได้)
- ✅ Refresh token rotation (อันเก่าใช้ซ้ำไม่ได้)
- ✅ Rate limit login (10/15min) + register (5/hr)
- ✅ CORS whitelist (ไม่ใช่ `*`)
- ✅ SQL: ใช้ named placeholder ทั้งหมด — กัน SQL injection
- ✅ Error message ไม่บอกว่า "อีเมลผิด" vs "รหัสผิด" — กัน enum
- ✅ Audit log บันทึก login attempts

## 10. ความปลอดภัย — สิ่งที่ยังไม่ทำ (รออนาคต)

- ❌ Email verification (ตาราง otp_codes พร้อมแล้ว แค่ต้องเชื่อม email service)
- ❌ Phone OTP
- ❌ Forgot password flow
- ❌ 2FA / TOTP
- ❌ CAPTCHA (Cloudflare Turnstile)
- ❌ HTTPS — ต้องตั้ง reverse proxy (nginx/caddy) ข้างหน้า
- ❌ Helmet middleware (security headers)
- ❌ Account lockout หลัง login fail หลายครั้ง

---

## 11. คำสั่งที่ใช้บ่อย

```bash
# Test connection
npm run db:test

# Run all SQL migrations
npm run db:migrate

# Start (manual)
node server.js

# Start (auto-reload เมื่อแก้โค้ด — Node 20+)
npm run dev

# PM2
npm run pm2:start
npm run pm2:logs
npm run pm2:stop

# ดู connection ค้างใน MySQL (ผ่าน SSH)
ssh dew_server1@110.171.128.44 -p 9544
mysql -u dew_server1 -p'Dew@1234' -e "SHOW PROCESSLIST" | head
```

---

## 12. Troubleshooting

### `ECONNREFUSED 110.171.128.44:3306`
- เซิร์ฟเวอร์ MySQL ดับ หรือ firewall บล็อก
- เช็ค: `ssh dew_server1@... -p 9544 'systemctl is-active mysql'`

### `ER_ACCESS_DENIED_ERROR`
- รหัสผ่าน DB ผิด — แก้ใน `.env`

### `Port 3001 already in use`
- มี API รันอยู่แล้ว → `pm2 list` หรือ `tasklist | findstr node` แล้ว kill

### CORS error จาก browser
- เพิ่ม origin ของ frontend ลง `CORS_ORIGINS` ใน `.env` แล้ว restart

### `validation_error` ทุกครั้งที่ submit
- ดูรายละเอียดใน `error.details` array — บอกว่า field ไหนผิด

---

## 13. ของที่ต้องทำต่อ (Next steps)

1. **Email service** — ผูก SendGrid/Postmark/SES สำหรับ verify email + reset password
2. **SMS / OTP** — Twilio หรือ Thai providers (THSMS, ThaiBulkSMS)
3. **Endpoints ฟีเจอร์หลัก:**
   - `POST /api/jobs` — โพสต์งาน
   - `GET /api/jobs/search` — ค้นหาช่าง
   - `POST /api/jobs/:id/quote` — ช่างเสนอราคา (ใช้ตั๋ว)
   - `POST /api/jobs/:id/accept` — ลูกค้ายืนยัน
   - `POST /api/reviews` — รีวิว
4. **Real-time** — WebSocket (ws / Socket.IO) สำหรับแชทและ status update
5. **File upload** — รูปงาน / โปรไฟล์ (multer + S3/local)
6. **Payment** — Omise / 2C2P escrow

---

## 14. Credentials note (สำคัญ!)

ไฟล์ `.env` มีรหัสจริง — **ห้าม commit ลง git**
ถ้าใช้ git ตรวจให้แน่ใจว่า `.gitignore` มี `.env`

ถ้า DB password หลุด:
```bash
ssh dew_server1@110.171.128.44 -p 9544
mysql -u dew_server1 -p'Dew@1234' -e "ALTER USER 'dew_server1'@'%' IDENTIFIED BY 'NEW_PASSWORD'"
# แล้วแก้ .env ให้ตรง
```
"# chaungthai_api" 
