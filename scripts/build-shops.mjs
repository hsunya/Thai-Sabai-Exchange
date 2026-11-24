// 從各家官方來源產生分店資料 site/data/exchange-shops.json。
// 分店地址、座標、營業時間很少變動，所以不放進每 30 分鐘的排程，需要更新時手動執行：
//   node scripts/build-shops.mjs
// 執行後請檢查 git diff 再 commit。
//
// 來源：
//   Super Rich   api.superrichthailand.com/api/v1/branch-client/options、/branch-client/:id (官網分店頁使用的 API)
//   T.T. Exchange api.ttexchange.com/stores (官網分店頁使用的 API)
//   Happy Rich   官網沒有 API，維持 exchange-shops.json 裡 dataSource 為 "manual" 的手動資料
//
// 原則：官方資料缺漏或格式不明的欄位一律留 null / 省略，不推測。

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'site', 'data', 'exchange-shops.json');
const TIMEOUT_MS = 15000;
const TODAY = new Date().toISOString().slice(0, 10);
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

// 同時最多 limit 個請求，避免對官方 API 造成負擔
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

function coord(value) {
  const n = parseFloat(String(value ?? '').trim());
  return Number.isFinite(n) ? n : null;
}

function validCoord(lat, lng) {
  return lat != null && lng != null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);
}

const clean = (s) => (s == null ? null : String(s).replace(/\s*\n\s*/g, ', ').replace(/\s+/g, ' ').trim() || null);

// 地區篩選用的大範圍分區。官方地址很多只寫樓層、沒有城市，所以依座標與兩個中心點的直線距離劃分：
//   曼谷都會區 (含蘇凡納布機場、暖武里、北欖) ：距曼谷市中心 45 公里內
//   芭達雅一帶 (含 Naklua、Jomtien)           ：距芭達雅市中心 20 公里內
// 其餘再用地址關鍵字判斷，仍無法判斷就是 null。
const REGIONS = [
  { name: '曼谷都會區', lat: 13.7563, lng: 100.5018, km: 45 },
  { name: '芭達雅一帶', lat: 12.9236, lng: 100.8825, km: 20 },
];

function haversineKm(lat1, lng1, lat2, lng2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function regionOf(lat, lng, address) {
  for (const z of REGIONS) {
    if (haversineKm(lat, lng, z.lat, z.lng) <= z.km) return z.name;
  }
  const a = String(address ?? '');
  if (/si\s?racha|sriracha|ศรีราชา/i.test(a)) return '是拉差';
  if (/chon\s?buri|ชลบุรี/i.test(a)) return '春武里';
  return null;
}

// ---------------------------------------------------------------- Super Rich

// API 的時間是 "1970-01-01T02:00:00.000Z" 這種 UTC 時刻，泰國是 UTC+7 (無日光節約)
function srTime(iso) {
  const m = /T(\d{2}):(\d{2})/.exec(iso ?? '');
  if (!m) return null;
  const h = (Number(m[1]) + 7) % 24;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

// dayOpen / dayhOpen / dayClose 用 1 = 週一 … 7 = 週日；非整數 (官方資料打錯，例如 6.7) 的日子視為未確認
function srHours(d) {
  const hours = {};
  const set = (days, value) => {
    for (const day of Array.isArray(days) ? days : []) {
      if (Number.isInteger(day) && day >= 1 && day <= 7 && value) hours[WEEKDAYS[day % 7]] = value;
    }
  };
  const open = srTime(d.timeOpen), close = srTime(d.timeClose);
  const hOpen = srTime(d.timehOpen), hClose = srTime(d.timehClose);
  set(d.dayOpen, open && close ? `${open}-${close}` : null);
  set(d.dayhOpen, hOpen && hClose ? `${hOpen}-${hClose}` : null);
  set(d.dayClose, 'closed');
  return Object.keys(hours).length ? hours : null;
}

async function buildSuperRich() {
  const headers = { 'X-Language-Code': 'en' };
  const base = 'https://api.superrichthailand.com/api/v1';
  const options = (await getJson(`${base}/branch-client/options`, headers)).data ?? [];
  const details = await mapLimit(options, 4, async (opt) => {
    try {
      return { opt, d: (await getJson(`${base}/branch-client/${opt.value}`, headers)).data };
    } catch (err) {
      console.log(`SKIP  Super Rich ${opt.value} ${opt.label}：${err.message}`);
      return null;
    }
  });

  const branches = [];
  for (const item of details) {
    if (!item?.d) continue;
    const { opt, d } = item;
    const lat = coord(d.latitude), lng = coord(d.longitude);
    if (!validCoord(lat, lng)) { console.log(`SKIP  Super Rich ${opt.value} ${opt.label}：座標無效`); continue; }
    if (d.isOpen === false) { console.log(`SKIP  Super Rich ${opt.value} ${opt.label}：官網標示未營業`); continue; }
    const address = clean(d.address);
    const note = [clean(d.weekday), clean(d.weekend), clean(d.holiday)].filter(Boolean).join('；');
    branches.push({
      id: `superrich-${opt.value}`,
      brand: 'Super Rich',
      branchName: clean(opt.label),
      city: regionOf(lat, lng, address),
      area: clean(opt.label),
      address,
      phone: null,
      latitude: lat,
      longitude: lng,
      openingHours: srHours(d),
      openingHoursNote: note ? `官網原文：${note}` : null,
      supportedCurrencies: null,
      rateKey: `superrich:${opt.value}`,
      rateScope: 'branch',
      rateScopeNote: `匯率為 Super Rich 官方 API 此分店 (branchId=${opt.value}) 公告`,
      googleMapsUrl: d.googleLink || null,
      lastVerifiedAt: TODAY,
      verification: `地址、座標、營業時間取自 Super Rich 官方分店 API (branch-client/${opt.value})`,
      dataSource: 'superrich-api',
    });
  }
  return branches;
}

// ---------------------------------------------------------------- T.T. Exchange

// opening_time 的 key 是 "0"…"6"，0 = 週日 (Rajchawaroon Road 分店 0、6 公休可驗證)
function ttHours(openingTime) {
  if (!openingTime || typeof openingTime !== 'object') return null;
  const hours = {};
  for (const [key, v] of Object.entries(openingTime)) {
    const day = WEEKDAYS[Number(key)];
    if (!day || !v) continue;
    if (v.status === 'close') { hours[day] = 'closed'; continue; }
    if (v.status === 'open' && /^\d{2}:\d{2}$/.test(v.from_time) && /^\d{2}:\d{2}$/.test(v.to_time)) {
      hours[day] = `${v.from_time}-${v.to_time}`;
    }
    // "Invalid date" 等格式不明的值 → 不寫入 (未確認)
  }
  return Object.keys(hours).length ? hours : null;
}

async function buildTT() {
  const stores = await getJson('https://api.ttexchange.com/stores');
  const branches = [];
  for (const s of Array.isArray(stores) ? stores : []) {
    const lat = coord(s.lat), lng = coord(s.lng);
    if (!validCoord(lat, lng)) { console.log(`SKIP  T.T. ${s.id} ${s.name}：座標無效`); continue; }
    if (!s.branch_id) { console.log(`SKIP  T.T. ${s.id} ${s.name}：沒有 branch_id，無法對應匯率`); continue; }
    const name = clean(String(s.name).replace(/^[A-Z0-9]+\s*:\s*/, ''));
    const address = clean(s.address);
    branches.push({
      id: `tt-${s.id}`,
      brand: 'T.T. Exchange',
      branchName: name,
      city: regionOf(lat, lng, address),
      area: clean(s.store_group_name),
      address,
      phone: clean(s.phone),
      latitude: lat,
      longitude: lng,
      openingHours: ttHours(s.opening_time),
      openingHoursNote: null,
      supportedCurrencies: null,
      rateKey: `tt:${s.branch_id}`,
      rateScope: 'branch',
      rateScopeNote: `匯率為 T.T. Exchange 官方 API 此分店 (branch_id=${s.branch_id}) 公告`,
      googleMapsUrl: null,
      lastVerifiedAt: TODAY,
      verification: `地址、電話、座標、營業時間取自 T.T. Exchange 官方 stores API (store id ${s.id})`,
      dataSource: 'tt-api',
    });
  }
  return branches;
}

// ---------------------------------------------------------------- 主程式

const current = JSON.parse(await readFile(OUTPUT, 'utf8'));
const manual = (current.branches ?? []).filter((b) => b.dataSource === 'manual');

const generated = [];
for (const [name, build] of [['Super Rich', buildSuperRich], ['T.T. Exchange', buildTT]]) {
  try {
    const list = await build();
    console.log(`OK    ${name}：${list.length} 家`);
    generated.push(...list);
  } catch (err) {
    // 某個來源整個失敗時保留舊資料，避免分店清單被清空
    const keep = (current.branches ?? []).filter((b) => b.brand === name && b.dataSource !== 'manual');
    console.log(`FAIL  ${name}：${err.message}，保留原本 ${keep.length} 家`);
    generated.push(...keep);
    process.exitCode = 1;
  }
}

const branches = [...manual, ...generated];
const ids = new Set();
for (const b of branches) {
  if (ids.has(b.id)) throw new Error(`分店 id 重複：${b.id}`);
  ids.add(b.id);
  if (!b.city) console.log(`WARN  ${b.id} 無法從地址判斷城市：${b.address}`);
}

const output = {
  schemaVersion: 2,
  description: current.description,
  generatedAt: new Date().toISOString(),
  branches,
};
await writeFile(OUTPUT, JSON.stringify(output, null, 2) + '\n', 'utf8');
console.log(`已寫入 ${OUTPUT}：共 ${branches.length} 家 (手動 ${manual.length}、自動 ${generated.length})`);
