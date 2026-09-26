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

    try {
      if (req.method === "GET" && u.pathname === "/market/ticker") {
        const symbol = u.searchParams.get("symbol");
        const qs = symbol ? "?symbol=" + encodeURIComponent(toBingxSymbol(symbol)) : "";
        const r = await fetch(BASE + "/openApi/swap/v2/quote/ticker" + qs);
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
        return json({ demo: isDemo, result: data }, r.ok ? 200 : r.status);
      }
      if (req.method === "GET" && u.pathname === "/market/premiumIndex") {
        const symbol = u.searchParams.get("symbol");
        const qs = symbol ? "?symbol=" + encodeURIComponent(toBingxSymbol(symbol)) : "";
        const r = await fetch(BASE + "/openApi/swap/v2/quote/premiumIndex" + qs);
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
        return json({ demo: isDemo, result: data }, r.ok ? 200 : r.status);
      }
      if (req.method === "GET" && u.pathname === "/market/klines") {
        const symbol = u.searchParams.get("symbol"), interval = u.searchParams.get("interval") || "1h", limit = u.searchParams.get("limit") || "100";
        if (!symbol) return json({ error: "symbol is required" }, 400);
        // ろうそく（K線）は公開データで署名不要。実勢の値動きを見るため、常にリアル環境（デモではなく本番の公開API）から取得する
        const qs = "?symbol=" + encodeURIComponent(toBingxSymbol(symbol)) + "&interval=" + encodeURIComponent(interval) + "&limit=" + encodeURIComponent(limit);
        const r = await fetch("https://open-api.bingx.com/openApi/swap/v3/quote/klines" + qs);
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
        return json({ demo: isDemo, result: data }, r.ok ? 200 : r.status);
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
const BINGX = "https://open-api.bingx.com", BYBIT = "https://api.bybit.com";
const FKEY = "trenchdesk_perp_v1", SRCKEY = "trenchdesk_perp_src";
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
  const sum = a => a.reduce((x,y)=>x+y,0);
  const pad = (n,l=2) => String(n).padStart(l,"0");
  const usd = (n,sign) => (sign?(n>=0?"+":"−"):(n<0?"−":"")) + "$" + Math.abs(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  const px = x => x>=1000 ? x.toFixed(1) : x>=1 ? x.toFixed(3) : x>=0.01 ? x.toFixed(4) : (x<=0 ? "0" : (x.toPrecision(3).includes("e") ? x.toExponential(2) : x.toPrecision(3)));
  const pct = (x,d=1) => (x>=0?"+":"−") + Math.abs(x).toFixed(d) + "%";
  const money = n => n>=1e9 ? "$"+(n/1e9).toFixed(2)+"B" : n>=1e6 ? "$"+(n/1e6).toFixed(2)+"M" : n>=1e3 ? "$"+(n/1e3).toFixed(1)+"K" : "$"+Math.round(n);
  const msMin = m => m*60e3*WARP;
  const baseOf = s => s.replace(/-?USDT$/,"");
  const $ = id => document.getElementById(id);
  const MODE_OPTS = [{l:"控えめ",v:"calm"},{l:"標準",v:"normal"},{l:"積極",v:"active"}];
  const YN = [{l:"OFF",v:false},{l:"ON",v:true}];
  const GATE_OPTS = [{l:"OFF",v:"off"},{l:"標準",v:"std"},{l:"厳しめ",v:"strict"}];

  function makePerp(){
    const PERP_MODE = {
      calm:   {poll:15000, r1:0.30, r5:1.0, vrel:2.0, maxPos:2, cool:10, hold:60, minTurn:3e6},
      normal: {poll:10000, r1:0.20, r5:0.7, vrel:1.6, maxPos:3, cool:5,  hold:30, minTurn:1.5e6},
      active: {poll:6000,  r1:0.10, r5:0.4, vrel:1.3, maxPos:5, cool:2,  hold:15, minTurn:8e5}
    };
    const MMR = 0.005, MAX_SPREAD = 0.0015;
    const FEEF = () => src === "bingx" ? 0.0005 : 0.00055;
    const GATES = { off:null, std:{risk:65,label:"標準"}, strict:{risk:50,label:"厳しめ"} };
    const ALLOW = {mode:["calm","normal","active"],dir:["both","long","short"],lev:[1,2,3,5,8,10,20],size:[0.04,0.05,0.1,0.2],sl:[0.8,1.25,1.5,3,5],tp:[1,1.25,2,4,8],gate:["off","std","strict"],scale:[true,false],live:[true,false],strategy:["momentum","fade","surge","dual","trend"],fadeThresh:[3,5,8],surgeThresh:[3,5,10],halfback:[true,false],scalp:[true,false],scalpTp:[1,2,3,4,5,6,7,8,9,10],scalpSl:[1,2,3,4,5,6,7,8,9,10],scalpHold:[30,45,60],maxPos:[3,5,8,10,15,20],orphan:[true,false],timeout:[0,30,60,180,360]};
    const PM = () => PERP_MODE[S.cfg.mode] || PERP_MODE.active;
    const pollMs = () => POLL_OVERRIDE || PM().poll;

    function fresh(){
      return { startedAt:Date.now(), running:true, cash:START_USD, positions:[], trades:[], log:[], errors:[], hist:[{t:Date.now(),v:START_USD}],
        skips:0, polls:0, events:0, logSeq:0, lastPollAt:0, cooldown:{}, retry:{}, epochs:[], pnlDaily:{},
        cfg:{mode:"active",dir:"both",lev:8,size:0.04,sl:1.5,tp:3,gate:"std",scale:true,live:false,strategy:"surge",fadeThresh:5,surgeThresh:5,halfback:true,scalp:false,scalpTp:1,scalpSl:1,scalpHold:45,maxPos:5,orphan:true,timeout:0} };
    }
    let S = fresh();
    const tokens = new Map();
    const bootTs = Date.now();
    let src = store.get(SRCKEY) === "bybit" ? "bybit" : "bingx";
    let liveAccount = null, liveAccountErr = null, lastLiveAccountAt = 0, liveAccBusy = false;
    async function fetchLiveAccount(){
      if (liveAccBusy) return; liveAccBusy = true;
      try{
        const [bal, pos] = await Promise.all([ relay("/balance"), relay("/positions") ]);
        const b = bal.result && bal.result.data && bal.result.data.balance;
        const raw = (pos.result && pos.result.data) || [];
        const list = (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
        liveAccount = {
          equity: b ? parseFloat(b.equity) : null, balance: b ? parseFloat(b.balance) : null, avail: b ? parseFloat(b.availableMargin) : null,
          positions: list.map(p => ({ symbol: p.symbol, side: p.positionSide, amt: parseFloat(p.positionAmt != null ? p.positionAmt : (p.positionSide==="SHORT" ? -Math.abs(parseFloat(p.positionAmt||0)) : p.positionAmt)) || 0,
            entry: parseFloat(p.avgPrice || p.entryPrice || 0), pnl: parseFloat(p.unrealizedProfit != null ? p.unrealizedProfit : (p.profit || 0)), lev: p.leverage })).filter(p => Math.abs(p.amt) > 0)
        };
        liveAccountErr = null;
      }catch(e){ liveAccountErr = e.message; }
      lastLiveAccountAt = Date.now(); liveAccBusy = false;
    }
    let lastPollAt = 0, lastError = null, lastErrLogged = "", busy = false, timer = null, onUpdate = () => {};

    function load(){
      try{
        const j = JSON.parse(store.get(FKEY) || "null");
        if (j && j.cfg && Array.isArray(j.positions)){ const def = fresh().cfg; S = Object.assign(fresh(), j); S.cfg = Object.assign(def, j.cfg); S.positions.forEach(p => { if (p.origQty==null) p.origQty = p.qty; if (p.margin0==null) p.margin0 = p.margin; if (p.realizedNet==null) p.realizedNet = 0; if (p.tpHit==null) p.tpHit = 0; if (p.beOn==null) p.beOn = false; if (!tokens.has(p.sym)) tokens.set(p.sym,{sym:p.sym,samples:[],firstSeen:Date.now(),px:p.entry,mark:p.entry,bid:0,ask:0,bidSz:0,askSz:0,turn:0,oi:0,fr:0,chg24:0,chg1h:0,hi:p.entry,lo:p.entry,updatedAt:0}); }); }
      }catch(_){}
    }
    function persist(){ S.lastPollAt = lastPollAt; store.set(FKEY, JSON.stringify(S)); }
    function addLog(tag,msg,hi){
      S.log.unshift({id:++S.logSeq,t:Date.now(),tag,msg,hi:!!hi}); if (S.log.length > 80) S.log.pop();
      if (tag!=="WATCH" && (msg.indexOf("失敗")>=0 || msg.indexOf("エラー")>=0)){
        S.errors.unshift({t:Date.now(),tag,msg}); if (S.errors.length>50) S.errors.length=50;
      }
    }
    const isFresh = t => t.px>0 && Date.now()-t.updatedAt < pollMs()*4;

    async function fetchBybit(){
      const j = await fetchJson(BYBIT+"/v5/market/tickers?category=linear");
      if (!j || j.retCode !== 0) throw new Error("Bybit: "+((j&&j.retMsg)||"応答が不正"));
      const out = [];
      for (const o of ((j.result && j.result.list) || [])){
        if (!o.symbol || !o.symbol.endsWith("USDT")) continue;
        const pxv = +o.lastPrice, p1 = +o.prevPrice1h;
        out.push({sym:o.symbol, px:pxv, mark:+o.markPrice||pxv, bid:+o.bid1Price||0, ask:+o.ask1Price||0, bidSz:+o.bid1Size||0, askSz:+o.ask1Size||0,
          turn:+o.turnover24h, oi:+o.openInterestValue||0, fr:+o.fundingRate, chg24:(+o.price24hPcnt||0)*100, chg1h:p1>0?(pxv/p1-1)*100:null, hi:+o.highPrice24h||pxv, lo:+o.lowPrice24h||pxv});
      }
      return out;
    }
    async function fetchBingx(){
      const viaRelay = !!(RELAY_URL && RELAY_TOKEN);
      let tk, pi;
      if (viaRelay){
        const [rtk, rpi] = await Promise.all([ relay("/market/ticker"), relay("/market/premiumIndex").catch(()=>null) ]);
        tk = rtk && rtk.result; pi = rpi && rpi.result;
      } else {
        const ts = Date.now();
        [tk, pi] = await Promise.all([
          fetchJson(BINGX+"/openApi/swap/v2/quote/ticker?timestamp="+ts),
          fetchJson(BINGX+"/openApi/swap/v2/quote/premiumIndex?timestamp="+ts).catch(()=>null)
        ]);
      }
      if (!tk || tk.code !== 0) throw new Error("BingX"+(viaRelay?"（リレー経由）":"")+": "+((tk&&tk.msg)||"応答が不正")+(tk&&tk.code?"（code "+tk.code+"）":""));
      const fund = new Map();
      if (pi && pi.code === 0){ for (const o of (Array.isArray(pi.data)?pi.data:[pi.data])) if (o && o.symbol) fund.set(o.symbol,{fr:parseFloat(o.lastFundingRate),mark:parseFloat(o.markPrice)}); }
      const out = [];
      for (const o of (Array.isArray(tk.data)?tk.data:[tk.data])){
        if (!o || !o.symbol || !o.symbol.endsWith("-USDT")) continue;
        { const b0 = o.symbol.replace(/-USDT$/,""); if (/^NC[A-Z]{2}/.test(b0) || /2USD$/.test(b0)) continue; }
        const pxv = parseFloat(o.lastPrice), f = fund.get(o.symbol) || {};
        out.push({sym:o.symbol, px:pxv, mark:f.mark>0?f.mark:pxv, bid:parseFloat(o.bidPrice)||0, ask:parseFloat(o.askPrice)||0, bidSz:parseFloat(o.bidQty)||0, askSz:parseFloat(o.askQty)||0,
          turn:parseFloat(o.quoteVolume), oi:0, fr:f.fr, chg24:parseFloat(o.priceChangePercent)||0, chg1h:null, hi:parseFloat(o.highPrice)||pxv, lo:parseFloat(o.lowPrice)||pxv});
      }
      if (!out.length) throw new Error("BingX: 銘柄データが空です");
      return out;
    }

    // ---- ろうそく（15分・1時間・4時間）とトレンド戦略 ----
    // ろうそくはBingXの過去データAPIから取得する。保存はせず、再起動時は取り直す（取引所に同じデータがあるため、消えても困らない）
    const CDL_CAP = 300, M15_CAP = 120, EMA1_PERIOD = 8, EMA4_PERIOD = 6;
    const TF = {m15:900000, h1:3600000, h4:14400000};
    const TR_MIN_TURN = 5e6;            // トレンド戦略の対象は24時間売買代金$5M以上（薄い銘柄はパターンがだましになりやすい）
    const TR_EMAS = [12,21,75,200];     // 使うEMAは4本
    const TR_ADD = 25, TR_SL = 35;      // -25%で1回だけ同額を追加、-35%で損切り（初回エントリー基準で固定）
    const TR_TPS = [[50,0.4],[70,0.3],[100,1]]; // +50%で4割、+70%で3割、+100%で残り全部
    const TR_PATS = {dbl:"ダブルトップ/ボトム", hs:"三尊/逆三尊", pb:"EMA21押し目・戻り", br:"ブレイク＆リテスト", en:"包み足", pin:"ピンバー"};
    let CDL = {};
    const cdlInflight = new Set();
    function cdlSave(){ /* 保存しない（取引所から取り直す） */ }
    function emaOf(candles, period){
      if (!candles || candles.length < period) return null;
      const k = 2/(period+1); let e = candles[0].c;
      for (let i=1;i<candles.length;i++) e = candles[i].c*k + e*(1-k);
      return e;
    }
    function emaSeries(candles, period){
      const k = 2/(period+1), out = new Array(candles.length); let e = candles.length ? candles[0].c : 0;
      for (let i=0;i<candles.length;i++){ e = i ? candles[i].c*k + e*(1-k) : e; out[i] = e; }
      return out;
    }
    function atrOf(cs, n){
      if (cs.length < n+1) return null; let s = 0;
      for (let i=cs.length-n;i<cs.length;i++){ const a = cs[i], b = cs[i-1]; s += Math.max(a.h-a.l, Math.abs(a.h-b.c), Math.abs(a.l-b.c)); }
      return s/n;
    }
    function trendOf(sym, px){ // シグナル検証の内訳用（旧方式・短いEMA）
      const c = CDL[sym]; if (!c) return {c1:0, c4:0, align:0, e1:null, e4:null};
      const e1 = emaOf(c.h1, EMA1_PERIOD), e4 = emaOf(c.h4, EMA4_PERIOD);
      const c1 = e1==null ? 0 : (px>e1 ? 1 : px<e1 ? -1 : 0);
      const c4 = e4==null ? 0 : (px>e4 ? 1 : px<e4 ? -1 : 0);
      const align = (c1!==0 && c1===c4) ? c1 : 0;
      return {c1, c4, align, e1, e4};
    }
    // 1つの時間足のトレンド：EMA21 > EMA75 > EMA200 かつ 終値 > EMA75 ならロング方向（逆ならショート方向）
    function tfTrend(cs){
      if (!cs || cs.length < 200) return 0;
      const e21 = emaOf(cs,21), e75 = emaOf(cs,75), e200 = emaOf(cs,200), cl = cs[cs.length-1].c;
      if (e21>e75 && e75>e200 && cl>e75) return 1;
      if (e21<e75 && e75<e200 && cl<e75) return -1;
      return 0;
    }
    function bigTrend(sym){ const c = CDL[sym]; if (!c) return 0; const a = tfTrend(c.h4), b = tfTrend(c.h1); return (a!==0 && a===b) ? a : 0; }
    function pivots(cs, from, to){
      const hi = [], lo = [];
      for (let i=Math.max(2,from); i<=Math.min(cs.length-3,to); i++){
        const x = cs[i];
        if (x.h>=cs[i-1].h && x.h>=cs[i-2].h && x.h>cs[i+1].h && x.h>cs[i+2].h) hi.push(i);
        if (x.l<=cs[i-1].l && x.l<=cs[i-2].l && x.l<cs[i+1].l && x.l<cs[i+2].l) lo.push(i);
      }
      return {hi, lo};
    }
    // 15分足（確定済み）で、トレンド方向と同じ向きのエントリーパターンを探す。見つかれば {pat, why}
    function m15Pattern(cs, dir){
      const n = cs.length; if (n < 60) return null;
      const atr = atrOf(cs,14); if (!(atr>0)) return null;
      const e12s = emaSeries(cs,12), e21s = emaSeries(cs,21), e12 = e12s[n-1], e21 = e21s[n-1];
      const L = cs[n-1], P = cs[n-2], s = dir;
      const up = x => s>0 ? x : -x;                      // ロング基準の式をショートにも使うための符号変換
      const hiOf = x => s>0 ? x.h : -x.l, loOf = x => s>0 ? x.l : -x.h, clOf = x => up(x.c), opOf = x => up(x.o);
      if (Math.abs(L.c - e21) > 3*atr) return null;       // 伸びすぎ（EMA21からATR3本分以上離れている）は見送り
      const pv = pivots(cs, n-50, n-3), lows = s>0 ? pv.lo : pv.hi;
      const neckBreak = (a,b) => { let neck = -Infinity; for (let i=a;i<=b;i++) neck = Math.max(neck, hiOf(cs[i])); return clOf(L) > neck && clOf(P) <= neck ? neck : null; };
      // 1. ダブルボトム（ショートはダブルトップ）：ほぼ同じ安値が2回、間の高値（ネックライン）を上抜けた足で確定
      if (lows.length >= 2){
        const a = lows[lows.length-2], b = lows[lows.length-1];
        if (b-a >= 5 && b >= n-15 && Math.abs(loOf(cs[a]) - loOf(cs[b])) <= 0.5*atr){
          const neck = neckBreak(a,b);
          if (neck!=null && neck - Math.min(loOf(cs[a]),loOf(cs[b])) >= 1.5*atr) return {pat:"dbl"};
        }
      }
      // 2. 逆三尊（ショートは三尊）：真ん中の安値が一番深く、左右の安値がほぼ同じ。ネックライン上抜けで確定
      if (lows.length >= 3){
        const a = lows[lows.length-3], h = lows[lows.length-2], b = lows[lows.length-1];
        if (b >= n-15 && loOf(cs[h]) < loOf(cs[a]) - 0.5*atr && loOf(cs[h]) < loOf(cs[b]) - 0.5*atr && Math.abs(loOf(cs[a]) - loOf(cs[b])) <= atr){
          if (neckBreak(a,b) != null) return {pat:"hs"};
        }
      }
      // 3. EMA21への押し目（ショートは戻り）：直前まで流れに乗っていて、EMA21に触れて反発した陽線（陰線）
      { let above = 0; for (let i=n-9;i<n-1;i++) if (up(cs[i].c) > up(e21s[i])) above++;
        if (above >= 6 && up(e12) > up(e21) && loOf(L) <= up(e21) + 0.2*atr && clOf(L) > up(e21) && clOf(L) > opOf(L)) return {pat:"pb"}; }
      // 4. ブレイク＆リテスト：直近の高値（安値）の水平線を抜けたあと、その線まで戻って反発
      { let lvl = -Infinity; for (let i=n-40;i<=n-7;i++) lvl = Math.max(lvl, hiOf(cs[i]));
        let broke = false; for (let i=n-6;i<=n-2;i++) if (clOf(cs[i]) > lvl + 0.1*atr) broke = true;
        if (broke && loOf(L) <= lvl + 0.3*atr && clOf(L) > lvl && clOf(L) > opOf(L)) return {pat:"br"}; }
      // 5. 包み足：1本前の逆向きの足を、実体ごと包む強い足（押し目・戻りの位置に限る）
      if (clOf(P) < opOf(P) && clOf(L) > opOf(L) && opOf(L) <= clOf(P) && clOf(L) >= opOf(P) && Math.abs(L.c-L.o) >= 0.6*atr && Math.min(loOf(L),loOf(P)) <= up(e21) + atr) return {pat:"en"};
      // 6. ピンバー：下ヒゲ（ショートは上ヒゲ）が実体の2倍以上・値幅の6割以上で、EMA21付近
      { const rng = L.h - L.l, body = Math.abs(L.c - L.o), wick = s>0 ? Math.min(L.o,L.c) - L.l : L.h - Math.max(L.o,L.c);
        const closePos = s>0 ? (L.c - L.l)/(rng||1) : (L.h - L.c)/(rng||1);
        if (rng >= 0.8*atr && wick >= 2*body && wick >= 0.6*rng && closePos >= 0.66 && loOf(L) <= up(e21) + 0.5*atr) return {pat:"pin"}; }
      return null;
    }
    function parseKlineArr(j, tfMs, now){
      const raw = (j && j.result && j.result.data) || (j && j.data) || [];
      const arr = Array.isArray(raw) ? raw : [];
      return arr.map(x => Array.isArray(x)
        ? {t:+x[0], o:+x[1], h:+x[2], l:+x[3], c:+x[4]}
        : {t:+(x.time!=null?x.time:(x.openTime!=null?x.openTime:x.t)), o:+(x.open!=null?x.open:x.o), h:+(x.high!=null?x.high:x.h), l:+(x.low!=null?x.low:x.l), c:+(x.close!=null?x.close:x.c)}
      ).filter(c => c.t>0 && c.c>0 && c.t + tfMs <= now).sort((a,b)=>a.t-b.t); // 確定した足だけを使う
    }
    async function fetchTf(base, iv, tfMs, limit, now){
      const r = await relay("/market/klines?symbol="+base+"USDT&interval="+iv+"&limit="+limit);
      return parseKlineArr(r, tfMs, now);
    }
    async function refreshCandles(sym, needHi, need15, now){
      const base = baseOf(sym);
      let c = CDL[sym]; if (!c){ c = {h1:[], h4:[], m15:[], fHi:0, f15:0, last15:0}; CDL[sym] = c; }
      try{
        if (needHi){
          const [h1, h4] = await Promise.all([fetchTf(base,"1h",TF.h1,CDL_CAP,now), fetchTf(base,"4h",TF.h4,CDL_CAP,now)]);
          if (h1.length) c.h1 = h1; if (h4.length) c.h4 = h4; c.fHi = now;
        }
        if (need15){
          const m15 = await fetchTf(base,"15m",TF.m15,M15_CAP,now);
          if (m15.length){ c.m15 = m15; } c.f15 = now;
          const last = c.m15.length ? c.m15[c.m15.length-1].t : 0;
          if (last && last !== c.last15){ c.last15 = last; onNew15(sym, c, now); }
        }
      }catch(err){ c.fHi = c.fHi || now - TF.h1 + 120000; c.f15 = now; if (!c.errLogged){ c.errLogged = true; addLog("SYS", base+" ろうそくの取得に失敗: "+err.message, true); } }
    }
    const CDL_FETCH_PER_CYCLE = 4;
    async function seedCandlesStep(now){
      const P = PM(), cur15 = Math.floor(now/TF.m15)*TF.m15; let n = 0;
      const held = new Set(S.positions.map(p=>p.sym));
      for (const t of tokens.values()){
        if (n >= CDL_FETCH_PER_CYCLE) break;
        const sym = t.sym; if (cdlInflight.has(sym)) continue;
        if (!held.has(sym) && t.turn < Math.max(P.minTurn, TR_MIN_TURN)) continue;
        const c = CDL[sym];
        const needHi = !c || now - (c.fHi||0) >= TF.h1;
        const need15 = !c || ((c.f15||0) < cur15 + 20000 && now >= cur15 + 20000); // 15分足が確定して20秒後に取りに行く
        if (!needHi && !need15) continue;
        n++; cdlInflight.add(sym);
        refreshCandles(sym, needHi, need15, now).finally(() => cdlInflight.delete(sym));
      }
    }
    function pruneCandles(){
      const keep = new Set(tokens.keys());
      for (const k of Object.keys(CDL)) if (!keep.has(k)) delete CDL[k];
    }
    // 15分足が1本確定するたびに呼ばれる：大きな流れ（4時間・1時間）と同じ向きのパターンが出ていれば、シグナルとして記録
    function onNew15(sym, c, now){
      const dir = bigTrend(sym); if (!dir) return;
      if (S.cfg.dir === "long" && dir < 0) return; if (S.cfg.dir === "short" && dir > 0) return;
      const hit = m15Pattern(c.m15, dir); if (!hit) return;
      c.sig = {dir, pat:hit.pat, at:now, bar:c.last15};
      const t = tokens.get(sym);
      if (t && t.px > 0) tsigPush(now, t, dir, hit.pat);
    }
    // ---- トレンド戦略のシグナル検証（1時間・4時間・24時間後の値動きを測る）----
    const TSIGKEY = "trenchdesk_tsig_v1", TSIG_H = [3600,14400,86400], TSIG_MAX_DONE = 1500, TSIG_MAX_PENDING = 500;
    let TSIG = {pending:[], done:[]}, tsigDirty = false, tsigSavedAt = 0;
    try{ const j = JSON.parse(store.get(TSIGKEY) || "null"); if (j && Array.isArray(j.pending)) TSIG = {pending:j.pending, done:j.done||[]}; }catch(_){}
    function tsigPush(now, t, dir, pat){
      if (TSIG.pending.length >= TSIG_MAX_PENDING) return;
      const sp = t.bid>0 && t.ask>0 ? (t.ask-t.bid)/t.px*100 : 0;
      TSIG.pending.push({t:now, sym:t.sym, d:dir, p0:t.px, pat, f:{}, mfe:0, mae:0, m:{sp:+sp.toFixed(3)}}); tsigDirty = true;
    }
    function tsigStep(now){
      const keep = [];
      for (const r of TSIG.pending){
        const t = tokens.get(r.sym), el = (now - r.t)/1000/WARP;
        if (t && t.px > 0){
          const rr = r.d*(t.px/r.p0-1)*100; if (rr > r.mfe) r.mfe = +rr.toFixed(3); if (rr < r.mae) r.mae = +rr.toFixed(3);
          for (const h of TSIG_H) if (r.f[h] == null && el >= h){ r.f[h] = +rr.toFixed(3); tsigDirty = true; }
        }
        if (r.f[86400] != null || el > 90000){ if (r.f[3600] != null){ TSIG.done.push(r); tsigDirty = true; } else tsigDirty = true; }
        else keep.push(r);
      }
      TSIG.pending = keep;
      if (TSIG.done.length > TSIG_MAX_DONE) TSIG.done.splice(0, TSIG.done.length - TSIG_MAX_DONE);
      if (tsigDirty && now - tsigSavedAt > 60000){ tsigSavedAt = now; tsigDirty = false; store.set(TSIGKEY, JSON.stringify(TSIG)); }
    }
    function tsigSummary(){
      const all = TSIG.done.concat(TSIG.pending), rows = [];
      const mk = (label, recs) => { const o = {label, n:recs.length, st:{}}; for (const h of TSIG_H) o.st[h] = sigStat(recs, h); return o; };
      rows.push(mk("全パターン合計", all));
      for (const k of Object.keys(TR_PATS)) rows.push(mk(TR_PATS[k], all.filter(r => r.pat === k)));
      rows.push(mk("ロング方向", all.filter(r => r.d > 0)), mk("ショート方向", all.filter(r => r.d < 0)));
      let m15 = 0, h1 = 0, h4 = 0, up = 0, dn = 0;
      for (const [s,c] of Object.entries(CDL)){ m15 = Math.max(m15, c.m15.length); h1 = Math.max(h1, c.h1.length); h4 = Math.max(h4, c.h4.length); const d = bigTrend(s); if (d>0) up++; else if (d<0) dn++; }
      return {H:TSIG_H, rows, pending:TSIG.pending.length, done:TSIG.done.length, trendUp:up, trendDn:dn, candles:{m15, h1, h4, tokens:Object.keys(CDL).length}};
    }

    async function pollTickers(){
      const rows = src === "bingx" ? await fetchBingx() : await fetchBybit();
      const now = Date.now(), P = PM(), heldSet = new Set(S.positions.map(p=>p.sym));
      for (const o of rows){
        if (!(o.px>0) || !isFinite(o.turn)) continue;
        if (!heldSet.has(o.sym) && o.turn < P.minTurn) continue;
        let t = tokens.get(o.sym); if (!t){ t = {sym:o.sym,samples:[],firstSeen:now}; tokens.set(o.sym,t); }
        t.px = o.px; t.mark = o.mark; t.bid = o.bid; t.ask = o.ask; t.bidSz = o.bidSz; t.askSz = o.askSz; t.turn = o.turn; t.oi = o.oi;
        t.fr = isFinite(o.fr) ? o.fr : 0; t.chg24 = o.chg24; t.chg1h = o.chg1h; t.hi = o.hi; t.lo = o.lo; t.updatedAt = now;
        t.samples.push({t:now,px:o.px,turn:o.turn,oi:o.oi}); if (t.samples.length>200) t.samples.shift();
      }
      for (const [k,t] of tokens) if (now - t.updatedAt > 90000 && !heldSet.has(k)) tokens.delete(k);
      pruneCandles();
      cdlSave(false);
    }

    function retOver(t,sec){
      const s = t.samples, n = s.length; if (n<2) return null;
      const nowT = s[n-1].t, target = nowT - sec*1000*WARP; let ref = null;
      for (let i=n-1;i>=0;i--){ if (s[i].t <= target){ ref = s[i]; break; } }
      if (!ref){ const o = s[0]; if (nowT - o.t >= sec*1000*WARP*0.5) ref = o; else return null; }
      return { r:s[n-1].px/ref.px - 1, age:(nowT-ref.t)/1000, ref };
    }
    function hiLoOver(t,sec){
      const s = t.samples, n = s.length; if (!n) return null;
      const nowT = s[n-1].t, cutoff = nowT - sec*1000*WARP;
      let hi = -Infinity, lo = Infinity, oldest = s[n-1].t;
      for (let i=n-1;i>=0;i--){ if (s[i].t < cutoff) break; hi = Math.max(hi, s[i].px); lo = Math.min(lo, s[i].px); oldest = s[i].t; }
      if (hi === -Infinity) return null;
      if (nowT - oldest < sec*1000*WARP*0.5) return null; // データがまだ足りない
      return { hi, lo };
    }
    function metricsOf(t){
      const s = t.samples, n = s.length, m = {r1:null,r5:null,r15:null,vrel:null,instVrel:null,r30s:null,oiChg:null,vol:0,adv:0,risk:0,up:0,dn:0,spread:0,buyShare:0.5};
      const a1 = retOver(t,60), a5 = retOver(t,300), a15 = retOver(t,900);
      if (a1){ m.r1 = a1.r*100; const dT = Math.max(0, s[n-1].turn - a1.ref.turn), rate = dT/Math.max(a1.age,1), base = t.turn/86400; m.vrel = base>0 ? rate/base : null; }
      if (a5){ m.r5 = a5.r*100; if (a5.ref.oi>0) m.oiChg = (t.oi/a5.ref.oi - 1)*100; }
      if (a15){ m.r15 = a15.r*100; }
      // 直近ポーリング間隔だけを見た「今この瞬間」の出来高急増（数秒〜十数秒の反応速度）
      if (n>=2){
        const prev = s[n-2], last = s[n-1], dt = Math.max((last.t-prev.t)/1000, 1), dTurn = Math.max(0, last.turn-prev.turn), rate = dTurn/dt, base = t.turn/86400;
        m.instVrel = base>0 ? rate/base : null;
        m.r30s = prev.px>0 ? (last.px/prev.px - 1)*100 : null;
      }
      let up = 0, dn = 0; const rets = [];
      for (let i=Math.max(1,n-30);i<n;i++){ const d = s[i].px - s[i-1].px; if (d>0) up++; else if (d<0) dn++; rets.push(Math.log(s[i].px/s[i-1].px)); }
      m.up = up; m.dn = dn; m.buyShare = (up+dn) ? up/(up+dn) : 0.5;
      let sd = 0; if (rets.length>=5){ const mu = sum(rets)/rets.length; sd = Math.sqrt(sum(rets.map(x=>(x-mu)**2))/rets.length); }
      m.vol = Math.round(clamp(sd/0.004*100,0,100));
      m.spread = (t.bid>0 && t.ask>0) ? (t.ask-t.bid)/((t.ask+t.bid)/2) : 0.01;
      m.adv = Math.round(clamp(Math.abs(t.fr)/0.001*40 + Math.max(0,Math.abs(t.chg24)-20)*0.6 + m.spread/MAX_SPREAD*15, 0, 100));
      m.risk = Math.round((m.vol+m.adv)/2);
      return m;
    }
    const WICK_PCT = 3; // 直近高値/安値から、これだけ%戻ったら「ヒゲができた＝終わりかけ」と見る
    function fadeCands(t,m,d){
      const out = {c:[], why:null};
      const hl = hiLoOver(t,300);
      if (!hl){ out.why = "ウォームアップ中（5分データ待ち）"; return out; }
      const th = S.cfg.fadeThresh;
      const overUp = m.r5>=th, overDn = -m.r5>=th;
      const backUp = hl.hi>0 ? (hl.hi - t.px)/hl.hi*100 : 0;   // 直近5分の高値からの戻り(%)
      const backDn = hl.lo>0 ? (t.px - hl.lo)/hl.lo*100 : 0;   // 直近5分の安値からの戻り(%)
      const wickUp = backUp >= WICK_PCT;
      const wickDn = backDn >= WICK_PCT;
      if (d!=="long" && overUp && wickUp) out.c.push({dir:"short",kind:"逆張り（5分+"+m.r5.toFixed(1)+"%・高値から-"+backUp.toFixed(1)+"%のヒゲ確認）",score:m.r5});
      if (d!=="short" && overDn && wickDn) out.c.push({dir:"long",kind:"逆張り（5分"+m.r5.toFixed(1)+"%・安値から+"+backDn.toFixed(1)+"%のヒゲ確認）",score:-m.r5});
      if (!out.c.length){
        out.why = !overUp && !overDn ? "逆張り条件未達（5分 "+pct(m.r5,2)+" ／ しきい値 ±"+th+"%）"
          : "逆張り: 行き過ぎてはいるがヒゲの兆しなし（高値からの戻り "+backUp.toFixed(1)+"% ／ 安値からの戻り "+backDn.toFixed(1)+"% ／ 必要 "+WICK_PCT+"%）";
      }
      return out;
    }
    function surgeCands(t,m,d){
      const out = {c:[], why:null};
      if (m.instVrel==null || m.r30s==null){ out.why = "出来高急増: ウォームアップ中"; return out; }
      const th = S.cfg.surgeThresh;
      if (d!=="short" && m.instVrel>=th && m.r30s>0) out.c.push({dir:"long",kind:"出来高急増（出来高×"+m.instVrel.toFixed(1)+"）",score:m.instVrel});
      if (d!=="long" && m.instVrel>=th && m.r30s<0) out.c.push({dir:"short",kind:"出来高急増（出来高×"+m.instVrel.toFixed(1)+"）",score:m.instVrel});
      if (!out.c.length) out.why = "出来高急増条件未達（出来高× "+(m.instVrel==null?"–":m.instVrel.toFixed(1))+" ／ しきい値 ×"+th+"）";
      return out;
    }
    function evalEntry(t){
      const m = metricsOf(t), P = PM(), r = {basic:false, dir:null, kind:"", why:null, gateWhy:null, score:0, m};
      if (!isFresh(t)){ r.why = "データ未更新"; return r; }
      { const sm = t.samples, n = sm.length;
        if (n >= 10){ let same = true; for (let i=n-10;i<n;i++){ if (sm[i].px !== sm[n-1].px){ same = false; break; } }
          if (same){ r.why = "価格が動いていません（休場・取引停止の可能性）"; return r; } } }
      if (t.turn < P.minTurn){ r.why = "売買代金 "+money(t.turn)+" < "+money(P.minTurn); return r; }
      if (m.spread > MAX_SPREAD){ r.why = "スプレッド "+(m.spread*100).toFixed(2)+"% が広い"; return r; }
      if (m.r5==null || m.r1==null || m.vrel==null){ r.why = "ウォームアップ中"; return r; }
      const d = S.cfg.dir, c = [], vr = Math.min(m.vrel,5);
      if (S.cfg.strategy === "fade"){
        const f = fadeCands(t,m,d); c.push(...f.c);
        if (!c.length){ r.why = f.why; return r; }
      } else if (S.cfg.strategy === "surge"){
        const s = surgeCands(t,m,d); c.push(...s.c);
        if (!c.length){ r.why = s.why; return r; }
      } else if (S.cfg.strategy === "dual"){
        const f = fadeCands(t,m,d), s = surgeCands(t,m,d);
        c.push(...f.c, ...s.c);
        if (!c.length){ r.why = [s.why, f.why].filter(Boolean).join(" ／ "); return r; }
      } else {
        if (d!=="short" && m.r1>=P.r1 && m.r5>=P.r5 && m.vrel>=P.vrel && t.fr<=0.001 && t.chg24<=100 && (t.chg1h==null || t.chg1h>=-3)) c.push({dir:"long",kind:"順張り",score:m.r5*vr});
        if (d!=="long"){
          if (-m.r1>=P.r1 && -m.r5>=P.r5 && m.vrel>=P.vrel && t.fr>=-0.001 && (t.chg1h==null || t.chg1h<=3)) c.push({dir:"short",kind:"順張り",score:-m.r5*vr});
          if (t.chg24>=35 && t.hi>0 && (t.hi-t.px)/t.hi>=0.04 && m.r5<=-P.r5*0.75 && t.fr>=0) c.push({dir:"short",kind:"反落狙い",score:-m.r5*Math.max(vr,1)});
        }
        if (!c.length){ r.why = "条件未達（5分 "+pct(m.r5,2)+" ／ 出来高×"+m.vrel.toFixed(1)+"）"; return r; }
      }
      c.sort((a,b)=>b.score-a.score); r.basic = true; r.dir = c[0].dir; r.kind = c[0].kind; r.score = c[0].score;
      const g = GATES[S.cfg.gate]; if (g && m.risk >= g.risk) r.gateWhy = "総合リスク "+m.risk+" ≥ 上限 "+g.risk;
      return r;
    }
    const unreal = (p,t) => p.side*((t?t.px:p.entry)-p.entry)*p.qty;
    function equity(){ let v = S.cash; for (const p of S.positions){ const t = tokens.get(p.sym); v += p.margin + unreal(p,t) - p.fundingPaid; } return v; }
    const impactOf = (t,side,N) => { const depth = (side>0 ? t.askSz*t.ask : t.bidSz*t.bid) || 0; return 0.0003 + 0.001*Math.min(N/Math.max(depth,1),5); };

    function liveQty(rawQty, p, precQty){
      return floorTo(rawQty, precQty);
    }
    async function liveSyncEntry(p, isOpen){
      try{
        const j = await relay("/positions?symbol="+baseOf(p.sym)+"USDT");
        const raw = (j.result && j.result.data) || [];
        const list = Array.isArray(raw) ? raw : [raw];
        const side = p.side>0 ? "LONG" : "SHORT";
        const pos = list.find(x => x && x.positionSide===side && Math.abs(parseFloat(x.positionAmt))>0);
        const avg = pos ? parseFloat(pos.avgPrice || pos.entryPrice) : 0;
        if (!(avg>0)) return 0;
        { const amt = Math.abs(parseFloat(pos.positionAmt)); if (p.live && amt>0) p.live.qty = amt; }
        p.entry = avg;
        p.liq = p.side>0 ? avg*(1-1/p.lev+MMR) : avg*(1+1/p.lev-MMR);
        if (isOpen){
          p.peak = avg;
          if (p.initEntry) p.initEntry = avg;
          if (p.slPriceFixed){ const k = (p.slLev || HB_SL)/100/p.lev; p.slPriceFixed = p.side>0 ? avg*(1-k) : avg*(1+k); }
        }
        return avg;
      }catch(_){ return 0; }
    }
    function ceilTo(v, prec){ const f = Math.pow(10,Math.max(0,prec)); return Number((Math.ceil(v*f - 1e-6)/f).toFixed(Math.max(0,prec))); }
    const trailBusy = new Set();
    async function liveActualAmt(p){
      try{
        const j = await relay("/positions?symbol="+baseOf(p.sym)+"USDT");
        const raw = (j.result && j.result.data) || [];
        const list = Array.isArray(raw) ? raw : [raw];
        const side = p.side>0 ? "LONG" : "SHORT";
        const pos = list.find(x => x && x.positionSide===side && Math.abs(parseFloat(x.positionAmt))>0);
        return pos ? Math.abs(parseFloat(pos.positionAmt)) : 0;
      }catch(_){ return 0; }
    }
    async function liveRestop(p, target, silent){
      const base = baseOf(p.sym), side = p.side>0 ? "LONG" : "SHORT", prec = await getPrecision(base);
      let q = floorTo(p.live.qty, prec.qty); if (!(q>0)) return false;
      const errText = errs => errs.map(e=>typeof e.detail==="string"?e.detail:JSON.stringify(e.detail)).join(", ");
      const isGoneErr = txt => /109420|position not exist/i.test(txt);
      const isDupErr = txt => /110424|available amount/i.test(txt);
      let br = await relay("/bracket-only","POST",{symbol:base+"USDT", positionSide:side, quantity:q, slPrice:String(target)});
      if (br.errors && br.errors.length){
        const txt = errText(br.errors);
        if (isGoneErr(txt)){
          p.live.status = "closed"; p.live.stopId = null;
          if (!silent) addLog("LIVE", base+" BingX側にポジションが見当たりません。決済済みとして扱います", true);
          return false;
        }
        if (isDupErr(txt)){
          if (p.live.stopId){ try{ await relay("/cancel-order","POST",{symbol:base+"USDT", orderId:p.live.stopId}); }catch(_){} p.live.stopId = null; }
          try{ await relay("/cancel-all","POST",{symbol:base+"USDT"}); }catch(_){}
          // 数量そのものが実際のポジションを超えている場合があるため、BingX側の実数量に合わせ直す
          const actual = await liveActualAmt(p);
          if (actual > 0){ const q2 = floorTo(actual, prec.qty); if (q2 > 0 && q2 !== q){ q = q2; p.live.qty = q; } }
          br = await relay("/bracket-only","POST",{symbol:base+"USDT", positionSide:side, quantity:q, slPrice:String(target)});
        }
      }
      if (br.errors && br.errors.length){
        const txt = errText(br.errors);
        if (isGoneErr(txt)){ p.live.status = "closed"; p.live.stopId = null; if (!silent) addLog("LIVE", base+" BingX側にポジションが見当たりません。決済済みとして扱います", true); return false; }
        throw new Error(txt);
      }
      const oldId = p.live.stopId;
      p.live.stopId = (br.ids && br.ids.sl) || null; p.live.stopPx = target;
      if (oldId){ try{ await relay("/cancel-order","POST",{symbol:base+"USDT", orderId:oldId}); }catch(_){} }
      return true;
    }
    async function liveTrail(p, hbPx){
      if (!S.cfg.live || !p.live || p.live.status!=="open" || trailBusy.has(p.sym)) return;
      trailBusy.add(p.sym);
      try{
        const base = baseOf(p.sym), prec = await getPrecision(base), t = tokens.get(p.sym);
        let target = p.side>0 ? floorTo(hbPx, prec.price) : ceilTo(hbPx, prec.price);
        const cur = t ? (t.mark || t.px) : null;
        if (cur > 0){
          // 損切りは現在価格より必ず不利側（ロング=下、ショート=上）でなければ取引所に拒否されるため、安全マージンを取る
          const margin = Math.max(cur*0.0008, Math.pow(10,-prec.price));
          if (p.side>0 && target >= cur - margin) target = floorTo(cur - margin, prec.price);
          if (p.side<0 && target <= cur + margin) target = ceilTo(cur + margin, prec.price);
        }
        const last = p.live.stopPx;
        if (!(target>0)) return;
        const better = last ? (p.side>0 ? target/last-1 : 1-target/last) : 1;
        if (better < 0.0025) return;
        if (await liveRestop(p, target)) addLog("LIVE", base+" BingX側の損切りを半戻しライン $"+px(target)+" に引き上げ（通信が切れても利益を守ります）", true);
      }catch(err){ addLog("LIVE", baseOf(p.sym)+" 損切りの引き上げに失敗: "+err.message, true); }
      finally{ trailBusy.delete(p.sym); }
    }
    async function liveOpen(p){
      if (!S.cfg.live) return;
      const base = baseOf(p.sym);
      try{
        const prec = await getPrecision(base);
        const qty = liveQty(p.qty, p, prec.qty);
        if (!(qty>0)){ addLog("LIVE",base+": 実発注スキップ（数量が最小単位未満）",true); p.live = null; return; }
        p.live = {qty:0, prec:prec.qty, status:"opening"};
        try{ await relay("/cancel-all","POST",{symbol:base+"USDT"}); }catch(_){}
        try{ await relay("/leverage","POST",{symbol:base+"USDT", side:p.side>0?"LONG":"SHORT", leverage:p.lev}); }
        catch(err){ addLog("LIVE",base+" レバレッジ "+p.lev+"x の設定に失敗（"+err.message+"）。BingX側の現在の設定のまま発注します",true); }
        const j = await relay("/order","POST",{symbol:base+"USDT", side:p.side>0?"BUY":"SELL", positionSide:p.side>0?"LONG":"SHORT", quantity:qty});
        p.live = {qty, prec:prec.qty, status:"open"};
        const syncedPx = await liveSyncEntry(p, true);
        const fillPx = syncedPx || parseFloat(j.result && j.result.data && j.result.data.avgPrice) || p.entry;
        addLog("LIVE",base+" 実発注: "+(p.side>0?"ロング":"ショート")+" "+qty+"（BingXデモ）",true);
        // 利確・損切りを、実際の約定価格を基準にBingX側へも置く（画面を閉じても取引所側で発動する）
        // 価格にも数量と同じく「小数点以下は何桁まで」という決まりがあるため、それに合わせて丸める
        let slPrice, tpPrice;
        if (p.scalp){
          // 固定$の利確・損切りを、数量から価格の距離に変換して置く
          const tick = Math.pow(10, -prec.price);
          slPrice = floorTo(fillPx - p.side*(p.scalpSl/qty), prec.price);
          tpPrice = floorTo(fillPx + p.side*(p.scalpTp/qty), prec.price);
          // 価格が極端に小さい銘柄では、$の距離が丸めで消えて現在価格と同じ（またはおかしい側）になることがあるため、
          // 損切り・利確が必ず正しい側に、最低でも1ティック離れるよう補正する
          if (p.side>0 ? slPrice>=fillPx : slPrice<=fillPx) slPrice = floorTo(fillPx - p.side*tick, prec.price);
          if (p.side>0 ? tpPrice<=fillPx : tpPrice>=fillPx) tpPrice = floorTo(fillPx + p.side*tick, prec.price);
        } else {
          const slPct = p.trend ? TR_SL/100/p.lev : p.halfback ? HB_SL/100/p.lev : S.cfg.sl/100;
          const tpPct = (p.halfback || p.trend) ? null : S.cfg.tp/100; // 半戻し利確は決済ラインが動くので、単発のTP注文は置かない（SLのみ）
          slPrice = floorTo(fillPx*(1 - p.side*slPct), prec.price);
          tpPrice = tpPct!=null ? floorTo(fillPx*(1 + p.side*tpPct), prec.price) : null;
        }
        try{
          const br = await relay("/bracket-only","POST",{symbol:base+"USDT", positionSide:p.side>0?"LONG":"SHORT", quantity: floorTo((p.live && p.live.qty>0) ? p.live.qty : qty, prec.qty), slPrice: String(slPrice), tpPrice: tpPrice!=null?String(tpPrice):undefined});
          if (p.live){ if (br.ids && br.ids.sl) p.live.stopId = br.ids.sl; p.live.stopPx = slPrice; }
          if (br.errors && br.errors.length) addLog("LIVE",base+" 利確/損切り注文の一部に失敗: "+br.errors.map(e=>e.which+"（"+(typeof e.detail==="string"?e.detail:JSON.stringify(e.detail))+"）").join(", "),true);
          else addLog("LIVE",base+" BingX側に損切り"+(tpPrice!=null?"・利確":"")+"を設置（画面を閉じても発動）",true);
        }catch(err){ addLog("LIVE",base+" 利確/損切り注文の設置に失敗: "+err.message,true); }
        if (p.trend) await liveTrendTps(p);
      }catch(err){ p.live = null; addLog("LIVE",base+" 実発注に失敗: "+err.message,true); }
    }
    async function liveClose(p, frac, label){
      if (!p.live || p.live.status!=="open"){
        if (S.cfg.live && !p.liveSkipLogged){ p.liveSkipLogged = true; addLog("LIVE", baseOf(p.sym)+" 実決済スキップ（"+label+"）: 実発注の記録がありません。BingX側に残っていれば自動で整理します", true); }
        return;
      }
      const base = baseOf(p.sym);
      try{
        let q = frac>=0.999 ? floorTo(p.live.qty, p.live.prec) : floorTo(p.live.qty*frac, p.live.prec);
        if (!(q>0)) return;
        await relay("/close","POST",{symbol:base+"USDT", positionSide:p.side>0?"LONG":"SHORT", quantity:q});
        p.live.qty = Math.max(0, p.live.qty - q);
        if (frac>=0.999 || p.live.qty<=0){
          p.live.status = "closed";
          try{ await relay("/cancel-all","POST",{symbol:base+"USDT"}); }catch(_){ /* 置いたままのTP/SLが残っても実害は小さいので無視 */ }
        }
        addLog("LIVE",base+" 実決済（"+label+"）: "+q,true);
      }catch(err){
        if (/101205|No position to close/i.test(String(err.message))){
          p.live.qty = 0; p.live.status = "closed";
          try{ await relay("/cancel-all","POST",{symbol:base+"USDT"}); }catch(_){}
          addLog("LIVE",base+" BingX側の損切りで、すでに決済されていました（"+label+"）",true);
          return;
        }
        addLog("LIVE",base+" 実決済に失敗（"+label+"）: "+err.message,true);
      }
    }
    const HB_ADD = 15, HB_SL = 32, HB_MIN_PEAK = 1.0; // 半戻し利確: -15%で1回だけ追加、-32%で固定損切り、ピークが+1%以上ついたら半戻し判定を有効化
    function openPos(t,e){
      let margin = Math.min(S.cash*0.98, equity()*S.cfg.size);
      const trendMode = S.cfg.strategy === "trend";
      if (S.cfg.scale && !S.cfg.halfback && !S.cfg.scalp && !trendMode) margin *= clamp(1 - e.m.risk/150, 0.4, 1);
      if (margin < 5) return false;
      const lev = S.cfg.lev, N = margin*lev, side = e.dir==="long" ? 1 : -1;
      const base = side>0 ? (t.ask||t.px) : (t.bid||t.px), fill = base*(1 + side*impactOf(t,side,N)), fee = N*FEEF();
      S.cash -= margin + fee;
      const liq = side>0 ? fill*(1-1/lev+MMR) : fill*(1+1/lev-MMR);
      const posObj = {sym:t.sym, side, lev, margin, margin0:margin, notional:N, qty:N/fill, origQty:N/fill, entry:fill, liq, ts:Date.now(), peak:fill, fundingPaid:0, feeOpen:fee, lastFund:Date.now(), kind:e.kind, slot:"main", realizedNet:0, tpHit:0, beOn:false, live:null, wsSign:null, wsCrosses:0, mfe:0, mae:0,
        ent:{ivrel:e.m.instVrel==null?null:+e.m.instVrel.toFixed(1), vrel:e.m.vrel==null?null:+e.m.vrel.toFixed(1), r30s:e.m.r30s==null?null:+e.m.r30s.toFixed(3), r5:e.m.r5==null?null:+e.m.r5.toFixed(2), spread:+(e.m.spread*100).toFixed(3), risk:e.m.risk, fr:+(t.fr*100).toFixed(4), chg24:+t.chg24.toFixed(1), buy:+e.m.buyShare.toFixed(2), hr:new Date(Date.now()+9*3600e3).getUTCHours()}};
      if (trendMode){
        posObj.trend = true; posObj.initEntry = fill; posObj.initMargin = margin; posObj.slLev = TR_SL;
        posObj.slPriceFixed = side>0 ? fill*(1-TR_SL/100/lev) : fill*(1+TR_SL/100/lev);
        posObj.trAdded = false; posObj.tpDone = 0; posObj.pat = e.pat || null;
      } else if (S.cfg.halfback){
        posObj.halfback = true; posObj.initEntry = fill; posObj.initMargin = margin;
        posObj.slPriceFixed = side>0 ? fill*(1-HB_SL/100/lev) : fill*(1+HB_SL/100/lev);
        posObj.hbAdded = false;
      } else if (S.cfg.scalp){
        posObj.scalp = true; posObj.scalpTp = S.cfg.scalpTp; posObj.scalpSl = S.cfg.scalpSl; posObj.scalpHold = S.cfg.scalpHold;
      }
      S.positions.push(posObj);
      liveOpen(posObj);
      S.events++;
      addLog("TRADE",baseOf(t.sym)+" "+(side>0?"ロング":"ショート")+" "+lev+"x（"+e.kind+"）証拠金 $"+margin.toFixed(2)+(trendMode ? "" : " ／ 5分 "+pct(e.m.r5,2)+" 出来高×"+(e.m.vrel==null?"–":e.m.vrel.toFixed(1))),true);
      return true;
    }
    async function liveAdd(p, addQty){
      if (!S.cfg.live || !p.live || p.live.status!=="open") return;
      const base = baseOf(p.sym);
      try{
        const prec = await getPrecision(base);
        const qty = liveQty(addQty, p, prec.qty);
        if (!(qty>0)) return;
        await relay("/order","POST",{symbol:base+"USDT", side:p.side>0?"BUY":"SELL", positionSide:p.side>0?"LONG":"SHORT", quantity:qty});
        p.live.qty += qty;
        await liveSyncEntry(p, false);
        try{ if (p.live.stopPx) await liveRestop(p, p.live.stopPx, true); }catch(err){ addLog("LIVE",base+" 追加後の損切り数量の更新に失敗: "+err.message,true); }
        if (p.trend){ try{ await liveTrendTps(p); }catch(err){ addLog("LIVE",base+" 追加後の利確注文の置き直しに失敗: "+err.message,true); } }
        addLog("LIVE",base+" 追加の実発注: "+qty+"（BingXデモ）",true);
      }catch(err){ addLog("LIVE",base+" 追加発注に失敗: "+err.message,true); }
    }
    function addOnce(p,label){
      const t = tokens.get(p.sym); if (!t || !isFresh(t)) return;
      const addMargin = p.initMargin;
      if (!(addMargin>0) || S.cash < addMargin+0.01){ addLog("RISK",baseOf(p.sym)+" 追加エントリー見送り（資金不足）",true); return; }
      const addNotional = addMargin*p.lev;
      const base = p.side>0 ? (t.ask||t.px) : (t.bid||t.px);
      const fill = base*(1+p.side*impactOf(t,p.side,addNotional));
      const fee = addNotional*FEEF();
      S.cash -= addMargin+fee;
      const addQty = addNotional/fill, newQty = p.qty+addQty;
      p.entry = (p.entry*p.qty + fill*addQty)/newQty;
      p.qty = newQty; p.origQty = newQty;
      p.margin += addMargin; p.margin0 += addMargin; p.notional += addNotional; p.feeOpen += fee;
      p.liq = p.side>0 ? p.entry*(1-1/p.lev+MMR) : p.entry*(1+1/p.lev-MMR);
      S.events++;
      addLog("TRADE",baseOf(p.sym)+" 追加エントリー（"+label+"） 新しい建値 $"+px(p.entry),true);
      liveAdd(p, addQty);
    }
    const WS_MIN_GAP_MS = 45000; // ノイズ対策: 前回のカウントから最低45秒は間を空ける
    function whipsawHit(p, value, threshold, now){
      const sign = value > threshold ? 1 : value < -threshold ? -1 : 0;
      if (sign !== 0){
        if (p.wsSign == null){ p.wsSign = sign; p.wsLastCrossAt = now; }
        else if (sign !== p.wsSign && (!p.wsLastCrossAt || now - p.wsLastCrossAt >= WS_MIN_GAP_MS)){
          p.wsCrosses = (p.wsCrosses||0) + 1; p.wsSign = sign; p.wsLastCrossAt = now;
        }
      }
      return (p.wsCrosses||0) >= 3;
    }
    function trendPartial(p, fracCur, label){
      const t = tokens.get(p.sym), last = t ? t.px : p.entry, q = p.qty*fracCur;
      if (!(q>0)) return;
      if (p.live && p.live.status==="open" && p.live.tpIds && Object.keys(p.live.tpIds).length){
        // BingX側に利確注文を置いてあるので、こちらからは決済しない。数秒後に約定を確認して、損切りを建値へ移す
        p.live.expQty = (p.live.expQty!=null ? p.live.expQty : p.live.qty)*(1-fracCur);
        p.live.syncAt = Date.now() + 5000; p.live.syncUntil = Date.now() + 60000;
      } else {
        liveClose(p, fracCur, label).then(() => { if (p.live && p.live.status==="open") return liveTrendSync(p, true); })
          .catch(err => addLog("LIVE", baseOf(p.sym)+" 部分利確後の損切りの更新に失敗: "+err.message, true));
      }
      const portion = fracCur, exitPx = fillExit(p,t,q,last), fee = q*exitPx*FEEF();
      const marginPart = p.margin*portion, fundPart = p.fundingPaid*portion;
      const back = Math.max(0, marginPart + p.side*(exitPx-p.entry)*q - fundPart - fee);
      S.cash += back; p.realizedNet = (p.realizedNet||0) + (back - marginPart);
      p.qty -= q; p.margin -= marginPart; p.notional *= (1-portion); p.fundingPaid -= fundPart; S.events++;
      addLog("TRADE",baseOf(p.sym)+" "+label+" を利確 "+((back-marginPart)>=0?"+":"−")+"$"+Math.abs(back-marginPart).toFixed(2),true);
    }
    const trendBusy = new Set();
    const TR_FRACS = [0.4, 0.3, 0.3], TR_BE_BUF = 0.001; // 建値撤退は手数料ぶん（約0.1%）だけ有利側に置く
    async function liveTrendTps(p){
      if (!p.live || p.live.status!=="open") return;
      const base = baseOf(p.sym), prec = await getPrecision(base), side = p.side>0 ? "LONG" : "SHORT";
      for (const id of Object.values(p.live.tpIds||{})) if (id){ try{ await relay("/cancel-order","POST",{symbol:base+"USDT", orderId:id}); }catch(_){} }
      p.live.tpIds = {};
      const lv = [0,1,2].filter(i => i >= (p.tpDone||0)); if (!lv.length) return;
      const total = floorTo(p.live.qty, prec.qty), fsum = lv.reduce((a,i)=>a+TR_FRACS[i],0);
      let left = total, carry = 0; const placed = [];
      for (let k=0;k<lv.length;k++){
        const i = lv[k], last = k === lv.length-1;
        let q = last ? left : floorTo(total*TR_FRACS[i]/fsum + carry, prec.qty);
        if (!(q>0)){ carry += total*TR_FRACS[i]/fsum; continue; } carry = 0;
        q = Math.min(q, left); left = floorTo(left - q, prec.qty);
        const raw = p.entry*(1+p.side*TR_TPS[i][0]/100/p.lev), price = p.side>0 ? floorTo(raw, prec.price) : ceilTo(raw, prec.price);
        try{
          const br = await relay("/bracket-only","POST",{symbol:base+"USDT", positionSide:side, quantity:q, tpPrice:String(price)});
          if (br.errors && br.errors.length) throw new Error(br.errors.map(e=>typeof e.detail==="string"?e.detail:JSON.stringify(e.detail)).join(", "));
          p.live.tpIds[i+1] = (br.ids && br.ids.tp) || "?"; placed.push("TP"+(i+1)+" $"+px(price)+"×"+q);
        }catch(err){ addLog("LIVE", base+" 利確"+(i+1)+"の注文設置に失敗: "+err.message+"（サーバー側で判定して決済します）", true); }
      }
      if (placed.length) addLog("LIVE", base+" BingX側に利確注文を設置: "+placed.join(" ／ "), true);
    }
    async function liveTrendSync(p, direct){
      if (!p.live || p.live.status!=="open" || trendBusy.has(p.sym)) return;
      trendBusy.add(p.sym);
      try{
        const base = baseOf(p.sym), prec = await getPrecision(base);
        let actual = await liveActualAmt(p);
        if (!(actual>0)){ p.live.status = "closed"; p.live.syncAt = 0; return; }
        if (!direct && p.live.expQty!=null && actual > p.live.expQty*1.02 + Math.pow(10,-prec.qty)){
          if (Date.now() < p.live.syncUntil){ p.live.syncAt = Date.now() + 5000; return; } // BingX側の利確がまだ約定していない→少し待つ
          // 1分待っても約定しない（価格の判定基準の違いなど）→ こちらから決済し、利確注文を置き直す
          p.live.qty = actual;
          await liveClose(p, (actual - p.live.expQty)/actual, "利確（BingX側で未約定のためサーバーから決済）");
          actual = await liveActualAmt(p); if (!(actual>0)){ p.live.status = "closed"; p.live.syncAt = 0; return; }
          p.live.qty = actual; await liveTrendTps(p);
        }
        p.live.qty = actual; p.live.expQty = null; p.live.syncAt = 0;
        const raw = p.beOn ? p.bePx : p.slPriceFixed, target = p.side>0 ? floorTo(raw, prec.price) : ceilTo(raw, prec.price);
        if (await liveRestop(p, target, true)) addLog("LIVE", base+" BingX側の損切りを"+(p.beOn?"建値":"初期固定ライン")+" $"+px(target)+" に設定（残り "+actual+"）", true);
      }catch(err){ p.live.syncAt = Date.now() + 15000; addLog("LIVE", baseOf(p.sym)+" 利確後の損切り移動に失敗: "+err.message+"（15秒後に再試行）", true); }
      finally{ trendBusy.delete(p.sym); }
    }
    function trendCheck(p,t,now){
      if ((p.side>0 && t.px<=p.liq) || (p.side<0 && t.px>=p.liq)){ closePos(p,"強制ロスカット"); return; }
      if (p.beOn && (p.side>0 ? t.px<=p.bePx : t.px>=p.bePx)){ closePos(p,"建値撤退（利確1の後）"); return; }
      if (p.side>0 ? t.px<=p.slPriceFixed : t.px>=p.slPriceFixed){ closePos(p,"損切り（初回基準 -"+TR_SL+"%・固定）"); return; }
      if (p.live && p.live.syncAt && now >= p.live.syncAt) liveTrendSync(p, false);
      if (!p.trAdded){
        const levInit = p.side*(t.px/p.initEntry - 1)*100*p.lev;
        if (levInit <= -TR_ADD){ p.trAdded = true; addOnce(p,"-"+TR_ADD+"%で1回だけ再エントリー"); }
      }
      const levAvg = p.side*(t.px/p.entry - 1)*100*p.lev;
      // 利確は元の数量に対して 4割 → 3割 → 残り全部。残っている数量に対する割合に直して決済する
      if (p.tpDone < 1 && levAvg >= TR_TPS[0][0]){ p.tpDone = 1; p.beOn = true; p.bePx = p.entry*(1+p.side*TR_BE_BUF); trendPartial(p, 0.4, "利確1（+"+TR_TPS[0][0]+"%・元の数量の4割）"); }
      if (p.tpDone < 2 && levAvg >= TR_TPS[1][0]){ p.tpDone = 2; trendPartial(p, 0.5, "利確2（+"+TR_TPS[1][0]+"%・元の数量の3割）"); }
      if (levAvg >= TR_TPS[2][0]){ closePos(p,"利確3（+"+TR_TPS[2][0]+"%・全決済）"); return; }
    }
    function halfbackCheck(p,t,now){
      if ((p.side>0 && t.px<=p.liq) || (p.side<0 && t.px>=p.liq)){ closePos(p,"強制ロスカット"); return; }
      const slHit = p.side>0 ? t.px<=p.slPriceFixed : t.px>=p.slPriceFixed;
      if (slHit){ closePos(p,"損切り（初期固定 -"+HB_SL+"%）"); return; }
      if (whipsawHit(p, p.side*(t.px/p.entry-1)*100*p.lev, 8, now)){ closePos(p,"方向不明（プラスマイナス3往復）"); return; }
      if (!p.hbAdded){
        const levPct = p.side*(t.px/p.entry - 1)*100*p.lev;
        if (levPct<=-HB_ADD){ addOnce(p,"証拠金維持率-"+HB_ADD+"%"); p.hbAdded=true; }
      }
      p.peak = p.side>0 ? Math.max(p.peak,t.px) : Math.min(p.peak,t.px);
      const fav = p.side*(t.px/p.entry-1)*100, best = p.side*(p.peak/p.entry-1)*100;
      if (best >= HB_MIN_PEAK && !(fav <= best/2)) liveTrail(p, p.entry*(1+p.side*best/200));
      if (best >= HB_MIN_PEAK && fav <= best/2){ closePos(p,"利確（半戻し）"); return; }
    }
    function scalpCheck(p,t,now){
      if ((p.side>0 && t.px<=p.liq) || (p.side<0 && t.px>=p.liq)){ closePos(p,"強制ロスカット"); return; }
      const pnl = unreal(p,t) - p.fundingPaid;
      if (pnl >= p.scalpTp){ closePos(p,"利確（+$"+p.scalpTp.toFixed(0)+"）"); return; }
      if (pnl <= -p.scalpSl){ closePos(p,"損切り（-$"+p.scalpSl.toFixed(0)+"）"); return; }
      if (now - p.ts > p.scalpHold*1000*WARP){ closePos(p,"保有時間切れ（"+p.scalpHold+"秒）"); return; }
    }
    function fillExit(p,t,q,last){
      const base = p.side>0 ? ((t&&t.bid)||last) : ((t&&t.ask)||last);
      return base*(1 - p.side*(t?impactOf(t,-p.side,q*last):0.0003));
    }
    function partial(p,frac,label){
      const t = tokens.get(p.sym), last = t ? t.px : p.entry, q = Math.min(p.qty*0.999, p.origQty*frac);
      if (!(q>0)) return;
      liveClose(p, frac, label);
      const portion = q/p.qty, exitPx = fillExit(p,t,q,last), fee = q*exitPx*FEEF();
      const marginPart = p.margin*portion, fundPart = p.fundingPaid*portion;
      const back = Math.max(0, marginPart + p.side*(exitPx-p.entry)*q - fundPart - fee);
      S.cash += back; p.realizedNet = (p.realizedNet||0) + (back - marginPart);
      p.qty -= q; p.margin -= marginPart; p.notional *= (1-portion); p.fundingPaid -= fundPart; S.events++;
      addLog("TRADE",baseOf(p.sym)+" "+label+"到達：約"+Math.round(frac*100)+"%を利確 "+((back-marginPart)>=0?"+":"−")+"$"+Math.abs(back-marginPart).toFixed(2),true);
    }
    function todayKey(d){ d = d || new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
    function notePnlDaily(pnl){
      const k = todayKey();
      S.pnlDaily[k] = (S.pnlDaily[k]||0) + pnl;
      const keys = Object.keys(S.pnlDaily);
      if (keys.length > 180){ keys.sort(); delete S.pnlDaily[keys[0]]; }
    }
    function closePos(p,reason){
      liveClose(p, 1, reason);
      const t = tokens.get(p.sym), last = t ? t.px : p.entry;
      let back;
      if (reason === "強制ロスカット"){ back = 0; }
      else {
        const exitPx = fillExit(p,t,p.qty,last), fee = p.qty*exitPx*FEEF();
        back = Math.max(0, p.margin + p.side*(exitPx-p.entry)*p.qty - p.fundingPaid - fee);
      }
      S.cash += back; S.positions = S.positions.filter(x=>x!==p);
      const pnl = (p.realizedNet||0) + (back - p.margin) - p.feeOpen, m0 = p.margin0 || p.margin;
      notePnlDaily(pnl);
      const why = reason;
      S.trades.unshift({symbol:baseOf(p.sym),mint:p.sym,side:p.side>0?"long":"short",lev:p.lev,entryTs:p.ts,exitTs:Date.now(),pnlUsd:pnl,pct:pnl/m0*100,reason:why,kind:p.kind,slot:p.slot||"main",mfe:+(p.mfe||0).toFixed(2),mae:+(p.mae||0).toFixed(2),ent:p.ent||null});
      if (S.trades.length>100) S.trades.pop();
      S.cooldown[p.sym] = Date.now(); S.events++;
      addLog("TRADE",baseOf(p.sym)+" "+(p.side>0?"ロング":"ショート")+" 決済（"+why+"） "+(pnl>=0?"+":"−")+"$"+Math.abs(pnl).toFixed(2),true);
    }
    function accrueFunding(){
      const now = Date.now();
      for (const p of S.positions){ const t = tokens.get(p.sym), dt = (now-p.lastFund)/1000; p.lastFund = now; if (t && dt>0 && dt<3600) p.fundingPaid += p.side*t.fr*p.notional*dt/(8*3600); }
    }
        const SIGKEY = "trenchdesk_sig_v1", SIG_H = [30,60,180,300,900], SIG_COST = 0.10, SIG_GAP_MS = 120000, SIG_MAX_PENDING = 600, SIG_MAX_DONE = 8000;
    const SIG_CHUNK = 1000, SIG_KINDS = ["s","f","b","t","k","r","p","c"];
    let SIG = {pending:[], done:[], startedAt:Date.now(), lastCtl:0, seq:0, n0:0, savedSeq:0}, sigSavedAt = 0, sigCache = null, sigCacheAt = 0;
    function sigLoad(){
      try{
        const j = JSON.parse(store.get(SIGKEY) || "null");
        if (!j || !Array.isArray(j.pending)) return;
        SIG = {pending:j.pending, done:[], startedAt:j.startedAt||Date.now(), lastCtl:j.lastCtl||0, seq:j.seq||0, n0:j.n0||0, savedSeq:j.seq||0};
        if (Array.isArray(j.done)){
          for (const r of j.done){ r.q = SIG.seq++; SIG.done.push(r); }
          SIG.n0 = SIG.done.length ? SIG.done[0].q : SIG.seq; SIG.savedSeq = 0;
        } else {
          for (let c=Math.floor(SIG.n0/SIG_CHUNK); c<=Math.floor((SIG.seq-1)/SIG_CHUNK); c++){
            try{ for (const r of JSON.parse(store.get(SIGKEY+"_d"+c) || "[]")) SIG.done.push(r); }catch(_){}
          }
        }
      }catch(_){}
    }
    sigLoad();
    function sigSave(force){
      const now = Date.now(); if (!force && now - sigSavedAt < 60000) return; sigSavedAt = now;
      const c0 = Math.floor((SIG.done.length ? SIG.done[0].q : SIG.seq)/SIG_CHUNK), c1 = Math.floor((SIG.seq-1)/SIG_CHUNK);
      for (let c=Math.max(c0, Math.floor((SIG.savedSeq||0)/SIG_CHUNK)); c<=c1; c++)
        store.set(SIGKEY+"_d"+c, JSON.stringify(SIG.done.filter(r => Math.floor(r.q/SIG_CHUNK) === c)));
      SIG.savedSeq = SIG.seq;
      store.set(SIGKEY, JSON.stringify({pending:SIG.pending, startedAt:SIG.startedAt, lastCtl:SIG.lastCtl, seq:SIG.seq, n0:SIG.done.length ? SIG.done[0].q : SIG.seq}));
    }
    function sigResetAll(){
      const c0 = Math.floor((SIG.n0||0)/SIG_CHUNK), c1 = Math.floor(Math.max(0,SIG.seq-1)/SIG_CHUNK);
      for (let c=c0; c<=c1; c++) store.set(SIGKEY+"_d"+c, "");
      SIG = {pending:[], done:[], startedAt:Date.now(), lastCtl:0, seq:0, n0:0, savedSeq:0}; sigCache = null;
      store.set(SIGKEY, JSON.stringify({pending:[], startedAt:SIG.startedAt, lastCtl:0, seq:0, n0:0}));
    }
    function sigFrozen(t){
      const sm = t.samples, n = sm.length; if (n < 10) return false;
      for (let i=n-10;i<n;i++) if (sm[i].px !== sm[n-1].px) return false;
      return true;
    }
    function sigPush(now, t, m, kind, d, act, hr, tr){
      SIG.pending.push({t:now, sym:t.sym, k:kind, d, p0:t.px, act, f:{}, mfe:0, mae:0,
        m:{iv:m.instVrel==null?null:+m.instVrel.toFixed(1), v1:m.vrel==null?null:+m.vrel.toFixed(1), r30:m.r30s==null?null:+m.r30s.toFixed(3), r1:+m.r1.toFixed(3), r5:+m.r5.toFixed(2), sp:+(m.spread*100).toFixed(3), rk:m.risk, fr:+(t.fr*100).toFixed(4), c24:+t.chg24.toFixed(1), tn:Math.round(t.turn), hr,
          c1:(tr&&tr.c1)||0, c4:(tr&&tr.c4)||0, tg:(tr&&tr.align)||0}});
    }
    function sigStep(now){
      const P = PM(), MAXP = S.cfg.maxPos || P.maxPos;
      for (const r of SIG.pending){
        const t = tokens.get(r.sym); if (!t || !(t.px>0)) continue;
        const el = (now - r.t)/1000/WARP, rr = r.d*(t.px/r.p0-1)*100;
        if (rr > r.mfe) r.mfe = rr; if (rr < r.mae) r.mae = rr;
        for (const h of SIG_H) if (r.f[h] == null && el >= h) r.f[h] = +rr.toFixed(3);
      }
      const keep = [];
      for (const r of SIG.pending){
        const el = (now - r.t)/1000/WARP;
        if (r.f[900] != null || el > 1500){ if (r.f[30] != null){ r.mfe = +r.mfe.toFixed(3); r.mae = +r.mae.toFixed(3); r.q = SIG.seq++; SIG.done.push(r); } }
        else keep.push(r);
      }
      SIG.pending = keep;
      if (SIG.done.length > SIG_MAX_DONE){
        const oldC = Math.floor(SIG.done[0].q/SIG_CHUNK);
        SIG.done.splice(0, SIG.done.length - SIG_MAX_DONE);
        const newC = Math.floor(SIG.done[0].q/SIG_CHUNK);
        for (let c=oldC; c<newC; c++) store.set(SIGKEY+"_d"+c, "");
      }
      const hr = new Date(now + 9*3600e3).getUTCHours(), cand = [];
      for (const t of tokens.values()){
        if (!isFresh(t) || t.turn < P.minTurn || sigFrozen(t)) continue;
        const m = metricsOf(t);
        if (m.r5 == null || m.r1 == null || m.vrel == null || m.spread > MAX_SPREAD) continue;
        cand.push({t, m});
        if (SIG.pending.length >= SIG_MAX_PENDING) continue;
        const ak = t.sigAtK || (t.sigAtK = {}), ok = k => !ak[k] || now - ak[k] >= SIG_GAP_MS*WARP;
        const tr = trendOf(t.sym, t.px);
        let kind = null, d = 0;
        if (ok("s") && m.instVrel != null && m.r30s != null && m.instVrel >= 2 && m.r30s !== 0){ kind = "s"; d = m.r30s > 0 ? 1 : -1; }
        else if (ok("f") && Math.abs(m.r5) >= 3){ kind = "f"; d = m.r5 > 0 ? -1 : 1; }
        if (kind){
          const e = evalEntry(t);
          const act = e.basic ? (e.gateWhy ? "gate" : (S.positions.length >= MAXP ? "cap" : "enter")) : "none";
          ak[kind] = now; sigPush(now, t, m, kind, d, act, hr, tr);
        }
        if (ok("b") && t.bid > 0 && t.ask > 0){
          const bq = t.bidSz*t.bid, aq = t.askSz*t.ask, tot = bq + aq;
          if (tot > 0){ const im = (bq-aq)/tot; if (Math.abs(im) >= 0.6){ ak.b = now; sigPush(now, t, m, "b", im > 0 ? 1 : -1, "none", hr, tr); } }
        }
        if (ok("t") && m.r15 != null && m.vrel >= 1.5 && Math.abs(m.r5) >= 1 && Math.abs(m.r15) >= 2 && (m.r5 > 0) === (m.r15 > 0)){ ak.t = now; sigPush(now, t, m, "t", m.r5 > 0 ? 1 : -1, "none", hr, tr); }
        if (ok("k") && m.vrel >= 1.5){
          const hl = hiLoOver(t, 900);
          if (hl && hl.lo > 0 && (hl.hi - hl.lo)/hl.lo >= 0.005){
            if (t.px >= hl.hi){ ak.k = now; sigPush(now, t, m, "k", 1, "none", hr, tr); }
            else if (t.px <= hl.lo){ ak.k = now; sigPush(now, t, m, "k", -1, "none", hr, tr); }
          }
        }
        if (ok("r") && Math.abs(m.r5) >= 3){
          const hl = hiLoOver(t, 300);
          if (hl){
            const backUp = hl.hi > 0 ? (hl.hi - t.px)/hl.hi*100 : 0, backDn = hl.lo > 0 ? (t.px - hl.lo)/hl.lo*100 : 0;
            if (m.r5 > 0 && backUp >= 1){ ak.r = now; sigPush(now, t, m, "r", -1, "none", hr, tr); }
            else if (m.r5 < 0 && backDn >= 1){ ak.r = now; sigPush(now, t, m, "r", 1, "none", hr, tr); }
          }
        }
        // トレンド逆行後の反発（1時間・4時間の両方が同じ方向のときだけ、その流れに乗る方向で、短期の逆行を待って入る）
        if (ok("p") && tr.align !== 0 && m.r5 != null){
          if (tr.align > 0 && m.r5 <= -1){ ak.p = now; sigPush(now, t, m, "p", 1, "none", hr, tr); }
          else if (tr.align < 0 && m.r5 >= 1){ ak.p = now; sigPush(now, t, m, "p", -1, "none", hr, tr); }
        }
      }
      if (now - (SIG.lastCtl||0) >= 60000*WARP && cand.length && SIG.pending.length < SIG_MAX_PENDING){
        SIG.lastCtl = now;
        for (let i=0;i<2;i++){
          const c = cand[Math.floor(Math.random()*cand.length)];
          sigPush(now, c.t, c.m, "c", Math.random() < 0.5 ? 1 : -1, "ctl", hr, trendOf(c.t.sym, c.t.px));
        }
      }
      sigSave(false);
    }
    function sigStat(recs, h){
      const xs = [];
      for (const r of recs){ const v = r.f[h]; if (v == null) continue; xs.push({t:r.t, s:r.sym, v, x:v - SIG_COST - (r.m.sp||0)}); }
      const n = xs.length; if (!n) return {n:0};
      xs.sort((a,b)=>a.t-b.t);
      let sum = 0, net = 0, win = 0; const grp = {};
      for (const o of xs){ sum += o.v; net += o.x; if (o.x > 0) win++; }
      const mu = net/n;
      for (const o of xs) grp[o.s] = (grp[o.s]||0) + (o.x - mu);
      let ss = 0, k = 0; for (const g in grp){ ss += grp[g]*grp[g]; k++; }
      const ci = 1.96*Math.sqrt(ss)/n;
      const half = Math.floor(n/2), m1 = half ? xs.slice(0,half).reduce((a,o)=>a+o.x,0)/half : 0, m2 = (n-half) ? xs.slice(half).reduce((a,o)=>a+o.x,0)/(n-half) : 0;
      const sig = (n >= 30 && k >= 5 && mu - ci > 0 && m1 > 0 && m2 > 0) ? "有意（前後半とも黒字）" : (m1 > 0 && m2 > 0 ? "有望（誤差内）" : "なし");
      return {n, k, mean:+(sum/n).toFixed(3), net:+mu.toFixed(3), ci:+ci.toFixed(3), hit:Math.round(win/n*1000)/10, h1:+m1.toFixed(3), h2:+m2.toFixed(3), sig};
    }
    function sigBuckets(by, h){
      const KN = {s:"出来高急増", f:"逆張り", p:"トレンド逆行後の反発"};
      const defs = [
        ["出来高の急増倍率（瞬間）", r=>r.m.iv, [[0,3,"×2〜3"],[3,5,"×3〜5"],[5,10,"×5〜10"],[10,1e9,"×10以上"]], ["s"]],
        ["30秒の値動き（絶対値）", r=>r.m.r30==null?null:Math.abs(r.m.r30), [[0,0.05,"〜0.05%"],[0.05,0.15,"0.05〜0.15%"],[0.15,0.4,"0.15〜0.4%"],[0.4,1e9,"0.4%以上"]], ["s"]],
        ["5分の値動き（絶対値）", r=>Math.abs(r.m.r5), [[0,1,"〜1%"],[1,3,"1〜3%"],[3,5,"3〜5%"],[5,1e9,"5%以上"]], ["s","f"]],
        ["スプレッド", r=>r.m.sp, [[0,0.02,"〜0.02%"],[0.02,0.05,"0.02〜0.05%"],[0.05,1e9,"0.05%以上"]], ["s","f"]],
        ["リスクスコア", r=>r.m.rk, [[0,30,"〜30"],[30,50,"30〜50"],[50,65,"50〜65"],[65,1e9,"65以上"]], ["s","f"]],
        ["時間帯（日本時間）", r=>r.m.hr, [[0,6,"0〜6時"],[6,12,"6〜12時"],[12,18,"12〜18時"],[18,24,"18〜24時"]], ["s","f"]],
        ["資金調達率（エントリー方向で見た有利不利）", r=>r.d*r.m.fr, [[-1e9,-0.01,"受取側（有利）"],[-0.01,0.01,"ほぼ0"],[0.01,1e9,"支払い側（不利）"]], ["s","f"]],
        ["24時間の売買代金", r=>r.m.tn, [[0,5e6,"〜$5M"],[5e6,5e7,"$5M〜50M"],[5e7,5e8,"$50M〜500M"],[5e8,1e18,"$500M以上"]], ["s","f"]]
      ];
      const out = [], rowOf = (l, xs) => { const s = sigStat(xs, h); return s.n ? Object.assign({l}, s) : null; };
      for (const [name, fn, ranges, kinds] of defs) for (const k of kinds){
        const rows = [];
        for (const [a,b,l] of ranges){ const r = rowOf(l, by[k].filter(x=>{ const v = fn(x); return v != null && v >= a && v < b; })); if (r) rows.push(r); }
        if (rows.length) out.push({title:name+"："+KN[k], rows});
      }
      for (const k of ["s","f"]){
        const rows = [], AL = {enter:"実際に入った条件", gate:"ゲートで見送り", cap:"枠が埋まっていて見送り", none:"戦略のしきい値に届かず"};
        for (const a of ["enter","gate","cap","none"]){ const r = rowOf(AL[a], by[k].filter(x=>x.act===a)); if (r) rows.push(r); }
        for (const [l,dv] of [["ロング方向",1],["ショート方向",-1]]){ const r = rowOf(l, by[k].filter(x=>x.d===dv)); if (r) rows.push(r); }
        if (rows.length) out.push({title:"実際の扱い・方向："+KN[k], rows});
      }
      // 1時間・4時間EMAで見たトレンドと、シグナルの方向が一致していたか
      for (const k of Object.keys(KN)){
        const rows = [];
        const withTrend = by[k].filter(x=>x.m.tg!==0);
        const same = rowOf("トレンドと同方向（順行）", withTrend.filter(x=>x.m.tg===x.d));
        const diff = rowOf("トレンドと逆方向（逆行）", withTrend.filter(x=>x.m.tg===-x.d));
        const none = rowOf("トレンド不明・形成前", by[k].filter(x=>x.m.tg===0));
        if (same) rows.push(same); if (diff) rows.push(diff); if (none) rows.push(none);
        if (rows.length) out.push({title:"1h/4h EMAトレンドとの一致："+KN[k], rows});
      }
      return out;
    }
    function sigSummary(){
      const all = SIG.done.concat(SIG.pending), by = {};
      for (const k of SIG_KINDS) by[k] = [];
      let from = Infinity;
      for (const r of all){ if (by[r.k]) by[r.k].push(r); if (r.t < from) from = r.t; }
      const out = {since:SIG.startedAt, from:isFinite(from)?from:null, h:300, cost:SIG_COST, n:{pending:SIG.pending.length}, tables:{}, buckets:[]};
      for (const k of SIG_KINDS){ out.n[k] = by[k].length; out.tables[k] = {}; for (const h of SIG_H) out.tables[k][h] = sigStat(by[k], h); }
      out.buckets = sigBuckets(by, 300);
      { let h1max=0, h4max=0, cnt=0; for (const c of Object.values(CDL)){ h1max = Math.max(h1max, c.h1.length); h4max = Math.max(h4max, c.h4.length); cnt++; }
        out.candles = {h1:h1max, h4:h4max, h1need:EMA1_PERIOD, h4need:EMA4_PERIOD, tokens:cnt}; }
      try{ out.trend = tsigSummary(); }catch(_){ out.trend = null; }
      return out;
    }
    function sigSummaryCached(){
      const now = Date.now();
      if (!sigCache || now - sigCacheAt > 30000){ sigCache = sigSummary(); sigCacheAt = now; }
      return sigCache;
    }
    const orphanSeen = {}, orphanTry = {};
    async function reconcileLive(){
      if (!S.cfg.live || !liveAccount || liveAccountErr) return;
      const now = Date.now(), held = new Set(S.positions.map(p => baseOf(p.sym)+"|"+(p.side>0?"LONG":"SHORT"))), seen = new Set();
      for (const lp of liveAccount.positions){
        const b0 = String(lp.symbol||"").replace(/-?USDT$/,"");
        if (!b0 || /^NC[A-Z]{2}/.test(b0) || /2USD$/.test(b0)) continue;
        const side = lp.side === "SHORT" ? "SHORT" : "LONG", key = b0+"|"+side, q = Math.abs(lp.amt);
        seen.add(key);
        if (held.has(key)){ delete orphanSeen[key]; continue; }
        if (!orphanSeen[key]){ orphanSeen[key] = now; addLog("LIVE", b0+" BingXにあってアプリに無いポジションを検出（"+(side==="LONG"?"ロング":"ショート")+" "+q+"）", true); continue; }
        if (now - orphanSeen[key] < 20000 || !S.cfg.orphan) continue;
        if (orphanTry[key] && now - orphanTry[key] < 120000) continue;
        orphanTry[key] = now;
        try{
          await relay("/close","POST",{symbol:b0+"USDT", positionSide:side, quantity:q});
          try{ await relay("/cancel-all","POST",{symbol:b0+"USDT"}); }catch(_){}
          addLog("LIVE", b0+" アプリに無いポジションを決済しました（"+q+"）", true);
          delete orphanSeen[key];
        }catch(err){ addLog("LIVE", b0+" アプリに無いポジションの決済に失敗: "+err.message, true); orphanSeen[key] = now; }
      }
      for (const k of Object.keys(orphanSeen)) if (!seen.has(k)) delete orphanSeen[k];
      for (const p of S.positions){
        if (!p.live || p.live.status !== "open" || p.missWarned || now - p.ts < 60000) continue;
        if (!seen.has(baseOf(p.sym)+"|"+(p.side>0?"LONG":"SHORT"))){ p.missWarned = true; addLog("LIVE", baseOf(p.sym)+" アプリにあるのにBingXに見当たりません（実注文が通っていない可能性）", true); }
      }
    }
    function agentStep(){
      const now = Date.now(), P = PM(), cf = S.cfg, MAXTP = cf.tp;
      accrueFunding();
      seedCandlesStep(now).catch(()=>{});
      try{ sigStep(now); }catch(_){}
      try{ tsigStep(now); }catch(_){}
      for (const p of [...S.positions]){
        const t = tokens.get(p.sym); if (!t || !isFresh(t)) continue;
        { const f0 = p.side*(t.px/p.entry-1)*100; if (f0 > (p.mfe||0)) p.mfe = f0; if (f0 < (p.mae||0)) p.mae = f0;
          if (!p.trend && cf.timeout > 0 && now - p.ts > msMin(cf.timeout) && (p.mfe||0) < 0.3 && f0 < 0){ closePos(p,"時間切れ（"+cf.timeout+"分・含み益に届かず）"); continue; } }
        if (p.trend){ trendCheck(p,t,now); continue; }
        if (p.halfback){ halfbackCheck(p,t,now); continue; }
        if (p.scalp){ scalpCheck(p,t,now); continue; }
        p.peak = p.side>0 ? Math.max(p.peak,t.px) : Math.min(p.peak,t.px);
        const fav = p.side*(t.px/p.entry-1)*100, m = metricsOf(t);
        const dead = (p.side>0 && t.px<=p.liq) || (p.side<0 && t.px>=p.liq);
        const wsThresh = Math.max(0.15, cf.sl*0.35);
        const wsDone = !dead && whipsawHit(p, fav, wsThresh, now);
        if (dead) closePos(p,"強制ロスカット");
        else if (wsDone) closePos(p,"方向不明（プラスマイナス3往復）");
        else if (fav >= MAXTP) closePos(p,"利確（MAX）");
        else if (fav <= -cf.sl) closePos(p,"損切り");
        else if (m.r5!=null && m.r1!=null && p.side*m.r5 <= -P.r5 && p.side*m.r1 < 0 && fav < 0.3) closePos(p,"反転");
        else if (now - p.ts > msMin(P.hold)) closePos(p,"時間切れ");
      }
      const MAXP = S.cfg.maxPos || P.maxPos;
      if (!S.running || S.positions.length >= MAXP) return;
      const held = new Set(S.positions.map(p=>p.sym)), cands = [];
      if (S.cfg.strategy === "trend"){
        for (const t of tokens.values()){
          const c = CDL[t.sym]; if (!c || !c.sig || c.sig.used) continue;
          if (now - c.sig.at > 10*60000){ c.sig.used = true; continue; }     // 15分足の確定から10分以内だけ有効
          if (held.has(t.sym) || !isFresh(t) || t.turn < TR_MIN_TURN) continue;
          if (S.cooldown[t.sym] && now - S.cooldown[t.sym] < 15*60000) continue;
          const m = metricsOf(t); if (m.spread > MAX_SPREAD) continue;
          if (bigTrend(t.sym) !== c.sig.dir) { c.sig.used = true; continue; }
          cands.push({t, e:{basic:true, dir:c.sig.dir>0?"long":"short", kind:"トレンド・"+TR_PATS[c.sig.pat], pat:c.sig.pat, score:1, m}, c});
        }
        for (const x of cands){ if (S.positions.length >= MAXP) break; x.c.sig.used = true; openPos(x.t, x.e); }
        return;
      }
      for (const t of tokens.values()){
        if (held.has(t.sym) || (!S.retry[t.sym] && S.cooldown[t.sym] && now - S.cooldown[t.sym] < msMin(P.cool))) continue;
        const e = evalEntry(t); if (!e.basic) continue;
        if (e.gateWhy){ if (!t.skipAt || now - t.skipAt > msMin(10)){ t.skipAt = now; S.skips++; addLog("RISK",baseOf(t.sym)+" 見送り: "+e.gateWhy,true); } continue; }
        cands.push({t,e});
      }
      cands.sort((a,b)=>b.e.score-a.e.score);
      for (const c of cands){ if (S.positions.length >= MAXP) break; openPos(c.t,c.e); }
    }
    let seq = 0;
    async function loop(){
      if (busy) return; busy = true; clearTimeout(timer);
      try{
        await pollTickers();
        S.polls++; lastPollAt = Date.now(); lastError = null; lastErrLogged = "";
        agentStep();
        S.hist.push({t:Date.now(),v:equity()}); if (S.hist.length>600) S.hist.shift();
        if (S.cfg.live && RELAY_URL && RELAY_TOKEN && Date.now()-lastLiveAccountAt > 15000) fetchLiveAccount().then(reconcileLive).catch(()=>{});
        persist();
      }catch(e){
        lastError = e.message;
        if (lastErrLogged !== e.message){ lastErrLogged = e.message; addLog("SYS","データ取得エラー: "+e.message,true); }
      }
      busy = false; onUpdate();
      timer = null;
    }

    function publicState(){
      const eq = equity(), now = Date.now(), held = new Set(S.positions.map(p=>p.sym)), P = PM();
      const rows = [...tokens.values()].filter(t=>t.px>0).map(t=>{
        const e = evalEntry(t), m = e.m;
        const status = held.has(t.sym) ? "held" : e.basic ? (e.gateWhy?"blocked":"ready") : "wait";
        const label = status==="ready" ? (e.dir==="long"?"買い候補":"売り候補") : status==="blocked" ? "見送り" : status==="held" ? "保有" : "–";
        const interest = Math.abs(m.r5||0)*Math.min(m.vrel||1,5) + Math.abs(t.chg1h||0)*0.1;
        return { mint:t.sym, symbol:baseOf(t.sym), dex:src==="bingx"?"BingX":"Bybit", url:src==="bingx"?"https://bingx.com/en/perpetual/"+t.sym:"https://www.bybit.com/trade/usdt/"+t.sym, px:t.px, pc5:m.r5==null?0:m.r5, pc1:t.chg1h==null?0:t.chg1h,
          taker:m.vrel==null?0:m.vrel, buys5:m.up, sells5:m.dn, liq:t.turn, mc:0, vol5:0, top10:null, vol:m.vol, down:m.adv, risk:m.risk, buyShare:m.buyShare,
          ageMin:null, status, label, dir:e.dir, why:e.gateWhy||e.why, score:e.score, interest, stale:!isFresh(t),
          pressTxt:"下げ "+m.dn+"回 ／ 上げ "+m.up+"回（直近30更新）", pressRight:"出来高×"+(m.vrel==null?"–":m.vrel.toFixed(1)),
          vit:[["価格","$"+px(t.px)],["5分",m.r5==null?"–":pct(m.r5,2)],["1時間",t.chg1h==null?"–":pct(t.chg1h)],["24時間",pct(t.chg24)],["出来高×（1分平均）",m.vrel==null?"–":m.vrel.toFixed(1)],["出来高×（瞬間）",m.instVrel==null?"–":m.instVrel.toFixed(1)],
            ["資金調達",(t.fr*100).toFixed(4)+"%"],["建玉(OI)",t.oi>0?money(t.oi):"–"],["24h売買代金",money(t.turn)],["スプレッド",(m.spread*100).toFixed(3)+"%"]] };
      });
      rows.sort((a,b)=>(b.status==="held")-(a.status==="held")||(b.status==="ready")-(a.status==="ready")||b.score-a.score||b.interest-a.interest);
      const watch = rows.slice(0,40), g = GATES[S.cfg.gate], warm = Math.max(0, Math.round(150*WARP - (now-bootTs)/1000));
      const dirL = {both:"ロング＋ショート",long:"ロングのみ",short:"ショートのみ"}[S.cfg.dir];
      return { kind:"perp", title:"先物 ロング/ショート（ペーパー）", colTaker:"出来高×", now, running:S.running, startUsd:START_USD, equity:eq, pnlUsd:eq-START_USD, cash:S.cash, cfg:S.cfg, gates:GATES,
        labels:{vol:"危険度・ボラ（激しさ）",down:"逆行リスク（過熱度）"},
        chips:[dirL+" ・ "+S.cfg.lev+"x", S.cfg.strategy==="fade" ? "逆張り（5分±"+S.cfg.fadeThresh+"%＋高値/安値から"+WICK_PCT+"%のヒゲ確認）" : S.cfg.strategy==="surge" ? "出来高急増（通常比×"+S.cfg.surgeThresh+"で瞬時に順張り）" : S.cfg.strategy==="dual" ? "併用：出来高急増（初動）＋逆張り（失速）" : S.cfg.strategy==="trend" ? "トレンド（4h/1hのEMA12・21・75・200で方向確認→15分足パターンで入る）" : "順張り", S.cfg.strategy==="trend" ? "資金管理: -"+TR_ADD+"%で1回追加・-"+TR_SL+"%固定損切り・+50%で4割／+70%で3割／+100%で全利確" : S.cfg.halfback ? "資金管理: 半戻し利確（-"+HB_ADD+"%で1回追加・-"+HB_SL+"%固定損切り）" : S.cfg.scalp ? "資金管理: 超高速スキャルピング（+$"+S.cfg.scalpTp+"利確・-$"+S.cfg.scalpSl+"損切り・"+S.cfg.scalpHold+"秒）" : "SL "+S.cfg.sl+"% ／ 利確 "+S.cfg.tp+"%","モード: "+(MODE_OPTS.find(o=>o.v===S.cfg.mode)||{l:""}).l,"ゲート: "+(g?g.label:"OFF")].concat(S.cfg.live?["実発注 ON（BingXデモ）"]:[]).concat(S.cfg.timeout?["時間切れ決済 "+S.cfg.timeout+"分"]:[]).concat(warm>0?["ウォームアップ中（あと約"+warm+"秒）"]:[]),
        stats:{trades:S.trades.length,wins:S.trades.filter(x=>x.pnlUsd>0).length,skips:S.skips,polls:S.polls,watching:tokens.size,events:S.events},
        health:{lastPollAt,lastError,pollMs:pollMs(),source:"open-api.bingx.com（リレー経由）"},
        positions:S.positions.map(p=>{ const t = tokens.get(p.sym), pxv = t?t.px:p.entry, un = unreal(p,t)-p.fundingPaid, m0 = p.margin0 || p.margin, cf = S.cfg;
          let rows;
          if (p.trend){
            const atA = k => p.entry*(1+p.side*k/100/p.lev);
            rows = [];
            rows.push({k:"tp"+(p.tpDone>=1?" hit":""), label:"利確1 +"+TR_TPS[0][0]+"%（4割）", px:atA(TR_TPS[0][0]), val:p.tpDone>=1?"済":"4割"});
            rows.push({k:"tp"+(p.tpDone>=2?" hit":""), label:"利確2 +"+TR_TPS[1][0]+"%（3割）", px:atA(TR_TPS[1][0]), val:p.tpDone>=2?"済":"3割"});
            rows.push({k:"tp", label:"利確3 +"+TR_TPS[2][0]+"%（残り全部）", px:atA(TR_TPS[2][0]), val:"全決済"});
            rows.push({k:"tr", label:(p.side>0?"買い建値":"売り建値")+"（平均）", px:p.entry, val:usd(p.margin)});
            if (!p.trAdded) rows.push({k:"sl", label:"再エントリー -"+TR_ADD+"%（1回のみ）", px:p.initEntry*(1-p.side*TR_ADD/100/p.lev), val:"同額を追加"});
            if (p.beOn) rows.push({k:"sl", label:"建値撤退（利確1の後）", px:p.bePx, val:"±0"});
            else rows.push({k:"sl", label:"損切り -"+TR_SL+"%（初回基準・固定）", px:p.slPriceFixed, val:"固定"});
            rows.push({k:"liq", label:"ロスカット", px:p.liq, val:"全損"});
          } else if (p.halfback){
            const bestPx = p.peak, best = p.side*(bestPx/p.entry-1)*100, halfPx = p.entry*(1+p.side*best/200);
            rows = [];
            rows.push({k:"tp", label:"ピーク（現在の最高値）", px:bestPx, val:pct(best,2)+" 到達"});
            rows.push({k:"tp", label:"半戻し利確ライン（ピーク追随・動く）", px:best>=HB_MIN_PEAK?halfPx:p.entry, val:best>=HB_MIN_PEAK?"有効":"ピークが+1%になるまで無効"});
            rows.push({k:"tr", label:(p.side>0?"買い建値":"売り建値")+"（現在）", px:p.entry, val:usd(p.margin)});
            if (!p.hbAdded) rows.push({k:"sl", label:"追加ライン -"+HB_ADD+"%（1回のみ）", px:p.entry*(1-p.side*HB_ADD/100/p.lev), val:"同額を追加"});
            rows.push({k:"sl", label:"固定損切り -"+HB_SL+"%（初回から不動）", px:p.slPriceFixed, val:"−"+usd(p.initMargin*HB_SL/100)});
            rows.push({k:"liq", label:"ロスカット", px:p.liq, val:"全損"});
          } else if (p.scalp){
            const pxTp = p.entry + p.side*(p.scalpTp/p.qty), pxSl = p.entry - p.side*(p.scalpSl/p.qty);
            rows = [];
            rows.push({k:"tp", label:"利確 +$"+p.scalpTp.toFixed(0), px:pxTp, val:"+$"+p.scalpTp.toFixed(0)});
            rows.push({k:"tr", label:(p.side>0?"買い建値":"売り建値"), px:p.entry, val:usd(p.margin)});
            rows.push({k:"sl", label:"損切り -$"+p.scalpSl.toFixed(0), px:pxSl, val:"−$"+p.scalpSl.toFixed(0)});
            rows.push({k:"liq", label:"保有時間切れ（"+p.scalpHold+"秒）", px:p.entry, val:"—"});
            rows.push({k:"liq", label:"ロスカット", px:p.liq, val:"全損"});
          } else {
            const at = k => p.entry*(1+p.side*cf.tp*k/100);
            rows = [];
            rows.push({k:"tp",label:"利確 "+cf.tp+"%",px:at(1),val:"+"+usd(p.notional*cf.tp/100)});
            rows.push({k:"tr",label:(p.side>0?"買い建値":"売り建値"),px:p.entry,val:usd(p.margin)});
            rows.push({k:"sl",label:"損切り "+cf.sl+"%",px:p.entry*(1-p.side*cf.sl/100),val:"−"+usd(p.notional*cf.sl/100)});
            rows.push({k:"liq",label:"ロスカット",px:p.liq,val:"全損"});
          }
          return { mint:p.sym, symbol:baseOf(p.sym), side:p.side>0?"long":"short", lev:p.lev, qty:p.qty, costUsd:p.margin, valueUsd:p.margin+un, retPct:((p.realizedNet||0)+un)/m0*100, entryPx:p.entry, px:pxv, ts:p.ts, rows }; }),
        watch, trades:S.trades.slice(0,100), log:S.log.slice(0,60), errors:(S.errors||[]).slice(0,30), calendar:calendarStats(), hist:S.hist.slice(-300).map(h=>h.v), startedAt:S.startedAt,
        ctl:[
          {key:"mode",label:"アクティブ度",opts:MODE_OPTS,val:S.cfg.mode},
          {key:"dir",label:"方向",opts:[{l:"両方",v:"both"},{l:"ロングのみ",v:"long"},{l:"ショートのみ",v:"short"}],val:S.cfg.dir},
          {key:"strategy",label:"戦略",opts:[{l:"順張り",v:"momentum"},{l:"出来高急増（瞬間検知）",v:"surge"},{l:"逆張り（行き過ぎ狩り）",v:"fade"},{l:"併用（急増＋失速の両方）",v:"dual"},{l:"トレンド（4h/1h＋15分足）",v:"trend"}],val:S.cfg.strategy},
          {key:"fadeThresh",label:"逆張りのしきい値（5分変化）",opts:ALLOW.fadeThresh.map(v=>({l:"±"+v+"%",v})),val:S.cfg.fadeThresh},
          {key:"surgeThresh",label:"出来高急増のしきい値（通常比）",opts:ALLOW.surgeThresh.map(v=>({l:"×"+v,v})),val:S.cfg.surgeThresh},
          {key:"lev",label:"レバレッジ",opts:ALLOW.lev.map(v=>({l:v+"x",v})),val:S.cfg.lev},
          {key:"size",label:"1回の証拠金（評価額比）",opts:ALLOW.size.map(v=>({l:Math.round(v*100)+"%",v})),val:S.cfg.size},
          {key:"sl",label:"損切り（価格の逆行）",opts:ALLOW.sl.map(v=>({l:v+"%",v})),val:S.cfg.sl},
          {key:"tp",label:"MAX利確（価格の順行）",opts:ALLOW.tp.map(v=>({l:v+"%",v})),val:S.cfg.tp},
          {key:"gate",label:"リスクゲート",opts:GATE_OPTS,val:S.cfg.gate},
          {key:"scale",label:"リスク連動サイズ",opts:YN,val:S.cfg.scale},
          {key:"live",label:"BingXデモへ実発注",opts:YN,val:S.cfg.live},
          {key:"halfback",label:"資金管理: 半戻し利確（-15%で1回追加・-32%固定損切り）",opts:YN,val:S.cfg.halfback},
          {key:"scalp",label:"資金管理: 超高速スキャルピング（$固定利確・損切り）",opts:YN,val:S.cfg.scalp},
          {key:"scalpTp",label:"スキャルピング利確（$）",opts:ALLOW.scalpTp.map(v=>({l:"$"+v,v})),val:S.cfg.scalpTp},
          {key:"scalpSl",label:"スキャルピング損切り（$）",opts:ALLOW.scalpSl.map(v=>({l:"$"+v,v})),val:S.cfg.scalpSl},
          {key:"scalpHold",label:"スキャルピング保有時間上限",opts:ALLOW.scalpHold.map(v=>({l:v+"秒",v})),val:S.cfg.scalpHold},
          {key:"maxPos",label:"最大同時保有数",opts:ALLOW.maxPos.map(v=>({l:v+"件",v})),val:S.cfg.maxPos},
          {key:"orphan",label:"BingXにだけあるポジションを自動決済",opts:YN,val:S.cfg.orphan},
          {key:"timeout",label:"時間切れ決済（含み益に届かず、マイナスのまま）",opts:[{l:"OFF",v:0},{l:"30分",v:30},{l:"1時間",v:60},{l:"3時間",v:180},{l:"6時間",v:360}],val:S.cfg.timeout}
        ],
        liveNote:"実発注は、アプリのペーパーと同じ数量（"+S.cfg.lev+"x）で、接続設定のリレー経由でBingXデモ口座に送信します。リレー未設定の場合はONにできません。",
        liveAccount: S.cfg.live ? { data: liveAccount, err: liveAccountErr, updatedAt: lastLiveAccountAt } : null,
        pdca: epochStats(), sig: sigSummaryCached(),
        foot:(S.cfg.strategy==="trend"
          ? ("戦略: トレンド（"+S.cfg.lev+"x）。4時間足と1時間足の両方で、EMA21＞EMA75＞EMA200かつ終値がEMA75より上ならロング方向（逆ならショート方向）と判定します。その向きで、15分足が確定した瞬間に、ダブルトップ/ボトム・三尊/逆三尊・EMA21への押し目/戻り・ブレイク＆リテスト・包み足・ピンバーのどれかが出ていれば入ります。対象は24時間売買代金$5M以上の銘柄です。損益の%は証拠金に対する割合で、-"+TR_ADD+"%で同額を1回だけ追加、損切りは初回エントリー基準の-"+TR_SL+"%に固定（追加しても動きません）。平均建値から+50%で4割、+70%で3割、+100%で残り全部を利確します。この3つの利確注文はBingX側にも置き、+50%の利確後は損切りを建値（手数料ぶん有利側）へ移します。時間切れ決済の対象外です。手数料は片道"+(FEEF()*100).toFixed(3)+"%で概算。実際の取引所とは異なり、この戦略に優位性があるとは限りません。")
          : S.cfg.halfback
          ? ("資金管理: 半戻し利確（固定ルール・"+S.cfg.lev+"x）。出来高急増を検知した瞬間にその方向へ乗ります。証拠金維持率-"+HB_ADD+"%まで逆行したら、初期と同じサイズを1回だけ追加します。損切りラインは、初回エントリー時点を基準に証拠金維持率-"+HB_SL+"%の位置に固定し、追加しても動きません。利確は、その時点までの最高値（安値）を記録し、そこから伸びた分の半分まで戻ってきた時点で、残り全部を利確します。回転重視のため保有時間の上限はありません。手数料は片道"+(FEEF()*100).toFixed(3)+"%、強制ロスカットは維持証拠金率0.5%で概算。実際の取引所の約定・ロスカットとは異なります。")
          : S.cfg.scalp
          ? ("資金管理: 超高速スキャルピング（固定ルール・"+S.cfg.lev+"x）。含み益が+$"+S.cfg.scalpTp+"に届いたら利確、含み損が-$"+S.cfg.scalpSl+"に届いたら損切り、どちらも届かないまま"+S.cfg.scalpHold+"秒たったら、その時点の損益で強制決済します。1回あたりの証拠金・レバレッジに関係なく、常に固定の金額で判定します。手数料は片道"+(FEEF()*100).toFixed(3)+"%、強制ロスカットは維持証拠金率0.5%で概算。実際の取引所の約定・ロスカットとは異なります。")
          : S.cfg.strategy==="dual"
          ? ("戦略「併用」は、出来高急増（初動に飛び乗る）と逆張り（行き過ぎの失速を狩る）を、同時に別々の銘柄で走らせます。ある銘柄で急な出来高が出た瞬間はそちらへ、別の銘柄が伸びきって失速したときはそちらへ、と両方の候補を毎回まとめて評価し、同時保有数（"+(PERP_MODE[S.cfg.mode]||PERP_MODE.active).maxPos+"件）の範囲でスコアの高い方から採用します。手数料は片道"+(FEEF()*100).toFixed(3)+"%、資金調達は保有中に連続的に概算、強制ロスカットは維持証拠金率0.5%で概算。実際の取引所とは異なります。レバレッジ取引は元本以上の損失に至ることがあり、この戦略に優位性があるとは限りません。")
          : "BingX公開データ（USDT無期限先物）で判定。戦略「出来高急増」は、直近のポーリング間隔（"+Math.round(pollMs()/1000)+"秒程度）だけを見た出来高の急増（通常ペースの何倍か）を検知し、価格がその方向にわずかでも動いていれば、その瞬間に順張りでエントリーします。手数料は片道"+(FEEF()*100).toFixed(3)+"%、資金調達は保有中に連続的に概算、強制ロスカットは維持証拠金率0.5%で概算。実際の取引所の約定・ロスカット・資金調達とは異なります。レバレッジ取引は元本以上の損失に至ることがあり、この戦略に優位性があるとは限りません。") };
    }
    const EPOCH_KEYS = ["mode","dir","strategy","fadeThresh","surgeThresh","lev","size","sl","tp","gate","scale","halfback","scalp","scalpTp","scalpSl","scalpHold","maxPos","timeout"];
    function cfgSnapshot(){ const o={}; EPOCH_KEYS.forEach(k=>o[k]=S.cfg[k]); return o; }
    function currentEpoch(){ return (S.epochs && S.epochs[0]) || null; }
    function tradesSince(ts, until){ return S.trades.filter(t=>t.exitTs>=ts && t.exitTs<until); }
    function noteEpoch(){
      const ep = currentEpoch(), now = Date.now();
      if (!ep){ S.epochs = [{id:now, startedAt:now, slot:"main", cfg:cfgSnapshot()}]; return; }
      if (tradesSince(ep.startedAt, now).length === 0){ ep.cfg = cfgSnapshot(); return; } // まだ何も約定していない設定は上書き（無駄なエポックを作らない）
      S.epochs.unshift({id:now, startedAt:now, slot:"main", cfg:cfgSnapshot()});
      if (S.epochs.length > 20) S.epochs.length = 20;
    }
    function calendarStats(){
      const dKeys = Object.keys(S.pnlDaily).sort();
      let run = 0; const dRows = dKeys.map(k => { run += S.pnlDaily[k]; return {key:k, pnl:S.pnlDaily[k], cum:run}; });
      const monthly = {}; dKeys.forEach(k => { const mk = k.slice(0,7); monthly[mk] = (monthly[mk]||0) + S.pnlDaily[k]; });
      const mKeys = Object.keys(monthly).sort();
      run = 0; const mRows = mKeys.map(k => { run += monthly[k]; return {key:k, pnl:monthly[k], cum:run}; });
      const yearly = {}; dKeys.forEach(k => { const yk = k.slice(0,4); yearly[yk] = (yearly[yk]||0) + S.pnlDaily[k]; });
      const yKeys = Object.keys(yearly).sort();
      run = 0; const yRows = yKeys.map(k => { run += yearly[k]; return {key:k, pnl:yearly[k], cum:run}; });
      return { daily: dRows.slice().reverse(), monthly: mRows.slice().reverse(), yearly: yRows.slice().reverse() };
    }
    function epochStats(){
      const eps = S.epochs || [];
      return eps.map((ep,i) => {
        const end = i===0 ? Date.now() : eps[i-1].startedAt;
        const trades = tradesSince(ep.startedAt, end);
        const wins = trades.filter(t=>t.pnlUsd>0).length;
        const pnl = trades.reduce((s,t)=>s+t.pnlUsd,0);
        return { id:ep.id, startedAt:ep.startedAt, slot:ep.slot||"main", cfg:ep.cfg, n:trades.length, wins, pnl, winRate: trades.length ? Math.round(wins/trades.length*1000)/10 : null };
      });
    }
    function handleCmd(b){
      const c = b.cmd;
      if (c==="pause"){ S.running = false; addLog("SYS","新規エントリーを停止"); }
      else if (c==="resume"){ S.running = true; addLog("SYS","新規エントリーを再開"); }
      else if (c==="close"){ for (const p of [...S.positions]) closePos(p,"手動クローズ"); }
      else if (c==="closeOne" && b.mint){ const p = S.positions.find(x=>x.sym===b.mint); if (p) closePos(p,"手動クローズ"); }
      else if (c==="reset"){ const cfg = S.cfg; S = fresh(); S.cfg = cfg; noteEpoch(); addLog("SYS","セッションをリセット（ペーパー）"); }
      else if (c==="sigReset"){ sigResetAll(); addLog("SYS","シグナル検証の記録をリセット"); }
      else if (c==="cfg" && b.cfg){
        let changed = false;
        for (const k of Object.keys(b.cfg)) if (ALLOW[k] && ALLOW[k].includes(b.cfg[k])){
          if (k==="live" && b.cfg[k]===true && (!RELAY_URL || !RELAY_TOKEN)){ addLog("SYS","実発注をONにするには、接続設定でリレーURLとトークンを入力してください。",true); continue; }
          if (S.cfg[k] !== b.cfg[k]) changed = true;
          S.cfg[k] = b.cfg[k];
          if (k==="scalp" && b.cfg[k]===true) S.cfg.halfback = false; // 資金管理モードは1つだけ
          if (k==="halfback" && b.cfg[k]===true) S.cfg.scalp = false;
          if (k==="live") addLog("SYS","BingXデモへの実発注を "+(b.cfg[k]?"ON":"OFF")+" にしました",true);
        }
        if (changed) noteEpoch();
      }
      persist();
    }
    function setSource(v){
      if (v !== "bingx" && v !== "bybit") return;
      if (v === src) return;
      for (const p of [...S.positions]) closePos(p,"データ元変更");
      src = v; store.set(SRCKEY, v); tokens.clear(); lastError = null; lastErrLogged = "";
      addLog("SYS","先物データ元を "+(v==="bingx"?"BingX":"Bybit")+" に変更",true); persist(); loop();
    }
    return { kind:"perp", publicState, handleCmd, setSource, getSource:()=>src, test:{relay, fetchLiveAccount},
      start(cb){ onUpdate = cb; load(); if (!S.epochs || !S.epochs.length) noteEpoch(); const gap = Date.now() - (S.lastPollAt || Date.now());
        if (S.positions.length && gap > 60e3) addLog("SYS","前回の終了から約"+Math.max(1,Math.round(gap/60000))+"分経過。保有中のポジションはこの間の損切り・利確・ロスカットが判定されていません。",true);
        },
      kick(){ const gap = Date.now() - (lastPollAt || S.lastPollAt || Date.now()); if (gap > pollMs()*3 && S.positions.length) addLog("SYS","約"+Math.max(1,Math.round(gap/60000))+"分間、画面が非表示で更新が止まっていました。この間の損切り・利確・ロスカットは判定されていません。",true); loop(); },
      applyConn(){ loop(); }, tick(){ return loop(); }, pollMs(){ return pollMs(); }, equity(){ return equity(); }, note(tag,msg){ addLog(tag,msg,true); persist(); } };
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
      SRV = Object.assign({enabled:false, dailyStop:50, liveMax:5, dayKey:null, dayStartEquity:null, stoppedDay:null, lastTickAt:0}, MEM.get("srv") ? JSON.parse(MEM.get("srv")) : {});
      LIVE_MAX = SRV.liveMax;
      ENGINE = makePerp();
      ENGINE.start(()=>{});
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
        if (b.liveMax > 0){ SRV.liveMax = +b.liveMax; LIVE_MAX = SRV.liveMax; }
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
