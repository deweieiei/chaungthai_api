# ChaungThai — รายการ Feature ทั้ง 2 แอพ

> อัพเดตล่าสุด: 2026-05-08 (v2 — เพิ่ม OTP, Upload, Report, WebSocket, Worker Verify)
> API Base URL: `http://localhost:9543/api`
> Auth Header : `Authorization: Bearer <accessToken>`
> WebSocket   : `ws://localhost:9543/ws?token=<accessToken>`

---

## สารบัญ
- [แอพผู้ว่าจ้าง (Customer App)](#-แอพผู้ว่าจ้าง-customer-app)
- [แอพช่าง / ผู้รับจ้าง (Worker App)](#-แอพช่าง--ผู้รับจ้าง-worker-app)
- [Feature ร่วมทั้ง 2 แอพ](#-feature-ร่วมทั้ง-2-แอพ)
- [WebSocket Events](#-websocket-events)
- [สถานะ Flow](#สถานะ-flow)

---

## 👤 แอพผู้ว่าจ้าง (Customer App)

### 1. ระบบบัญชี (Account)

| # | Feature | API Endpoint | Method | หมายเหตุ |
|---|---------|--------------|--------|----------|
| 1.1 | สมัครสมาชิก | `POST /auth/register` | Public | role = `customer` |
| 1.2 | เข้าสู่ระบบ | `POST /auth/login` | Public | Rate limit 10/15 นาที |
| 1.3 | ออกจากระบบ | `POST /auth/logout` | Auth | Revoke refresh token |
| 1.4 | Refresh Access Token | `POST /auth/refresh` | Public | Token rotation |
| 1.5 | ดูข้อมูลโปรไฟล์ | `GET /users/me` | Auth | |
| 1.6 | แก้ไขชื่อ-นามสกุล | `PATCH /users/me` | Auth | |
| 1.7 | เปลี่ยนรหัสผ่าน | `PATCH /users/me/password` | Auth | Revoke tokens ทั้งหมด |
| 1.8 | **ลืมรหัสผ่าน** 🆕 | `POST /auth/forgot-password` | Public | ส่ง OTP ไปทาง email/phone |
| 1.9 | **รีเซ็ตรหัสผ่าน** 🆕 | `POST /auth/reset-password` | Public | ยืนยัน OTP + ตั้งรหัสใหม่ |
| 1.10 | ลบบัญชี (PDPA) | `DELETE /users/me` | Auth | Soft delete, ลบจริงใน 90 วัน |
| 1.11 | ดูประวัติการยินยอม (PDPA) | `GET /users/me/consent` | Auth | |
| 1.12 | บันทึกการยินยอม | `POST /users/me/consent` | Auth | terms, privacy_policy, cookie |
| 1.13 | ลงทะเบียน Device Token | `POST /users/me/device-token` | Auth | FCM/APNs/Web |
| 1.14 | ยกเลิก Device Token | `DELETE /users/me/device-token` | Auth | |

---

### 2. ยืนยันตัวตน (Verification) 🆕

| # | Feature | API Endpoint | Method | หมายเหตุ |
|---|---------|--------------|--------|----------|
| 2.1 | ส่ง OTP ยืนยันอีเมล | `POST /verify/email/send` | Auth | ส่งทุก 60 วิ / Rate 5/ชม. |
| 2.2 | ยืนยัน OTP อีเมล | `POST /verify/email/confirm` | Auth | OTP 6 หลัก หมดอายุ 10 นาที |
| 2.3 | ส่ง OTP ยืนยันเบอร์โทร | `POST /verify/phone/send` | Auth | ส่ง SMS |
| 2.4 | ยืนยัน OTP เบอร์โทร | `POST /verify/phone/confirm` | Auth | |

---

### 3. อัพโหลดรูปภาพ (Upload) 🆕

| # | Feature | API Endpoint | Method | หมายเหตุ |
|---|---------|--------------|--------|----------|
| 3.1 | อัพโหลดรูป | `POST /upload/image?purpose=chat` | Auth | max 5 MB, JPG/PNG/WebP/GIF |
| 3.2 | ลบรูปของตัวเอง | `DELETE /upload/:fileId` | Auth | |

> **purpose**: `chat` / `avatar` / `verify_id` / `other`
> รูปที่อัพโหลดเข้าถึงได้ที่: `GET /uploads/<purpose>/<filename>`

---

### 4. ค้นหาช่าง (Find Worker)

| # | Feature | API Endpoint | Method | หมายเหตุ |
|---|---------|--------------|--------|----------|
| 4.1 | ค้นหาช่าง (filter หลายแบบ) | `GET /workers` | Public | skillId, provinceId, ratingMin, priceMax, q |
| 4.2 | ดูโปรไฟล์ช่าง | `GET /workers/:id` | Public | สกิล, พื้นที่, รีวิวล่าสุด |
| 4.3 | ดูรีวิวช่างทั้งหมด | `GET /ratings/worker/:workerId` | Public | summary + รายการ |
| 4.4 | **ดูประวัติรีวิวลูกค้า** 🆕 | `GET /ratings/customer/:customerId` | Auth | ช่างดูว่าลูกค้าให้คะแนนแบบไหน |
| 4.5 | โหลด Skill / หมวดหมู่ | `GET /skills`, `GET /skills/categories` | Public | |
| 4.6 | โหลดที่ตั้ง | `GET /locations/provinces` ฯลฯ | Public | cascade จังหวัด→อำเภอ→ตำบล |

---

### 5. จัดการงาน (Job Management)

| # | Feature | API Endpoint | Method | หมายเหตุ |
|---|---------|--------------|--------|----------|
| 5.1 | โพสประกาศงาน | `POST /jobs` | Auth (customer) | หมดอายุใน 24 ชม. |
| 5.2 | รายการงานของตัวเอง | `GET /jobs` | Auth (customer) | กรองตาม status |
| 5.3 | รายละเอียดงาน | `GET /jobs/:id` | Auth | |
| 5.4 | แก้ไขงาน | `PATCH /jobs/:id` | Auth (customer) | เฉพาะ open |
| 5.5 | ยกเลิกประกาศ | `DELETE /jobs/:id` | Auth (customer) | เฉพาะ open |
| 5.6 | ดูรายชื่อช่างที่สมัคร | `GET /jobs/:id/applications` | Auth (customer) | เรียง rating สูง→ต่ำ |
| 5.7 | เลือกช่าง | `POST /jobs/:id/select/:appId` | Auth (customer) | สร้าง match + chat room |
| 5.8 | จ้างช่างโดยตรง | `POST /matches/direct` | Auth (customer) | ไม่ต้องโพสงาน |

---

### 6. Match / งานที่ตกลงแล้ว

| # | Feature | API Endpoint | Method | หมายเหตุ |
|---|---------|--------------|--------|----------|
| 6.1 | รายการ match ทั้งหมด | `GET /matches` | Auth | |
| 6.2 | รายละเอียด match | `GET /matches/:id` | Auth | เบอร์ช่าง, ที่อยู่งาน |
| 6.3 | ยืนยันงานเสร็จ | `PATCH /matches/:id/complete` | Auth (customer) | ล็อก chat อัตโนมัติ |
| 6.4 | ยกเลิกงาน | `PATCH /matches/:id/cancel` | Auth | ต้องระบุเหตุผล |

---

### 7. รีวิว / แชท / แจ้งเตือน / รายงาน

| # | Feature | API Endpoint | Method | หมายเหตุ |
|---|---------|--------------|--------|----------|
| 7.1 | ให้คะแนนช่าง | `POST /ratings` | Auth (customer) | 1-5 ดาว + ข้อความ |
| 7.2 | รายการห้องแชท | `GET /chat` | Auth | unread count |
| 7.3 | ส่งข้อความ | `POST /chat/:roomId` | Auth | text / image URL |
| 7.4 | โหลดข้อความ | `GET /chat/:roomId` | Auth | cursor pagination |
| 7.5 | รายการแจ้งเตือน | `GET /notifications` | Auth | |
| 7.6 | **รายงานผู้ใช้** 🆕 | `POST /reports` | Auth | spam, fraud, harassment ฯลฯ |
| 7.7 | **ดูรายงานที่ส่งไป** 🆕 | `GET /reports/my` | Auth | |

> Push ที่ลูกค้าได้รับ: `new_application`, `job_started`, `job_cancelled`, `new_message`
> Real-time ผ่าน WebSocket ด้วย (ไม่ต้อง polling)

---
---

## 🔧 แอพช่าง / ผู้รับจ้าง (Worker App)

### 1. ระบบบัญชี (Account)

| # | Feature | API Endpoint | Method | หมายเหตุ |
|---|---------|--------------|--------|----------|
| 1.1 | สมัครสมาชิก | `POST /auth/register` | Public | role = `worker` |
| 1.2 | เข้าสู่ระบบ | `POST /auth/login` | Public | |
| 1.3 | ออกจากระบบ | `POST /auth/logout` | Auth | |
| 1.4 | Refresh Token | `POST /auth/refresh` | Public | |
| 1.5 | ดูโปรไฟล์ตัวเอง | `GET /users/me` | Auth | รวม workerProfile |
| 1.6 | แก้ไขชื่อ | `PATCH /users/me` | Auth | |
| 1.7 | เปลี่ยนรหัสผ่าน | `PATCH /users/me/password` | Auth | |
| 1.8 | **ลืมรหัสผ่าน** 🆕 | `POST /auth/forgot-password` | Public | |
| 1.9 | **รีเซ็ตรหัสผ่าน** 🆕 | `POST /auth/reset-password` | Public | |
| 1.10 | ลบบัญชี (PDPA) | `DELETE /users/me` | Auth | |
| 1.11 | ลงทะเบียน Device Token | `POST /users/me/device-token` | Auth | |

---

### 2. ยืนยันตัวตน (Verification) 🆕

| # | Feature | API Endpoint | Method | หมายเหตุ |
|---|---------|--------------|--------|----------|
| 2.1 | ยืนยัน OTP อีเมล | `POST /verify/email/send` + `/confirm` | Auth | |
| 2.2 | ยืนยัน OTP เบอร์โทร | `POST /verify/phone/send` + `/confirm` | Auth | |
| 2.3 | **ส่งบัตรประชาชนยืนยันช่าง** 🆕 | `POST /workers/me/verify-id` | Auth (worker) | รูปบัตรหน้า/หลัง + selfie |
| 2.4 | **ตรวจสถานะการยืนยัน** 🆕 | `GET /workers/me/verify-id` | Auth (worker) | pending/approved/rejected |

> ⚠️ ช่างที่ยังไม่ผ่าน `is_verified` จะสมัครงาน Level 3+ ไม่ได้

---

### 3. โปรไฟล์ช่าง (Worker Profile)

| # | Feature | API Endpoint | Method | หมายเหตุ |
|---|---------|--------------|--------|----------|
| 3.1 | แก้ Bio / รูปโปรไฟล์ | `PUT /workers/me/profile` | Auth (worker) | |
| 3.2 | ตั้งค่าสกิล + ราคา | `PUT /workers/me/skills` | Auth (worker) | max 20 สกิล |
| 3.3 | ตั้งพื้นที่บริการ | `PUT /workers/me/areas` | Auth (worker) | max 20 พื้นที่ |
| 3.4 | อัพเดท GPS | `PUT /workers/me/location` | Auth (worker) | |
| 3.5 | สถิติผลงาน | `GET /workers/me/stats` | Auth (worker) | งานเสร็จ, rating, ตั๋ว |

---

### 4. อัพโหลดรูปภาพ (Upload) 🆕

| # | Feature | API Endpoint | Method | หมายเหตุ |
|---|---------|--------------|--------|----------|
| 4.1 | อัพโหลดรูปโปรไฟล์ | `POST /upload/image?purpose=avatar` | Auth | URL ที่ได้ → ส่งไปใน PUT /workers/me/profile |
| 4.2 | อัพโหลดรูปบัตรประชาชน | `POST /upload/image?purpose=verify_id` | Auth | URL → ส่งไปใน POST /workers/me/verify-id |
| 4.3 | อัพโหลดรูปในแชท | `POST /upload/image?purpose=chat` | Auth | URL → ส่งไปใน POST /chat/:roomId |

---

### 5. ฟีดหางาน + สมัครงาน

| # | Feature | API Endpoint | Method | หมายเหตุ |
|---|---------|--------------|--------|----------|
| 5.1 | ฟีดงานที่ match | `GET /jobs` | Auth (worker) | filter ตาม skills+areas อัตโนมัติ |
| 5.2 | รายละเอียดงาน | `GET /jobs/:id` | Auth | แสดง myApplication ด้วย |
| 5.3 | สมัครงาน | `POST /jobs/:id/apply` | Auth (worker) | หักตั๋ว = job_level |
| 5.4 | ถอนใบสมัคร | `DELETE /jobs/:id/apply` | Auth (worker) | คืนตั๋วคืน |

---

### 6. Match + ระบบตั๋ว

| # | Feature | API Endpoint | Method | หมายเหตุ |
|---|---------|--------------|--------|----------|
| 6.1 | รายการงานที่รับแล้ว | `GET /matches` | Auth | |
| 6.2 | รายละเอียดงาน | `GET /matches/:id` | Auth | เบอร์ลูกค้า, ที่อยู่ |
| 6.3 | กดเริ่มงาน | `PATCH /matches/:id/start` | Auth (worker) | |
| 6.4 | ยกเลิกงาน | `PATCH /matches/:id/cancel` | Auth | |
| 6.5 | ยอดตั๋ว + ประวัติ | `GET /tickets` | Auth (worker) | |
| 6.6 | แพ็คเกจตั๋ว | `GET /tickets/packages` | Auth | |
| 6.7 | ซื้อตั๋ว | `POST /tickets/purchase` | Auth (worker) | sandbox mode ในตอนนี้ |
| 6.8 | ประวัติชำระเงิน | `GET /tickets/payments` | Auth | |

---

### 7. แชท / แจ้งเตือน / รายงาน

| # | Feature | API Endpoint | Method | หมายเหตุ |
|---|---------|--------------|--------|----------|
| 7.1 | รายการห้องแชท | `GET /chat` | Auth | |
| 7.2 | ส่ง/รับข้อความ | `POST /chat/:roomId` | Auth | Real-time ผ่าน WebSocket |
| 7.3 | รายการแจ้งเตือน | `GET /notifications` | Auth | |
| 7.4 | **รายงานผู้ใช้** 🆕 | `POST /reports` | Auth | |

> Push ที่ช่างได้รับ: `match_accepted`, `job_cancelled`, `job_completed`, `rating_received`, `ticket_purchase`, `verify_approved`, `verify_rejected`

---
---

## 🔗 Feature ร่วมทั้ง 2 แอพ

| Feature | รายละเอียด |
|---------|-----------|
| JWT Auth | Access token 15 นาที, Refresh 30 วัน |
| Account Lockout | ล็อก 15 นาทีหลังใส่รหัสผิด 5 ครั้ง |
| **OTP System** 🆕 | Email + SMS OTP หมดอายุ 10 นาที, ส่งซ้ำได้ทุก 60 วินาที |
| **Forgot Password** 🆕 | ขอ OTP ผ่าน email หรือ phone แล้วตั้งรหัสใหม่ |
| **Image Upload** 🆕 | อัพโหลดรูป max 5 MB, เข้าถึงได้ที่ `/uploads/` |
| **Real-time WebSocket** 🆕 | Chat + Notification ทันทีไม่ต้อง polling |
| **Report System** 🆕 | รายงาน user/job/match/message ได้ 10 ครั้ง/ชม. |
| Push Notification (FCM/APNs) | ยังต้องการ token จากอุปกรณ์ก่อน |
| PDPA Compliance | ยินยอม + ลบบัญชีได้ |

---

## 🔌 WebSocket Events

เชื่อมต่อ: `ws://localhost:9543/ws?token=<accessToken>`

| Event (type) | ทิศทาง | รายละเอียด |
|-------------|--------|-----------|
| `connected` | Server → Client | ยืนยันการเชื่อมต่อ |
| `chat_message` | Server → Client | ข้อความแชทใหม่ พร้อม roomId + message object |
| `notification` | Server → Client | แจ้งเตือนทุกประเภท พร้อม title/body/data |
| `pong` | Server → Client | ตอบกลับ ping |
| `ping` | Client → Server | Heartbeat เพื่อกัน timeout |

> ถ้า token ไม่ถูกต้อง → server ปิด connection ทันทีด้วย code `4001`

---

## สถานะ Flow

```
Job:   open → matched → in_progress → completed
             ↘ expired (24 ชม.)
             ↘ cancelled

Match: matched → in_progress → completed
              ↘ cancelled

Worker Verify: pending → approved ✅
                       → rejected ❌ (ส่งใหม่ได้)
```

---

## Admin Endpoints (เฉพาะ role = admin)

| Endpoint | หน้าที่ |
|---------|--------|
| `GET /admin/stats` | สถิติรวม users/jobs/matches/reports |
| `GET /admin/users` | รายชื่อผู้ใช้ทั้งหมด |
| `PATCH /admin/:id/status` | เปิด/ปิดบัญชี |
| `GET /admin/jobs` | รายการงานทั้งหมด |
| `GET /admin/reports` | รายงานที่รอตรวจสอบ |
| `PATCH /admin/reports/:id` | อนุมัติ/ปฏิเสธรายงาน |
| **`GET /admin/verify-requests`** 🆕 | คำขอยืนยันตัวตนช่าง |
| **`PATCH /admin/verify-requests/:id`** 🆕 | อนุมัติ/ปฏิเสธบัตรช่าง |
| `GET /admin/audit` | audit log |
| `POST /admin/blacklist` | blacklist email/phone |
| **`GET /admin/ws-stats`** 🆕 | จำนวน WebSocket ที่ online อยู่ |
