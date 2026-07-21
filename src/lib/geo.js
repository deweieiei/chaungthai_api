// ============================================================
//  Geo helpers — พิกัด + การเปิดเผยตำแหน่ง 2 ระดับ
//  อ้างอิง: Desktop\Linux\chaungthai\docs\04_ระบบแผนที่.md
// ============================================================

// ขนาดกริดสำหรับเบลอพิกัด ≈ 1 กม.
const GRID = 0.009;

// ขอบเขตประเทศไทยแบบหลวมๆ — กันคนยิงพิกัดมั่วเข้ามา
const TH_BOUNDS = { minLat: 5.0, maxLat: 21.0, minLng: 96.0, maxLng: 106.5 };

/**
 * เบลอพิกัดด้วยการ "ปัดลงกริด" ไม่ใช่สุ่ม
 *
 * ทำไมไม่สุ่ม: ถ้าสุ่มจุดใหม่ทุกครั้งที่เรียก คนไม่หวังดีกด refresh 100 ครั้ง
 * แล้วเอาพิกัดมาเฉลี่ย = ได้ตำแหน่งจริง
 * ปัดลงกริด: พิกัดเดิมได้จุดเบลอเดิมเสมอ → รู้ได้แค่ "อยู่ในช่องกริด 1 กม. นี้"
 */
function blurCoord(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // ปัด 7 ตำแหน่งกัน floating point noise (18.791999999999998 → 18.792)
  return Number((Math.round(n / GRID) * GRID).toFixed(7));
}

/**
 * ตรวจพิกัดที่รับจาก client
 * คืน { ok: true, lat, lng } หรือ { ok: false, error }
 */
function parseLatLng(latRaw, lngRaw) {
  const lat = Number(latRaw);
  const lng = Number(lngRaw);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: 'พิกัด (lat/lng) ต้องเป็นตัวเลข' };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, error: 'พิกัดอยู่นอกช่วงที่เป็นไปได้' };
  }
  if (
    lat < TH_BOUNDS.minLat || lat > TH_BOUNDS.maxLat ||
    lng < TH_BOUNDS.minLng || lng > TH_BOUNDS.maxLng
  ) {
    return { ok: false, error: 'ตอนนี้เปิดให้บริการเฉพาะในประเทศไทย' };
  }

  // เก็บ 7 ตำแหน่งทศนิยมให้ตรงกับ DECIMAL(10,7)
  return { ok: true, lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)) };
}

/**
 * แปลงกรอบแผนที่ที่ผู้ใช้เห็น → เงื่อนไข SQL
 * รับสตริง "min_lat,min_lng,max_lat,max_lng" (เหมือน Leaflet map.getBounds().toBBoxString() สลับลำดับ)
 */
function parseBBox(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: 'bbox ต้องเป็นสตริง "min_lat,min_lng,max_lat,max_lng"' };
  }
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return { ok: false, error: 'bbox ต้องเป็นตัวเลข 4 ตัวคั่นด้วยจุลภาค' };
  }
  const [minLat, minLng, maxLat, maxLng] = parts;
  if (minLat > maxLat || minLng > maxLng) {
    return { ok: false, error: 'bbox กลับด้าน (ค่า min ต้องน้อยกว่า max)' };
  }
  return { ok: true, minLat, minLng, maxLat, maxLng };
}

/**
 * กรอบสี่เหลี่ยมคร่าวๆ รอบจุดหนึ่ง ตามรัศมีเป็นกิโลเมตร
 * ใช้กรองหยาบใน SQL ก่อน แล้วค่อยคำนวณระยะจริงด้วย Haversine
 */
function bboxFromRadius(lat, lng, radiusKm) {
  const latDelta = radiusKm / 111.0;
  // ลองจิจูดหดตามละติจูด — ที่เส้นศูนย์สูตรกว้างสุด
  const cos = Math.cos((lat * Math.PI) / 180);
  const lngDelta = radiusKm / (111.0 * (Math.abs(cos) < 0.01 ? 0.01 : cos));
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}

/** ระยะทางระหว่าง 2 พิกัด (กม.) — สูตร Haversine */
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * ตัดสินว่าคนที่กำลังดู ควรเห็นพิกัดจริงหรือพิกัดเบลอ
 *
 * | ใครดู                          | เห็นอะไร            |
 * |--------------------------------|---------------------|
 * | ไม่ล็อกอิน / ยังไม่ยืนยันตัวตน   | พิกัดเบลอ ~1 กม.    |
 * | ยืนยันตัวตนแล้ว                 | พิกัดจริง            |
 * | เจ้าของหมุดเอง                  | พิกัดจริง            |
 *
 * @param {object|null} viewer  - req.user (JWT payload) หรือ null
 * @param {object} opts         - { isOwner, viewerVerified }
 */
function canSeeExactLocation(viewer, { isOwner = false, viewerVerified = false } = {}) {
  if (isOwner) return true;
  if (!viewer) return false;
  return Boolean(viewerVerified);
}

/**
 * คืนพิกัดที่พร้อมส่งออก API + บอกว่าเบลอหรือไม่
 * ใช้กับทุก endpoint ที่ส่งตำแหน่งช่างออกไป เพื่อให้กฎอยู่ที่เดียว
 */
function publicCoords(lat, lng, exact) {
  if (lat === null || lat === undefined || lng === null || lng === undefined) {
    return { lat: null, lng: null, is_blurred: false };
  }
  if (exact) {
    return { lat: Number(lat), lng: Number(lng), is_blurred: false };
  }
  return { lat: blurCoord(lat), lng: blurCoord(lng), is_blurred: true };
}

module.exports = {
  GRID,
  TH_BOUNDS,
  blurCoord,
  parseLatLng,
  parseBBox,
  bboxFromRadius,
  distanceKm,
  canSeeExactLocation,
  publicCoords,
};
