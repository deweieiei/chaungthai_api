// ============================================================
//  Seed Bulk Workers — ช่างปลอมจำนวนมาก กระจายทั่วประเทศ
//
//  ใช้พิกัดตำบลจริง 7,124 แห่งจาก data/sub_district.json
//  (ครอบคลุม lat 5.7–20.4 / lng 97.6–105.6 = ทั้งประเทศไทย)
//  แล้วสุ่มกระจายรอบตำบลอีก ~2 กม. เพื่อไม่ให้หมุดซ้อนกันเป็นจุดเดียว
//
//  Usage:
//    node scripts/seed_bulk_workers.js --count=1000000
//    node scripts/seed_bulk_workers.js --count=10000 --batch=2000
//    node scripts/seed_bulk_workers.js --count=1000 --dry-run
//
//  ปลอดภัย:
//    - อีเมลเป็น fake_<n>@chaungthai-test.com เสมอ → ลบทิ้งทีหลังได้หมด
//      ด้วย scripts/cleanup_bulk_workers.js
//    - user_password = NULL → บัญชีพวกนี้ "ล็อกอินไม่ได้" (กันบัญชีปลอมล้านตัว
//      กลายเป็นช่องโหว่) ถ้าอยากทดสอบล็อกอิน ตั้งรหัสเฉพาะตัวที่ต้องการทีหลัง
//    - กำหนด user_id / worker_id เองแบบต่อท้ายของเดิม ไม่ชนข้อมูลจริง
//      (innodb_autoinc_lock_mode=2 ทำให้ auto id ไม่การันตีว่าต่อเนื่อง)
// ============================================================

require('dotenv').config();
const mysql = require('mysql2/promise');
const path = require('path');

// ------------------------------------------------------------
//  args
// ------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

const COUNT = Number(args.count) || 1000;
const BATCH = Number(args.batch) || 2000;
const DRY_RUN = Boolean(args['dry-run']);

const EMAIL_DOMAIN = 'chaungthai-test.com';   // ต้องตรงกับสคริปต์ cleanup
const MIN_SKILLS = 1;
const MAX_SKILLS = 5;
const BUSY_RATIO = 0.15;        // 15% กำลังรับงานอยู่ (ไม่ขึ้นแผนที่)
const VERIFIED_RATIO = 0.4;     // 40% ยืนยันตัวตนแล้ว
const JITTER_DEG = 0.018;       // ±~2 กม. รอบจุดตำบล
const BKK_JITTER_DEG = 0.035;   // ±~4 กม. รอบจุดกลางเขต กทม. (จุดหยาบกว่า เลยกระจายกว้างกว่า)

// ------------------------------------------------------------
//  คลังชื่อไทย — คูณกันได้ ~7,700 ชื่อเต็ม (ซ้ำได้ ตามความจริง)
// ------------------------------------------------------------
const FIRST_NAMES = [
  'สมชาย','สมหญิง','สมศักดิ์','สมพร','วิชัย','วิเชียร','ประเสริฐ','ประยุทธ','ประภาส','อนุชา',
  'อนันต์','อดิศักดิ์','ธนพล','ธนากร','ธีระ','ธีรพงษ์','ณรงค์','ณัฐพล','ณัฐวุฒิ','กิตติ',
  'กิตติศักดิ์','เกียรติศักดิ์','จิระ','จรัญ','เจริญ','ชัยวัฒน์','ชาญชัย','ชูชาติ','ดนัย','ดำรง',
  'ทวี','ทองดี','นพดล','นิรันดร์','บุญมี','บุญส่ง','ปรีชา','ปิยะ','พงษ์ศักดิ์','พิชัย',
  'ไพโรจน์','ภาณุ','มานพ','มานะ','ยุทธนา','รังสรรค์','เรวัต','ฤทธิ์','วรวุฒิ','วสันต์',
  'ศักดิ์ชัย','ศิริชัย','สนอง','สุชาติ','สุทธิพงษ์','สุรชัย','สุริยา','เสกสรร','อภิชาติ','อำนาจ',
  'มาลี','สุนีย์','สุพรรณี','วรรณา','จันทร์เพ็ญ','นงลักษณ์','ปราณี','พรทิพย์','ยุพิน','รัตนา',
  'ละออง','วิภา','ศิริพร','สมปอง','สุดา','อรุณี','กาญจนา','ขวัญใจ','จินตนา','ฉวีวรรณ',
  'ณัฐนันท์','ดวงใจ','ทัศนีย์','นภาพร','บุปผา','ปรานอม','พเยาว์','ภาวินี','มธุรส','รุ่งนภา',
];

const LAST_NAMES = [
  'ใจดี','ทองสุข','ศรีสุข','แสงทอง','บุญมาก','พงษ์ไทย','รักไทย','สายทอง','เจริญสุข','มั่นคง',
  'พูนทรัพย์','วงศ์ใหญ่','แก้วมณี','ชัยมงคล','ดวงแก้ว','ตั้งใจ','ถาวร','นาคเงิน','บัวทอง','ปานทอง',
  'ผาสุก','พรหมมา','ภูมิใจ','มณีรัตน์','ยิ่งยง','รุ่งเรือง','ลาภมาก','วารีรัตน์','ศรีเมือง','สกุลทอง',
  'สมบูรณ์','สุขสันต์','เสาวภา','หอมหวล','อินทรา','อุดมทรัพย์','กมลรัตน์','ขจรศักดิ์','คงทน','งามพร้อม',
  'จันทร์แจ่ม','ฉลองชัย','ชูเกียรติ','เชิดชู','ซื่อตรง','ญาณวุฒิ','ฐิติกุล','ณ ลำพูน','ดำรงชัย','เที่ยงธรรม',
  'ธนกิจ','นิลรัตน์','บวรศักดิ์','ประดิษฐ์','พิพัฒน์','เพชรรัตน์','ไพศาล','มงคลชัย','ยอดเยี่ยม','โรจนสิน',
  'ลิ้มไพบูลย์','วัฒนกิจ','ศักดิ์สิทธิ์','สถาพร','เสริมสุข','หาญกล้า','อภิรักษ์','เอี่ยมสะอาด','กิจไพศาล','ขันติ',
  'คำหอม','จรัสแสง','ชโลธร','ณัฐกุล','ดีเลิศ','ธารทอง','นพคุณ','บำรุงราษฎร์','ปัญญาดี','พัฒนกิจ',
];

const RESUMES = [
  'รับงานทั่วไป มีประสบการณ์มากกว่า 5 ปี',
  'ทำงานละเอียด ตรงเวลา รับประกันงาน',
  'รับงานด่วน ติดต่อได้ตลอด',
  'ประสบการณ์ 10 ปี ราคาเป็นกันเอง',
  'รับงานทั้งบ้านและอาคารพาณิชย์',
  'มีเครื่องมือครบ ทำงานสะอาด',
  'รับงานเล็กงานใหญ่ ปรึกษาฟรี',
  null,
];

const RADIUS_CHOICES = [5, 10, 10, 15, 20, 20, 30, 50];

const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const randInt = (min, max) => min + ((Math.random() * (max - min + 1)) | 0);

// ------------------------------------------------------------
//  main
// ------------------------------------------------------------
(async () => {
  const t0 = Date.now();

  // ---- โหลดจุดกระจายหมุด ----
  //  แต่ละจุด = [lat, lng, รัศมีสุ่มรอบจุด (องศา)]
  const subRaw = require(path.join(__dirname, '../data/sub_district.json'));

  //  1) ตำบลที่มีพิกัดจริง
  const points = subRaw
    .filter((s) => s.lat != null && s.long != null)
    .map((s) => [Number(s.lat), Number(s.long), JITTER_DEG]);

  //  2) กรุงเทพฯ — ตำบลทั้ง 170 แห่งใน sub_district.json มี lat/long เป็น null หมด
  //     ถ้าไม่เติมตรงนี้ แผนที่กลางกรุงเทพจะว่างเปล่าทั้งที่เป็นพื้นที่สำคัญที่สุด
  //     จึงใช้พิกัดกลางเขต (50 เขต) แทน แล้วสุ่มกระจายกว้างขึ้นให้เต็มเขต
  const bkk = require(path.join(__dirname, '../data/bangkok_district_geo.json')).districts;
  let bkkPoints = 0;
  for (const s of subRaw) {
    if (s.lat != null && s.long != null) continue;
    const d = bkk[String(s.district_id)];
    if (!d) continue;                       // ตำบลนอก กทม. ที่ขาดพิกัด (158 แห่ง) ข้ามไป
    points.push([d.lat, d.lng, BKK_JITTER_DEG]);
    bkkPoints++;
  }

  if (points.length === 0) {
    console.error('ไม่พบพิกัดสำหรับกระจายหมุดเลย');
    process.exit(1);
  }
  const subdistricts = points;

  console.log('============================================');
  console.log('  Seed Bulk Workers — ช่างปลอมทั่วประเทศ');
  console.log('============================================');
  console.log(`  จำนวนที่จะสร้าง : ${COUNT.toLocaleString('th-TH')} คน`);
  console.log(`  ต่อ batch       : ${BATCH.toLocaleString('th-TH')}`);
  console.log(`  จุดกระจายหมุด    : ${subdistricts.length.toLocaleString('th-TH')} จุด` +
              ` (ตำบล ${(subdistricts.length - bkkPoints).toLocaleString('th-TH')} + กทม.รายเขต ${bkkPoints})`);
  console.log(`  อีเมล           : fake_<n>@${EMAIL_DOMAIN} (ลบทิ้งทีหลังได้)`);
  console.log(`  รหัสผ่าน        : NULL — ล็อกอินไม่ได้`);
  console.log('============================================');

  if (DRY_RUN) {
    console.log('[dry-run] ไม่เขียน DB — ตัวอย่างข้อมูลที่จะสร้าง:');
    for (let i = 0; i < 3; i++) {
      const [lat, lng] = pick(subdistricts);
      console.log('  ', pick(FIRST_NAMES), pick(LAST_NAMES),
        '@', (lat + (Math.random() - 0.5) * JITTER_DEG).toFixed(5),
        (lng + (Math.random() - 0.5) * JITTER_DEG).toFixed(5));
    }
    process.exit(0);
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'chaungthai',
    charset: 'utf8mb4',
  });

  try {
    // ---- skill ids ที่ใช้ได้จริง ----
    const [skillRows] = await conn.query(
      'SELECT skill_id FROM skill_chaungthai WHERE skill_is_active = 1'
    );
    const skillIds = skillRows.map((r) => r.skill_id);
    if (skillIds.length === 0) throw new Error('ไม่มี skill ในระบบ — โหลด seed สกิลก่อน');
    console.log(`  สกิลที่ใช้ได้    : ${skillIds.length} รายการ\n`);

    // ---- หา id เริ่มต้น (เว้นช่องกันชนข้อมูลจริง) ----
    const [[maxU]] = await conn.query('SELECT COALESCE(MAX(user_id), 0) AS m FROM user_chaungthai');
    const [[maxW]] = await conn.query('SELECT COALESCE(MAX(worker_id), 0) AS m FROM worker_chaungthai');
    const startUserId = maxU.m + 1000;
    const startWorkerId = maxW.m + 1000;

    // ---- รันซ้ำได้: ต่อเลขอีเมลจากของเดิม ไม่ให้ fake_0@ ชนกันเอง ----
    const [[fakeMax]] = await conn.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(SUBSTRING(user_email, 6), '@', 1) AS UNSIGNED)), -1) AS m
         FROM user_chaungthai WHERE user_email LIKE ?`,
      [`fake\\_%@${EMAIL_DOMAIN}`]
    );
    // mysql2 คืน BIGINT/DECIMAL มาเป็น string — ไม่แปลงก่อนจะกลายเป็นต่อ string
    // ("-1" + 1 = "-11" แล้วอีเมลเพี้ยนเป็น fake_-110@)
    const startSeq = Number(fakeMax.m) + 1;

    console.log(`  user_id เริ่มที่  : ${startUserId.toLocaleString('th-TH')}`);
    console.log(`  worker_id เริ่มที่: ${startWorkerId.toLocaleString('th-TH')}`);
    console.log(`  เลขอีเมลเริ่มที่  : fake_${startSeq}@${EMAIL_DOMAIN}\n`);

    // ---- ปิด FK check ระหว่าง bulk insert (เร็วขึ้นมาก) ----
    //  *** ไม่ปิด UNIQUE_CHECKS *** — ถ้าปิดแล้วเผลอรันซ้ำ อีเมลซ้ำจะหลุด
    //  เข้าไปอยู่ใน unique index ทำให้ index เสีย แก้ยากกว่าที่ประหยัดได้
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');

    let done = 0;
    let skillRowCount = 0;
    let lastLog = Date.now();

    while (done < COUNT) {
      const n = Math.min(BATCH, COUNT - done);
      const userRows = [];
      const workerRows = [];
      const wsRows = [];

      for (let i = 0; i < n; i++) {
        const seq = done + i;
        const userId = startUserId + seq;
        const workerId = startWorkerId + seq;

        const [baseLat, baseLng, jitter] = pick(subdistricts);
        const lat = +(baseLat + (Math.random() - 0.5) * jitter).toFixed(7);
        const lng = +(baseLng + (Math.random() - 0.5) * jitter).toFixed(7);

        userRows.push([
          userId,
          pick(FIRST_NAMES),
          pick(LAST_NAMES),
          `fake_${startSeq + seq}@${EMAIL_DOMAIN}`,
          null,                                   // user_password = ล็อกอินไม่ได้
          'worker',                               // user_role
          'worker',                               // user_account_type
          Math.random() < VERIFIED_RATIO ? new Date() : null,
        ]);

        workerRows.push([
          workerId,
          userId,
          lat,
          lng,
          pick(RADIUS_CHOICES),
          Math.random() < BUSY_RATIO ? 'busy' : 'free',
          randInt(0, 25),                         // worker_job_tickets
          randInt(0, 80),                         // worker_total_jobs
          pick(RESUMES),
        ]);

        // สกิลของช่างคนนี้ (ไม่ซ้ำกันเอง)
        const k = randInt(MIN_SKILLS, MAX_SKILLS);
        const chosen = new Set();
        while (chosen.size < k) chosen.add(pick(skillIds));
        for (const sid of chosen) wsRows.push([workerId, sid]);
      }

      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO user_chaungthai
          (user_id, user_name, user_lastname, user_email, user_password,
           user_role, user_account_type, user_identity_verified_at)
         VALUES ?`,
        [userRows]
      );
      await conn.query(
        `INSERT INTO worker_chaungthai
          (worker_id, worker_user_id, worker_lat, worker_lng,
           worker_service_radius_km, worker_availability,
           worker_job_tickets, worker_total_jobs, worker_resume)
         VALUES ?`,
        [workerRows]
      );
      await conn.query(
        `INSERT INTO workerskill_chaungthai
          (workerskill_worker_id, workerskill_skill_id) VALUES ?`,
        [wsRows]
      );
      await conn.commit();

      done += n;
      skillRowCount += wsRows.length;

      if (Date.now() - lastLog > 3000 || done === COUNT) {
        const sec = (Date.now() - t0) / 1000;
        const rate = Math.round(done / sec);
        const eta = rate > 0 ? Math.round((COUNT - done) / rate) : 0;
        console.log(
          `  ${done.toLocaleString('th-TH')} / ${COUNT.toLocaleString('th-TH')} คน` +
          `  (${((done / COUNT) * 100).toFixed(1)}%)` +
          `  ${rate.toLocaleString('th-TH')} คน/วิ` +
          (done < COUNT ? `  เหลืออีก ~${eta} วิ` : '')
        );
        lastLog = Date.now();
      }
    }

    await conn.query('SET FOREIGN_KEY_CHECKS = 1');

    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('\n============================================');
    console.log(`  เสร็จใน ${sec} วินาที`);
    console.log(`  ช่าง          : ${done.toLocaleString('th-TH')} คน`);
    console.log(`  แถวสกิล        : ${skillRowCount.toLocaleString('th-TH')}`);
    console.log(`  ลบทิ้ง         : node scripts/cleanup_bulk_workers.js`);
    console.log('============================================');
  } catch (err) {
    console.error('\n[seed] ล้มเหลว:', err.message);
    try { await conn.rollback(); } catch { /* ไม่มี transaction ค้าง */ }
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
})();
