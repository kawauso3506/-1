/**
 * BingXデモ（VST）専用の発注リレー / Cloudflare Worker
 * シークレット: BINGX_API_KEY / BINGX_API_SECRET / ACCESS_TOKEN
 * 任意: BASE_URL（既定はデモ https://open-api-vst.bingx.com）
 * 追加: /server/state・/server/cmd（Durable Objectの常駐エンジン）
 * 対応: /market/* /balance /positions /contracts /leverage /order /bracket /bracket-only /cancel-all /close /close-all
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

function checkAuth(req, env) {
  const got = req.headers.get("authorization") || "";
  const want = "Bearer " + (env.ACCESS_TOKEN || "");
  return env.ACCESS_TOKEN && got === want;
}

async function sign(secret, paramString) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(paramString));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function buildParamString(params) {
  const keys = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== null).sort();
  return keys.map((k) => `${k}=${params[k]}`).join("&");
}

async function bingxRequest(env, method, path, params = {}) {
  const base = env.BASE_URL || "https://open-api-vst.bingx.com";
  const full = { ...params, timestamp: Date.now(), recvWindow: 5000 };
  const paramString = buildParamString(full);
  const signature = await sign(env.BINGX_API_SECRET, paramString);
  const url = `${base}${path}?${paramString}&signature=${signature}`;
  const r = await fetch(url, { method, headers: { "X-BX-APIKEY": env.BINGX_API_KEY } });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  if (data && typeof data === "object") { const m = text.match(/"orderId"\s*:\s*"?(\d+)"?/); if (m) data._orderId = m[1]; }
  if (!r.ok || (data && typeof data.code !== "undefined" && data.code !== 0)) {
    throw { httpStatus: r.ok ? 200 : r.status, bingxCode: data && data.code, body: data };
  }
  return data;
}

function toBingxSymbol(sym) {
  if (sym.includes("-")) return sym;
  return sym.replace(/USDT$/, "-USDT");
}

// 損切り/利確（取引所側に置く条件付き成行注文）
async function placeTriggers(env, b, isDemo) {
  const sym = toBingxSymbol(b.symbol);
  const closeSide = b.positionSide === "LONG" ? "SELL" : "BUY";
  const placed = [], errors = [], ids = {};
  const place = async (which, type, price) => {
    try {
      const rr = await bingxRequest(env, "POST", "/openApi/swap/v2/trade/order", {
        symbol: sym, side: closeSide, positionSide: b.positionSide,
        type, quantity: b.quantity, stopPrice: price, workingType: "MARK_PRICE",
      });
      placed.push(which);
      if (rr && rr._orderId) ids[which] = rr._orderId;
    } catch (e) {
      errors.push({ which, detail: e.body || e.message || String(e) });
    }
  };
  if (b.slPrice) await place("sl", "STOP_MARKET", b.slPrice);
  if (b.tpPrice) await place("tp", "TAKE_PROFIT_MARKET", b.tpPrice);
  return { demo: isDemo, placed, errors, ids };
}

async function route(req, env) {
    const u = new URL(req.url);
    const isDemo = (env.BASE_URL || "https://open-api-vst.bingx.com").includes("vst");
    const BASE = env.BASE_URL || "https://open-api-vst.bingx.com";
    // 価格データ（ティッカー・資金調達率・マーク価格）は、常に本番市場の公開データを使う。
    // デモ環境は取引が少なく、最終約定価格が止まったままになる銘柄があるため（注文はデモ口座へ出す）
    const MARKET_BASE = "https://open-api.bingx.com";

    try {
      if (req.method === "GET" && u.pathname === "/market/ticker") {
        const symbol = u.searchParams.get("symbol");
        const qs = symbol ? "?symbol=" + encodeURIComponent(toBingxSymbol(symbol)) : "";
        const r = await fetch(MARKET_BASE + "/openApi/swap/v2/quote/ticker" + qs);
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
        return json({ demo: isDemo, result: data }, r.ok ? 200 : r.status);
      }
      if (req.method === "GET" && u.pathname === "/market/premiumIndex") {
        const symbol = u.searchParams.get("symbol");
        const qs = symbol ? "?symbol=" + encodeURIComponent(toBingxSymbol(symbol)) : "";
        const r = await fetch(MARKET_BASE + "/openApi/swap/v2/quote/premiumIndex" + qs);
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
        return json({ demo: isDemo, result: data }, r.ok ? 200 : r.status);
      }
      if (req.method === "GET" && u.pathname === "/market/klines") {
        const symbol = u.searchParams.get("symbol"), interval = u.searchParams.get("interval") || "1h", limit = u.searchParams.get("limit") || "100";
        if (!symbol) return json({ error: "symbol is required" }, 400);
        // ろうそく（K線）は公開データで署名不要。実勢の値動きを見るため、常にリアル環境（デモではなく本番の公開API）から取得する
        let qs = "?symbol=" + encodeURIComponent(toBingxSymbol(symbol)) + "&interval=" + encodeURIComponent(interval) + "&limit=" + encodeURIComponent(limit);
        const et = u.searchParams.get("endTime"); if (et && /^\d+$/.test(et)) qs += "&endTime=" + et; // 過去にさかのぼって取得する用
        const r = await fetch("https://open-api.bingx.com/openApi/swap/v3/quote/klines" + qs);
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
        return json({ demo: isDemo, result: data }, r.ok ? 200 : r.status);
      }

      // 先物×現物の監視用（公開データ・署名不要。常に本番市場から取得）
      if (req.method === "GET" && ["/market/spot-ticker","/market/spot-trades","/market/trades","/market/oi"].includes(u.pathname)) {
        const symbol = u.searchParams.get("symbol"), limit = u.searchParams.get("limit") || "100";
        const P = {"/market/spot-ticker":"/openApi/spot/v1/ticker/24hr", "/market/spot-trades":"/openApi/spot/v1/market/trades", "/market/trades":"/openApi/swap/v2/quote/trades", "/market/oi":"/openApi/swap/v2/quote/openInterest"}[u.pathname];
        let qs = "?timestamp=" + Date.now();
        if (u.pathname !== "/market/spot-ticker"){ if (!symbol) return json({ error: "symbol is required" }, 400); qs += "&symbol=" + encodeURIComponent(toBingxSymbol(symbol)); }
        if (u.pathname === "/market/spot-trades" || u.pathname === "/market/trades") qs += "&limit=" + encodeURIComponent(limit);
        const r = await fetch(MARKET_BASE + P + qs);
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
        return json({ demo: isDemo, result: data }, r.ok ? 200 : r.status);
      }

      // 未約定の注文一覧（切り替え時の後片付け用。symbolなし＝全銘柄）
      if (req.method === "GET" && u.pathname === "/open-orders") {
        const symbol = u.searchParams.get("symbol");
        const r = await bingxRequest(env, "GET", "/openApi/swap/v2/trade/openOrders", symbol ? { symbol: toBingxSymbol(symbol) } : {});
        return json({ demo: isDemo, result: r });
      }
      if (req.method === "GET" && u.pathname === "/balance") {
        const r = await bingxRequest(env, "GET", "/openApi/swap/v2/user/balance");
        return json({ demo: isDemo, result: r });
      }
      if (req.method === "GET" && u.pathname === "/positions") {
        const symbol = u.searchParams.get("symbol");
        const r = await bingxRequest(env, "GET", "/openApi/swap/v2/user/positions", symbol ? { symbol: toBingxSymbol(symbol) } : {});
        return json({ demo: isDemo, result: r });
      }
      if (req.method === "GET" && u.pathname === "/contracts") {
        const symbol = u.searchParams.get("symbol");
        const r = await bingxRequest(env, "GET", "/openApi/swap/v2/quote/contracts", symbol ? { symbol: toBingxSymbol(symbol) } : {});
        return json({ demo: isDemo, result: r });
      }

      if (req.method === "GET" && u.pathname === "/leverage") {
        const symbol = u.searchParams.get("symbol"), side = u.searchParams.get("side") || "LONG";
        if (!symbol) return json({ error: "symbol is required" }, 400);
        const r = await bingxRequest(env, "GET", "/openApi/swap/v2/trade/leverage", { symbol: toBingxSymbol(symbol), side });
        return json({ demo: isDemo, result: r });
      }
      if (req.method === "POST" && u.pathname === "/leverage") {
        const b = await req.json();
        if (!b.symbol || !b.side || !b.leverage) return json({ error: "symbol, side, leverage は必須です" }, 400);
        const r = await bingxRequest(env, "POST", "/openApi/swap/v2/trade/leverage", {
          symbol: toBingxSymbol(b.symbol), side: b.side, leverage: b.leverage,
        });
        return json({ demo: isDemo, result: r });
      }

      // 成行注文（新規）
      if (req.method === "POST" && u.pathname === "/order") {
        const b = await req.json();
        if (!b.symbol || !b.side || !b.positionSide || !b.quantity) {
          return json({ error: "symbol, side, positionSide, quantity は必須です" }, 400);
        }
        const r = await bingxRequest(env, "POST", "/openApi/swap/v2/trade/order", {
          symbol: toBingxSymbol(b.symbol), side: b.side, positionSide: b.positionSide,
          type: "MARKET", quantity: b.quantity,
        });
        return json({ demo: isDemo, result: r });
      }

      // 損切り/利確だけを置く（エントリー済みのポジション用）
      if (req.method === "POST" && u.pathname === "/bracket-only") {
        const b = await req.json();
        if (!b.symbol || !b.positionSide || !b.quantity) {
          return json({ error: "symbol, positionSide, quantity は必須です" }, 400);
        }
        return json(await placeTriggers(env, b, isDemo));
      }

      // 成行エントリー＋損切り/利確を一度に
      if (req.method === "POST" && u.pathname === "/bracket") {
        const b = await req.json();
        if (!b.symbol || !b.side || !b.positionSide || !b.quantity) {
          return json({ error: "symbol, side, positionSide, quantity は必須です" }, 400);
        }
        const entry = await bingxRequest(env, "POST", "/openApi/swap/v2/trade/order", {
          symbol: toBingxSymbol(b.symbol), side: b.side, positionSide: b.positionSide,
          type: "MARKET", quantity: b.quantity,
        });
        const t = await placeTriggers(env, b, isDemo);
        return json({ demo: isDemo, result: entry, placed: t.placed, errors: t.errors });
      }

      // 注文を1件だけ取消（損切りラインの引き上げで、古い注文を外すのに使う）
      if (req.method === "POST" && u.pathname === "/cancel-order") {
        const b = await req.json().catch(() => ({}));
        if (!b.symbol || !b.orderId) return json({ error: "symbol, orderId は必須です" }, 400);
        const r = await bingxRequest(env, "DELETE", "/openApi/swap/v2/trade/order", { symbol: toBingxSymbol(b.symbol), orderId: String(b.orderId) });
        return json({ demo: isDemo, result: r });
      }

      // 銘柄の未約定注文をすべて取消
      if (req.method === "POST" && u.pathname === "/cancel-all") {
        const b = await req.json().catch(() => ({}));
        if (!b.symbol) return json({ error: "symbol は必須です" }, 400);
        const r = await bingxRequest(env, "DELETE", "/openApi/swap/v2/trade/allOpenOrders", { symbol: toBingxSymbol(b.symbol) });
        return json({ demo: isDemo, result: r });
      }

      // 決済（反対売買）
      if (req.method === "POST" && u.pathname === "/close") {
        const b = await req.json();
        if (!b.symbol || !b.positionSide || !b.quantity) {
          return json({ error: "symbol, positionSide, quantity は必須です" }, 400);
        }
        const r = await bingxRequest(env, "POST", "/openApi/swap/v2/trade/order", {
          symbol: toBingxSymbol(b.symbol),
          side: b.positionSide === "LONG" ? "SELL" : "BUY",
          positionSide: b.positionSide, type: "MARKET", quantity: b.quantity,
        });
        return json({ demo: isDemo, result: r });
      }

      if (req.method === "POST" && u.pathname === "/close-all") {
        const b = await req.json().catch(() => ({}));
        const r = await bingxRequest(env, "POST", "/openApi/swap/v2/trade/closeAllPositions", b.symbol ? { symbol: toBingxSymbol(b.symbol) } : {});
        return json({ demo: isDemo, result: r });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: "bingx_request_failed", detail: e.body || e.message || String(e), httpStatus: e.httpStatus }, 502);
    }
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!checkAuth(req, env)) return json({ error: "unauthorized" }, 401);
    const u = new URL(req.url);
    if (u.pathname.startsWith("/server/")){
      if (!env.ENGINE) return json({ error: "Durable Objectのバインディング ENGINE が未設定です" }, 500);
      const stub = env.ENGINE.get(env.ENGINE.idFromName("main"));
      const r = await stub.fetch(req);
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });
    }
    return route(req, env);
  },
};

// ============================================================
// 常駐エンジン（Durable Object）: ブラウザ版と同じ売買ロジックを、Cloudflare側で動かす
// ============================================================
const START_USD = 500, POLL_OVERRIDE = 0, WARP = 1;


let PROXY = "", RELAY_URL = "internal", RELAY_TOKEN = "internal", LIVE_MAX = 5;
let ENV = null, MEM = new Map(), DIRTY = new Set();
const PENDING = new Set();
const store = {
  get(k){ return MEM.get(k) || ""; },
  set(k,v){ MEM.set(k,v); DIRTY.add(k); }
};
// エンジンからのリレー呼び出しは、ネットワークを通さず同じWorker内のroute()へ直接渡す
async function relay(path, method, body){
  const p = (async () => {
    const req = new Request("https://internal" + path, {
      method: method || "GET",
      headers: { authorization: "Bearer " + ENV.ACCESS_TOKEN, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const r = await route(req, ENV);
    const j = await r.json().catch(()=>({}));
    if (!r.ok || j.error) throw new Error(j.error ? (j.error+(j.detail?": "+(typeof j.detail==="string"?j.detail:JSON.stringify(j.detail)):"")) : ("HTTP "+r.status));
    return j;
  })();
  PENDING.add(p);
  p.then(()=>PENDING.delete(p), ()=>PENDING.delete(p));
  return p;
}
async function drain(){
  // 画面側の処理と違い、注文などの非同期処理が終わる前にアラームを終えないよう待つ
  for (let i=0;i<20;i++){
    if (!PENDING.size) return;
    await Promise.allSettled([...PENDING]);
    await new Promise(r=>setTimeout(r,0));
  }
}
async function fetchJson(url, opt){
  const ctl = new AbortController(), to = setTimeout(()=>ctl.abort(), 9000);
  try{
    const r = await fetch(url, Object.assign({signal:ctl.signal}, opt||{}));
    if (!r.ok) throw new Error("HTTP "+r.status);
    return await r.json();
  }catch(e){
    if (e.name === "AbortError") throw new Error("タイムアウト");
    throw e;
  } finally { clearTimeout(to); }
}
  const precisionCache = new Map();
  async function getPrecision(symBase){
    if (precisionCache.has(symBase)) return precisionCache.get(symBase);
    let out = {qty:3, price:4};
    try{
      const j = await relay("/contracts?symbol="+symBase+"USDT");
      const d = Array.isArray(j.result && j.result.data) ? j.result.data[0] : (j.result && j.result.data);
      if (d && d.quantityPrecision != null) out.qty = d.quantityPrecision;
      if (d && d.pricePrecision != null) out.price = d.pricePrecision;
    }catch(_){}
    precisionCache.set(symBase, out);
    return out;
  }
  function floorTo(v, prec){ const f = Math.pow(10,Math.max(0,prec)); return Number((Math.floor(v*f + 1e-6)/f).toFixed(Math.max(0,prec))); }
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));

// ============================================================
// TrenchDesk v3：週足・日足トレンド＋15分足EMA50押し目（包み足・はらみ足）戦略
// ルールはすべて固定値。画面からは変更しない
// ============================================================
const RULE = {
  lev: 4,                 // レバレッジ4倍固定
  marginPct: 0.10,        // 1回の証拠金＝総資産の10%（建玉は総資産の40%）
  maxPos: 5,              // 最大同時ポジション数
  maxSameDir: 3,          // 同一方向の最大数
  minTurn: 5e6,           // 24時間売買代金$5M以上
  minWeeks: 52,           // 上場1年未満は対象外（週足が52本未満）
  riskEq: 0.02,           // 1回の最大損失＝総資産の2.0%（手数料・スリッページ込み）
  fee: 0.0005,            // 手数料（片道・建玉に対して）
  slip: 0.0005,           // スリッページ（片道・建玉に対して）
  accK: 1.2,              // 逆行の加速＝15分足の終値がEMA50からATR(14)の1.2本分以上、逆側で確定
  watchBars: 8,           // EMA50接触後、反転足を待つ本数（2時間）
};
// 損切りの値幅（価格の%）＝(総資産の2% ÷ 建玉40%) − 往復の手数料とスリッページ ＝ 5% − 0.2% ＝ 4.8%
RULE.beCost = 2*(RULE.fee + RULE.slip); // 建値に上げるときの上乗せ（往復の手数料＋スリッページ＝0.2%）。残りを建値で決済しても損が出ない位置
RULE.slPct = +((RULE.riskEq/(RULE.marginPct*RULE.lev) - 2*(RULE.fee + RULE.slip))*100).toFixed(3);

const V3_KEY = "td3_state", V3_BTKEY = "td3_bt", V3_VER = 3;
const TFMS = {m15:900000, h1:3600000, d1:86400000, w1:604800000};

function emaSeries(cs, n){ const k = 2/(n+1), out = new Array(cs.length); let e = null;
  for (let i=0;i<cs.length;i++){ const c = cs[i].c; e = e == null ? c : c*k + e*(1-k); out[i] = e; } return out; }
function atrSeries(cs, n){ const out = new Array(cs.length).fill(null); let s = 0;
  const tr = cs.map((x,i) => i ? Math.max(x.h-x.l, Math.abs(x.h-cs[i-1].c), Math.abs(x.l-cs[i-1].c)) : x.h-x.l);
  for (let i=0;i<cs.length;i++){ s += tr[i]; if (i >= n) s -= tr[i-n]; if (i >= n-1) out[i] = s/n; } return out; }
// トレンド：上昇＝EMA20＞EMA50かつ終値＞EMA50、下降＝その逆、それ以外＝レンジ
function trendAt(cs, e20, e50, i){ if (i < 49) return 0; const c = cs[i].c;
  if (e20[i] > e50[i] && c > e50[i]) return 1; if (e20[i] < e50[i] && c < e50[i]) return -1; return 0; }
function trendOf(cs){ if (!cs || cs.length < 50) return 0; return trendAt(cs, emaSeries(cs,20), emaSeries(cs,50), cs.length-1); }
const TLABEL = t => t > 0 ? "上昇" : t < 0 ? "下降" : "レンジ";
// 反転足（ロング基準。ショートは価格の符号を反転して同じ式を使う）
// 包み足：前の足が陰線、確定足が陽線で、確定足の実体が前の足の実体を完全に包む
// はらみ足：前の足が陰線、確定足が陽線で、確定足の実体が前の足の実体の内側に収まる
function reversalOf(P, L, dir){
  const u = x => dir > 0 ? x : -x, po = u(P.o), pc = u(P.c), lo = u(L.o), lc = u(L.c);
  if (!(pc < po) || !(lc > lo)) return null;
  if (lo <= pc && lc >= po) return "en";
  if (lo >= pc && lc <= po) return "ha";
  return null;
}
const PATNAME = {en:"包み足", ha:"はらみ足"};
// 逆行の加速（k＝ATR倍率。"S"＝終値がEMA50の逆側で、前の足の安値（ショートは高値）を更新して確定）
function accelOf(L, P, e50, atr, dir, k){
  if (k === "S") return dir*(L.c - e50) < 0 && dir*(L.l - P.l) < 0 && (dir > 0 ? L.l < P.l : L.h > P.h);
  return atr > 0 && dir*(L.c - e50) <= -k*atr;
}
function shapeOf(P, L){
  const r = reversalOf(P, L, 1) || reversalOf(P, L, -1);
  const kind = r ? PATNAME[r]+(L.c > L.o ? "（上向き）" : "（下向き）") : "";
  return kind || (L.c > L.o ? "陽線" : L.c < L.o ? "陰線" : "十字線");
}
function parseK(j, tfMs, now){
  const raw = (j && j.result && j.result.data) || (j && j.data) || [];
  return (Array.isArray(raw) ? raw : []).map(x => Array.isArray(x)
    ? {t:+x[0], o:+x[1], h:+x[2], l:+x[3], c:+x[4]}
    : {t:+(x.time!=null?x.time:x.openTime), o:+x.open, h:+x.high, l:+x.low, c:+x.close}
  ).filter(c => c.t > 0 && c.c > 0 && c.t + tfMs <= now).sort((a,b) => a.t - b.t); // 確定した足だけ
}
async function fetchK(base, iv, tfMs, limit, now){
  return parseK(await relay("/market/klines?symbol="+base+"USDT&interval="+iv+"&limit="+limit), tfMs, now);
}
async function fetchKBack(base, iv, tfMs, need, now){ // 新しい方から過去へ、need本まで（1回最大1440本）
  let out = [], end = null;
  for (let k=0;k<8 && out.length < need;k++){
    const arr = parseK(await relay("/market/klines?symbol="+base+"USDT&interval="+iv+"&limit=1440"+(end ? "&endTime="+end : "")), tfMs, now);
    const fresh = out.length ? arr.filter(x => x.t < out[0].t) : arr;
    if (!fresh.length) break; out = fresh.concat(out); end = out[0].t - 1; if (arr.length < 200) break;
  }
  return out.slice(-need);
}
const baseOf = s => s.replace(/-?USDT$/, "");

function makePerp(){
  let S = null;
  const tokens = new Map();                       // 銘柄 → {sym, px, bid, ask, turn}
  const CDL = {};                                  // 銘柄 → {w, d, m15, fw, fd, f15, last15}
  const inflight = new Set(), chains = new Map(), levSet = new Set();
  let busy = false, lastTickerAt = 0, lastReconcileAt = 0, lastErr = null;
  const POLL = 5000, FETCH_PER_TICK = 6;

  function fresh(){ return {ver:V3_VER, startedAt:Date.now(), running:true, cash:START_USD, positions:[], trades:[], log:[], seq:0, W:{}, pend:[], legacy:null, day:{}}; }
  function load(){ try{ const j = JSON.parse(store.get(V3_KEY) || "null"); S = j && j.ver === V3_VER ? Object.assign(fresh(), j) : fresh(); }catch(_){ S = fresh(); } }
  function persist(){ store.set(V3_KEY, JSON.stringify(S)); }
  function log(tag, msg){ S.log.unshift({id:++S.seq, t:Date.now(), tag, msg}); if (S.log.length > 120) S.log.length = 120; }
  function unreal(p){ const t = tokens.get(p.sym); const px = t && t.px > 0 ? t.px : p.entry; return p.dir*(px - p.entry)*p.qty; }
  function equity(){ let v = S.cash; for (const p of S.positions) v += p.margin + unreal(p); return v; }

  // ---- 価格と売買代金 ----
  async function pollTickers(){
    const j = await relay("/market/ticker"), d = j && j.result;
    if (!d || d.code !== 0) throw new Error("ティッカー取得失敗: "+((d && d.msg) || "応答が不正"));
    for (const o of (Array.isArray(d.data) ? d.data : [])){
      if (!o || !o.symbol || !o.symbol.endsWith("-USDT")) continue;
      const b = o.symbol.replace(/-USDT$/, ""); if (/^NC[A-Z]{2}/.test(b) || /2USD$/.test(b)) continue;
      const px = parseFloat(o.lastPrice); if (!(px > 0)) continue;
      tokens.set(o.symbol, {sym:o.symbol, px, bid:parseFloat(o.bidPrice)||px, ask:parseFloat(o.askPrice)||px, turn:parseFloat(o.quoteVolume)||0, at:Date.now()});
    }
    lastTickerAt = Date.now();
  }
  function universe(){ return [...tokens.values()].filter(t => t.turn >= RULE.minTurn).sort((a,b) => b.turn - a.turn); }
  function trendsOf(sym){ const c = CDL[sym]; if (!c || !c.w || !c.d) return null;
    if (c.w.length < RULE.minWeeks) return {w:0, d:0, dir:0, young:true};
    const w = trendOf(c.w), d = trendOf(c.d); return {w, d, dir:(w !== 0 && w === d) ? w : 0}; }

  // ---- ろうそくの取得（週足は1日ごと、日足は4時間ごと、15分足はトレンドが一致した銘柄と保有中の銘柄だけ） ----
  function candleStep(now){
    const cur15 = Math.floor(now/TFMS.m15)*TFMS.m15, held = new Set(S.positions.map(p => p.sym)); let n = 0;
    const list = universe().map(t => t.sym); for (const s of held) if (!list.includes(s)) list.unshift(s);
    const jobs = [];
    for (const sym of list){
      if (inflight.has(sym)) continue;
      const c = CDL[sym] || (CDL[sym] = {w:null, d:null, m15:null, fw:0, fd:0, f15:0, last15:0});
      const needW = now - c.fw >= 24*3600e3, needD = now - c.fd >= 4*3600e3;
      const tr = trendsOf(sym), want15 = held.has(sym) || (tr && tr.dir !== 0);
      const need15 = want15 && c.f15 < cur15 + 20000 && now >= cur15 + 20000; // 15分足が確定して20秒後
      if (need15) jobs.push([0, sym, "15"]); else if (needW || needD) jobs.push([now < cur15 + 6*60000 ? 2 : 1, sym, "WD"]);
    }
    jobs.sort((a,b) => a[0] - b[0]);
    for (const [,sym,kind] of jobs){ if (n >= FETCH_PER_TICK) break; n++; inflight.add(sym);
      refresh(sym, kind, now).finally(() => inflight.delete(sym)); }
  }
  async function refresh(sym, kind, now){
    const c = CDL[sym], b = baseOf(sym);
    try{
      if (kind === "WD"){
        if (now - c.fw >= 24*3600e3){ c.w = await fetchK(b, "1w", TFMS.w1, 300, now); c.fw = now; }
        if (now - c.fd >= 4*3600e3){ c.d = await fetchK(b, "1d", TFMS.d1, 300, now); c.fd = now; }
      } else {
        const m = await fetchK(b, "15m", TFMS.m15, 400, now); c.f15 = now;
        if (m.length >= 120){ c.m15 = m; const last = m[m.length-1].t; if (last !== c.last15){ c.last15 = last; on15(sym, now); } }
      }
    }catch(err){ if (kind === "WD"){ c.fw = c.fw || now - 23*3600e3; c.fd = c.fd || now - 3.5*3600e3; } else c.f15 = now; lastErr = b+": "+err.message; }
  }

  // ---- 15分足が確定するたびの判定 ----
  function on15(sym, now){
    const c = CDL[sym], cs = c.m15, n = cs.length, e50 = emaSeries(cs,50), e20 = emaSeries(cs,20), atr = atrSeries(cs,14);
    const tr = trendsOf(sym), dir = tr ? tr.dir : 0;
    let st = null;
    const from = c.proc ? cs.findIndex(x => x.t > c.proc) : n-1; // まだ判定していない足から（再起動直後は最新の1本だけ）
    if (from < 1) return; c.proc = cs[n-1].t;
    for (let i = Math.max(60, from); i < n; i++){
      const L = cs[i], P = cs[i-1], pos = S.positions.find(p => p.sym === sym);
      if (pos){ if (L.t >= pos.barT) manageBar(pos, L, P, e50[i], e20[i], atr[i]); delete S.W[sym]; continue; } // 保有中は新しい監視をしない
      st = S.W[sym] || null;
      if (!dir){ if (st) delete S.W[sym]; continue; }
      if (st && st.dir !== dir){ delete S.W[sym]; st = null; }
      let fired = false;
      if (st && st.touchT){
        const k = Math.round((L.t - st.touchT)/TFMS.m15);
        if (accelOf(L, P, e50[i], atr[i], dir, RULE.accK)){ log("見送り", baseOf(sym)+"：EMA50接触後に逆行が加速したため取り消し"); delete S.W[sym]; st = null; fired = true; }
        else if (k > RULE.watchBars){ log("見送り", baseOf(sym)+"：EMA50接触から2時間、反転足が出なかった"); delete S.W[sym]; st = null; }
        else if (k >= 1){
          const pat = reversalOf(P, L, dir);
          if (pat){ delete S.W[sym]; st = null; fired = true;
            if (i === n-1 && now - (L.t + TFMS.m15) < 10*60000) S.pend.push({sym, dir, pat, t:now, barT:L.t + TFMS.m15, sig:L.c});
            else log("見送り", baseOf(sym)+"：反転足（"+PATNAME[pat]+"）の確定から時間が経っていたため");
          } else if (k >= RULE.watchBars){ log("見送り", baseOf(sym)+"：EMA50接触から2時間、反転足が出なかった"); delete S.W[sym]; st = null; }
        }
      }
      if (!st && !fired){ // EMA50への接触（直前の足はEMA50のトレンド側にあったこと）
        const touch = dir > 0 ? (L.l <= e50[i] && P.c > e50[i-1]) : (L.h >= e50[i] && P.c < e50[i-1]);
        if (touch && !accelOf(L, P, e50[i], atr[i], dir, RULE.accK)){ S.W[sym] = {dir, touchT:L.t}; st = S.W[sym]; }
      }
    }
  }

  // ---- エントリー ----
  function canOpen(sym, dir){
    if (!S.running) return "新規エントリー停止中";
    if (S.positions.some(p => p.sym === sym)) return "同じ銘柄を保有中";
    if (S.legacy && S.legacy.positions.some(x => x.sym === baseOf(sym))) return "取引所に、この銘柄の管理外のポジションが残っている";
    if (S.positions.length >= RULE.maxPos) return "最大"+RULE.maxPos+"件に達している";
    if (S.positions.filter(p => p.dir === dir).length >= RULE.maxSameDir) return "同じ方向が最大"+RULE.maxSameDir+"件に達している";
    const b = baseOf(sym), other = b === "BTC" ? "ETH" : b === "ETH" ? "BTC" : null;
    if (other && S.positions.some(p => baseOf(p.sym) === other && p.dir === dir)) return other+"を同じ方向で保有中（BTCとETHは同時に同じ方向で持たない）";
    return null;
  }
  function targetOf(sym, dir, entry){ // 半分利確：日足EMA20・EMA50・20日高値（ショートは安値）のうち、損切り幅以上（RR1:1）離れていて一番近いもの
    const d = CDL[sym] && CDL[sym].d; if (!d || d.length < 50) return null;
    const e20 = emaSeries(d,20), e50 = emaSeries(d,50), last = d.slice(-20);
    const hl = dir > 0 ? Math.max(...last.map(x => x.h)) : Math.min(...last.map(x => x.l));
    const min = entry*RULE.slPct/100;
    const c = [["日足EMA20", e20[e20.length-1]], ["日足EMA50", e50[e50.length-1]], [dir > 0 ? "20日高値" : "20日安値", hl]].filter(x => dir*(x[1] - entry) >= min);
    c.sort((a,b) => dir*(a[1]-entry) - dir*(b[1]-entry));
    return c.length ? {px:c[0][1], name:c[0][0]} : null;
  }
  function openFromPending(now){
    const q = S.pend.splice(0), cand = q.filter(x => now - x.t < 10*60000).map(x => Object.assign(x, {turn:(tokens.get(x.sym)||{}).turn||0})).sort((a,b) => b.turn - a.turn);
    for (const x of cand){
      const why = canOpen(x.sym, x.dir), b = baseOf(x.sym);
      if (why){ log("見送り", b+"："+PATNAME[x.pat]+"は確定したが、"+why); continue; }
      const t = tokens.get(x.sym); if (!t) continue;
      const eq = equity(), margin = eq*RULE.marginPct, notional = margin*RULE.lev;
      const entry = x.dir > 0 ? t.ask : t.bid, qty = notional/entry, fee = notional*RULE.fee;
      const stop = entry*(1 - x.dir*RULE.slPct/100), tg = targetOf(x.sym, x.dir, entry);
      const p = {id:++S.seq, sym:x.sym, dir:x.dir, pat:x.pat, entry, qty, qty0:qty, notional, margin, margin0:margin, stop, target:tg ? tg.px : null, targetName:tg ? tg.name : null,
        half:false, armed:false, ts:now, barT:x.barT, fee, realized:0, live:null};
      S.cash -= margin + fee; S.positions.push(p);
      log("エントリー", b+" "+(x.dir > 0 ? "ロング" : "ショート")+"（"+PATNAME[x.pat]+"）価格 "+fmtPx(entry)+" ／ 損切り "+fmtPx(stop)+"（-"+RULE.slPct+"%）"+(tg ? " ／ 半分利確 "+fmtPx(tg.px)+"（"+tg.name+"）" : " ／ 半分利確の目標なし（RR1:1以上離れた節目がない）"));
      liveOpen(p);
    }
  }
  // ---- 決済 ----
  function closePart(p, frac, px, reason){
    const q = frac >= 1 ? p.qty : p.qty*frac, notional = q*px, fee = notional*RULE.fee, m = frac >= 1 ? p.margin : p.margin*frac;
    const pnl = p.dir*(px - p.entry)*q - fee;
    S.cash += m + pnl; p.realized += pnl; p.qty -= q; p.margin -= m;
    if (frac >= 1 || p.qty <= p.qty0*1e-6){
      S.positions = S.positions.filter(x => x !== p);
      const net = p.realized - p.fee, eqPct = net/(p.margin0/RULE.marginPct)*100;
      S.trades.unshift({sym:p.sym, dir:p.dir, pat:p.pat, entry:p.entry, exit:px, ts:p.ts, exitTs:Date.now(), net:+net.toFixed(2), eqPct:+eqPct.toFixed(2), reason, half:p.half});
      if (S.trades.length > 300) S.trades.length = 300;
      const dk = new Date(Date.now()+9*3600e3).toISOString().slice(0,10); S.day[dk] = +((S.day[dk]||0) + net).toFixed(2);
      log("決済", baseOf(p.sym)+" "+reason+" ／ 損益 "+(net >= 0 ? "+" : "")+net.toFixed(2)+"$（総資産の"+(eqPct >= 0 ? "+" : "")+eqPct.toFixed(2)+"%）");
      liveClose(p, 1);
    } else { log("半分利確", baseOf(p.sym)+" "+reason+" ／ 実現 "+(pnl >= 0 ? "+" : "")+pnl.toFixed(2)+"$"); liveClose(p, frac); }
  }
  function managePrice(p){ // 毎回の価格で：損切り・半分利確
    const t = tokens.get(p.sym); if (!t || !(t.px > 0)) return;
    if (p.dir*(t.px - p.stop) <= 0) return closePart(p, 1, p.stop*(1 - p.dir*RULE.slip), p.be ? "建値で決済（半分利確後の損切り）" : "損切り（-"+RULE.slPct+"%）");
    if (!p.half && p.target != null && p.dir*(t.px - p.target) >= 0){
      p.half = true; p.stop = p.entry*(1 + p.dir*RULE.beCost); p.be = true; // 残りの損切りを建値（＋手数料分）へ引き上げる。取引所の注文も、半分決済のあとにこの価格で置き直す
      closePart(p, 0.5, p.target, "半分利確（"+p.targetName+"に到達）。残りの損切りを建値 "+fmtPx(p.stop)+" へ引き上げ"); }
  }
  function manageBar(p, L, P, e50, e20, atr){ // 15分足の確定ごとに：逆行の加速・EMA20トレーリング
    if (!S.positions.includes(p)) return;
    const px = (tokens.get(p.sym)||{}).px || L.c;
    if (accelOf(L, P, e50, atr, p.dir, RULE.accK)) return closePart(p, 1, px, "逆行が加速（終値がEMA50からATR"+RULE.accK+"本分以上逆側）");
    if (!p.armed && p.dir*(L.c - e20) > 0){ p.armed = true; log("トレーリング", baseOf(p.sym)+"：終値がEMA20の"+(p.dir > 0 ? "上" : "下")+"で確定。以後、15分足EMA20をトレーリングラインにする"); }
    if (p.armed && p.dir*(L.c - e20) < 0) return closePart(p, 1, px, "トレーリング決済（終値が15分足EMA20を"+(p.dir > 0 ? "下" : "上")+"抜け）");
  }

  // ---- 取引所（BingXデモ）への発注。同じ銘柄の処理は順番に行う ----
  function chain(sym, fn){ const prev = chains.get(sym) || Promise.resolve(); const nx = prev.then(fn, fn); chains.set(sym, nx.catch(()=>{})); return nx; }
  const side = p => p.dir > 0 ? "LONG" : "SHORT";
  async function placeStop(p, qty, prec){
    await relay("/bracket-only", "POST", {symbol:baseOf(p.sym)+"USDT", positionSide:side(p), quantity:qty, slPrice:Number(p.stop.toFixed(prec.price))});
  }
  function liveOpen(p){
    if (S.positions.filter(x => x.live && x.live.status === "open").length >= LIVE_MAX){ p.live = {status:"skip", msg:"取引所への同時発注の上限（"+LIVE_MAX+"件）"}; return; }
    p.live = {status:"opening"};
    chain(p.sym, async () => {
      const b = baseOf(p.sym), prec = await getPrecision(b), qty = floorTo(p.qty, prec.qty);
      try{
        if (!(qty > 0)) throw new Error("数量が最小単位未満");
        await relay("/cancel-all", "POST", {symbol:b+"USDT"}).catch(()=>{});
        const lk = b+"|"+side(p); if (!levSet.has(lk)){ await relay("/leverage", "POST", {symbol:b+"USDT", side:side(p), leverage:RULE.lev}); levSet.add(lk); }
        await relay("/order", "POST", {symbol:b+"USDT", side:p.dir > 0 ? "BUY" : "SELL", positionSide:side(p), quantity:qty});
        p.live = {status:"open", qty, at:Date.now()};
        await placeStop(p, qty, prec);
        log("取引所", b+"：成行で建てて、損切り注文 "+fmtPx(p.stop)+" を置きました");
      }catch(err){ p.live = {status:p.live && p.live.status === "open" ? "open" : "error", qty:p.live && p.live.qty, msg:err.message}; log("取引所", b+"：発注の失敗 "+err.message); }
      persist();
    });
  }
  function liveClose(p, frac){
    if (!p.live || p.live.status !== "open") return;
    chain(p.sym, async () => {
      const b = baseOf(p.sym), prec = await getPrecision(b);
      try{
        const q = frac >= 1 ? p.live.qty : floorTo(p.live.qty*frac, prec.qty);
        if (q > 0) await relay("/close", "POST", {symbol:b+"USDT", positionSide:side(p), quantity:q}).catch(err => { if (frac < 1) throw err; });
        await relay("/cancel-all", "POST", {symbol:b+"USDT"}).catch(()=>{});
        if (frac >= 1){ p.live.status = "closed"; }
        else { p.live.qty = floorTo(p.live.qty - q, prec.qty); if (p.live.qty > 0) await placeStop(p, p.live.qty, prec); }
      }catch(err){ log("取引所", b+"：決済注文の失敗 "+err.message); }
      persist();
    });
  }
  let lastOrderScanAt = 0;
  async function reconcile(now, force){ // 60秒ごとに取引所のポジションを確認する
    if (!force && now - lastReconcileAt < 60000) return; lastReconcileAt = now;
    const j = await relay("/positions"), raw = (j.result && j.result.data) || [], list = (Array.isArray(raw) ? raw : [raw]).filter(x => x && Math.abs(parseFloat(x.positionAmt)||0) > 0);
    const has = new Set(list.map(x => baseOf(String(x.symbol))+"|"+x.positionSide));
    // このアプリが管理していないポジション（以前のルールの残りなど）は、自動では決済せず、一覧にして画面に出す
    const mine = new Set(S.positions.map(p => baseOf(p.sym)+"|"+side(p)));
    const others = list.filter(x => !mine.has(baseOf(String(x.symbol))+"|"+x.positionSide)).map(x => ({sym:baseOf(String(x.symbol)), side:x.positionSide,
      amt:Math.abs(parseFloat(x.positionAmt)||0), entry:parseFloat(x.avgPrice || x.entryPrice || 0), pnl:parseFloat(x.unrealizedProfit != null ? x.unrealizedProfit : (x.profit || 0)) || 0, lev:x.leverage}));
    let orderSyms = S.legacy ? S.legacy.orderSyms || [] : [];
    if (force || now - lastOrderScanAt > 10*60000){ lastOrderScanAt = now; // 未約定の注文（以前の損切り注文など）も10分ごとに確認
      const o = await relay("/open-orders").catch(() => null), od = o && o.result && o.result.data, orders = (od && (od.orders || od)) || [];
      const mineSym = new Set(S.positions.map(p => baseOf(p.sym)));
      orderSyms = [...new Set((Array.isArray(orders) ? orders : []).map(x => baseOf(String(x.symbol||""))).filter(v => v && !mineSym.has(v)))]; }
    const prevN = S.legacy ? S.legacy.positions.length : -1;
    S.legacy = (others.length || orderSyms.length) ? {at:now, positions:others, orderSyms} : null;
    if (others.length && prevN !== others.length) log("SYS", "取引所に、このアプリが管理していないポジションが"+others.length+"件あります（"+others.map(x => x.sym+" "+(x.side === "LONG" ? "ロング" : "ショート")).join("、")+"）。自動では決済しません。画面で確認してください");
    const opens = S.positions.filter(p => p.live && p.live.status === "open" && now - (p.live.at||0) > 30000); if (!opens.length) return;
    for (const p of opens) if (!has.has(baseOf(p.sym)+"|"+side(p))){ p.live.status = "closed"; const t = tokens.get(p.sym);
      closePart(p, 1, t ? t.px : p.entry, "取引所側で決済済み（損切り注文の約定など）"); }
  }
  async function closeLegacy(){ // 画面のボタンを押したときだけ：管理外のポジションを成行で決済し、その銘柄の未約定注文を取り消す
    const L = S.legacy; if (!L) return;
    const syms = new Set([...L.positions.map(x => x.sym), ...(L.orderSyms||[])]); let ok = 0, ng = [];
    for (const s of syms){
      try{ if (L.positions.some(x => x.sym === s)) await relay("/close-all", "POST", {symbol:s+"USDT"}); await relay("/cancel-all", "POST", {symbol:s+"USDT"}); ok++; }
      catch(err){ ng.push(s+"（"+err.message+"）"); }
    }
    log("SYS", "管理外のポジション・注文を片付けました："+ok+"銘柄"+(ng.length ? "。失敗："+ng.join("、") : ""));
    await reconcile(Date.now(), true).catch(()=>{});
  }

  // ---- メインループ ----
  async function tick(){
    if (busy) return; busy = true; const now = Date.now();
    try{
      await pollTickers();
      for (const p of [...S.positions]) managePrice(p);
      candleStep(now);
      if (S.pend.length) openFromPending(now);
      await reconcile(now).catch(err => { lastErr = "照合: "+err.message; });
      btStep(now).catch(err => { lastErr = "検証: "+err.message; });
    }catch(err){ lastErr = err.message; log("SYS", "処理エラー: "+err.message); }
    finally{ busy = false; persist(); }
  }
  const fmtPx = x => x >= 1000 ? x.toFixed(1) : x >= 1 ? x.toFixed(4) : x.toPrecision(4);

  // ============================================================
  // 過去検証：約60日の15分足で、この戦略を再現する（上位60銘柄）
  // ============================================================
  const BT_TOP = 60, BT_DAYS = 60, BT_STEP = 20000, BT_RAND = 32;
  const BT_ACC = [1.0, 1.2, 1.5, "S"], BT_TRAIL = ["m15", "h1"], BT_HALF = [true, false];
  const vKey = (a,t,h) => a+"|"+t+"|"+(h ? 1 : 0), LIVE_V = vKey(1.2, "m15", true);
  let BT = null, btBusy = false, btAt = 0, btCache = null, btCacheAt = 0;
  function btFresh(){ return {ver:V3_VER, since:Date.now(), syms:[], done:{}, tr:{}, rb:{}, from:0, to:0, complete:false}; }
  // 保存は、決済方式ごと・1500件ごとに別のキーへ分ける（1つのキーの保存上限128KBを超えないため）
  function btLoad(){ try{ const j = JSON.parse(store.get(V3_BTKEY) || "null"); BT = j && j.ver === V3_VER ? j : btFresh();
      if (j && j.parts){ BT.tr = {}; for (const k in j.parts) for (let c=0;c<j.parts[k];c++){ const a = JSON.parse(store.get(V3_BTKEY+"_"+k+"_"+c) || "[]"); (BT.tr[k] || (BT.tr[k] = [])).push(...a); btSaved[k] = (BT.tr[k]||[]).length; } delete BT.parts; }
    }catch(_){ BT = btFresh(); } }
  const btSaved = {}; // 決済方式ごとに、保存済みの件数（変わった分のキーだけ書き直す）
  function btSave(){ const parts = {}, meta = Object.assign({}, BT, {tr:undefined});
    for (const k in BT.tr){ const a = BT.tr[k]; parts[k] = Math.ceil(a.length/1500);
      for (let c=Math.floor((btSaved[k]||0)/1500); c<parts[k]; c++) store.set(V3_BTKEY+"_"+k+"_"+c, JSON.stringify(a.slice(c*1500,(c+1)*1500))); btSaved[k] = a.length; }
    meta.parts = parts; store.set(V3_BTKEY, JSON.stringify(meta)); }
  function asOf(cs, tfMs, T, k){ while (k+1 < cs.length && cs[k+1].t + tfMs <= T) k++; return k; }
  // 1つの設定で、1銘柄を最初から最後まで再現する。rand>0なら、反転足の代わりに一定間隔で入る（比較用）
  function btSim(D, acc, trail, half, rand){
    const {m, e50, e20, atr, h1, h20, hIdx, dir, dT, dE20, dE50, dHH, dLL} = D, out = [];
    let st = null, pos = null, lastRand = -1e9;
    for (let i = 201; i < m.length - 1; i++){
      const L = m[i], P = m[i-1], d = dir[i];
      if (pos){
        const x = pos; let exitPx = null, why = null;
        if (i >= x.i0){
          const hitStop = x.d > 0 ? L.l <= x.stop : L.h >= x.stop;
          if (hitStop){ exitPx = x.d > 0 ? Math.min(x.stop, L.o) : Math.max(x.stop, L.o); why = "sl"; } // 窓を開けて飛んだ場合は始値で約定（不利側）
          else {
            if (half && !x.half && x.tg != null && (x.d > 0 ? L.h >= x.tg : L.l <= x.tg)){ x.half = true; x.hr = x.d*(x.tg/x.e - 1)*100; x.stop = x.e*(1 + x.d*RULE.beCost); } // 残りは建値（＋手数料分）へ。次の足から有効
            let tl = e20[i], armedNow = x.d*(L.c - e20[i]) > 0;
            if (trail === "h1"){ const k = hIdx[i]; const isClose = k >= 0 && h1[k].t + TFMS.h1 === L.t + TFMS.m15; tl = k >= 0 ? h20[k] : null; armedNow = isClose && tl != null && x.d*(h1[k].c - tl) > 0; if (isClose && tl != null && x.armed && x.d*(h1[k].c - tl) < 0) why = "tr"; }
            else if (x.armed && x.d*(L.c - e20[i]) < 0) why = "tr";
            if (!why && accelOf(L, P, e50[i], atr[i], x.d, acc)) why = "ac";
            if (armedNow) x.armed = true;
            if (why) exitPx = m[i+1].o;
          }
        }
        if (why){
          const cost = 2*(RULE.fee + RULE.slip)*100, r2 = x.d*(exitPx/x.e - 1)*100;
          const r = (x.half ? (x.hr + r2)/2 : r2) - cost;
          out.push({te:x.te, tx:L.t + TFMS.m15, d:x.d, r:+r.toFixed(3), h:x.half ? 1 : 0, w:why, p:x.p}); pos = null;
        }
        continue;
      }
      if (!d){ st = null; continue; }
      if (st && st.dir !== d) st = null;
      const enter = (pat) => { const e = m[i+1].o, k = dT[i]; // 反転足の次の足の始値で入る（手数料・スリッページは損益側で引く）
        const min = e*RULE.slPct/100, c = [dE20[k], dE50[k], d > 0 ? dHH[k] : dLL[k]].filter(v => v != null && d*(v - e) >= min).sort((a,b) => d*(a-e) - d*(b-e));
        pos = {d, e, stop:e*(1 - d*RULE.slPct/100), tg:c.length ? c[0] : null, i0:i+1, te:m[i+1].t, armed:false, half:false, p:pat}; };
      if (rand){ if (i - lastRand >= rand){ lastRand = i; enter("r"); } continue; }
      if (st){
        const k = Math.round((L.t - st.t)/TFMS.m15);
        if (accelOf(L, P, e50[i], atr[i], d, acc)){ st = null; continue; }
        else if (k >= 1 && k <= RULE.watchBars){ const pt = reversalOf(P, L, d); if (pt){ st = null; enter(pt); continue; } if (k >= RULE.watchBars) st = null; }
        else if (k > RULE.watchBars) st = null;
      }
      if (!st){ const touch = d > 0 ? (L.l <= e50[i] && P.c > e50[i-1]) : (L.h >= e50[i] && P.c < e50[i-1]);
        if (touch && !accelOf(L, P, e50[i], atr[i], d, acc)) st = {dir:d, t:L.t}; }
    }
    return out;
  }
  function btProcess(si, w, dd, h1, m){
    const e50 = emaSeries(m,50), e20 = emaSeries(m,20), atr = atrSeries(m,14), h20 = emaSeries(h1,20);
    const w20 = emaSeries(w,20), w50 = emaSeries(w,50), d20 = emaSeries(dd,20), d50 = emaSeries(dd,50);
    const dir = new Array(m.length).fill(0), dT = new Array(m.length).fill(-1), hIdx = new Array(m.length).fill(-1);
    const dHH = dd.map((_,k) => k >= 19 ? Math.max(...dd.slice(k-19,k+1).map(x => x.h)) : null), dLL = dd.map((_,k) => k >= 19 ? Math.min(...dd.slice(k-19,k+1).map(x => x.l)) : null);
    let kw = -1, kd = -1, kh = -1;
    for (let i=0;i<m.length;i++){ const T = m[i].t + TFMS.m15;
      kw = asOf(w, TFMS.w1, T, kw); kd = asOf(dd, TFMS.d1, T, kd); kh = asOf(h1, TFMS.h1, T, kh); dT[i] = kd; hIdx[i] = kh;
      if (kw + 1 < RULE.minWeeks || kd < 49) continue;
      const a = trendAt(w, w20, w50, kw), b = trendAt(dd, d20, d50, kd); dir[i] = (a !== 0 && a === b) ? a : 0; }
    const D = {m, e50, e20, atr, h1, h20, hIdx, dir, dT, dE20:d20, dE50:d50, dHH, dLL};
    for (const a of BT_ACC) for (const t of BT_TRAIL) for (const h of BT_HALF){
      const k = vKey(a,t,h), tr = btSim(D, a, t, h, 0), rb = btSim(D, a, t, h, BT_RAND);
      (BT.tr[k] || (BT.tr[k] = [])).push(...tr.map(x => [si, x.d, Math.round(x.te/60000), Math.round(x.tx/60000), +x.r.toFixed(2), x.h, x.w, x.p]));
      const R = BT.rb[k] || (BT.rb[k] = {n:0, s:0}); for (const x of rb){ R.n++; R.s += x.r; }
    }
    const f = m[201] ? m[201].t : 0, t2 = m[m.length-1].t; if (!BT.from || f < BT.from) BT.from = f; if (t2 > BT.to) BT.to = t2;
  }
  async function btStep(now){
    if (btBusy || BT.complete) return; const cur15 = Math.floor(now/TFMS.m15)*TFMS.m15;
    if (now < cur15 + 6*60000 || now - btAt < BT_STEP) return; // 15分足の確定直後は実売買の取得を優先
    if (!BT.syms.length){ const u = universe().slice(0, BT_TOP).map(t => t.sym); if (u.length < 10) return; BT.syms = u; }
    const si = BT.syms.findIndex(s => BT.done[s] == null);
    if (si < 0){ BT.complete = true; btSave(); log("SYS", "過去検証が完了しました（"+BT.syms.length+"銘柄）"); return; }
    btBusy = true; btAt = now; const sym = BT.syms[si], b = baseOf(sym);
    try{
      const n0 = Date.now();
      const w = await fetchK(b, "1w", TFMS.w1, 300, n0), dd = await fetchK(b, "1d", TFMS.d1, 500, n0);
      const h1 = await fetchKBack(b, "1h", TFMS.h1, BT_DAYS*24 + 200, n0), m = await fetchKBack(b, "15m", TFMS.m15, BT_DAYS*96 + 260, n0);
      if (w.length >= RULE.minWeeks && dd.length >= 60 && m.length > 1000 && h1.length > 300){ btProcess(si, w, dd, h1, m); BT.done[sym] = 1; } else BT.done[sym] = -1;
      btSave(); btCache = null;
    }catch(err){ btAt = now + 30000; lastErr = "過去検証 "+b+": "+err.message; }
    finally{ btBusy = false; }
  }
  // 口座全体の再現：ルール（最大5件・同方向3件・BTCとETH・1銘柄1件）を守って、時間順に採用する
  function btPortfolio(rows, days){
    const tr = rows.slice().sort((a,b) => a[2] - b[2] || a[0] - b[0]), open = [], taken = [];
    for (const x of tr){
      for (let j = open.length-1; j >= 0; j--) if (open[j][3] <= x[2]) open.splice(j,1);
      const bs = baseOf(BT.syms[x[0]] || ""), other = bs === "BTC" ? "ETH" : bs === "ETH" ? "BTC" : null;
      if (open.length >= RULE.maxPos || open.filter(o => o[1] === x[1]).length >= RULE.maxSameDir || open.some(o => o[0] === x[0])) continue;
      if (other && open.some(o => baseOf(BT.syms[o[0]]||"") === other && o[1] === x[1])) continue;
      open.push(x); taken.push(x);
    }
    const eqOf = r => r*RULE.marginPct*RULE.lev; // 1回の損益（総資産に対する%）＝値動きの%×建玉40%
    // 複利：毎回、その時点の総資産の10%を証拠金にする（決済の順に掛け合わせる）
    const grow = xs => xs.slice().sort((a,b) => a[3] - b[3]).reduce((g,x) => g*(1 + eqOf(x[4])/100), 1);
    let g = 1, peak = 1, dd = 0; for (const x of taken.slice().sort((a,b) => a[3] - b[3])){ g *= 1 + eqOf(x[4])/100; peak = Math.max(peak, g); dd = Math.min(dd, (g/peak - 1)*100); }
    const mid = BT.from + (BT.to - BT.from)/2, a = taken.filter(x => x[2]*60000 < mid), b = taken.filter(x => x[2]*60000 >= mid);
    const ann = (xs, dy) => dy > 0 && xs.length ? (Math.pow(grow(xs), 365/dy) - 1)*100 : null;
    return {n:taken.length, total:(g - 1)*100, ann:ann(taken, days), annA:ann(a, days/2), annB:ann(b, days/2), dd, win:taken.length ? Math.round(taken.filter(x => x[4] > 0).length/taken.length*100) : null,
      avgEq:taken.length ? taken.reduce((s,x) => s + eqOf(x[4]), 0)/taken.length : null};
  }
  function btSummary(){
    if (btCache && Date.now() - btCacheAt < 60000) return btCache;
    const days = BT.to > BT.from ? (BT.to - BT.from)/86400e3 : 0, rows = [];
    for (const a of BT_ACC) for (const t of BT_TRAIL) for (const h of BT_HALF){
      const k = vKey(a,t,h), tr = BT.tr[k] || [], rb = BT.rb[k] || {n:0, s:0}; if (!tr.length){ rows.push({k, n:0}); continue; }
      const n = tr.length, avg = tr.reduce((s,x) => s + x[4], 0)/n, bySym = {};
      for (const x of tr){ const o = bySym[x[0]] || (bySym[x[0]] = [0,0]); o[0]++; o[1] += x[4]; }
      let ss = 0; for (const s in bySym){ const d0 = bySym[s][1] - bySym[s][0]*avg; ss += d0*d0; }
      const ci = 1.96*Math.sqrt(ss)/n, ra = rb.n ? rb.s/rb.n : null, pf = btPortfolio(tr, days);
      const cnt = w => tr.filter(x => x[6] === w).length, pat = p => tr.filter(x => x[7] === p).length;
      rows.push({k, acc:a, trail:t, half:h, live:k === LIVE_V, n, win:Math.round(tr.filter(x => x[4] > 0).length/n*100), avg, ci, rand:ra, diff:ra == null ? null : avg - ra,
        exits:{sl:cnt("sl"), tr:cnt("tr"), ac:cnt("ac")}, pats:{en:pat("en"), ha:pat("ha")}, halfN:tr.filter(x => x[5]).length, pf,
        ok:!!(pf.ann != null && pf.ann >= 15 && pf.annA > 0 && pf.annB > 0 && ra != null && avg - ra > 0)});
    }
    btCache = {complete:BT.complete, done:Object.keys(BT.done).length, total:BT.syms.length || BT_TOP, skipped:Object.values(BT.done).filter(v => v < 0).length,
      from:BT.from, to:BT.to, days:+days.toFixed(1), rows}; btCacheAt = Date.now(); return btCache;
  }

  // ---- 画面用：候補銘柄ごとの分析（6項目） ----
  function analysis(){
    const out = [], longN = S.positions.filter(p => p.dir > 0).length, shortN = S.positions.filter(p => p.dir < 0).length;
    const corr = (sym, dir) => { const b = baseOf(sym), notes = [];
      notes.push("保有中 ロング"+longN+"件・ショート"+shortN+"件（最大"+RULE.maxPos+"件、同じ方向は"+RULE.maxSameDir+"件まで）");
      if (dir){ const same = dir > 0 ? longN : shortN; if (same >= 2) notes.push("同じ方向がすでに"+same+"件。暗号資産は同じ方向に動きやすく、実質的に同じ賭けが重なる"); }
      const other = b === "BTC" ? "ETH" : b === "ETH" ? "BTC" : null; if (other && S.positions.some(p => baseOf(p.sym) === other)) notes.push(other+"を保有中。同じ方向では持てない");
      return notes.join("。"); };
    for (const t of universe()){
      const c = CDL[t.sym], tr = trendsOf(t.sym), pos = S.positions.find(p => p.sym === t.sym);
      if (!pos && (!tr || !tr.dir || !c || !c.m15)) continue;
      const cs = c && c.m15, n = cs ? cs.length : 0; if (n < 60) continue;
      const e50 = emaSeries(cs,50), e20 = emaSeries(cs,20), L = cs[n-1], P = cs[n-2], dist = (L.c/e50[n-1] - 1)*100, dir = tr ? tr.dir : 0, st = S.W[t.sym];
      let can = false, reason, plan = null;
      if (pos){ reason = "保有中（"+(pos.dir > 0 ? "ロング" : "ショート")+"）"; }
      else if (st){ const k = Math.round((L.t - st.touchT)/TFMS.m15); reason = "EMA50に接触済み。反転足（包み足・はらみ足）の確定待ち（残り"+Math.max(0, RULE.watchBars - k)+"本）"; }
      else reason = "EMA50への接触待ち（現在EMA50から"+(dist >= 0 ? "+" : "")+dist.toFixed(2)+"%）";
      if (!pos){ const why = canOpen(t.sym, dir); if (why) reason += "。ただし今は入れない："+why;
        if (st && !why){ can = true; const e = L.c, tg = targetOf(t.sym, dir, e);
          plan = {dir, entry:e, stop:e*(1 - dir*RULE.slPct/100), trail:e20[n-1], target:tg ? tg.px : null, targetName:tg ? tg.name : null}; } }
      out.push({sym:t.sym, w:TLABEL(tr ? tr.w : 0), d:TLABEL(tr ? tr.d : 0), dir, px:t.px, e50:e50[n-1], e20:e20[n-1], dist:+dist.toFixed(2), shape:shapeOf(P, L), watching:!!st, held:!!pos,
        can, reason, plan, corr:corr(t.sym, dir)});
    }
    out.sort((a,b) => (b.held - a.held) || (b.watching - a.watching) || Math.abs(a.dist) - Math.abs(b.dist));
    return out.slice(0, 30);
  }
  function publicState(){
    const u = universe(); let young = 0, up = 0, dn = 0, rng = 0, noData = 0;
    for (const t of u){ const tr = trendsOf(t.sym); if (!tr) noData++; else if (tr.young) young++; else if (tr.dir > 0) up++; else if (tr.dir < 0) dn++; else rng++; }
    const eq = equity(), tr = S.trades, wins = tr.filter(x => x.net > 0).length;
    return { ver:V3_VER, rule:RULE, running:S.running, startedAt:S.startedAt, startUsd:START_USD, equity:+eq.toFixed(2), cash:+S.cash.toFixed(2), lastErr, lastTickerAt,
      universe:{total:u.length, up, dn, range:rng, young, noData},
      positions:S.positions.map(p => { const t = tokens.get(p.sym), px = t ? t.px : p.entry, c = CDL[p.sym], cs = c && c.m15;
        return {sym:p.sym, dir:p.dir, pat:PATNAME[p.pat], entry:p.entry, px, qty:p.qty, margin:+p.margin.toFixed(2), stop:p.stop, be:!!p.be, target:p.target, targetName:p.targetName, half:p.half, armed:p.armed,
          e20:cs && cs.length > 20 ? emaSeries(cs,20)[cs.length-1] : null, upnl:+unreal(p).toFixed(2), upnlEq:+(unreal(p)/eq*100).toFixed(2), ts:p.ts, live:p.live}; }),
      trades:tr.slice(0,100), stats:{n:tr.length, win:tr.length ? Math.round(wins/tr.length*100) : null, net:+tr.reduce((s,x) => s + x.net, 0).toFixed(2)}, day:S.day,
      analysis:analysis(), bt:btSummary(), legacy:S.legacy, log:S.log.slice(0,80) };
  }
  function handleCmd(b){
    const c = b && b.cmd;
    if (c === "pause"){ S.running = false; log("SYS", "新規エントリーを停止しました（保有中は決済ルールが続きます）"); }
    else if (c === "resume"){ S.running = true; log("SYS", "新規エントリーを再開しました"); }
    else if (c === "closeAll"){ for (const p of [...S.positions]){ const t = tokens.get(p.sym); closePart(p, 1, t ? t.px : p.entry, "手動で全決済"); } }
    else if (c === "legacyClose"){ closeLegacy().then(persist); }
    else if (c === "legacyScan"){ reconcile(Date.now(), true).then(persist).catch(err => { lastErr = "照合: "+err.message; }); }
    else if (c === "btRestart"){ BT = btFresh(); for (const k in btSaved) btSaved[k] = 0; btSave(); btCache = null; log("SYS", "過去検証をやり直します"); }
    persist();
  }
  return { publicState, handleCmd,
    start(){ load(); btLoad(); if (!S.log.length) log("SYS", "新しい戦略（週足・日足トレンド＋15分足EMA50押し目）で開始しました。総資産 $"+START_USD); persist(); },
    tick, pollMs(){ return POLL; }, equity, note(tag,msg){ log(tag,msg); persist(); } };
}
let ENGINE = null, SRV = null;
function jstDay(){ return new Date(Date.now()+9*3600e3).toISOString().slice(0,10); }
function srvPublic(){
  return { enabled:SRV.enabled, dailyStop:SRV.dailyStop, liveMax:SRV.liveMax, dayKey:SRV.dayKey,
    dayPnl: SRV.dayStartEquity!=null && ENGINE ? ENGINE.equity()-SRV.dayStartEquity : 0, stoppedDay:SRV.stoppedDay||null, lastTickAt:SRV.lastTickAt||0 };
}
export class Engine {
  constructor(ctx, env){ this.ctx = ctx; this.env = env; this.ready = null; }
  init(){
    if (this.ready) return this.ready;
    this.ready = (async () => {
      ENV = this.env; MEM = new Map(); DIRTY = new Set();
      const all = await this.ctx.storage.list();
      for (const [k,v] of all) MEM.set(k, v);
      // 新しい戦略への切り替え：以前の記録（検証・売買履歴など）をすべて削除する。常駐の設定（srv）だけ残す
      if (!MEM.get("td3_state")){
        const old = [...MEM.keys()].filter(k => k !== "srv");
        for (let i=0;i<old.length;i+=128) await this.ctx.storage.delete(old.slice(i, i+128));
        for (const k of old) MEM.delete(k);
      }
      SRV = Object.assign({enabled:false, dailyStop:50, liveMax:5, dayKey:null, dayStartEquity:null, stoppedDay:null, lastTickAt:0}, MEM.get("srv") ? JSON.parse(MEM.get("srv")) : {});
      LIVE_MAX = Math.min(SRV.liveMax, RULE.maxPos);
      ENGINE = makePerp();
      ENGINE.start();
    })();
    return this.ready;
  }
  async flush(){
    MEM.set("srv", JSON.stringify(SRV)); DIRTY.add("srv");
    const ks = [...DIRTY]; DIRTY.clear();
    for (const k of ks) await this.ctx.storage.put(k, MEM.get(k));
  }
  async fetch(req){
    await this.init(); ENV = this.env;
    const u = new URL(req.url);
    if (req.method === "GET" && u.pathname === "/server/state"){
      return json({ server: srvPublic(), state: ENGINE.publicState() });
    }
    if (req.method === "POST" && u.pathname === "/server/cmd"){
      const b = await req.json().catch(()=>({}));
      const c = b.cmd;
      if (c === "srvOn"){
        SRV.enabled = true; SRV.dayKey = jstDay(); SRV.dayStartEquity = ENGINE.equity(); SRV.stoppedDay = null;
        ENGINE.note("SYS","サーバー常駐を開始しました");
        await this.ctx.storage.setAlarm(Date.now()+200);
      } else if (c === "srvOff"){
        SRV.enabled = false; await this.ctx.storage.deleteAlarm();
        ENGINE.note("SYS","サーバー常駐を停止しました（保有中の取引所側の損切りは残ります）");
      } else if (c === "srvCfg"){
        if (b.dailyStop > 0) SRV.dailyStop = +b.dailyStop;
        if (b.liveMax > 0){ SRV.liveMax = +b.liveMax; LIVE_MAX = Math.min(SRV.liveMax, RULE.maxPos); }
      } else if (c === "setSource"){
        /* サーバーはBingX固定 */
      } else {
        ENGINE.handleCmd(b);
        await drain();
      }
      await this.flush();
      return json({ server: srvPublic(), state: ENGINE.publicState() });
    }
    return json({ error: "not found" }, 404);
  }
  async alarm(){
    await this.init(); ENV = this.env;
    if (!SRV.enabled) return;
    try{
      await ENGINE.tick(); await drain();
      SRV.lastTickAt = Date.now();
      const day = jstDay(), eq = ENGINE.equity();
      if (SRV.dayKey !== day){ SRV.dayKey = day; SRV.dayStartEquity = eq; SRV.stoppedDay = null; }
      if (SRV.dayStartEquity != null && eq - SRV.dayStartEquity <= -SRV.dailyStop && SRV.stoppedDay !== day){
        SRV.stoppedDay = day;
        ENGINE.handleCmd({cmd:"pause"});
        ENGINE.note("RISK","本日の損失が上限 $"+SRV.dailyStop+" に達したため、新規エントリーを停止しました（保有中は決済ルールが続きます）");
      }
      await this.flush();
    }catch(e){
      try{ ENGINE.note("SYS","サーバー処理エラー: "+(e&&e.message||e)); await this.flush(); }catch(_){}
    }finally{
      if (SRV.enabled) await this.ctx.storage.setAlarm(Date.now() + Math.max(3000, ENGINE.pollMs()));
    }
  }
}
