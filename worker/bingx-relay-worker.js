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
  const text = (await r.text()).replace(/"(orderId|tranId|tradeId|positionId)"\s*:\s*(\d{15,})/g, '"$1":"$2"'); // 19桁の注文番号は、数値にすると末尾がずれるため、文字列にして受け取る
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

      // 注文の約定内容（平均約定価格・約定数量）を調べる
      if (req.method === "GET" && u.pathname === "/order-info") {
        const symbol = u.searchParams.get("symbol"), orderId = u.searchParams.get("orderId");
        if (!symbol || !orderId) return json({ error: "symbol, orderId は必須です" }, 400);
        const r = await bingxRequest(env, "GET", "/openApi/swap/v2/trade/order", { symbol: toBingxSymbol(symbol), orderId: String(orderId) });
        return json({ demo: isDemo, result: r });
      }
      // 収支明細（確定損益・取引手数料・資金調達）
      if (req.method === "GET" && u.pathname === "/income") {
        const p = { limit: Number(u.searchParams.get("limit")) || 1000 };
        const st = u.searchParams.get("startTime"); if (st && /^\d+$/.test(st)) p.startTime = Number(st);
        const sy = u.searchParams.get("symbol"); if (sy) p.symbol = toBingxSymbol(sy);
        const r = await bingxRequest(env, "GET", "/openApi/swap/v2/user/income", p);
        return json({ demo: isDemo, result: r });
      }
      // 注文履歴（約定済みの注文。手動トレードの実際の約定価格・損益を調べる）
      if (req.method === "GET" && u.pathname === "/order-history") {
        const symbol = u.searchParams.get("symbol");
        if (!symbol) return json({ error: "symbol は必須です" }, 400);
        const p = { symbol: toBingxSymbol(symbol), limit: Number(u.searchParams.get("limit")) || 100 };
        const st = u.searchParams.get("startTime"); if (st && /^\d+$/.test(st)) p.startTime = Number(st);
        const r = await bingxRequest(env, "GET", "/openApi/swap/v2/trade/allOrders", p);
        return json({ demo: isDemo, result: r });
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
  trailBuf: 0.5,          // トレーリングの余裕：終値が15分足EMA20から、ATR(14)のこの倍数だけ超えて逆側で確定して初めて決済（有効化も、同じ幅だけ順行側に出てから）
  slPctD: 15,             // 日足の戦略の損切り：建値から15%（証拠金10%・4倍なので、総資産の約6.1%の損失）。2%ルールより優先（2026/9/30 承認）
  dCancelK: 0.5,          // 日足：終値がEMA50からATRのこの倍数だけ逆側で確定したら、押し目ではなく崩れと見て取り消す
  dWatch: 3,              // 日足：EMA20に接触した日を0本目として、3本目までにトレンド方向の足が確定すること
  topN: 60,               // 対象は、売買代金の上位60銘柄（約定のずれを小さくするため）
  accK: 1.2,              // 逆行の加速＝15分足の終値がEMA50からATR(14)の1.2本分以上、逆側で確定
  watchBars: 8,           // EMA50接触後、反転足を待つ本数（2時間）
};
// 損切りの値幅（価格の%）＝(総資産の2% ÷ 建玉40%) − 往復の手数料とスリッページ ＝ 5% − 0.2% ＝ 4.8%
RULE.beCost = 2*(RULE.fee + RULE.slip); // 建値に上げるときの上乗せ（往復の手数料＋スリッページ＝0.2%）。残りを建値で決済しても損が出ない位置
RULE.slPct = +((RULE.riskEq/(RULE.marginPct*RULE.lev) - 2*(RULE.fee + RULE.slip))*100).toFixed(3);

const V3_KEY = "td3_state", V3_BTKEY = "td3_bt2", V3_VER = 3, V3_BTVER = 4; // 過去検証だけ作り直すため、検証用の版を別にしている（売買の記録は消えない）
const TFMS = {m15:900000, h1:3600000, h4:14400000, d1:86400000, w1:604800000};

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
const PATNAME = {en:"包み足", ha:"はらみ足", d1:"日足の押し目"};
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
    ? {t:+x[0], o:+x[1], h:+x[2], l:+x[3], c:+x[4], v:+x[5]||0}
    : {t:+(x.time!=null?x.time:x.openTime), o:+x.open, h:+x.high, l:+x.low, c:+x.close, v:+x.volume||0}
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

  function fresh(){ return {ver:V3_VER, startedAt:Date.now(), running:true, cash:START_USD, positions:[], trades:[], log:[], seq:0, W:{}, pend:[], WD:{}, legacy:null, day:{}}; }
  function load(){ try{ const j = JSON.parse(store.get(V3_KEY) || "null"); S = j && j.ver === V3_VER ? Object.assign(fresh(), j) : fresh(); }catch(_){ S = fresh(); } }
  function persist(){ store.set(V3_KEY, JSON.stringify(S)); if (manDirty && MAN) manSave(); if (ledDirty && LED && Date.now() - ledSavedAt > 30000) ledSave(); }
  function log(tag, msg){ S.log.unshift({id:++S.seq, t:Date.now(), tag, msg}); if (S.log.length > 120) S.log.length = 120; }
  function unreal(p){ const t = tokens.get(p.sym); const px = t && t.px > 0 ? t.px : p.entry; return p.dir*(px - p.entry)*p.qty; }
  function equityInternal(){ let v = S.cash; for (const p of S.positions) v += p.margin + unreal(p); return v; } // アプリ内の独自計算（BingXが取得できないときの代わり）
  function equity(){ const L = LED ? ledGet() : null; return L && L.ok ? L.eq : equityInternal(); } // 総資産＝500＋BingXの実現損益＋含み損益

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
    const cur15 = Math.floor(now/TFMS.m15)*TFMS.m15, curD = Math.floor(now/TFMS.d1)*TFMS.d1, held = new Set(S.positions.map(p => p.sym)), held15 = new Set(S.positions.filter(p => p.v !== "d1").map(p => p.sym)); let n = 0;
    const list = top60().map(t => t.sym); for (const s of held) if (!list.includes(s)) list.unshift(s);
    const jobs = [];
    for (const sym of list){
      if (inflight.has(sym)) continue;
      const c = CDL[sym] || (CDL[sym] = {w:null, d:null, m15:null, fw:0, fd:0, f15:0, last15:0});
      const closeD = c.fd < curD + 90000 && now >= curD + 90000; // 日足が確定して1分半後（日本時間9時過ぎ）
      const needW = now - c.fw >= 24*3600e3, needD = closeD || now - c.fd >= 4*3600e3;
      const need15 = held15.has(sym) && c.f15 < cur15 + 20000 && now >= cur15 + 20000; // 15分足の戦略の保有分だけ（決済の管理）
      if (need15) jobs.push([0, sym, "15"]); else if (needW || needD) jobs.push([closeD ? 0 : 1, sym, "WD"]);
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
        if (now - c.fd >= 4*3600e3 || c.fd < Math.floor(now/TFMS.d1)*TFMS.d1 + 90000){ const d = await fetchK(b, "1d", TFMS.d1, 300, now); c.fd = now;
          if (d.length){ c.d = d; if (c.d[c.d.length-1].t !== c.lastD){ c.lastD = c.d[c.d.length-1].t; if (c.w) onDaily(sym, now); } } }
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
      if (pos){ if (pos.v !== "d1" && L.t >= pos.barT) manageBar(pos, L, P, e50[i], e20[i], atr[i]); delete S.W[sym]; continue; } // 保有中は新しい監視をしない
      delete S.W[sym]; continue; // 15分足の戦略の新規エントリーは廃止（2026/9/30〜日足の戦略）。以下は使わない
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
    if (MAN && (Object.values(MAN.active).some(r => baseOf(r.sym) === baseOf(sym)) || manOrdSyms.includes(baseOf(sym)))) return "この銘柄は手動でポジションまたは注文がある（手動の注文を取り消さないため）";
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
    const q = S.pend.splice(0), cand = q.filter(x => now - x.t < (x.pat === "d1" ? 60*60000 : 10*60000)).map(x => Object.assign(x, {turn:(tokens.get(x.sym)||{}).turn||0})).sort((a,b) => b.turn - a.turn);
    for (const x of cand){
      const why = canOpen(x.sym, x.dir), b = baseOf(x.sym);
      if (why){ log("見送り", b+"："+(x.pat === "d1" ? (x.dir > 0 ? "陽線" : "陰線") : PATNAME[x.pat])+"は確定したが、"+why); continue; }
      const t = tokens.get(x.sym); if (!t) continue;
      const eq = equity(), margin = eq*RULE.marginPct, notional = margin*RULE.lev, isD = x.pat === "d1", slp = isD ? RULE.slPctD : RULE.slPct;
      const entry = x.dir > 0 ? t.ask : t.bid, qty = notional/entry, fee = notional*RULE.fee;
      const stop = entry*(1 - x.dir*slp/100), tg = isD ? targetD(x.sym, x.dir, entry) : targetOf(x.sym, x.dir, entry);
      const p = {id:++S.seq, sym:x.sym, dir:x.dir, pat:x.pat, v:isD ? "d1" : undefined, slPct:slp, entry, qty, qty0:qty, notional, margin, margin0:margin, stop, target:tg ? tg.px : null, targetName:tg ? tg.name : null,
        half:false, armed:isD ? !!(x.conf && x.dir*(x.conf.c - x.conf.e20) > 0) : false, ts:now, barT:x.barT, fee, realized:0, live:null};
      S.cash -= margin + fee; S.positions.push(p);
      log("エントリー", b+" "+(x.dir > 0 ? "ロング" : "ショート")+"（"+PATNAME[x.pat]+"）価格 "+fmtPx(entry)+" ／ 損切り "+fmtPx(stop)+"（-"+slp+"%）"+(tg ? " ／ 半分利確 "+fmtPx(tg.px)+"（"+tg.name+"）" : isD ? " ／ 半分利確の目標なし（"+(x.dir > 0 ? "20日高値の更新中" : "20日安値の更新中")+"）" : " ／ 半分利確の目標なし（RR1:1以上離れた節目がない）")+(isD ? " ／ 残りは日足の終値がEMA20を"+(x.dir > 0 ? "割ったら" : "超えたら")+"決済"+(p.armed ? "" : "（終値が一度EMA20の"+(x.dir > 0 ? "上" : "下")+"で確定してから有効）") : ""));
      liveOpen(p);
    }
  }
  // ---- 決済 ----
  function noteSlip(k, pct){ S.fills = S.fills || {en:[0,0], ex:[0,0]}; S.fills[k][0]++; S.fills[k][1] += pct; } // 想定価格との差（不利側が＋）
  function closePart(p, frac, px, reason, fillKnown){ // fillKnown＝pxが取引所の実際の約定価格のとき true（そうでなければ、ティッカー価格による推定）
    const q = frac >= 1 ? p.qty : p.qty*frac, notional = q*px, fee = notional*RULE.fee, m = frac >= 1 ? p.margin : p.margin*frac;
    const pnl = p.dir*(px - p.entry)*q - fee;
    S.cash += m + pnl; p.realized += pnl; p.qty -= q; p.margin -= m;
    if (frac >= 1 || p.qty <= p.qty0*1e-6){
      S.positions = S.positions.filter(x => x !== p);
      const booked = p.booked || 0, net = p.realized - p.fee - booked, eqPct = net/(p.margin0/RULE.marginPct)*100; // 一部決済で計上済みの分は、ここでは含めない
      const dk = new Date(Date.now()+9*3600e3).toISOString().slice(0,10);
      const rec = {sym:p.sym, dir:p.dir, pat:p.pat, entry:p.entry, exit:px, ts:p.ts, exitTs:Date.now(), net:+net.toFixed(2), eqPct:+eqPct.toFixed(2), reason, half:p.half, est:!fillKnown && !!(p.live && p.live.status === "open"), eq0:p.margin0/RULE.marginPct, dayKey:dk, entryEst:!p.fillEntry, booked:+booked.toFixed(2), total:+(net + booked).toFixed(2)};
      S.trades.unshift(rec);
      if (S.trades.length > 300) S.trades.length = 300;
      S.day[dk] = +((S.day[dk]||0) + net).toFixed(2);
      log("決済", baseOf(p.sym)+" "+reason+" ／ 損益 "+(net >= 0 ? "+" : "")+net.toFixed(2)+"$（総資産の"+(eqPct >= 0 ? "+" : "")+eqPct.toFixed(2)+"%）");
      liveClose(p, 1, {rec, px, q});
    } else { // 一部決済：履歴にも1行として記録し、今日の損益にも入れる（建てた時の手数料は、決済した割合ぶんを引く）
      const net = pnl - p.fee*(q/p.qty0), eq0 = p.margin0/RULE.marginPct, dk = new Date(Date.now()+9*3600e3).toISOString().slice(0,10);
      p.booked = (p.booked || 0) + net;
      const rec = {sym:p.sym, dir:p.dir, pat:p.pat, entry:p.entry, exit:px, ts:p.ts, exitTs:Date.now(), net:+net.toFixed(2), eqPct:+(net/eq0*100).toFixed(2), reason, half:true, part:true, est:!fillKnown && !!(p.live && p.live.status === "open"), eq0, dayKey:dk, entryEst:!p.fillEntry};
      S.trades.unshift(rec); if (S.trades.length > 300) S.trades.length = 300;
      S.day[dk] = +((S.day[dk]||0) + net).toFixed(2);
      log("半分利確", baseOf(p.sym)+" "+reason+" ／ 損益 "+(net >= 0 ? "+" : "")+net.toFixed(2)+"$（総資産の"+(net >= 0 ? "+" : "")+(net/eq0*100).toFixed(2)+"%）");
      liveClose(p, frac, {rec, px, q}); }
  }
  function managePrice(p){ // 毎回の価格で：損切り・半分利確
    const t = tokens.get(p.sym); if (!t || !(t.px > 0)) return;
    if (p.dir*(t.px - p.stop) <= 0) return closePart(p, 1, p.stop*(1 - p.dir*RULE.slip), p.be ? "建値で決済（半分利確後の損切り）" : "損切り（-"+(p.slPct || RULE.slPct)+"%）");
    if (!p.half && p.target != null && p.dir*(t.px - p.target) >= 0){
      p.half = true; p.stop = p.entry*(1 + p.dir*RULE.beCost); p.be = true; // 残りの損切りを建値（＋手数料分）へ引き上げる。取引所の注文も、半分決済のあとにこの価格で置き直す
      closePart(p, 0.5, p.target, "半分利確（"+p.targetName+"に到達）。残りの損切りを建値 "+fmtPx(p.stop)+" へ引き上げ"); }
  }
  function manageBar(p, L, P, e50, e20, atr){ // 15分足の確定ごとに：逆行の加速・EMA20トレーリング
    if (!S.positions.includes(p)) return;
    const px = (tokens.get(p.sym)||{}).px || L.c;
    if (accelOf(L, P, e50, atr, p.dir, RULE.accK)) return closePart(p, 1, px, "逆行が加速（終値がEMA50からATR"+RULE.accK+"本分以上逆側）");
    const bf = RULE.trailBuf*atr, dv = p.dir*(L.c - e20);
    if (!p.armed && dv > bf){ p.armed = true; log("トレーリング", baseOf(p.sym)+"：終値が15分足EMA20から"+RULE.trailBuf+"ATR以上、"+(p.dir > 0 ? "上" : "下")+"で確定。以後、EMA20の"+RULE.trailBuf+"ATR手前をトレーリングラインにする"); }
    if (p.armed && dv < -bf) return closePart(p, 1, px, "トレーリング決済（終値が15分足EMA20を"+RULE.trailBuf+"ATR以上、"+(p.dir > 0 ? "下" : "上")+"抜け）");
  }

  // ---- 取引所（BingXデモ）への発注。同じ銘柄の処理は順番に行う ----
  function chain(sym, fn){ const prev = chains.get(sym) || Promise.resolve(); const nx = prev.then(fn, fn); chains.set(sym, nx.catch(()=>{})); return nx; }
  const side = p => p.dir > 0 ? "LONG" : "SHORT";
  async function placeStop(p, qty, prec){ // 損切り注文を置き、その注文番号を返す（失敗したら例外）
    const j = await relay("/bracket-only", "POST", {symbol:baseOf(p.sym)+"USDT", positionSide:side(p), quantity:qty, slPrice:Number(p.stop.toFixed(prec.price))});
    if (j && j.errors && j.errors.length) throw new Error("損切り注文が通りませんでした: "+JSON.stringify(j.errors).slice(0,160));
    const id = j && j.ids ? j.ids.sl : null; addBot(id); return id;
  }
  async function fillOf(sym, orderId){ // 取引所の注文の、実際の平均約定価格（最大4回、0.8秒おきに確認）
    if (!orderId) return null;
    for (let i=0;i<4;i++){
      try{
        const j = await relay("/order-info?symbol="+baseOf(sym)+"USDT&orderId="+orderId), d = j && j.result && j.result.data, o = d && (d.order || d);
        const px = o ? parseFloat(o.avgPrice) : 0, q = o ? parseFloat(o.executedQty) : 0;
        if (px > 0 && q > 0) return {px, qty:q};
      }catch(_){}
      await new Promise(r => setTimeout(r, 800));
    }
    return null;
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
        const r = await relay("/order", "POST", {symbol:b+"USDT", side:p.dir > 0 ? "BUY" : "SELL", positionSide:side(p), quantity:qty}), oid = r && r.result && r.result._orderId; addBot(oid);
        p.live = {status:"open", qty, at:Date.now()};
        p.live.slId = await placeStop(p, qty, prec); // まず、想定価格の損切りを置く（無防備な時間を作らない）
        log("取引所", b+"：成行で建てて、損切り注文 "+fmtPx(p.stop)+" を置きました");
        const f = await fillOf(p.sym, oid);
        if (f && S.positions.includes(p)){ // 実際の約定価格で、建値・損切り・半分利確の目標を計算し直す
          const assumed = p.entry, slip = p.dir*(f.px - assumed)/assumed*100; noteSlip("en", slip); // 不利側が＋（ロングは高く買わされた、ショートは安く売らされた）
          p.entryAssumed = assumed; p.entry = f.px; p.fillEntry = true; p.stop = f.px*(1 - p.dir*(p.slPct || RULE.slPct)/100);
          const tg = p.v === "d1" ? targetD(p.sym, p.dir, f.px) : targetOf(p.sym, p.dir, f.px); p.target = tg ? tg.px : null; p.targetName = tg ? tg.name : null;
          const old = p.live.slId; p.live.slId = await placeStop(p, qty, prec); // 新しい損切りを先に置いてから、古い方を取り消す
          if (old) await relay("/cancel-order", "POST", {symbol:b+"USDT", orderId:old}).catch(()=>{});
          log("約定", b+"：実際の約定価格 "+fmtPx(f.px)+"（想定 "+fmtPx(assumed)+"、不利側に "+(slip >= 0 ? "+" : "")+slip.toFixed(2)+"%）。損切りを "+fmtPx(p.stop)+" に置き直しました");
        } else if (!f) log("約定", b+"：実際の約定価格を取得できなかったため、想定価格で計算します");
      }catch(err){ p.live = {status:p.live && p.live.status === "open" ? "open" : "error", qty:p.live && p.live.qty, msg:err.message}; log("取引所", b+"：発注の失敗 "+err.message); }
      persist();
    });
  }
  const closing = new Map(); // 決済注文を処理中の「銘柄|方向」（この間に取引所のポジションを照合しても、管理外とは見なさない）
  function liveClose(p, frac, ctx){
    if (!p.live || p.live.status !== "open") return;
    const ck = baseOf(p.sym)+"|"+side(p); closing.set(ck, (closing.get(ck)||0) + 1);
    chain(p.sym, async () => {
      const b = baseOf(p.sym), prec = await getPrecision(b);
      try{
        const q = frac >= 1 ? p.live.qty : floorTo(p.live.qty*frac, prec.qty);
        let oid = null;
        if (q > 0){ const r = await relay("/close", "POST", {symbol:b+"USDT", positionSide:side(p), quantity:q}).catch(err => { if (frac < 1) throw err; return null; }); oid = r && r.result && r.result._orderId; addBot(oid); }
        await relay("/cancel-all", "POST", {symbol:b+"USDT"}).catch(()=>{});
        if (frac >= 1){ p.live.status = "closed"; }
        else { p.live.qty = floorTo(p.live.qty - q, prec.qty); if (p.live.qty > 0) p.live.slId = await placeStop(p, p.live.qty, prec); }
        let f = ctx && oid ? await fillOf(p.sym, oid) : null; // 実際の約定価格で、損益を直す
        if (!f && ctx && frac >= 1 && !oid && p.live.slId) f = await fillOf(p.sym, p.live.slId); // 取引所の損切りが先に約定していたときは、その約定価格
        if (f){
          const delta = p.dir*(f.px - ctx.px)*ctx.q, slip = p.dir*(ctx.px - f.px)/ctx.px*100; noteSlip("ex", slip);
          S.cash += delta;
          if (ctx.rec){ const r = ctx.rec; r.net = +(r.net + delta).toFixed(2); r.eqPct = +(r.net/r.eq0*100).toFixed(2); r.exit = f.px; r.est = false; if (r.dayKey) S.day[r.dayKey] = +((S.day[r.dayKey]||0) + delta).toFixed(2);
            if (r.part){ p.realized += delta; p.booked = (p.booked||0) + delta; } } // 残りの損益の計算と、二重に数えないための計上済み額の両方に反映
          else p.realized += delta;
          log("約定", b+"：決済の実際の約定価格 "+fmtPx(f.px)+"（想定 "+fmtPx(ctx.px)+"、不利側に "+(slip >= 0 ? "+" : "")+slip.toFixed(2)+"%）。損益を "+(delta >= 0 ? "+" : "")+delta.toFixed(2)+"$ 補正");
        } else if (ctx && ctx.rec) log("約定", b+"：決済の実際の約定価格を取得できなかったため、推定のままです");
      }catch(err){ log("取引所", b+"：決済注文の失敗 "+err.message); }
      finally{ const n = (closing.get(ck)||1) - 1; if (n > 0) closing.set(ck, n); else closing.delete(ck); }
      persist();
    });
  }
  let lastOrderScanAt = 0;
  async function reconcile(now, force){ // 60秒ごとに取引所のポジションを確認する
    if (!force && now - lastReconcileAt < 60000) return; lastReconcileAt = now;
    const j = await relay("/positions"), raw = (j.result && j.result.data) || [], list = (Array.isArray(raw) ? raw : [raw]).filter(x => x && Math.abs(parseFloat(x.positionAmt)||0) > 0);
    const has = new Set(list.map(x => baseOf(String(x.symbol))+"|"+x.positionSide));
    // このアプリが管理していないポジション（以前のルールの残りなど）は、自動では決済せず、一覧にして画面に出す
    const mine = new Set([...S.positions.map(p => baseOf(p.sym)+"|"+side(p)), ...closing.keys()]);
    const others = list.filter(x => !mine.has(baseOf(String(x.symbol))+"|"+x.positionSide)).map(x => ({sym:baseOf(String(x.symbol)), side:x.positionSide,
      amt:Math.abs(parseFloat(x.positionAmt)||0), entry:parseFloat(x.avgPrice || x.entryPrice || 0), pnl:parseFloat(x.unrealizedProfit != null ? x.unrealizedProfit : (x.profit || 0)) || 0, lev:x.leverage}));
    let orderSyms = S.legacy ? S.legacy.orderSyms || [] : [];
    if (force || now - lastOrderScanAt > 10*60000){ lastOrderScanAt = now; // 未約定の注文（以前の損切り注文など）も10分ごとに確認
      const o = await relay("/open-orders").catch(() => null), od = o && o.result && o.result.data, orders = (od && (od.orders || od)) || [];
      const mineSym = new Set(S.positions.map(p => baseOf(p.sym)));
      orderSyms = [...new Set((Array.isArray(orders) ? orders : []).map(x => baseOf(String(x.symbol||""))).filter(v => v && !mineSym.has(v)))]; }
    const prevN = S.legacy ? S.legacy.positions.length : -1;
    S.legacy = (others.length || orderSyms.length) && !S.manualOn ? {at:now, positions:others, orderSyms} : null; // 手動記録モードでは、管理外のポジションは「手動トレード」として扱う
    if (others.length && prevN !== others.length && !S.manualOn) log("SYS", "取引所に、このアプリが管理していないポジションが"+others.length+"件あります（"+others.map(x => x.sym+" "+(x.side === "LONG" ? "ロング" : "ショート")).join("、")+"）。自動では決済しません。画面で確認してください");
    const opens = S.positions.filter(p => p.live && p.live.status === "open" && now - (p.live.at||0) > 30000); if (!opens.length) return;
    for (const p of opens) if (!has.has(baseOf(p.sym)+"|"+side(p))){
      p.live.status = "closed"; const f = p.live.slId ? await fillOf(p.sym, p.live.slId) : null, t = tokens.get(p.sym);
      if (f) noteSlip("ex", p.dir*(p.stop - f.px)/p.stop*100);
      closePart(p, 1, f ? f.px : (t ? t.px : p.entry), f ? "取引所の損切り注文が約定" : "取引所側で決済済み（損切り注文の約定など。価格は推定）", !!f); }
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
      bdStep(now).catch(err => { lastErr = "検証: "+err.message; });
      ledStep(now).catch(err => { lastErr = "BingXの収支の取得: "+err.message; });
    }catch(err){ lastErr = err.message; log("SYS", "処理エラー: "+err.message); }
    finally{ busy = false; persist(); }
  }
  const fmtPx = x => x >= 1000 ? x.toFixed(1) : x >= 1 ? x.toFixed(4) : x.toPrecision(4);

  // ============================================================
  // 過去検証：約60日の15分足で、この戦略を再現する（上位60銘柄）
  // ============================================================
  const BT_TOP = 60, BT_DAYS = 60, BT_STEP = 20000, BT_RAND = 32;
  const BT_ACC = [1.0, 1.2, 1.5, "S"], BT_TRAIL = ["m15", "h1"], BT_BUF = [0, 0.5, 1.0]; // 半分利確は、あり・なしで差がなかったので「あり」のみ
  const vKey = (a,t,b) => a+"|"+t+"|"+b, LIVE_V = vKey(1.2, "m15", RULE.trailBuf);
  let BT = null, btBusy = false, btAt = 0, btCache = null, btCacheAt = 0;
  function btFresh(){ return {ver:V3_BTVER, since:Date.now(), syms:[], done:{}, tr:{}, rb:{}, from:0, to:0, complete:false}; }
  // 保存は、決済方式ごと・1500件ごとに別のキーへ分ける（1つのキーの保存上限128KBを超えないため）
  function btLoad(){ try{ const j = JSON.parse(store.get(V3_BTKEY) || "null"); BT = j && j.ver === V3_BTVER ? j : btFresh();
      if (j && j.parts){ BT.tr = {}; for (const k in j.parts) for (let c=0;c<j.parts[k];c++){ const a = JSON.parse(store.get(V3_BTKEY+"_"+k+"_"+c) || "[]"); (BT.tr[k] || (BT.tr[k] = [])).push(...a); btSaved[k] = (BT.tr[k]||[]).length; } delete BT.parts; }
    }catch(_){ BT = btFresh(); } }
  const btSaved = {}; // 決済方式ごとに、保存済みの件数（変わった分のキーだけ書き直す）
  function btSave(){ const parts = {}, meta = Object.assign({}, BT, {tr:undefined});
    for (const k in BT.tr){ const a = BT.tr[k]; parts[k] = Math.ceil(a.length/1500);
      for (let c=Math.floor((btSaved[k]||0)/1500); c<parts[k]; c++) store.set(V3_BTKEY+"_"+k+"_"+c, JSON.stringify(a.slice(c*1500,(c+1)*1500))); btSaved[k] = a.length; }
    meta.parts = parts; store.set(V3_BTKEY, JSON.stringify(meta)); }
  function asOf(cs, tfMs, T, k){ while (k+1 < cs.length && cs[k+1].t + tfMs <= T) k++; return k; }
  // 1つの設定で、1銘柄を最初から最後まで再現する。rand>0なら、反転足の代わりに一定間隔で入る（比較用）
  function btSim(D, acc, trail, buf, rand){
    const half = true, {m, e50, e20, atr, h1, h20, ah1, hIdx, dir, dT, dE20, dE50, dHH, dLL} = D, out = [];
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
            let armedNow = false;
            if (trail === "h1"){ const k = hIdx[i], isClose = k >= 0 && h1[k].t + TFMS.h1 === L.t + TFMS.m15;
              if (isClose && h20[k] != null && ah1[k] != null){ const bf = buf*ah1[k], dv = x.d*(h1[k].c - h20[k]); armedNow = dv > bf; if (x.armed && dv < -bf) why = "tr"; } }
            else { const bf = buf*atr[i], dv = x.d*(L.c - e20[i]); armedNow = dv > bf; if (x.armed && dv < -bf) why = "tr"; }
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
    const e50 = emaSeries(m,50), e20 = emaSeries(m,20), atr = atrSeries(m,14), h20 = emaSeries(h1,20), ah1 = atrSeries(h1,14);
    const w20 = emaSeries(w,20), w50 = emaSeries(w,50), d20 = emaSeries(dd,20), d50 = emaSeries(dd,50);
    const dir = new Array(m.length).fill(0), dT = new Array(m.length).fill(-1), hIdx = new Array(m.length).fill(-1);
    const dHH = dd.map((_,k) => k >= 19 ? Math.max(...dd.slice(k-19,k+1).map(x => x.h)) : null), dLL = dd.map((_,k) => k >= 19 ? Math.min(...dd.slice(k-19,k+1).map(x => x.l)) : null);
    let kw = -1, kd = -1, kh = -1;
    for (let i=0;i<m.length;i++){ const T = m[i].t + TFMS.m15;
      kw = asOf(w, TFMS.w1, T, kw); kd = asOf(dd, TFMS.d1, T, kd); kh = asOf(h1, TFMS.h1, T, kh); dT[i] = kd; hIdx[i] = kh;
      if (kw + 1 < RULE.minWeeks || kd < 49) continue;
      const a = trendAt(w, w20, w50, kw), b = trendAt(dd, d20, d50, kd); dir[i] = (a !== 0 && a === b) ? a : 0; }
    const D = {m, e50, e20, atr, h1, h20, ah1, hIdx, dir, dT, dE20:d20, dE50:d50, dHH, dLL};
    for (const a of BT_ACC) for (const t of BT_TRAIL) for (const h of BT_BUF){
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
    for (const a of BT_ACC) for (const t of BT_TRAIL) for (const h of BT_BUF){
      const k = vKey(a,t,h), tr = BT.tr[k] || [], rb = BT.rb[k] || {n:0, s:0}; if (!tr.length){ rows.push({k, n:0}); continue; }
      const n = tr.length, avg = tr.reduce((s,x) => s + x[4], 0)/n, bySym = {};
      for (const x of tr){ const o = bySym[x[0]] || (bySym[x[0]] = [0,0]); o[0]++; o[1] += x[4]; }
      let ss = 0; for (const s in bySym){ const d0 = bySym[s][1] - bySym[s][0]*avg; ss += d0*d0; }
      const ci = 1.96*Math.sqrt(ss)/n, ra = rb.n ? rb.s/rb.n : null, pf = btPortfolio(tr, days);
      const cnt = w => tr.filter(x => x[6] === w).length, pat = p => tr.filter(x => x[7] === p).length;
      rows.push({k, acc:a, trail:t, buf:h, live:k === LIVE_V, n, win:Math.round(tr.filter(x => x[4] > 0).length/n*100), avg, ci, rand:ra, diff:ra == null ? null : avg - ra,
        exits:{sl:cnt("sl"), tr:cnt("tr"), ac:cnt("ac")}, pats:{en:pat("en"), ha:pat("ha")}, halfN:tr.filter(x => x[5]).length, pf,
        ok:!!(pf.ann != null && pf.ann >= 15 && pf.annA > 0 && pf.annB > 0 && ra != null && avg - ra > 0)});
    }
    btCache = {complete:BT.complete, done:Object.keys(BT.done).length, total:BT.syms.length || BT_TOP, skipped:Object.values(BT.done).filter(v => v < 0).length,
      from:BT.from, to:BT.to, days:+days.toFixed(1), rows}; btCacheAt = Date.now(); return btCache;
  }

  // ============================================================
  // 手動トレードの記録と分析
  // 取引所（BingXデモ）で手動で建てたポジションを検知し、①その時の相場の状況 ②損切り・利確の置き方 ③値動きと結果 を記録する。
  // 「ランダムに入った場合」の分布と比べて、入りの特徴（何が普通より偏っているか）と、入り後の値動き・決済の良し悪しを統計で確かめる。
  // ボットの新規エントリーは止め、ボットが管理していないポジションはすべて手動として扱う（自動では触らない）
  // ============================================================
  const MAN_KEY = "td3_man", MAN_VER = 1, MAN_POLL = 10000, MAN_DAYS = 14;
  let MAN = null, manAt = 0, manBusy = false, manQBusy = false, manDirty = false, manOrdSyms = [], manCache = null, manCacheAt = 0, btcCache = null;
  const manQ = [];
  function manFresh(){ return {ver:MAN_VER, seq:0, active:{}, done:[], diag:{}}; }
  function manLoad(){
    try{ const j = JSON.parse(store.get(MAN_KEY) || "null");
      if (j && j.ver === MAN_VER){ MAN = j; MAN.done = []; for (let c=0;c<(j.chunks||0);c++) MAN.done.push(...JSON.parse(store.get(MAN_KEY+"_d"+c) || "[]")); delete MAN.chunks; }
      else MAN = manFresh();
    }catch(_){ MAN = manFresh(); }
  }
  function manSave(){ // 20件ごとに別のキーへ分けて保存（1つのキーの保存上限を超えないため）
    const chunks = Math.ceil(MAN.done.length/20), meta = Object.assign({}, MAN, {done:undefined, chunks});
    for (let c=0;c<chunks;c++) store.set(MAN_KEY+"_d"+c, JSON.stringify(MAN.done.slice(c*20,(c+1)*20)));
    store.set(MAN_KEY, JSON.stringify(meta)); manDirty = false;
  }
  const num = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };

  // ---- 相場の状況（特徴量）：バケットに分けて、ランダムな時点の分布と比べられるようにする ----
  const FEATS = [
    ["tW", "週足の向き"], ["tD", "日足の向き"], ["t4", "4時間足の向き"], ["t1", "1時間足の向き"], ["tB", "BTC(1時間足)の向き"],
    ["loc50", "15分足の終値とEMA50の位置（ATR比）"], ["loc20", "15分足の終値とEMA20の位置（ATR比）"], ["stack", "15分足EMA20とEMA50の並び"],
    ["body", "直近の15分足の実体（ATR比）"], ["rev", "直近の反転足"], ["mom1", "直近1時間の値動き"], ["mom24", "直近24時間の値動き"],
    ["rng24", "24時間レンジ内の位置"], ["d20", "20日高値/安値までの距離（日足ATR比）"], ["vol", "出来高（直近20本平均比）"], ["atrP", "値動きの大きさ（15分足ATR%）"], ["hour", "時間帯（日本時間）"]
  ];
  const FLAB = Object.fromEntries(FEATS);
  const bk = (v, edges, labels) => { let i = 0; while (i < edges.length && v >= edges[i]) i++; return labels[i]; };
  const L6 = ["<−2", "−2〜−0.7", "−0.7〜0", "0〜0.7", "0.7〜2", "2以上"];
  function ctxBuild(x){ // ろうそく一式 → 各時点で参照できる系列
    const m = x.m, n = m.length, C = {m, n, e20:emaSeries(m,20), e50:emaSeries(m,50), atr:atrSeries(m,14)};
    C.vavg = m.map((_,i) => { if (i < 20) return null; let s = 0; for (let k=i-20;k<i;k++) s += m[k].v||0; return s/20; });
    const tser = arr => { const a = emaSeries(arr,20), b = emaSeries(arr,50); return arr.map((_,i) => trendAt(arr, a, b, i)); };
    C.tw = tser(x.w); C.td = tser(x.d); C.t4 = tser(x.h4); C.t1 = tser(x.h1); C.tb = tser(x.btc);
    C.atrD = atrSeries(x.d,14);
    C.dH = x.d.map((_,k) => k >= 19 ? Math.max(...x.d.slice(k-19,k+1).map(z => z.h)) : null); C.dL = x.d.map((_,k) => k >= 19 ? Math.min(...x.d.slice(k-19,k+1).map(z => z.l)) : null);
    const ptr = (arr, tf) => { const out = new Array(n); let k = -1; for (let i=0;i<n;i++){ const T = m[i].t + TFMS.m15; while (k+1 < arr.length && arr[k+1].t + tf <= T) k++; out[i] = k; } return out; };
    C.kw = ptr(x.w, TFMS.w1); C.kd = ptr(x.d, TFMS.d1); C.k4 = ptr(x.h4, TFMS.h4); C.k1 = ptr(x.h1, TFMS.h1); C.kb = ptr(x.btc, TFMS.h1);
    return C;
  }
  function featOf(C, i, dir){ // i番目の15分足が確定した時点の特徴。値は「自分の方向が＋」になるよう符号をそろえる
    const m = C.m, a = C.atr[i]; if (i < 100 || !(a > 0)) return null;
    const L = m[i], P = m[i-1], c = L.c, F = {};
    const sg = t => t === 0 ? "レンジ" : (t === dir ? "一致" : "逆"), tv = (arr, k) => k >= 0 ? arr[k] : 0;
    F.tW = sg(tv(C.tw, C.kw[i])); F.tD = sg(tv(C.td, C.kd[i])); F.t4 = sg(tv(C.t4, C.k4[i])); F.t1 = sg(tv(C.t1, C.k1[i])); F.tB = sg(tv(C.tb, C.kb[i]));
    F.loc50 = bk(dir*(c - C.e50[i])/a, [-2,-0.7,0,0.7,2], L6); F.loc20 = bk(dir*(c - C.e20[i])/a, [-2,-0.7,0,0.7,2], L6);
    F.stack = dir*(C.e20[i] - C.e50[i]) > 0 ? "自分の方向に並ぶ" : "逆に並ぶ";
    F.body = bk(dir*(L.c - L.o)/a, [-0.8,-0.2,0.2,0.8], ["逆に強い", "逆に小さい", "ほぼ無し", "順に小さい", "順に強い"]);
    F.rev = reversalOf(P, L, dir) ? PATNAME[reversalOf(P, L, dir)] : "なし";
    F.mom1 = bk(dir*(c/m[i-4].c - 1)*100, [-1,-0.3,0.3,1], ["<−1%", "−1〜−0.3%", "±0.3%", "0.3〜1%", "1%以上"]);
    F.mom24 = bk(dir*(c/m[i-96].c - 1)*100, [-5,-1.5,1.5,5], ["<−5%", "−5〜−1.5%", "±1.5%", "1.5〜5%", "5%以上"]);
    let hi = -Infinity, lo = Infinity; for (let k=i-95;k<=i;k++){ if (m[k].h > hi) hi = m[k].h; if (m[k].l < lo) lo = m[k].l; }
    const r = hi > lo ? (c - lo)/(hi - lo) : 0.5, pr = dir > 0 ? r : 1 - r; // 0＝自分の方向と逆の端（押し目側）、1＝自分の方向の端（高値/安値圏）
    F.rng24 = bk(pr, [0.2,0.4,0.6,0.8], ["逆の端(下位20%)", "20〜40%", "中央", "60〜80%", "順の端(上位20%)"]);
    const kd = C.kd[i], aD = kd >= 0 ? C.atrD[kd] : null;
    if (kd >= 19 && aD > 0){ const dd = dir > 0 ? (C.dH[kd] - c)/aD : (c - C.dL[kd])/aD; F.d20 = bk(dd, [0,1,3], ["更新", "0〜1", "1〜3", "3以上"]); } else F.d20 = "データなし";
    const va = C.vavg[i]; F.vol = va > 0 ? bk((L.v||0)/va, [0.7,1.3,2.5], ["<0.7倍", "0.7〜1.3倍", "1.3〜2.5倍", "2.5倍以上"]) : "データなし";
    F.atrP = bk(a/c*100, [0.3,0.6,1.0], ["<0.3%", "0.3〜0.6%", "0.6〜1.0%", "1.0%以上"]);
    const h = new Date(L.t + TFMS.m15 + 9*3600e3).getUTCHours(); F.hour = h < 6 ? "0〜6時" : h < 12 ? "6〜12時" : h < 18 ? "12〜18時" : "18〜24時";
    return F;
  }
  function baseStats(C, dir){ // ランダムな時点（この銘柄の直近の全ての15分足）の特徴の分布と、その後の平均的な値動き
    const freq = {}, fs = {m15:[0,0], h1:[0,0], h4:[0,0], h24:[0,0]}; let nb = 0;
    for (const [k] of FEATS) freq[k] = {};
    for (let i=200;i<C.n;i++){
      const F = featOf(C, i, dir); if (!F) continue; nb++;
      for (const [k] of FEATS) freq[k][F[k]] = (freq[k][F[k]]||0) + 1;
      for (const [nm, kb] of [["m15",1],["h1",4],["h4",16],["h24",96]]) if (i + kb < C.n){ fs[nm][0]++; fs[nm][1] += dir*(C.m[i+kb].c/C.m[i].c - 1)*100; }
    }
    const fwd = {}; for (const nm in fs) fwd[nm] = fs[nm][0] > 20 ? +(fs[nm][1]/fs[nm][0]).toFixed(4) : null;
    return {n:nb, freq, fwd};
  }
  function replayBot(C, i0, dir, entry, iEnd){ // 今のボットの決済ルール（損切り・逆行加速・トレーリング）を、手動の入りに当てはめたらどうなったか（価格の%・コスト前）
    let armed = false; const stop = entry*(1 - dir*RULE.slPct/100);
    for (let i=Math.max(i0,1); i<=iEnd && i<C.n; i++){
      const L = C.m[i], P = C.m[i-1];
      if (dir > 0 ? L.l <= stop : L.h >= stop) return {pct:dir*(stop/entry - 1)*100, why:"損切り", bars:i-i0+1};
      if (accelOf(L, P, C.e50[i], C.atr[i], dir, RULE.accK)) return {pct:dir*(L.c/entry - 1)*100, why:"逆行の加速", bars:i-i0+1};
      const bf = RULE.trailBuf*C.atr[i], dv = dir*(L.c - C.e20[i]);
      if (!armed && dv > bf) armed = true;
      if (armed && dv < -bf) return {pct:dir*(L.c/entry - 1)*100, why:"トレーリング", bars:i-i0+1};
    }
    const j = Math.min(iEnd, C.n-1); return {pct:dir*(C.m[j].c/entry - 1)*100, why:"未決済(手動の決済時点)", bars:j-i0+1};
  }

  // ---- ろうそくの取得 ----
  async function btcH1(days, now){
    if (btcCache && now - btcCache.at < 30*60000 && btcCache.days >= days) return btcCache.arr;
    const arr = await fetchKBack("BTC", "1h", TFMS.h1, days*24 + 220, now); btcCache = {at:now, days, arr}; return arr;
  }
  async function ctxLoad(sym, days){
    const b = baseOf(sym), now = Date.now();
    const w = await fetchK(b, "1w", TFMS.w1, 300, now), d = await fetchK(b, "1d", TFMS.d1, 300, now), h4 = await fetchK(b, "4h", TFMS.h4, 300, now);
    const h1 = await fetchKBack(b, "1h", TFMS.h1, days*24 + 220, now), m = await fetchKBack(b, "15m", TFMS.m15, days*96 + 260, now);
    const btc = b === "BTC" ? h1 : await btcH1(days, now);
    if (m.length < 300) throw new Error("15分足が足りません（"+m.length+"本）");
    return ctxBuild({w, d, h4, h1, m, btc});
  }
  const lastClosedIdx = (C, t) => { let i = C.n - 1; while (i > 0 && C.m[i].t + TFMS.m15 > t) i--; return i; }; // 時刻tの直前に確定した15分足

  // ---- 検知と追跡（10秒ごと） ----
  async function manualStep(now){
    if (!S.manualOn || manBusy || now - manAt < MAN_POLL) return;
    manAt = now; manBusy = true;
    try{
      const j = await relay("/positions"), raw = (j.result && j.result.data) || [], all = (Array.isArray(raw) ? raw : [raw]).filter(x => x && Math.abs(num(x.positionAmt)) > 0);
      const o = await relay("/open-orders").catch(() => null), od = o && o.result && o.result.data, ords = (od && (od.orders || od)) || [];
      const orders = Array.isArray(ords) ? ords : [];
      MAN.diag = {at:now, pos:all.slice(0,2), ord:orders.slice(0,3)}; // 取引所の応答の生データの見本（項目名の確認用）
      const mine = new Set([...S.positions.map(p => baseOf(p.sym)+"|"+side(p)), ...closing.keys()]), botSyms = new Set(S.positions.map(p => baseOf(p.sym))), seen = new Set();
      manOrdSyms = [...new Set(orders.map(od => baseOf(String(od.symbol||""))).filter(v => v && !botSyms.has(v)))];
      for (const x of all){
        const b = baseOf(String(x.symbol)), amt = Math.abs(num(x.positionAmt)), ps = String(x.positionSide || (num(x.positionAmt) > 0 ? "LONG" : "SHORT")).toUpperCase(), k = b+"|"+ps;
        if (mine.has(k)) continue;
        seen.add(k);
        const dir = ps === "LONG" ? 1 : -1, avg = num(x.avgPrice || x.entryPrice), t = tokens.get(b+"-USDT"), px = t ? t.px : avg;
        let r = MAN.active[k];
        if (!r){
          r = MAN.active[k] = {id:++MAN.seq, sym:b+"-USDT", dir, t0:now, entry:avg, qty:amt, qtyMax:amt, lev:num(x.leverage) || null, margin:num(x.initialMargin || x.margin) || null,
            miss:0, mfe:0, mae:0, snaps:{}, ev:[], lv:[], last:px, F:null};
          log("手動", b+" "+(dir > 0 ? "ロング" : "ショート")+"を検知（建値 "+fmtPx(avg)+"／数量 "+amt+"）。相場の状況を記録します");
          manQ.push(() => manCtx(r));
        } else {
          r.miss = 0;
          if (amt > r.qty*1.001){ r.ev.push({t:now, k:"add", q:+(amt - r.qty).toFixed(6), px}); r.qtyMax = Math.max(r.qtyMax, amt); }
          else if (amt < r.qty*0.999) r.ev.push({t:now, k:"reduce", q:+(r.qty - amt).toFixed(6), px});
          if (r.ev.length > 30) r.ev.length = 30;
          r.qty = amt; if (avg > 0) r.entry = avg;
        }
        r.last = px; r.upnl = num(x.unrealizedProfit);
        if (r.entry > 0){
          const g = dir*(px/r.entry - 1)*100; r.mfe = Math.max(r.mfe, g); r.mae = Math.min(r.mae, g);
          const el = now - r.t0; for (const [nm, ms] of [["m5",300000], ["m15",900000], ["h1",3600000], ["h4",14400000], ["h24",86400000]]) if (el >= ms && r.snaps[nm] == null) r.snaps[nm] = +g.toFixed(3);
        }
        for (const od of orders){ // 損切り・利確の注文（置いた価格と、置き直した履歴）
          if (baseOf(String(od.symbol||"")) !== b || String(od.positionSide||"").toUpperCase() !== ps || String(od.side||"").toUpperCase() !== (dir > 0 ? "SELL" : "BUY")) continue;
          const ty = String(od.type||"").toUpperCase(), sp = num(od.stopPrice), pr = num(od.price); let kind = null, lvl = 0;
          if (/^STOP/.test(ty)){ kind = "SL"; lvl = sp || pr; } else if (/^TAKE_PROFIT/.test(ty)){ kind = "TP"; lvl = sp || pr; }
          else if (ty === "LIMIT" && pr > 0){ kind = dir*(pr - r.entry) > 0 ? "TP" : "SL"; lvl = pr; }
          if (!kind || !(lvl > 0) || !(r.entry > 0)) continue;
          const prev = [...r.lv].reverse().find(z => z.kind === kind);
          if (!prev || Math.abs(prev.px/lvl - 1) > 0.0002){ r.lv.push({t:now, kind, px:lvl, pct:+(dir*(lvl/r.entry - 1)*100).toFixed(3)}); if (r.lv.length > 14) r.lv.shift(); }
        }
      }
      for (const k of Object.keys(MAN.active)) if (!seen.has(k)){ const r = MAN.active[k]; r.miss++; if (r.miss >= 2){ delete MAN.active[k]; manQ.push(() => manFinalize(r)); } }
      manDirty = true; manCache = null;
    }catch(err){ lastErr = "手動記録: "+err.message; }
    finally{ manBusy = false; }
  }
  async function manWork(){ // 重い取得は、1回の処理につき1件ずつ
    if (manQBusy || !manQ.length) return; manQBusy = true;
    try{ await manQ.shift()(); manDirty = true; manCache = null; }catch(err){ lastErr = "手動記録: "+err.message; }
    finally{ manQBusy = false; }
  }
  async function manCtx(r){ // 入った時点の相場の状況
    const C = await ctxLoad(r.sym, MAN_DAYS), i = lastClosedIdx(C, r.t0), F = featOf(C, i, r.dir);
    if (!F) throw new Error(baseOf(r.sym)+"：特徴を計算できませんでした");
    r.F = F; r.i0t = C.m[i].t;
    const t = tokens.get(r.sym); r.raw = {atr:+C.atr[i].toFixed(8), atrP:+(C.atr[i]/C.m[i].c*100).toFixed(3), turn:t ? Math.round(t.turn) : null, px:C.m[i].c};
    log("手動", baseOf(r.sym)+"：入りの状況を記録（週足 "+F.tW+"／日足 "+F.tD+"／15分足EMA50との位置 "+F.loc50+"ATR／反転足 "+F.rev+"）");
  }
  async function histFills(r){ // 取引所の注文履歴から、実際の入り・出の約定を取る
    const j = await relay("/order-history?symbol="+baseOf(r.sym)+"USDT&startTime="+Math.max(0, r.t0 - 10*60000)+"&limit=100"), d = j && j.result && j.result.data, arr = (d && (d.orders || d)) || [];
    const opS = r.dir > 0 ? "BUY" : "SELL", ps = r.dir > 0 ? "LONG" : "SHORT";
    const fl = (Array.isArray(arr) ? arr : []).filter(z => String(z.positionSide||"").toUpperCase() === ps && num(z.executedQty) > 0 && num(z.avgPrice) > 0 && (!z.status || /FILLED/i.test(String(z.status))));
    const op = fl.filter(z => String(z.side).toUpperCase() === opS && num(z.updateTime || z.time) >= r.t0 - 10*60000), cl = fl.filter(z => String(z.side).toUpperCase() !== opS && num(z.updateTime || z.time) >= r.t0 - 60000);
    const vw = a => { const q = a.reduce((s,z) => s + num(z.executedQty), 0); return q > 0 ? a.reduce((s,z) => s + num(z.avgPrice)*num(z.executedQty), 0)/q : 0; };
    if (!cl.length) return null;
    const last = cl.slice().sort((a,b) => num(a.updateTime||a.time) - num(b.updateTime||b.time)).pop(), ty = String(last.type||"").toUpperCase();
    return {entryPx:vw(op), exitPx:vw(cl), entryT:op.length ? Math.min(...op.map(z => num(z.time || z.updateTime))) : 0, exitT:num(last.updateTime || last.time),
      profit:[...op, ...cl].reduce((s,z) => s + num(z.profit), 0), fee:[...op, ...cl].reduce((s,z) => s + Math.abs(num(z.commission)), 0),
      how:/^STOP/.test(ty) ? "損切り注文が約定" : /^TAKE_PROFIT/.test(ty) ? "利確注文が約定" : ty === "LIMIT" ? "指値で決済" : ty === "MARKET" ? "成行で決済" : (ty || "不明"), nCl:cl.length};
  }
  async function manFinalize(r){ // ポジションが無くなった：結果を確定し、後から分析するための取得を予約
    let h = null; try{ h = await histFills(r); }catch(_){}
    const dir = r.dir, ex = h && h.exitPx > 0 ? h.exitPx : r.last, en = h && h.entryPx > 0 ? h.entryPx : r.entry;
    r.entryFill = en; r.exit = ex; r.exitEst = !(h && h.exitPx > 0); r.how = h ? h.how : "不明（注文履歴を取得できず、最後の価格で推定）";
    r.t0 = h && h.entryT > 0 ? h.entryT : r.t0; r.t1 = h && h.exitT > 0 ? h.exitT : Date.now();
    r.pct = +(dir*(ex/en - 1)*100).toFixed(3);
    r.pnl = h && (h.profit || h.fee) ? +(h.profit - h.fee).toFixed(2) : +(dir*(ex - en)*r.qtyMax).toFixed(2); r.pnlEst = !(h && (h.profit || h.fee));
    r.notional = +(en*r.qtyMax).toFixed(2); r.hold = r.t1 - r.t0;
    MAN.done.push(r);
    log("手動", baseOf(r.sym)+" "+(dir > 0 ? "ロング" : "ショート")+"の決済を記録：価格 "+(r.pct >= 0 ? "+" : "")+r.pct+"%／損益 "+(r.pnl >= 0 ? "+" : "")+r.pnl+"$（"+r.how+"）");
    manQ.push(() => manPost(r));
  }
  async function manPost(r){ // 入り後の値動き・ランダム入りとの比較・ボットの決済ルールを当てはめた場合
    const days = Math.min(40, MAN_DAYS + Math.ceil((Date.now() - r.t0)/86400e3)), C = await ctxLoad(r.sym, days), iE = lastClosedIdx(C, r.t0);
    if (!r.F){ r.F = featOf(C, iE, r.dir); r.i0t = C.m[iE].t; }
    const en = r.entryFill || r.entry; r.fwd = {};
    for (const [nm, kb] of [["m15",1], ["h1",4], ["h4",16], ["h24",96]]) r.fwd[nm] = iE + kb < C.n ? +(r.dir*(C.m[iE+kb].c/en - 1)*100).toFixed(3) : null;
    r.base = baseStats(C, r.dir);
    const iX = lastClosedIdx(C, r.t1); r.bot = iX > iE ? replayBot(C, iE+1, r.dir, en, iX) : null;
    if (r.bot) r.bot.pct = +r.bot.pct.toFixed(3);
    r.post = true;
  }

  // ---- 集計（画面・報告用） ----
  function manSummary(force){
    if (!force && manCache && Date.now() - manCacheAt < 20000) return manCache;
    const done = MAN.done, act = Object.values(MAN.active), N = done.length, mean = a => a.length ? a.reduce((s,v) => s + v, 0)/a.length : null;
    const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s,v) => s + (v-m)*(v-m), 0)/(a.length-1)); };
    const lvOf = (r, kind) => { const z = r.lv.find(v => v.kind === kind); return z ? z.pct : null; };
    const trades = done.slice().reverse().map(r => ({id:r.id, sym:r.sym, dir:r.dir, t0:r.t0, t1:r.t1, hold:r.hold, entry:r.entryFill||r.entry, exit:r.exit, pct:r.pct, pnl:r.pnl, pnlEst:!!r.pnlEst, exitEst:!!r.exitEst, how:r.how,
      mfe:+r.mfe.toFixed(2), mae:+r.mae.toFixed(2), cap:r.mfe > 0.05 ? Math.round(r.pct/r.mfe*100) : null, sl:lvOf(r,"SL"), tp:lvOf(r,"TP"), adds:r.ev.filter(e => e.k === "add").length, reduces:r.ev.filter(e => e.k === "reduce").length,
      F:r.F, bot:r.bot ? {pct:r.bot.pct, why:r.bot.why} : null, snaps:r.snaps}));
    const pcts = done.map(r => r.pct), wins = done.filter(r => r.pnl > 0).length;
    const caps = trades.filter(t => t.cap != null).map(t => t.cap);
    const stat = {n:N, win:N ? Math.round(wins/N*100) : null, pnl:+done.reduce((s,r) => s + (r.pnl||0), 0).toFixed(2), avgPct:mean(pcts), avgPnl:mean(done.map(r => r.pnl||0)), hold:mean(done.map(r => r.hold||0)),
      mfe:mean(done.map(r => r.mfe)), mae:mean(done.map(r => r.mae)), cap:mean(caps), sl:mean(trades.map(t => t.sl).filter(v => v != null)), tp:mean(trades.map(t => t.tp).filter(v => v != null)), slN:trades.filter(t => t.sl != null).length, tpN:trades.filter(t => t.tp != null).length,
      noSl:trades.filter(t => t.sl == null).length, adds:trades.reduce((s,t) => s + t.adds, 0), estN:done.filter(r => r.pnlEst || r.exitEst).length};
    // 入りの特徴：ランダムな時点と比べた偏り（Poisson二項の期待値と分散）
    const wf = done.filter(r => r.F && r.base && r.base.n > 100), rows = [];
    for (const [f, label] of FEATS){
      const bs = new Set(); for (const r of wf){ bs.add(r.F[f]); for (const b in r.base.freq[f]) bs.add(b); }
      for (const b of bs){
        let c = 0, E = 0, V = 0;
        for (const r of wf){ if (r.F[f] === b) c++; const q = (r.base.freq[f][b]||0)/r.base.n; E += q; V += q*(1-q); }
        if (c === 0 && E < 1) continue;
        rows.push({f, label, b, c, n:wf.length, share:c/wf.length, exp:E/wf.length, lift:E > 0 ? c/E : null, z:V > 0 ? (c - E)/Math.sqrt(V) : 0});
      }
    }
    rows.sort((a,b) => Math.abs(b.z) - Math.abs(a.z));
    const cand = wf.length >= 8 ? rows.filter(x => x.z >= 3 && x.share >= 0.5 && x.c >= 3).slice(0, 8) : []; // 約85通りを同時に見るので、偶然を除くためにz≥3・8件以上を「候補」の条件にする
    // 入り後の値動き：同じ銘柄・同じ方向でランダムに入った場合との差
    const fw = ["m15","h1","h4","h24"].map(nm => { const d = wf.filter(r => r.fwd && r.fwd[nm] != null && r.base.fwd[nm] != null).map(r => r.fwd[nm] - r.base.fwd[nm]); const m = mean(d), s = sd(d);
      return {nm, n:d.length, man:mean(wf.filter(r => r.fwd && r.fwd[nm] != null && r.base.fwd[nm] != null).map(r => r.fwd[nm])), base:mean(wf.filter(r => r.fwd && r.fwd[nm] != null && r.base.fwd[nm] != null).map(r => r.base.fwd[nm])), diff:m, se:s != null && d.length ? s/Math.sqrt(d.length) : null}; });
    const wb = done.filter(r => r.bot), bot = {n:wb.length, man:mean(wb.map(r => r.pct)), bot:mean(wb.map(r => r.bot.pct)),
      better:wb.filter(r => r.pct > r.bot.pct).length};
    const active = act.map(r => { const t = tokens.get(r.sym); return {id:r.id, sym:r.sym, dir:r.dir, t0:r.t0, entry:r.entry, px:t ? t.px : r.last, g:r.entry > 0 ? r.dir*((t ? t.px : r.last)/r.entry - 1)*100 : null, upnl:r.upnl, mfe:+r.mfe.toFixed(2), mae:+r.mae.toFixed(2),
      sl:lvOf(r,"SL"), tp:lvOf(r,"TP"), lv:r.lv.slice(-4), F:r.F, qty:r.qty, pending:!r.F}; });
    manCache = {on:true, stat, trades, active, rows:rows.slice(0, 40), cand, fw, bot, nF:wf.length, queue:manQ.length, diag:MAN.diag}; manCacheAt = Date.now();
    return manCache;
  }

  // ============================================================
  // BingXの収支と約定履歴（正とする数字）
  //   実現損益 ＝ BingXの収支明細（確定損益 ＋ 取引手数料 ＋ 資金調達）の、最初のボットの売買以降の合計
  //   含み損益 ＝ BingXの保有ポジションの含み損益の合計
  //   総資産   ＝ 500 ＋ 実現損益 ＋ 含み損益
  // 約定履歴は、BingXの注文履歴（半分利確・損切り・手動の約定を含む）をそのまま表示する
  // ============================================================
  const LED_KEY = "td3_led", LED_VER = 1, LED_MAXROWS = 320;
  let LED = null, ledAt = 0, ledBusy = false, ledIncAt = 0, ledPosAt = 0, ledDirty = false, ledSavedAt = 0, ledSymAt = {}, ledCache = null, ledCacheAt = 0, posC = null;
  function ledFresh(){ return {ver:LED_VER, since:null, rows:{}, inc:null, upnl:null, diag:{}}; }
  function ledLoad(){ try{ const j = JSON.parse(store.get(LED_KEY) || "null"); LED = j && j.ver === LED_VER ? j : ledFresh(); }catch(_){ LED = ledFresh(); } }
  function ledSave(){ store.set(LED_KEY, JSON.stringify(LED)); ledDirty = false; ledSavedAt = Date.now(); }
  function addBot(id){ if (!id) return; id = String(id); S.botOids = S.botOids || []; if (!S.botOids.includes(id)){ S.botOids.push(id); if (S.botOids.length > 500) S.botOids.shift(); } } // ボットが出した注文の番号（履歴で「ボット」と区別する）
  async function positionsRaw(maxAge){
    const now = Date.now(); if (posC && now - posC.at <= maxAge) return posC.list;
    const j = await relay("/positions"), raw = (j.result && j.result.data) || [], list = (Array.isArray(raw) ? raw : [raw]).filter(x => x && Math.abs(num(x.positionAmt)) > 0);
    posC = {at:now, list}; return list;
  }
  function ledSince(){ // 最初のボットの売買の1分前から数える（それ以前の、以前のルールのポジションの損益を混ぜない）
    if (LED.since) return LED.since;
    const ts = [...S.trades.map(x => x.ts), ...S.positions.map(p => p.ts)].filter(v => v > 0);
    if (!ts.length) return null;
    LED.since = Math.min(...ts) - 60000; ledDirty = true; return LED.since;
  }
  async function ledIncome(now){ // 収支明細（確定損益・取引手数料・資金調達）
    const since = ledSince(); if (!since) return;
    const j = await relay("/income?startTime="+since+"&limit=1000"), d = j.result && j.result.data;
    const arr = Array.isArray(d) ? d : (d && (d.income || d.list || d.rows || d.data)) || [], list = Array.isArray(arr) ? arr : [];
    LED.diag.inc = list.slice(0,3);
    const sum = {pnl:0, fee:0, fund:0, oth:0}, types = {}, byDay = {}, syms = {};
    for (const x of list){
      const t = num(x.time || x.createTime); if (t && t < since) continue;
      const ty = String(x.incomeType || x.type || "").toUpperCase(); types[ty] = (types[ty]||0) + 1;
      if (/TRANSFER|TRIAL|DEPOSIT|WITHDRAW|GTD|AIRDROP|REBATE/.test(ty)) continue; // 入出金・付与などは損益に含めない
      let v = num(x.income != null ? x.income : x.amount), k;
      if (ty === "REALIZED_PNL") k = "pnl"; else if (/FUND/.test(ty)) k = "fund"; else if (/FEE|COMMISSION/.test(ty)){ k = "fee"; v = -Math.abs(v); } else k = "oth"; // 手数料は必ず支払い（マイナス）
      sum[k] += v;
      const dk = new Date((t || now) + 9*3600e3).toISOString().slice(0,10); byDay[dk] = (byDay[dk]||0) + v;
      if (x.symbol) syms[baseOf(String(x.symbol))] = 1;
    }
    LED.inc = {at:now, n:list.length, cap:list.length >= 1000, pnl:+sum.pnl.toFixed(4), fee:+sum.fee.toFixed(4), fund:+sum.fund.toFixed(4), oth:+sum.oth.toFixed(4), types, byDay, syms:Object.keys(syms)};
    ledDirty = true;
  }
  async function ledPositions(now){ // 保有ポジションの含み損益
    const list = await positionsRaw(0);
    LED.upnl = {at:now, n:list.length, sum:+list.reduce((s,x) => s + num(x.unrealizedProfit), 0).toFixed(4), list:list.slice(0,30).map(x => ({sym:baseOf(String(x.symbol)), ps:String(x.positionSide||"").toUpperCase(), amt:num(x.positionAmt), upnl:num(x.unrealizedProfit)}))};
    ledDirty = true;
  }
  async function ledOrders(now){ // 注文履歴（約定した注文）。1回に1銘柄ずつ
    const since = ledSince(); if (!since) return;
    const open = new Set((LED.upnl ? LED.upnl.list : []).map(x => x.sym));
    const cand = new Set([...open, ...(LED.inc ? LED.inc.syms : []), ...S.positions.map(p => baseOf(p.sym)), ...S.trades.slice(0,60).map(t => baseOf(t.sym)), ...Object.values(MAN.active).map(r => baseOf(r.sym)), ...MAN.done.slice(-30).map(r => baseOf(r.sym))]);
    const due = [...cand].filter(b => now - (ledSymAt[b]||0) >= (open.has(b) ? 20000 : 180000)).sort((a,b) => (ledSymAt[a]||0) - (ledSymAt[b]||0));
    if (!due.length) return;
    const b = due[0]; ledSymAt[b] = now;
    const j = await relay("/order-history?symbol="+b+"USDT&startTime="+since+"&limit=100"), d = j.result && j.result.data, arr = (d && (d.orders || d)) || [], list = Array.isArray(arr) ? arr : [];
    if (list.length && !LED.diag.ord) LED.diag.ord = list.slice(0,2);
    for (const o of list){
      const q = num(o.executedQty), p = num(o.avgPrice), st = String(o.status||"").toUpperCase();
      if (!(q > 0) || !(p > 0) || /CANCEL|EXPIRED|REJECT|^NEW$/.test(st)) continue;
      LED.rows[String(o.orderId)] = {t:num(o.updateTime || o.time), sym:b, s:String(o.side||"").toUpperCase(), ps:String(o.positionSide||"").toUpperCase(), ty:String(o.type||"").toUpperCase(), q, p, f:Math.abs(num(o.commission)), g:num(o.profit)};
    }
    const ids = Object.keys(LED.rows);
    if (ids.length > LED_MAXROWS){ ids.sort((a,b) => LED.rows[a].t - LED.rows[b].t); for (const id of ids.slice(0, ids.length - LED_MAXROWS)) delete LED.rows[id]; }
    ledDirty = true;
  }
  async function ledStep(now){
    if (!LED || ledBusy || now - ledAt < 5000) return; ledAt = now; ledBusy = true;
    try{
      if (now - ledIncAt >= (LED.incErr ? 120000 : 30000)){ ledIncAt = now; // 失敗が続いているときは2分おきに再試行
        try{ await ledIncome(now); LED.incErr = null; }
        catch(err){ LED.incErr = {since:LED.incErr ? LED.incErr.since : now, at:now, msg:String(err.message).slice(0,200)}; ledDirty = true;
          if (now - LED.incErr.since > 15*60000) lastErr = "BingXの収支明細を15分以上取得できていません（注文履歴の合計で代用中）: "+LED.incErr.msg; } }
      else if (now - ledPosAt >= 15000){ ledPosAt = now; await ledPositions(now); }
      else await ledOrders(now);
      ledCache = null;
    }catch(err){ lastErr = "BingXの収支の取得: "+err.message; }
    finally{ ledBusy = false; }
  }
  function ledGet(){ // 集計（3秒キャッシュ）
    const now = Date.now(); if (ledCache && now - ledCacheAt < 3000) return ledCache;
    ledCache = ledSummary(now); ledCacheAt = now; return ledCache;
  }
  function ledSummary(now){
    if (!LED || !LED.since) return {ok:false, why:"まだ売買がありません"};
    const since = LED.since, rows = Object.entries(LED.rows).map(([id, r]) => Object.assign({id}, r)).filter(r => r.t >= since).sort((a,b) => b.t - a.t);
    const ordS = rows.reduce((s,r) => s + r.g - r.f, 0), inc = LED.inc, up = LED.upnl, fr = x => x && now - x.at < 180000;
    const incOk = fr(inc) && !(inc.n === 0 && rows.length > 0); // 収支明細が空なのに約定がある場合は、収支明細を信用せず、注文履歴の合計を使う
    const R = incOk ? inc.pnl + inc.fee + inc.fund + inc.oth : (rows.length ? ordS : null), U = fr(up) ? up.sum : null;
    const ok = R != null && U != null, dk = new Date(now + 9*3600e3).toISOString().slice(0,10);
    const bot = new Set(S.botOids || []), mans = [...Object.values(MAN ? MAN.active : {}), ...(MAN ? MAN.done : [])];
    const out = rows.slice(0, 150).map(r => ({id:r.id, t:r.t, sym:r.sym, s:r.s, ps:r.ps, ty:r.ty, q:r.q, p:r.p, f:r.f, g:r.g, net:+(r.g - r.f).toFixed(4),
      open:(r.ps === "LONG" && r.s === "BUY") || (r.ps === "SHORT" && r.s === "SELL"),
      by:bot.has(r.id) ? "ボット" : mans.some(m => baseOf(m.sym) === r.sym && (m.dir > 0) === (r.ps === "LONG")) ? "手動" : "その他"}));
    return {ok, src:incOk ? "収支明細" : (rows.length ? "注文履歴（収支明細を取得できないため）" : null), since, R, U, eq:ok ? START_USD + R + U : null, pnl:ok ? R + U : null,
      inc:inc ? {pnl:inc.pnl, fee:inc.fee, fund:inc.fund, oth:inc.oth, n:inc.n, cap:inc.cap, types:inc.types, stale:!fr(inc)} : null,
      ordS:+ordS.toFixed(4), diff:inc ? +(ordS - (inc.pnl + inc.fee)).toFixed(4) : null, today:inc && inc.byDay ? +(inc.byDay[dk]||0).toFixed(4) : null,
      nRows:rows.length, rows:out, incErr:LED.incErr || null, upn:up ? {n:up.n, sum:up.sum, stale:!fr(up), list:up.list} : null, diag:LED.diag};
  }

  // ============================================================
  // 日足の戦略（2026/9/30〜）
  //  トレンド：週足と日足が同じ向き（EMA20＞EMA50かつ終値＞EMA50＝上昇、逆＝下降）
  //  入り：日足の安値がEMA20以下（ショートは高値がEMA20以上）＝押し目。接触した日を含めて4本以内に、トレンド方向の足（陽線/陰線）が確定したら、次の足の始値で入る
  //        ただし終値がEMA50からATRの0.5倍以上逆側で確定したら、崩れと見て取り消す
  //  損切り：建値から15%。部分利確：20日高値（ショートは安値）で半分→残りの損切りを建値＋0.2%へ
  //  残りの決済：日足の終値がEMA20を割ったら（ショートは超えたら）。終値が一度EMA20のトレンド側で確定してから有効
  // ============================================================
  const DAYMS = TFMS.d1;
  const trendW = (sym) => { const c = CDL[sym]; return c && c.w && c.w.length >= RULE.minWeeks ? trendOf(c.w) : 0; };
  function top60(){ return universe().slice(0, RULE.topN); }
  function targetD(sym, dir, entry){ // 20日高値（ショートは安値）。建値より有利側にある時だけ
    const d = CDL[sym] && CDL[sym].d; if (!d || d.length < 20) return null;
    const last = d.slice(-20), v = dir > 0 ? Math.max(...last.map(x => x.h)) : Math.min(...last.map(x => x.l));
    return dir*(v - entry) > 0 ? {px:v, name:dir > 0 ? "20日高値" : "20日安値"} : null;
  }
  function onDaily(sym, now){
    const c = CDL[sym], d = c.d, n = d.length; if (n < 60) return;
    const e20 = emaSeries(d,20), e50 = emaSeries(d,50), atr = atrSeries(d,14), wt = trendW(sym), inU = top60().some(t => t.sym === sym);
    const from = c.procD ? d.findIndex(x => x.t > c.procD) : Math.max(60, n - 4); // 再起動直後は、直近4本から監視の状態を作り直す
    if (from < 0) return; c.procD = d[n-1].t;
    for (let i = Math.max(60, from); i < n; i++){
      const L = d[i], P = d[i-1], pos = S.positions.find(p => p.sym === sym);
      if (pos){ if (pos.v === "d1" && L.t >= pos.barT) manageDay(pos, L, e20[i]); delete S.WD[sym]; continue; }
      const dt = trendAt(d, e20, e50, i), dir = inU && wt !== 0 && wt === dt ? wt : 0;
      let st = S.WD[sym] || null;
      if (!dir || (st && st.dir !== dir)){ if (st) delete S.WD[sym]; continue; }
      const touch = dir > 0 ? L.l <= e20[i] : L.h >= e20[i], broke = atr[i] > 0 && dir*(L.c - e50[i]) <= -RULE.dCancelK*atr[i];
      if (broke){ if (st || touch) log("見送り", baseOf(sym)+"：日足の終値がEMA50から"+RULE.dCancelK+"ATR以上、逆側で確定（押し目ではなく崩れ）"); delete S.WD[sym]; continue; }
      if (touch && !st){ st = S.WD[sym] = {dir, touchT:L.t}; }
      if (!st) continue;
      const k = Math.round((L.t - st.touchT)/DAYMS);
      if (dir*(L.c - L.o) > 0){ // トレンド方向の足が確定
        delete S.WD[sym];
        if (i === n-1 && now - (L.t + DAYMS) < 6*3600e3) S.pend.push({sym, dir, pat:"d1", t:now, barT:L.t + DAYMS, conf:{c:L.c, e20:e20[i]}});
        else log("見送り", baseOf(sym)+"：確定足から時間が経っていたため（"+tmD(L.t)+"の足）");
      } else if (k >= RULE.dWatch){ delete S.WD[sym]; log("見送り", baseOf(sym)+"：EMA20に接触してから"+(RULE.dWatch+1)+"本以内に、"+(dir > 0 ? "陽線" : "陰線")+"が確定しなかった"); }
    }
  }
  const tmD = t => { const x = new Date(t + 9*3600e3); return (x.getUTCMonth()+1)+"/"+x.getUTCDate(); };
  function manageDay(p, L, e20){ // 日足の確定ごと：残りの全部決済（EMA20）
    if (!S.positions.includes(p)) return;
    const px = (tokens.get(p.sym)||{}).px || L.c, dv = p.dir*(L.c - e20);
    if (!p.armed && dv > 0){ p.armed = true; log("トレーリング", baseOf(p.sym)+"：日足の終値がEMA20の"+(p.dir > 0 ? "上" : "下")+"で確定。以後、終値がEMA20を"+(p.dir > 0 ? "割ったら" : "超えたら")+"残りを全決済"); }
    else if (p.armed && dv < 0) closePart(p, 1, px, "日足の終値がEMA20を"+(p.dir > 0 ? "割った" : "超えた")+"（残りを全決済）");
  }
  function analysisD(){ // 画面用：上位60銘柄のうち、週足・日足が一致しているもの（6項目）
    const out = [], longN = S.positions.filter(p => p.dir > 0).length, shortN = S.positions.filter(p => p.dir < 0).length;
    for (const t of top60()){
      const c = CDL[t.sym], pos = S.positions.find(p => p.sym === t.sym); if (!c || !c.d || c.d.length < 60) continue;
      const d = c.d, n = d.length, e20 = emaSeries(d,20), e50 = emaSeries(d,50), L = d[n-1], wt = trendW(t.sym), dt = trendAt(d, e20, e50, n-1);
      const dir = wt !== 0 && wt === dt ? wt : 0; if (!dir && !pos) continue;
      const st = S.WD[t.sym], d20 = (t.px/e20[n-1] - 1)*100, d50 = (t.px/e50[n-1] - 1)*100;
      let reason, can = false, plan = null;
      if (pos) reason = "保有中（"+(pos.dir > 0 ? "ロング" : "ショート")+"）";
      else if (st){ const k = Math.round((L.t - st.touchT)/DAYMS); reason = "EMA20に接触済み（"+tmD(st.touchT)+"）。"+(dir > 0 ? "陽線" : "陰線")+"の確定待ち（残り"+Math.max(0, RULE.dWatch - k)+"本）"; }
      else reason = "日足EMA20への接触待ち（現在EMA20から"+(d20 >= 0 ? "+" : "")+d20.toFixed(2)+"%）";
      if (!pos){ const why = canOpen(t.sym, dir); if (why) reason += "。ただし今は入れない："+why;
        if (st && !why){ can = true; const e = t.px, tg = targetD(t.sym, dir, e);
          plan = {dir, entry:e, stop:e*(1 - dir*RULE.slPctD/100), trail:e20[n-1], target:tg ? tg.px : null, targetName:tg ? tg.name : null}; } }
      const b = baseOf(t.sym), other = b === "BTC" ? "ETH" : b === "ETH" ? "BTC" : null, notes = ["保有中 ロング"+longN+"件・ショート"+shortN+"件（最大"+RULE.maxPos+"件、同じ方向は"+RULE.maxSameDir+"件まで）"];
      if (dir && (dir > 0 ? longN : shortN) >= 2) notes.push("同じ方向がすでに"+(dir > 0 ? longN : shortN)+"件。暗号資産は同じ方向に動きやすく、実質的に同じ賭けが重なる");
      if (other && S.positions.some(p => baseOf(p.sym) === other)) notes.push(other+"を保有中。同じ方向では持てない");
      out.push({sym:t.sym, w:TLABEL(wt), d:TLABEL(dt), dir, px:t.px, e20:e20[n-1], e50:e50[n-1], dist:+d20.toFixed(2), dist50:+d50.toFixed(2), shape:L.c > L.o ? "陽線" : L.c < L.o ? "陰線" : "十字線",
        watching:!!st, held:!!pos, can, reason, plan, corr:notes.join("。")});
    }
    out.sort((a,b) => (b.held - a.held) || (b.watching - a.watching) || Math.abs(a.dist) - Math.abs(b.dist));
    return out.slice(0, 30);
  }

  // ---- 過去検証（日足・最大約4年・上位60銘柄） ----
  const BTD_KEY = "td3_btd", BTD_VER = 1, BTD_STEP = 8000, BTD_COST = 0.4, BTD_RAND = 7; // 往復コスト0.4%（手数料0.1%＋スリッページ0.3%の想定）
  const BTD_SL = [4.8, 15], BTD_HALF = [true, false], dvKey = (s,h) => s+"|"+(h ? 1 : 0), DLIVE = dvKey(15, true);
  let BD = null, bdBusy = false, bdAt = 0, bdCache = null, bdCacheAt = 0; const bdSaved = {};
  function bdFresh(){ return {ver:BTD_VER, syms:[], done:{}, tr:{}, rb:{}, from:0, to:0, complete:false}; }
  function bdLoad(){ try{ const j = JSON.parse(store.get(BTD_KEY) || "null"); BD = j && j.ver === BTD_VER ? j : bdFresh();
      if (j && j.parts){ BD.tr = {}; for (const k in j.parts){ for (let c=0;c<j.parts[k];c++) (BD.tr[k] || (BD.tr[k] = [])).push(...JSON.parse(store.get(BTD_KEY+"_"+k+"_"+c) || "[]")); bdSaved[k] = (BD.tr[k]||[]).length; } delete BD.parts; }
    }catch(_){ BD = bdFresh(); } }
  function bdSave(){ const parts = {}, meta = Object.assign({}, BD, {tr:undefined});
    for (const k in BD.tr){ const a = BD.tr[k]; parts[k] = Math.ceil(a.length/1500); for (let c=Math.floor((bdSaved[k]||0)/1500); c<parts[k]; c++) store.set(BTD_KEY+"_"+k+"_"+c, JSON.stringify(a.slice(c*1500,(c+1)*1500))); bdSaved[k] = a.length; }
    meta.parts = parts; store.set(BTD_KEY, JSON.stringify(meta)); }
  function bdSim(D, sl, half, rand){
    const {d, e20, e50, atr, dirs} = D, out = [], n = d.length; let st = null, pos = null, lastR = -1e9;
    const costR = BTD_COST;
    for (let i = 60; i < n - 1; i++){
      const L = d[i];
      if (pos){
        const x = pos; let why = null, ex = null;
        if (i >= x.i0){
          const hit = x.d > 0 ? L.l <= x.stop : L.h >= x.stop;
          if (hit){ ex = x.d > 0 ? Math.min(x.stop, L.o) : Math.max(x.stop, L.o); why = x.half ? "be" : "sl"; }
          else {
            if (half && !x.half && x.tg != null && (x.d > 0 ? L.h >= x.tg : L.l <= x.tg)){ x.half = true; x.hr = x.d*(x.tg/x.e - 1)*100; x.stop = x.e*(1 + x.d*RULE.beCost); }
            const dv = x.d*(L.c - e20[i]);
            if (!x.armed && dv > 0) x.armed = true; else if (x.armed && dv < 0){ why = "e20"; ex = d[i+1].o; }
          }
        }
        if (why){ const r2 = x.d*(ex/x.e - 1)*100, r = (x.half ? (x.hr + r2)/2 : r2) - costR;
          out.push([x.te, L.t + DAYMS, x.d, +r.toFixed(3), x.half ? 1 : 0, why, i - x.i0 + 1]); pos = null; }
        continue;
      }
      const dir = dirs[i]; if (!dir){ st = null; continue; }
      const enter = () => { const e = d[i+1].o, hh = dir > 0 ? Math.max(...d.slice(i-19, i+1).map(z => z.h)) : Math.min(...d.slice(i-19, i+1).map(z => z.l));
        pos = {d:dir, e, stop:e*(1 - dir*sl/100), tg:dir*(hh - e) > 0 ? hh : null, i0:i+1, te:d[i+1].t, armed:dir*(L.c - e20[i]) > 0, half:false}; };
      if (rand){ if (i - lastR >= rand){ lastR = i; enter(); } continue; }
      if (st && st.dir !== dir) st = null;
      const touch = dir > 0 ? L.l <= e20[i] : L.h >= e20[i], broke = atr[i] > 0 && dir*(L.c - e50[i]) <= -RULE.dCancelK*atr[i];
      if (broke){ st = null; continue; }
      if (touch && !st) st = {dir, i};
      if (!st) continue;
      if (dir*(L.c - L.o) > 0){ st = null; enter(); }
      else if (i - st.i >= RULE.dWatch) st = null;
    }
    return out;
  }
  function bdProcess(si, w, d){
    const e20 = emaSeries(d,20), e50 = emaSeries(d,50), atr = atrSeries(d,14), w20 = emaSeries(w,20), w50 = emaSeries(w,50), dirs = new Array(d.length).fill(0);
    let kw = -1; for (let i=0;i<d.length;i++){ const T = d[i].t + DAYMS; while (kw+1 < w.length && w[kw+1].t + TFMS.w1 <= T) kw++;
      if (kw + 1 < RULE.minWeeks || i < 49) continue; const a = trendAt(w, w20, w50, kw), b2 = trendAt(d, e20, e50, i); dirs[i] = a !== 0 && a === b2 ? a : 0; }
    const D = {d, e20, e50, atr, dirs};
    for (const sl of BTD_SL) for (const h of BTD_HALF){ const k = dvKey(sl,h), tr = bdSim(D, sl, h, 0), rb = bdSim(D, sl, h, BTD_RAND);
      (BD.tr[k] || (BD.tr[k] = [])).push(...tr.map(x => [si, ...x]));
      const R = BD.rb[k] || (BD.rb[k] = {n:0, s:0}); for (const x of rb){ R.n++; R.s += x[3]; } }
    if (!BD.from || d[60].t < BD.from) BD.from = d[60].t; if (d[d.length-1].t > BD.to) BD.to = d[d.length-1].t;
  }
  async function bdStep(now){
    if (bdBusy || BD.complete || now - bdAt < BTD_STEP) return;
    const curD = Math.floor(now/DAYMS)*DAYMS; if (now < curD + 20*60000) return; // 日足の確定直後は、実売買の取得を優先
    if (!BD.syms.length){ const u = top60().map(t => t.sym); if (u.length < 10) return; BD.syms = u; }
    const si = BD.syms.findIndex(s => BD.done[s] == null);
    if (si < 0){ BD.complete = true; bdSave(); log("SYS", "日足の過去検証が完了しました（"+BD.syms.length+"銘柄）"); return; }
    bdBusy = true; bdAt = now; const sym = BD.syms[si], b = baseOf(sym);
    try{
      const n0 = Date.now(), w = await fetchK(b, "1w", TFMS.w1, 300, n0), d = await fetchKBack(b, "1d", DAYMS, 1500, n0);
      if (w.length >= RULE.minWeeks && d.length >= 300){ bdProcess(si, w, d); BD.done[sym] = 1; } else BD.done[sym] = -1;
      bdSave(); bdCache = null;
    }catch(err){ bdAt = now + 30000; lastErr = "日足の過去検証 "+b+": "+err.message; }
    finally{ bdBusy = false; }
  }
  function bdPortfolio(rows, days){ // 口座全体：最大5件・同じ方向3件・BTCとETH・1銘柄1件を守り、複利（毎回その時点の総資産の10%）
    const tr = rows.slice().sort((a,b) => a[1] - b[1] || a[0] - b[0]), open = [], taken = [];
    for (const x of tr){
      for (let j = open.length-1; j >= 0; j--) if (open[j][2] <= x[1]) open.splice(j,1);
      const bs = baseOf(BD.syms[x[0]] || ""), other = bs === "BTC" ? "ETH" : bs === "ETH" ? "BTC" : null;
      if (open.length >= RULE.maxPos || open.filter(o => o[3] === x[3]).length >= RULE.maxSameDir || open.some(o => o[0] === x[0])) continue;
      if (other && open.some(o => baseOf(BD.syms[o[0]]||"") === other && o[3] === x[3])) continue;
      open.push(x); taken.push(x);
    }
    const eqOf = r => r*RULE.marginPct*RULE.lev, byExit = taken.slice().sort((a,b) => a[2] - b[2]);
    let g = 1, peak = 1, dd = 0; const yr = {};
    for (const x of byExit){ const f = 1 + eqOf(x[4])/100; g *= f; peak = Math.max(peak, g); dd = Math.min(dd, (g/peak - 1)*100); const y = new Date(x[2]).getUTCFullYear(); yr[y] = (yr[y] || 1)*f; }
    const mid = BD.from + (BD.to - BD.from)/2, grow = xs => xs.reduce((a,x) => a*(1 + eqOf(x[4])/100), 1);
    const ann = (xs, dy) => dy > 0 && xs.length ? (Math.pow(grow(xs), 365/dy) - 1)*100 : null;
    return {n:taken.length, total:(g - 1)*100, ann:ann(taken, days), annA:ann(taken.filter(x => x[1] < mid), days/2), annB:ann(taken.filter(x => x[1] >= mid), days/2), dd,
      years:Object.keys(yr).sort().map(y => ({y, r:+((yr[y] - 1)*100).toFixed(1), n:byExit.filter(x => new Date(x[2]).getUTCFullYear() === +y).length})),
      win:taken.length ? Math.round(taken.filter(x => x[4] > 0).length/taken.length*100) : null, avgEq:taken.length ? taken.reduce((s,x) => s + eqOf(x[4]), 0)/taken.length : null};
  }
  function bdSummary(){
    if (bdCache && Date.now() - bdCacheAt < 60000) return bdCache;
    const days = BD.to > BD.from ? (BD.to - BD.from)/DAYMS : 0, rows = [];
    for (const sl of BTD_SL) for (const h of BTD_HALF){
      const k = dvKey(sl,h), tr = BD.tr[k] || [], rb = BD.rb[k] || {n:0, s:0}; if (!tr.length){ rows.push({k, sl, half:h, n:0}); continue; }
      const n = tr.length, avg = tr.reduce((s,x) => s + x[4], 0)/n, by = {}; for (const x of tr){ const o = by[x[0]] || (by[x[0]] = [0,0]); o[0]++; o[1] += x[4]; }
      let ss = 0; for (const s in by){ const q = by[s][1] - by[s][0]*avg; ss += q*q; }
      const ci = 1.96*Math.sqrt(ss)/n, ra = rb.n ? rb.s/rb.n : null, pf = bdPortfolio(tr, days), cnt = w => tr.filter(x => x[6] === w).length;
      rows.push({k, sl, half:h, live:k === DLIVE, n, win:Math.round(tr.filter(x => x[4] > 0).length/n*100), avg, ci, rand:ra, diff:ra == null ? null : avg - ra,
        exits:{sl:cnt("sl"), be:cnt("be"), e20:cnt("e20")}, halfN:tr.filter(x => x[5]).length, hold:tr.reduce((s,x) => s + x[7], 0)/n, pf,
        ok:!!(pf.ann != null && pf.ann >= 15 && pf.annA > 0 && pf.annB > 0 && ra != null && avg - ra > 0)});
    }
    bdCache = {kind:"d1", complete:BD.complete, done:Object.keys(BD.done).length, total:BD.syms.length || RULE.topN, skipped:Object.values(BD.done).filter(v => v < 0).length,
      from:BD.from, to:BD.to, days:+days.toFixed(0), cost:BTD_COST, rows}; bdCacheAt = Date.now(); return bdCache;
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
    const eq = equity(), tr = S.trades, full = tr.filter(x => !x.part), wins = full.filter(x => x.net + (x.booked||0) > 0).length; // 一部決済で先に計上した分も含めた、1回の取引の合計損益で判定
    return { ver:V3_VER, rule:RULE, running:S.running, startedAt:S.startedAt, startUsd:START_USD, equity:+eq.toFixed(2), cash:+S.cash.toFixed(2), lastErr, lastTickerAt,
      universe:{total:u.length, up, dn, range:rng, young, noData},
      positions:S.positions.map(p => { const t = tokens.get(p.sym), px = t ? t.px : p.entry, c = CDL[p.sym], cs = c && c.m15;
        return {sym:p.sym, dir:p.dir, pat:PATNAME[p.pat], entry:p.entry, px, qty:p.qty, margin:+p.margin.toFixed(2), stop:p.stop, be:!!p.be, v:p.v||"m15", slPct:p.slPct||RULE.slPct, fillEntry:!!p.fillEntry, booked:+(p.booked||0).toFixed(2), target:p.target, targetName:p.targetName, half:p.half, armed:p.armed,
          e20:cs && cs.length > 20 ? emaSeries(cs,20)[cs.length-1] : null, upnl:+unreal(p).toFixed(2), upnlEq:+(unreal(p)/eq*100).toFixed(2), ts:p.ts, live:p.live}; }),
      trades:tr.slice(0,100), stats:{n:full.length, win:full.length ? Math.round(wins/full.length*100) : null, net:+tr.reduce((s,x) => s + x.net, 0).toFixed(2), parts:tr.length - full.length}, day:S.day,
      led:ledGet(), eqInternal:+equityInternal().toFixed(2),
      fills:S.fills ? {enN:S.fills.en[0], en:S.fills.en[0] ? S.fills.en[1]/S.fills.en[0] : null, exN:S.fills.ex[0], ex:S.fills.ex[0] ? S.fills.ex[1]/S.fills.ex[0] : null} : null,
      analysis:analysisD(), bt:bdSummary(), btOld:null, legacy:S.legacy, manualOn:!!S.manualOn, manual:S.manualOn && MAN ? manSummary() : null, log:S.log.slice(0,80) };
  }
  function handleCmd(b){
    const c = b && b.cmd;
    if (c === "pause"){ S.running = false; log("SYS", "新規エントリーを停止しました（保有中は決済ルールが続きます）"); }
    else if (c === "resume"){ S.running = true; log("SYS", "新規エントリーを再開しました"); }
    else if (c === "closeAll"){ for (const p of [...S.positions]){ const t = tokens.get(p.sym); closePart(p, 1, t ? t.px : p.entry, "手動で全決済"); } }
    else if (c === "manualOn"){ S.manualOn = true; log("SYS", "手動記録モードを開始しました"); }
    else if (c === "manualOff"){ S.manualOn = false; log("SYS", "手動記録モードを止めました（記録は残ります）"); }
    else if (c === "manClear"){ MAN = manFresh(); for (let i=0;i<50;i++) store.set(MAN_KEY+"_d"+i, "[]"); manDirty = true; manCache = null; log("SYS", "手動トレードの記録を消しました"); }
    else if (c === "legacyClose"){ closeLegacy().then(persist); }
    else if (c === "legacyScan"){ reconcile(Date.now(), true).then(persist).catch(err => { lastErr = "照合: "+err.message; }); }
    else if (c === "btRestart"){ BD = bdFresh(); for (const k in bdSaved) bdSaved[k] = 0; bdSave(); bdCache = null; log("SYS", "日足の過去検証をやり直します"); }
    else if (c === "btRestartOld"){ BT = btFresh(); for (const k in btSaved) btSaved[k] = 0; btSave(); btCache = null; log("SYS", "過去検証をやり直します"); }
    persist();
  }
  return { publicState, handleCmd,
    start(){ load(); btLoad(); manLoad(); ledLoad(); bdLoad(); S.WD = S.WD || {}; S.manualOn = false; // 手動記録モードは廃止
      if (S.manualInit === undefined) S.manualInit = true; // 手動記録モードは廃止（以前は、初回起動で新規エントリーを止めていた）
      if (!S.log.length) log("SYS", "新しい戦略（週足・日足トレンド＋15分足EMA50押し目）で開始しました。総資産 $"+START_USD); persist(); },
    tick, pollMs(){ return POLL; }, equity, _t:{onDaily, bdSummary, get BD(){ return BD; }, analysisD, top60, ledGet, ledStep, ledSummary, get LED(){ return LED; }, ctxBuild, featOf, baseStats, replayBot, manSummary, get MAN(){ return MAN; }, manFinalize, manPost, manCtx, histFills, ctxLoad}, note(tag,msg){ log(tag,msg); persist(); } };
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
