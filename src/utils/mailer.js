/**
 * mailer.js — ส่งอีเมลผ่าน nodemailer
 *
 * Development : ใช้ Ethereal (fake SMTP) หรือถ้าตั้ง SMTP_HOST → ใช้จริง
 *               OTP code จะถูก log ออก console เสมอในโหมด dev
 * Production  : ตั้ง SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS ใน .env
 *               หรือใช้ Mailgun/SendGrid → เปลี่ยน transport ตรงนี้ที่เดียว
 */

const nodemailer = require('nodemailer');
const config     = require('../config');

let _transport = null;

async function getTransport() {
    if (_transport) return _transport;

    if (config.smtp.host) {
        // Production / staging SMTP
        _transport = nodemailer.createTransport({
            host:   config.smtp.host,
            port:   config.smtp.port,
            secure: config.smtp.port === 465,
            auth: {
                user: config.smtp.user,
                pass: config.smtp.pass,
            },
        });
    } else {
        // Development: Ethereal fake inbox
        const testAccount = await nodemailer.createTestAccount();
        _transport = nodemailer.createTransport({
            host:   'smtp.ethereal.email',
            port:   587,
            secure: false,
            auth: {
                user: testAccount.user,
                pass: testAccount.pass,
            },
        });
        console.log('[mailer] DEV mode — Ethereal account:', testAccount.user);
    }
    return _transport;
}

/**
 * ส่งอีเมล
 * @param {object} opts
 * @param {string}  opts.to      — ที่อยู่อีเมลผู้รับ
 * @param {string}  opts.subject — หัวข้อ
 * @param {string}  opts.html    — เนื้อหา HTML
 * @param {string}  [opts.text]  — เนื้อหา plain text (fallback)
 */
async function sendMail({ to, subject, html, text }) {
    try {
        const transport = await getTransport();
        const info = await transport.sendMail({
            from: config.smtp.from || '"ChaungThai" <noreply@chaungthai.co.th>',
            to,
            subject,
            html,
            text: text || html.replace(/<[^>]+>/g, ''),
        });

        if (config.env !== 'production') {
            const previewUrl = nodemailer.getTestMessageUrl(info);
            if (previewUrl) {
                console.log(`[mailer] Preview URL → ${previewUrl}`);
            }
        }
        return info;
    } catch (err) {
        console.error('[mailer] send failed:', err.message);
        // ไม่ throw เพื่อไม่ให้ API crash เพราะ email ส่งไม่ได้
    }
}

// ── Template: OTP ──────────────────────────────────────────────────────────
function otpEmailHtml(code, purpose, expiresMin = 10) {
    const purposeLabel = {
        verify_email:   'ยืนยันอีเมล',
        verify_phone:   'ยืนยันเบอร์โทร',
        reset_password: 'รีเซ็ตรหัสผ่าน',
    }[purpose] || 'ยืนยันตัวตน';

    return `
<!DOCTYPE html>
<html lang="th">
<head><meta charset="UTF-8"><title>${purposeLabel} — ChaungThai</title></head>
<body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,.08)">
    <h2 style="color:#b91c1c;margin-top:0">ChaungThai 🔧</h2>
    <p style="color:#374151">สวัสดีครับ!</p>
    <p style="color:#374151">รหัส OTP สำหรับ <strong>${purposeLabel}</strong> ของคุณ:</p>
    <div style="background:#fef2f2;border:2px dashed #b91c1c;border-radius:8px;padding:20px;text-align:center;margin:24px 0">
      <span style="font-size:36px;font-weight:800;letter-spacing:8px;color:#b91c1c">${code}</span>
    </div>
    <p style="color:#6b7280;font-size:14px">รหัสนี้หมดอายุใน <strong>${expiresMin} นาที</strong></p>
    <p style="color:#6b7280;font-size:14px">หากคุณไม่ได้ทำรายการนี้ กรุณาเพิกเฉยต่ออีเมลนี้</p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
    <p style="color:#9ca3af;font-size:12px">ChaungThai — แพลตฟอร์มหาช่างฝีมือ</p>
  </div>
</body>
</html>`;
}

module.exports = { sendMail, otpEmailHtml };
