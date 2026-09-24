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
  const placed = [], errors = [];
  const place = async (which, type, price) => {
    try {
      await bingxRequest(env, "POST", "/openApi/swap/v2/trade/order", {
        symbol: sym, side: closeSide, positionSide: b.positionSide,
        type, quantity: b.quantity, stopPrice: price, workingType: "MARK_PRICE",
      });
      placed.push(which);
    } catch (e) {
      errors.push({ which, detail: e.body || e.message || String(e) });
    }
  };
  if (b.slPrice) await place("sl", "STOP_MARKET", b.slPrice);
  if (b.tpPrice) await place("tp", "TAKE_PROFIT_MARKET", b.tpPrice);
  return { demo: isDemo, placed, errors };
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
  const MODE_OPTS = [{l:"控えめ",v:"calm"},{l:"標準",v:"normal"},{l:"積極",v:"active"}];
  const YN = [{l:"OFF",v:false},{l:"ON",v:true}];
  const GATE_OPTS = [{l:"OFF",v:"off"},{l:"標準",v:"std"},{l:"厳しめ",v:"strict"}];
  const LADDER_OPTS = [{l:"OFF",v:false},{l:"3分割",v:true}];
  const BE_OPTS = [{l:"OFF",v:"off"},{l:"TP1後",v:"tp1"},{l:"TP2後",v:"tp2"}];
  const beLabel = v => v==="tp1" ? "建値撤退: TP1後" : v==="tp2" ? "建値撤退: TP2後" : "建値撤退: OFF";

  function makePerp(){
    const PERP_MODE = {
      calm:   {poll:15000, r1:0.30, r5:1.0, vrel:2.0, maxPos:2, cool:10, hold:60, minTurn:3e6},
      normal: {poll:10000, r1:0.20, r5:0.7, vrel:1.6, maxPos:3, cool:5,  hold:30, minTurn:1.5e6},
      active: {poll:6000,  r1:0.10, r5:0.4, vrel:1.3, maxPos:5, cool:2,  hold:15, minTurn:8e5}
    };
    const MMR = 0.005, MAX_SPREAD = 0.0015;
    const FEEF = () => src === "bingx" ? 0.0005 : 0.00055;
    const GATES = { off:null, std:{risk:65,label:"標準"}, strict:{risk:50,label:"厳しめ"} };
    const ALLOW = {mode:["calm","normal","active"],dir:["both","long","short"],lev:[1,2,3,5,8,10,20],size:[0.04,0.05,0.1,0.2],sl:[0.8,1.25,1.5,3,5],tp:[1,1.25,2,4,8],trail:[true,false],gate:["off","std","strict"],scale:[true,false],ladder:[true,false],be:["off","tp1","tp2"],live:[true,false],strategy:["momentum","fade","surge","dual"],fadeThresh:[3,5,8],surgeThresh:[3,5,10],pyramid:[true,false],halfback:[true,false]};
    const PM = () => PERP_MODE[S.cfg.mode] || PERP_MODE.active;
    const pollMs = () => POLL_OVERRIDE || PM().poll;

    function fresh(){
      return { startedAt:Date.now(), running:true, cash:START_USD, positions:[], trades:[], log:[], errors:[], hist:[{t:Date.now(),v:START_USD}],
        skips:0, polls:0, events:0, logSeq:0, lastPollAt:0, cooldown:{}, retry:{}, epochs:[], pnlDaily:{},
        slots:[{id:"main", label:"メイン"}], // 将来「サブ」を足すための下ごしらえ。今はmainだけを使う
        cfg:{mode:"active",dir:"both",lev:8,size:0.04,sl:1.5,tp:3,trail:true,gate:"std",scale:true,ladder:true,be:"tp2",live:false,strategy:"surge",fadeThresh:5,surgeThresh:5,pyramid:false,halfback:true} };
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
      const capQty = LIVE_MAX*p.lev/p.entry;
      if (rawQty > capQty) addLog("LIVE", baseOf(p.sym)+": アプリの数量が実発注の上限（証拠金 $"+LIVE_MAX.toFixed(2)+"）を超えるため、上限まで縮小して発注します", true);
      return floorTo(Math.min(rawQty, capQty), precQty);
    }
    async function liveOpen(p){
      if (!S.cfg.live) return;
      const base = baseOf(p.sym);
      try{
        const prec = await getPrecision(base);
        const qty = liveQty(p.qty, p, prec.qty);
        if (!(qty>0)){ addLog("LIVE",base+": 実発注スキップ（数量が最小単位未満）",true); p.live = null; return; }
        try{ await relay("/leverage","POST",{symbol:base+"USDT", side:p.side>0?"LONG":"SHORT", leverage:p.lev}); }
        catch(err){ addLog("LIVE",base+" レバレッジ "+p.lev+"x の設定に失敗（"+err.message+"）。BingX側の現在の設定のまま発注します",true); }
        const j = await relay("/order","POST",{symbol:base+"USDT", side:p.side>0?"BUY":"SELL", positionSide:p.side>0?"LONG":"SHORT", quantity:qty});
        p.live = {qty, prec:prec.qty, status:"open"};
        const fillPx = parseFloat(j.result && j.result.data && j.result.data.avgPrice) || p.entry;
        addLog("LIVE",base+" 実発注: "+(p.side>0?"ロング":"ショート")+" "+qty+"（BingXデモ）",true);
        // 利確・損切りを、実際の約定価格を基準にBingX側へも置く（画面を閉じても取引所側で発動する）
        // 価格にも数量と同じく「小数点以下は何桁まで」という決まりがあるため、それに合わせて丸める
        const slPct = p.pyramid ? PYR_SL/100/p.lev : p.halfback ? HB_SL/100/p.lev : S.cfg.sl/100;
        const tpPct = (p.pyramid || p.halfback) ? null : S.cfg.tp/100; // ピラミッド式・半戻し利確は決済ラインが動くので、単発のTP注文は置かない（SLのみ）
        const slPrice = floorTo(fillPx*(1 - p.side*slPct), prec.price);
        const tpPrice = tpPct!=null ? floorTo(fillPx*(1 + p.side*tpPct), prec.price) : null;
        try{
          const br = await relay("/bracket-only","POST",{symbol:base+"USDT", positionSide:p.side>0?"LONG":"SHORT", quantity: qty, slPrice: String(slPrice), tpPrice: tpPrice!=null?String(tpPrice):undefined});
          if (br.errors && br.errors.length) addLog("LIVE",base+" 利確/損切り注文の一部に失敗: "+br.errors.map(e=>e.which+"（"+(typeof e.detail==="string"?e.detail:JSON.stringify(e.detail))+"）").join(", "),true);
          else addLog("LIVE",base+" BingX側に損切り"+(tpPrice!=null?"・利確":"")+"を設置（画面を閉じても発動）",true);
        }catch(err){ addLog("LIVE",base+" 利確/損切り注文の設置に失敗: "+err.message,true); }
      }catch(err){ p.live = null; addLog("LIVE",base+" 実発注に失敗: "+err.message,true); }
    }
    async function liveClose(p, frac, label){
      if (!p.live || p.live.status!=="open") return;
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
      }catch(err){ addLog("LIVE",base+" 実決済に失敗（"+label+"）: "+err.message,true); }
    }
    const PYR_SL = 35, PYR_ADD1 = 20, PYR_ADD2 = 28, PYR_TP1 = 40, PYR_TP2 = 70, PYR_TP3 = 100, PYR_STEP = 20, PYR_MAX_ADD2 = 3, PYR_MAX_RETRY = 8;
    const HB_ADD = 15, HB_SL = 32, HB_MIN_PEAK = 1.0; // 半戻し利確: -15%で1回だけ追加、-32%で固定損切り、ピークが+1%以上ついたら半戻し判定を有効化
    function openPos(t,e){
      let margin = Math.min(S.cash*0.98, equity()*S.cfg.size);
      if (S.cfg.scale && !S.cfg.pyramid && !S.cfg.halfback) margin *= clamp(1 - e.m.risk/150, 0.4, 1);
      if (margin < 5) return false;
      const lev = S.cfg.lev, N = margin*lev, side = e.dir==="long" ? 1 : -1;
      const base = side>0 ? (t.ask||t.px) : (t.bid||t.px), fill = base*(1 + side*impactOf(t,side,N)), fee = N*FEEF();
      S.cash -= margin + fee;
      const liq = side>0 ? fill*(1-1/lev+MMR) : fill*(1+1/lev-MMR);
      const posObj = {sym:t.sym, side, lev, margin, margin0:margin, notional:N, qty:N/fill, origQty:N/fill, entry:fill, liq, ts:Date.now(), peak:fill, fundingPaid:0, feeOpen:fee, lastFund:Date.now(), kind:e.kind, slot:"main", realizedNet:0, tpHit:0, beOn:false, live:null, wsSign:null, wsCrosses:0};
      if (S.cfg.pyramid){
        posObj.pyramid = true; posObj.initEntry = fill; posObj.initMargin = margin;
        posObj.slPriceFixed = side>0 ? fill*(1-PYR_SL/100/lev) : fill*(1+PYR_SL/100/lev);
        posObj.phase1Adds = 0; posObj.phase2Adds = 0; posObj.tp1Done = false; posObj.tp2Done = false; posObj.beActive = false; posObj.bePrice = null; posObj.peak2 = null;
      } else if (S.cfg.halfback){
        posObj.halfback = true; posObj.initEntry = fill; posObj.initMargin = margin;
        posObj.slPriceFixed = side>0 ? fill*(1-HB_SL/100/lev) : fill*(1+HB_SL/100/lev);
        posObj.hbAdded = false;
      }
      S.positions.push(posObj);
      liveOpen(posObj);
      S.events++;
      addLog("TRADE",baseOf(t.sym)+" "+(side>0?"ロング":"ショート")+" "+lev+"x（"+e.kind+"）証拠金 $"+margin.toFixed(2)+" ／ 5分 "+pct(e.m.r5,2)+" 出来高×"+e.m.vrel.toFixed(1),true);
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
        addLog("LIVE",base+" 追加の実発注: "+qty+"（BingXデモ）",true);
      }catch(err){ addLog("LIVE",base+" 追加発注に失敗: "+err.message,true); }
    }
    function addPyramid(p,label){
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
    function pyramidCheck(p,t,now){
      const levPct = p.side*(t.px/p.entry - 1)*100*p.lev;
      if ((p.side>0 && t.px<=p.liq) || (p.side<0 && t.px>=p.liq)){ closePos(p,"強制ロスカット"); return; }
      const slHit = p.side>0 ? t.px<=p.slPriceFixed : t.px>=p.slPriceFixed;
      if (slHit){ closePos(p,"損切り（初期固定 -"+PYR_SL+"%）"); return; }
      if (whipsawHit(p, levPct, 8, now)){ closePos(p,"方向不明（プラスマイナス3往復）"); return; }
      if (!p.tp1Done){
        if (p.phase1Adds===0 && levPct<=-PYR_ADD1){ addPyramid(p,"証拠金維持率-"+PYR_ADD1+"%"); p.phase1Adds=1; }
        else if (p.phase1Adds===1 && levPct<=-PYR_ADD2){ addPyramid(p,"証拠金維持率-"+PYR_ADD2+"%"); p.phase1Adds=2; }
        if (levPct>=PYR_TP1){ partial(p,0.3,"TP1(+"+PYR_TP1+"%)"); p.tp1Done=true; }
        return;
      }
      if (!p.tp2Done){
        if (levPct>=PYR_TP2){ partial(p,0.49,"TP2(+"+PYR_TP2+"%)"); p.tp2Done=true; p.beActive=true; p.bePrice=t.px; p.peak2=levPct; }
        return;
      }
      p.peak2 = Math.max(p.peak2, levPct);
      if (p.beActive){
        const beHit = p.side>0 ? t.px<=p.bePrice : t.px>=p.bePrice;
        if (beHit){ closePos(p,"最終決済（TP2水準）"); return; }
      }
      if (p.phase2Adds<PYR_MAX_ADD2 && (p.peak2-levPct) >= PYR_STEP*(p.phase2Adds+1)){
        addPyramid(p,"TP2後-"+PYR_STEP+"%逆行×"+(p.phase2Adds+1));
        p.phase2Adds++; // 最終決済ラインはTP2到達時の価格に固定。追加しても動かさない
      }
      if (levPct>=PYR_TP3){ closePos(p,"利確（TP3 +"+PYR_TP3+"%）"); return; }
    }
    function halfbackCheck(p,t,now){
      if ((p.side>0 && t.px<=p.liq) || (p.side<0 && t.px>=p.liq)){ closePos(p,"強制ロスカット"); return; }
      const slHit = p.side>0 ? t.px<=p.slPriceFixed : t.px>=p.slPriceFixed;
      if (slHit){ closePos(p,"損切り（初期固定 -"+HB_SL+"%）"); return; }
      if (whipsawHit(p, p.side*(t.px/p.entry-1)*100*p.lev, 8, now)){ closePos(p,"方向不明（プラスマイナス3往復）"); return; }
      if (!p.hbAdded){
        const levPct = p.side*(t.px/p.entry - 1)*100*p.lev;
        if (levPct<=-HB_ADD){ addPyramid(p,"証拠金維持率-"+HB_ADD+"%"); p.hbAdded=true; }
      }
      p.peak = p.side>0 ? Math.max(p.peak,t.px) : Math.min(p.peak,t.px);
      const fav = p.side*(t.px/p.entry-1)*100, best = p.side*(p.peak/p.entry-1)*100;
      if (best >= HB_MIN_PEAK && fav <= best/2){ closePos(p,"利確（半戻し）"); return; }
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
      const why = (p.tpHit>0 && !reason.startsWith("利確")) ? reason+"（TP"+p.tpHit+"済）" : reason;
      S.trades.unshift({symbol:baseOf(p.sym),mint:p.sym,side:p.side>0?"long":"short",lev:p.lev,entryTs:p.ts,exitTs:Date.now(),pnlUsd:pnl,pct:pnl/m0*100,reason:why,kind:p.kind,slot:p.slot||"main"});
      if (S.trades.length>100) S.trades.pop();
      S.cooldown[p.sym] = Date.now(); S.events++;
      if (p.pyramid && reason.indexOf("初期固定")>=0){
        const n = (S.retry[p.sym]||0)+1;
        if (n <= PYR_MAX_RETRY){ S.retry[p.sym] = n; delete S.cooldown[p.sym]; addLog("SYS",baseOf(p.sym)+" 固定損切りで再エントリー待機なし（"+n+"/"+PYR_MAX_RETRY+"回目）",true); }
        else { addLog("SYS",baseOf(p.sym)+" 再エントリーの上限（"+PYR_MAX_RETRY+"回）に達したため、通常のクールダウンに戻します",true); }
      } else if (p.pyramid && S.retry[p.sym]){ delete S.retry[p.sym]; }
      addLog("TRADE",baseOf(p.sym)+" "+(p.side>0?"ロング":"ショート")+" 決済（"+why+"） "+(pnl>=0?"+":"−")+"$"+Math.abs(pnl).toFixed(2),true);
    }
    function accrueFunding(){
      const now = Date.now();
      for (const p of S.positions){ const t = tokens.get(p.sym), dt = (now-p.lastFund)/1000; p.lastFund = now; if (t && dt>0 && dt<3600) p.fundingPaid += p.side*t.fr*p.notional*dt/(8*3600); }
    }
    function agentStep(){
      const now = Date.now(), P = PM(), cf = S.cfg, MAXTP = cf.tp;
      accrueFunding();
      for (const p of [...S.positions]){
        const t = tokens.get(p.sym); if (!t || !isFresh(t)) continue;
        if (p.pyramid){ pyramidCheck(p,t,now); continue; }
        if (p.halfback){ halfbackCheck(p,t,now); continue; }
        p.peak = p.side>0 ? Math.max(p.peak,t.px) : Math.min(p.peak,t.px);
        const fav = p.side*(t.px/p.entry-1)*100, best = p.side*(p.peak/p.entry-1)*100, m = metricsOf(t);
        const dead = (p.side>0 && t.px<=p.liq) || (p.side<0 && t.px>=p.liq);
        const wsThresh = Math.max(0.15, cf.sl*0.35);
        const wsDone = !dead && whipsawHit(p, fav, wsThresh, now);
        if (!dead && !wsDone && cf.ladder){
          if (p.tpHit<1 && fav >= MAXTP/3){ partial(p,1/3,"TP1"); p.tpHit = 1; }
          if (p.tpHit<2 && fav >= MAXTP*2/3){ partial(p,1/3,"TP2"); p.tpHit = 2; }
        }
        if ((cf.be==="tp1" && p.tpHit>=1) || (cf.be==="tp2" && p.tpHit>=2)) p.beOn = true;
        const trailOn = cf.trail && (!cf.ladder || p.tpHit>=1);
        if (dead) closePos(p,"強制ロスカット");
        else if (wsDone) closePos(p,"方向不明（プラスマイナス3往復）");
        else if (fav >= MAXTP) closePos(p,"利確（"+(cf.ladder?"TP3/MAX":"MAX")+"）");
        else if (p.beOn && fav <= 0) closePos(p,"建値撤退");
        else if (!p.beOn && fav <= -cf.sl) closePos(p,"損切り");
        else if (trailOn && best >= Math.max(0.8,MAXTP*0.4) && (best-fav) >= Math.max(0.5,MAXTP*0.25)) closePos(p,"トレーリング");
        else if (m.r5!=null && m.r1!=null && p.side*m.r5 <= -P.r5 && p.side*m.r1 < 0 && fav < 0.3) closePos(p,"反転");
        else if (now - p.ts > msMin(P.hold)) closePos(p,"時間切れ");
      }
      if (!S.running || S.positions.length >= P.maxPos) return;
      const held = new Set(S.positions.map(p=>p.sym)), cands = [];
      for (const t of tokens.values()){
        if (held.has(t.sym) || (!S.retry[t.sym] && S.cooldown[t.sym] && now - S.cooldown[t.sym] < msMin(P.cool))) continue;
        const e = evalEntry(t); if (!e.basic) continue;
        if (e.gateWhy){ if (!t.skipAt || now - t.skipAt > msMin(10)){ t.skipAt = now; S.skips++; addLog("RISK",baseOf(t.sym)+" 見送り: "+e.gateWhy,true); } continue; }
        cands.push({t,e});
      }
      cands.sort((a,b)=>b.e.score-a.e.score);
      for (const c of cands){ if (S.positions.length >= P.maxPos) break; openPos(c.t,c.e); }
    }
    let seq = 0;
    async function loop(){
      if (busy) return; busy = true; clearTimeout(timer);
      try{
        await pollTickers();
        S.polls++; lastPollAt = Date.now(); lastError = null; lastErrLogged = "";
        agentStep();
        S.hist.push({t:Date.now(),v:equity()}); if (S.hist.length>600) S.hist.shift();
        if (S.cfg.live && RELAY_URL && RELAY_TOKEN && Date.now()-lastLiveAccountAt > 15000) fetchLiveAccount();
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
        chips:[dirL+" ・ "+S.cfg.lev+"x", S.cfg.strategy==="fade" ? "逆張り（5分±"+S.cfg.fadeThresh+"%＋高値/安値から"+WICK_PCT+"%のヒゲ確認）" : S.cfg.strategy==="surge" ? "出来高急増（通常比×"+S.cfg.surgeThresh+"で瞬時に順張り）" : S.cfg.strategy==="dual" ? "併用：出来高急増（初動）＋逆張り（失速）" : "順張り", S.cfg.halfback ? "資金管理: 半戻し利確（-"+HB_ADD+"%で1回追加・-"+HB_SL+"%固定損切り）" : S.cfg.pyramid ? "資金管理: ピラミッド式" : (S.cfg.ladder ? "SL "+S.cfg.sl+"% ／ TP "+(S.cfg.tp/3).toFixed(2)+"/"+(S.cfg.tp*2/3).toFixed(2)+"/"+S.cfg.tp+"%" : "SL "+S.cfg.sl+"% ／ 利確 "+S.cfg.tp+"%"), beLabel(S.cfg.be),"モード: "+(MODE_OPTS.find(o=>o.v===S.cfg.mode)||{l:""}).l+(S.cfg.trail?" ・ トレーリング":""),"ゲート: "+(g?g.label:"OFF")].concat(S.cfg.live?["実発注 ON（BingXデモ）"]:[]).concat(warm>0?["ウォームアップ中（あと約"+warm+"秒）"]:[]),
        stats:{trades:S.trades.length,wins:S.trades.filter(x=>x.pnlUsd>0).length,skips:S.skips,polls:S.polls,watching:tokens.size,events:S.events},
        health:{lastPollAt,lastError,pollMs:pollMs(),source:(src==="bingx"?BINGX:BYBIT).replace(/^https?:\/\//,"")+(src==="bingx"&&RELAY_URL&&RELAY_TOKEN?"（リレー経由）":PROXY?"（プロキシ経由）":"")},
        positions:S.positions.map(p=>{ const t = tokens.get(p.sym), pxv = t?t.px:p.entry, un = unreal(p,t)-p.fundingPaid, m0 = p.margin0 || p.margin, cf = S.cfg, lad = cf.ladder;
          let rows;
          if (p.pyramid){
            const atLev = k => p.entry*(1+p.side*k/100/p.lev);
            rows = [];
            rows.push({k:"tp"+(p.tp1Done?" hit":""), label:"TP1 +"+PYR_TP1+"%（3割）", px:atLev(PYR_TP1), val:p.tp1Done?"済":"約 +"+usd(p.notional*PYR_TP1/100*0.3)});
            rows.push({k:"tp"+(p.tp2Done?" hit":""), label:"TP2 +"+PYR_TP2+"%（7割・建値化）", px:atLev(PYR_TP2), val:p.tp2Done?"済":"約 +"+usd(p.notional*PYR_TP2/100*0.49)});
            rows.push({k:"tp", label:"TP3 +"+PYR_TP3+"%（残り全部）", px:atLev(PYR_TP3), val:"約 +"+usd(p.notional*PYR_TP3/100*0.21)});
            rows.push({k:"tr", label:(p.side>0?"買い建値":"売り建値")+"（現在）", px:p.entry, val:usd(p.margin)});
            if (p.beActive) rows.push({k:"sl", label:"最終決済ライン（TP2水準・固定）", px:p.bePrice, val:"+"+usd(p.notional*PYR_TP2/100*0.21)});
            rows.push({k:"sl", label:"固定損切り -"+PYR_SL+"%（初回から不動）", px:p.slPriceFixed, val:"−"+usd(p.initMargin*PYR_SL/100)});
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
          } else {
            const at = k => p.entry*(1+p.side*cf.tp*k/100);
            rows = [];
            if (lad){ [1,2].forEach(k=>rows.push({k:"tp"+(p.tpHit>=k?" hit":""),label:"TP"+k+" "+(cf.tp*k/3).toFixed(2)+"%",px:at(k/3),val:p.tpHit>=k?"済":"+"+usd(p.notional*cf.tp*k/300)})); }
            rows.push({k:"tp",label:(lad?"TP3(MAX) ":"利確 ")+cf.tp+"%",px:at(1),val:"+"+usd(p.notional*cf.tp/100)});
            rows.push({k:"tr",label:(p.side>0?"買い建値":"売り建値"),px:p.entry,val:usd(p.margin)});
            rows.push(p.beOn ? {k:"sl",label:"建値撤退",px:p.entry,val:"±0"} : {k:"sl",label:"損切り "+cf.sl+"%",px:p.entry*(1-p.side*cf.sl/100),val:"−"+usd(p.notional*cf.sl/100)});
            rows.push({k:"liq",label:"ロスカット",px:p.liq,val:"全損"});
          }
          return { mint:p.sym, symbol:baseOf(p.sym), side:p.side>0?"long":"short", lev:p.lev, qty:p.qty, costUsd:p.margin, valueUsd:p.margin+un, retPct:((p.realizedNet||0)+un)/m0*100, entryPx:p.entry, px:pxv, ts:p.ts, rows, tpHit:p.tpHit, beOn:p.beOn,
            pyrInfo: p.pyramid ? ("追加: フェーズ1 "+p.phase1Adds+"/2 ・ フェーズ2 "+p.phase2Adds+"/"+PYR_MAX_ADD2) : null }; }),
        watch, trades:S.trades.slice(0,20), log:S.log.slice(0,60), errors:(S.errors||[]).slice(0,30), calendar:calendarStats(), hist:S.hist.slice(-300).map(h=>h.v), startedAt:S.startedAt,
        ctl:[
          {key:"mode",label:"アクティブ度",opts:MODE_OPTS,val:S.cfg.mode},
          {key:"dir",label:"方向",opts:[{l:"両方",v:"both"},{l:"ロングのみ",v:"long"},{l:"ショートのみ",v:"short"}],val:S.cfg.dir},
          {key:"strategy",label:"戦略",opts:[{l:"順張り",v:"momentum"},{l:"出来高急増（瞬間検知）",v:"surge"},{l:"逆張り（行き過ぎ狩り）",v:"fade"},{l:"併用（急増＋失速の両方）",v:"dual"}],val:S.cfg.strategy},
          {key:"fadeThresh",label:"逆張りのしきい値（5分変化）",opts:ALLOW.fadeThresh.map(v=>({l:"±"+v+"%",v})),val:S.cfg.fadeThresh},
          {key:"surgeThresh",label:"出来高急増のしきい値（通常比）",opts:ALLOW.surgeThresh.map(v=>({l:"×"+v,v})),val:S.cfg.surgeThresh},
          {key:"lev",label:"レバレッジ",opts:ALLOW.lev.map(v=>({l:v+"x",v})),val:S.cfg.lev},
          {key:"size",label:"1回の証拠金（評価額比）",opts:ALLOW.size.map(v=>({l:Math.round(v*100)+"%",v})),val:S.cfg.size},
          {key:"sl",label:"損切り（価格の逆行）",opts:ALLOW.sl.map(v=>({l:v+"%",v})),val:S.cfg.sl},
          {key:"tp",label:"MAX利確（TP3・価格の順行）",opts:ALLOW.tp.map(v=>({l:v+"%",v})),val:S.cfg.tp},
          {key:"ladder",label:"利確の分割（TP1/2/3）",opts:LADDER_OPTS,val:S.cfg.ladder},
          {key:"be",label:"建値撤退（BE）",opts:BE_OPTS,val:S.cfg.be},
          {key:"trail",label:"トレーリング",opts:YN,val:S.cfg.trail},
          {key:"gate",label:"リスクゲート",opts:GATE_OPTS,val:S.cfg.gate},
          {key:"scale",label:"リスク連動サイズ",opts:YN,val:S.cfg.scale},
          {key:"live",label:"BingXデモへ実発注",opts:YN,val:S.cfg.live},
          {key:"pyramid",label:"資金管理: ピラミッド式（固定ルール）",opts:YN,val:S.cfg.pyramid},
          {key:"halfback",label:"資金管理: 半戻し利確（-15%で1回追加・-32%固定損切り）",opts:YN,val:S.cfg.halfback}
        ],
        liveNote:"実発注は1回あたり証拠金 $"+LIVE_MAX.toFixed(2)+"（"+S.cfg.lev+"x）を上限に、接続設定のリレー経由でBingXデモ口座に送信します。リレー未設定の場合はONにできません。",
        liveAccount: S.cfg.live ? { data: liveAccount, err: liveAccountErr, updatedAt: lastLiveAccountAt } : null,
        pdca: epochStats(),
        slots: S.slots || [{id:"main", label:"メイン"}],
        foot:(S.cfg.pyramid ?
          ("資金管理: ピラミッド式（固定ルール・"+S.cfg.lev+"x）。初期エントリー時点を基準に、証拠金維持率-"+PYR_SL+"%の位置に損切りラインを固定（この後どれだけ買い増ししても動きません）。証拠金維持率-"+PYR_ADD1+"%、-"+PYR_ADD2+"%でそれぞれ初期と同じサイズを追加（最大3回）。+"+PYR_TP1+"%で3割利確、+"+PYR_TP2+"%で残りの7割を利確し、その時点の価格に最終決済ラインを固定します。+"+PYR_TP2+"%後にTP3（+"+PYR_TP3+"%）へ向かう途中で"+PYR_STEP+"%逆行するたびに初期と同じサイズを追加（最大"+PYR_MAX_ADD2+"回）しますが、最終決済ラインはTP2到達時の価格のまま動かしません。+"+PYR_TP3+"%に届けば残り全部を利確します。手数料は片道"+(FEEF()*100).toFixed(3)+"%、強制ロスカットは維持証拠金率0.5%で概算。実際の取引所の約定・ロスカットとは異なります。")
          : S.cfg.halfback
          ? ("資金管理: 半戻し利確（固定ルール・"+S.cfg.lev+"x）。出来高急増を検知した瞬間にその方向へ乗ります。証拠金維持率-"+HB_ADD+"%まで逆行したら、初期と同じサイズを1回だけ追加します。損切りラインは、初回エントリー時点を基準に証拠金維持率-"+HB_SL+"%の位置に固定し、追加しても動きません。利確は、その時点までの最高値（安値）を記録し、そこから伸びた分の半分まで戻ってきた時点で、残り全部を利確します。回転重視のため保有時間の上限はありません。手数料は片道"+(FEEF()*100).toFixed(3)+"%、強制ロスカットは維持証拠金率0.5%で概算。実際の取引所の約定・ロスカットとは異なります。")
          : S.cfg.strategy==="dual"
          ? ("戦略「併用」は、出来高急増（初動に飛び乗る）と逆張り（行き過ぎの失速を狩る）を、同時に別々の銘柄で走らせます。ある銘柄で急な出来高が出た瞬間はそちらへ、別の銘柄が伸びきって失速したときはそちらへ、と両方の候補を毎回まとめて評価し、同時保有数（"+(PERP_MODE[S.cfg.mode]||PERP_MODE.active).maxPos+"件）の範囲でスコアの高い方から採用します。手数料は片道"+(FEEF()*100).toFixed(3)+"%、資金調達は保有中に連続的に概算、強制ロスカットは維持証拠金率0.5%で概算。実際の取引所とは異なります。レバレッジ取引は元本以上の損失に至ることがあり、この戦略に優位性があるとは限りません。")
          : (src==="bingx"?"BingX":"Bybit")+"公開データ（USDT無期限先物）で判定。戦略「出来高急増」は、直近のポーリング間隔（"+Math.round(pollMs()/1000)+"秒程度）だけを見た出来高の急増（通常ペースの何倍か）を検知し、価格がその方向にわずかでも動いていれば、その瞬間に順張りでエントリーします。1分・5分の平均を使う通常の順張りより反応が早いぶん、誤検知（すぐ反転する「フェイク」）も増えます。利確は MAX利確を3等分（TP1=1/3、TP2=2/3、TP3=MAX）し、TP1・TP2で約1/3ずつ決済、「建値撤退」をTP2後（またはTP1後）にすると損切りが建値に切り上がります。手数料は片道"+(FEEF()*100).toFixed(3)+"%、資金調達は保有中に連続的に概算、強制ロスカットは維持証拠金率0.5%で概算。実際の取引所の約定・ロスカット・資金調達とは異なります。レバレッジ取引は元本以上の損失に至ることがあり、この戦略に優位性があるとは限りません。") };
    }
    const EPOCH_KEYS = ["mode","dir","strategy","fadeThresh","surgeThresh","lev","size","sl","tp","trail","gate","scale","ladder","be","pyramid","halfback"];
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
      else if (c==="cfg" && b.cfg){
        let changed = false;
        for (const k of Object.keys(b.cfg)) if (ALLOW[k] && ALLOW[k].includes(b.cfg[k])){
          if (k==="live" && b.cfg[k]===true && (!RELAY_URL || !RELAY_TOKEN)){ addLog("SYS","実発注をONにするには、接続設定でリレーURLとトークンを入力してください。",true); continue; }
          if (S.cfg[k] !== b.cfg[k]) changed = true;
          S.cfg[k] = b.cfg[k];
          if (k==="pyramid" && b.cfg[k]===true) S.cfg.halfback = false; // 資金管理モードは1つだけ
          if (k==="halfback" && b.cfg[k]===true) S.cfg.pyramid = false;
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
