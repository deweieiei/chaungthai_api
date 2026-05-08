/**
 * sms.js — ส่ง SMS OTP
 *
 * Development : log OTP ออก console เท่านั้น (ไม่ต้องมี provider)
 * Production  : ต่อเชื่อมกับ provider ที่ต้องการ
 *
 * Provider ที่แนะนำสำหรับไทย:
 *   - Twilio          : SMS_PROVIDER=twilio, SMS_ACCOUNT_SID, SMS_AUTH_TOKEN, SMS_FROM
 *   - Thaibulksms     : SMS_PROVIDER=thaibulksms, SMS_KEY, SMS_SECRET
 *   - Opensmsth       : SMS_PROVIDER=opensms
 *   - True MOVE H API : SMS_PROVIDER=true
 *
 * วิธีใช้: SMS_PROVIDER ยังไม่ได้ตั้ง → dev mode (log เท่านั้น)
 */

const config = require('../config');

/**
 * ส่ง SMS
 * @param {object} opts
 * @param {string} opts.to    — เบอร์โทร เช่น "0812345678" หรือ "+66812345678"
 * @param {string} opts.body  — ข้อความ SMS
 */
async function sendSMS({ to, body }) {
    // ── DEV mode: log เท่านั้น ─────────────────────────────────────
    if (!config.sms.provider || config.env !== 'production') {
        console.log(`[sms] DEV — To: ${to} | Message: ${body}`);
        return { dev: true };
    }

    // ── Production providers ───────────────────────────────────────
    switch (config.sms.provider) {
        case 'twilio':
            return sendViaTwilio(to, body);
        case 'thaibulksms':
            return sendViaThaibulksms(to, body);
        default:
            console.warn(`[sms] Unknown provider: ${config.sms.provider} — message not sent`);
    }
}

// ── Twilio ─────────────────────────────────────────────────────────────────
async function sendViaTwilio(to, body) {
    // npm install twilio (ถ้าใช้จริง)
    try {
        const twilio = require('twilio');
        const client = twilio(config.sms.accountSid, config.sms.authToken);
        const msg = await client.messages.create({
            body,
            from: config.sms.from,
            to: normalizePhone(to),
        });
        console.log(`[sms] Twilio SID: ${msg.sid}`);
        return msg;
    } catch (err) {
        console.error('[sms] Twilio error:', err.message);
    }
}

// ── Thaibulksms ────────────────────────────────────────────────────────────
async function sendViaThaibulksms(to, body) {
    try {
        const https = require('https');
        const phone = normalizePhone(to).replace('+', '');
        const params = new URLSearchParams({
            username: config.sms.key,
            password: config.sms.secret,
            msisdn:   phone,
            message:  body,
            sender:   'ChaungThai',
        });
        return new Promise((resolve, reject) => {
            const url = `https://www.thaibulksms.com/sms/?${params}`;
            https.get(url, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => { console.log('[sms] Thaibulksms:', data); resolve(data); });
            }).on('error', reject);
        });
    } catch (err) {
        console.error('[sms] Thaibulksms error:', err.message);
    }
}

/** แปลง 0812345678 → +66812345678 */
function normalizePhone(phone) {
    const clean = phone.replace(/[\s\-]/g, '');
    if (clean.startsWith('+')) return clean;
    if (clean.startsWith('0'))  return '+66' + clean.slice(1);
    return clean;
}

module.exports = { sendSMS };
