// 換匯與距離計算的測試 (Node 22 內建 test runner，無相依套件)
//   node --test tests/calc.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../site/js/calc.js');

const close = (actual, expected, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `${actual} ≠ ${expected}`);

// 2026-11-24 實際抓到的面額匯率 (Super Rich 總行 / T.T. Exchange Terminal 21)
const SR_TIERS = [
  { denom: '100', min: 100, max: 100, buy: 33.83 },
  { denom: '50', min: 50, max: 50, buy: 33.83 },
  { denom: '20-10', min: 10, max: 20, buy: 33.77 },
  { denom: '5', min: 5, max: 5, buy: 33.72 },
  { denom: '1', min: 1, max: 1, buy: 33.57 },
];
const TT_TIERS = [
  { denom: '100-50', min: 50, max: 100, buy: 33.71 },
  { denom: '20-5', min: 5, max: 20, buy: 33.23 },
  { denom: '2-1', min: 1, max: 2, buy: 32.73 },
];
const BOT_SELL = 33.21;

// ---------------------------------------------------------------- 輸入

test('parseAmount：空值、零、負數、非數字、極大值', () => {
  assert.deepEqual(C.parseAmount(''), { ok: false, value: 0, error: 'empty' });
  assert.equal(C.parseAmount('   ').error, 'empty');
  assert.equal(C.parseAmount(null).error, 'empty');
  assert.equal(C.parseAmount('0').error, 'zero');
  assert.equal(C.parseAmount('-5').error, 'negative');
  assert.equal(C.parseAmount('abc').error, 'nan');
  assert.equal(C.parseAmount('Infinity').error, 'nan');
  assert.equal(C.parseAmount('1e12').error, 'too-large');
  assert.deepEqual(C.parseAmount('10,000'), { ok: true, value: 10000, error: null });
  assert.equal(C.parseAmount(String(C.MAX_AMOUNT)).ok, true);
});

// ---------------------------------------------------------------- 面額

test('parseDenomRange 解析各家面額寫法', () => {
  assert.deepEqual(C.parseDenomRange('100'), { min: 100, max: 100 });
  assert.deepEqual(C.parseDenomRange('20-10'), { min: 10, max: 20 });
  assert.deepEqual(C.parseDenomRange('100-50'), { min: 50, max: 100 });
  assert.deepEqual(C.parseDenomRange('2,000-100'), { min: 100, max: 2000 });
  assert.equal(C.parseDenomRange(null), null);
  assert.equal(C.parseDenomRange('N/A'), null);
});

test('usdRateForBill：每個面額對應正確匯率，沒有資料的面額回傳 null', () => {
  assert.equal(C.usdRateForBill(SR_TIERS, 100), 33.83);
  assert.equal(C.usdRateForBill(SR_TIERS, 50), 33.83);
  assert.equal(C.usdRateForBill(SR_TIERS, 20), 33.77);
  assert.equal(C.usdRateForBill(SR_TIERS, 10), 33.77);
  assert.equal(C.usdRateForBill(SR_TIERS, 5), 33.72);
  assert.equal(C.usdRateForBill(SR_TIERS, 1), 33.57);
  assert.equal(C.usdRateForBill(SR_TIERS, 2), null); // Super Rich 沒有公告 2 元鈔

  assert.equal(C.usdRateForBill(TT_TIERS, 100), 33.71);
  assert.equal(C.usdRateForBill(TT_TIERS, 50), 33.71);
  assert.equal(C.usdRateForBill(TT_TIERS, 20), 33.23);
  assert.equal(C.usdRateForBill(TT_TIERS, 10), 33.23);
  assert.equal(C.usdRateForBill(TT_TIERS, 5), 33.23);
  assert.equal(C.usdRateForBill(TT_TIERS, 1), 32.73);
});

test('usdTiersOf：舊資料只有最大面額時，不把大鈔匯率套到小鈔', () => {
  const legacy = { usdBuy: 33.83, usdDenom: '100' };
  const tiers = C.usdTiersOf(legacy);
  assert.equal(C.usdRateForBill(tiers, 100), 33.83);
  assert.equal(C.usdRateForBill(tiers, 50), null);
  assert.equal(C.usdRateForBill(tiers, 1), null);

  assert.deepEqual(C.usdTiersOf({ usdTiers: SR_TIERS }), SR_TIERS);
  assert.deepEqual(C.usdTiersOf(null), []);
  assert.deepEqual(C.usdTiersOf({ usdBuy: 0, usdDenom: '100' }), []);
});

test('splitUsdBills：以最少張數拆算', () => {
  assert.deepEqual(C.splitUsdBills(387), { 100: 3, 50: 1, 20: 1, 10: 1, 5: 1, 1: 2 });
  assert.deepEqual(C.splitUsdBills(300), { 100: 3, 50: 0, 20: 0, 10: 0, 5: 0, 1: 0 });
  assert.deepEqual(C.splitUsdBills(0.99), { 100: 0, 50: 0, 20: 0, 10: 0, 5: 0, 1: 0 });
  assert.equal(C.sumBills(C.splitUsdBills(1234)), 1234);
});

// ---------------------------------------------------------------- USD 模式

test('usdBillsToThb：各面額分別計算 (Super Rich, US$387)', () => {
  const r = C.usdBillsToThb(C.splitUsdBills(387), SR_TIERS);
  // 300×33.83 + 50×33.83 + 20×33.77 + 10×33.77 + 5×33.72 + 2×33.57
  const expected = 300 * 33.83 + 50 * 33.83 + 20 * 33.77 + 10 * 33.77 + 5 * 33.72 + 2 * 33.57;
  close(r.thb, expected);
  close(r.thb, 13089.34);
  assert.equal(r.usdCounted, 387);
  assert.equal(r.usdMissing, 0);
  // 比「全部用 100 元匯率」的理論值少
  assert.ok(r.thb < 387 * 33.83);
});

test('usdBillsToThb：T.T. Exchange 的 20-5 區間套用同一匯率', () => {
  const r = C.usdBillsToThb({ 100: 2, 20: 1, 5: 1, 1: 3 }, TT_TIERS);
  close(r.thb, 200 * 33.71 + 25 * 33.23 + 3 * 32.73);
  assert.equal(r.usdCounted, 228);
});

test('usdBillsToThb：沒有對應面額匯率的鈔票不計入並回報', () => {
  const r = C.usdBillsToThb({ 100: 1, 1: 4 }, [{ denom: '100', min: 100, max: 100, buy: 33.83 }]);
  close(r.thb, 3383);
  assert.equal(r.usdCounted, 100);
  assert.equal(r.usdMissing, 4);
  assert.deepEqual(r.missingBills, [1]);
});

// ---------------------------------------------------------------- TWD 模式

test('twdDirect：與修改前的計算一致 (NT$100 的倍數)', () => {
  for (const twd of [5000, 10000, 30000, 50000]) {
    close(C.twdDirect(twd, 1.035).thb, twd * 1.035);
  }
  assert.equal(C.twdDirect(10000, 0), null);
});

test('twdDirect：未滿 NT$100 的零頭不計', () => {
  const r = C.twdDirect(10050, 1.035);
  close(r.thb, 10000 * 1.035);
  assert.equal(r.twdExchanged, 10000);
  assert.equal(r.twdLeft, 50);
});

test('twdViaUsd：NT$10,000 只買得到 3 張 100 元，餘額 NT$37 不足 100 未換', () => {
  const r = C.twdViaUsd(10000, BOT_SELL, SR_TIERS, 1.035);
  assert.equal(r.ok, true);
  assert.equal(r.bills, 3);
  assert.equal(r.usd, 300);
  assert.equal(r.twdSpent, 9963);
  assert.equal(r.twdRemainder, 37);
  assert.equal(r.twdRemainderExchanged, 0);
  assert.equal(r.twdLeft, 37);
  close(r.thb, 300 * 33.83);
  // 舊版理論值 (可分割美金) 較高，只供對照
  close(r.theoreticalThb, 10000 / 33.21 * 33.83);
  assert.ok(r.theoreticalThb > r.thb);
});

test('twdViaUsd：餘額 ≥ NT$100 在同一家直接換台幣，且沒有浮點誤差', () => {
  // 5021 - 3321 = 1700：浮點運算若沒處理會變成 1699.999… 而少算一張
  const r = C.twdViaUsd(5021, BOT_SELL, SR_TIERS, 1.035);
  assert.equal(r.bills, 1);
  assert.equal(r.twdRemainder, 1700);
  assert.equal(r.twdRemainderExchanged, 1700);
  assert.equal(r.twdLeft, 0);
  close(r.thb, 100 * 33.83 + 1700 * 1.035);
});

test('twdViaUsd：金額剛好買整數張', () => {
  const r = C.twdViaUsd(9963, BOT_SELL, SR_TIERS, 1.035);
  assert.equal(r.bills, 3);
  assert.equal(r.twdLeft, 0);
});

test('twdViaUsd：金額不足一張、缺台銀或缺 100 元匯率', () => {
  assert.deepEqual(C.twdViaUsd(3000, BOT_SELL, SR_TIERS, 1.035), { ok: false, reason: 'not-enough', costPerBill: 3321 });
  assert.equal(C.twdViaUsd(10000, 0, SR_TIERS, 1.035).reason, 'no-bot');
  assert.equal(C.twdViaUsd(10000, BOT_SELL, [{ denom: '20-10', min: 10, max: 20, buy: 33.7 }], 1.035).reason, 'no-usd-rate');
});

test('twdViaUsd：兌換所沒有台幣匯率時，餘額保留為台幣', () => {
  const r = C.twdViaUsd(5021, BOT_SELL, SR_TIERS, 0);
  assert.equal(r.thbFromTwd, 0);
  assert.equal(r.twdLeft, 1700);
  close(r.thb, 3383);
});

// ---------------------------------------------------------------- 距離

test('haversineKm：已知距離', () => {
  assert.equal(C.haversineKm(13.75, 100.5, 13.75, 100.5), 0);
  // 赤道上經度差 1 度 ≈ 111.19 公里
  close(C.haversineKm(0, 0, 0, 1), 111.195, 0.01);
  // Super Rich 水門 → 蘇凡納布機場，直線約 23.4 公里
  close(C.haversineKm(13.7484897, 100.5416936, 13.6924722, 100.7509648), 23.45, 0.05);
  // 對稱
  close(C.haversineKm(13.7, 100.5, 12.9, 100.9), C.haversineKm(12.9, 100.9, 13.7, 100.5));
});

test('isValidCoord：排除缺漏、超出範圍與 (0,0)', () => {
  assert.equal(C.isValidCoord(13.75, 100.53), true);
  assert.equal(C.isValidCoord(null, 100.53), false);
  assert.equal(C.isValidCoord('13.75', 100.53), false);
  assert.equal(C.isValidCoord(91, 100), false);
  assert.equal(C.isValidCoord(13, 181), false);
  assert.equal(C.isValidCoord(0, 0), false);
  assert.equal(C.isValidCoord(NaN, 100), false);
});

test('directionsUrl：Google Maps 導航網址只含目的地座標', () => {
  assert.equal(C.directionsUrl(13.7484897, 100.5416936),
    'https://www.google.com/maps/dir/?api=1&destination=13.7484897%2C100.5416936');
});

// ---------------------------------------------------------------- 分店資料

test('exchange-shops.json：id 唯一、座標有效、對應到 rates.json 的來源', async () => {
  const { readFile } = await import('node:fs/promises');
  const shops = JSON.parse(await readFile(new URL('../site/data/exchange-shops.json', import.meta.url), 'utf8'));
  const rates = JSON.parse(await readFile(new URL('../site/data/rates.json', import.meta.url), 'utf8'));
  const ids = new Set();
  for (const b of shops.branches) {
    assert.ok(b.id && !ids.has(b.id), `重複或缺少 id：${b.id}`);
    ids.add(b.id);
    assert.ok(C.isValidCoord(b.latitude, b.longitude), `${b.id} 座標無效`);
    assert.ok(rates.sources[b.rateSource], `${b.id} 的 rateSource 不存在：${b.rateSource}`);
    assert.ok(b.lastVerifiedAt, `${b.id} 缺少 lastVerifiedAt`);
    // 未查證的營業時間必須是 null，不可填猜測值
    assert.ok(b.openingHours === null || typeof b.openingHours === 'object');
  }
});
