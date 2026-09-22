/**
 * BingXデモ（VST）専用の発注リレー / Cloudflare Worker
 * ------------------------------------------------------------
 * ・BingXのAPIキー/シークレットはここ（Cloudflareのシークレット）にだけ保存します。
 *   ブラウザ側やGitHubのファイルには一切書きません。
 * ・既定のBASE_URLはデモ環境 https://open-api-vst.bingx.com に固定しています。
 *   実口座のAPIキーを入れても、ここが変わらない限り実口座には発注されません。
 * ・呼び出す側は、このWorkerが発行した ACCESS_TOKEN をヘッダーに付けて呼びます
 *   （BingXのキーそのものではありません）。
 *
 * 【重要】このコードは実際のBingX APIに対して動作確認していません。
 * 署名の作り方・パラメータ名は公開されているドキュメント/コミュニティ資料をもとに書いていますが、
 * 実際の挙動はBingX側の応答で初めて確認できます。まずは残高確認など「読み取り」だけを試し、
 * 発注は最小サイズ・少数量から試してください。
 *
 * 必須のシークレット（wrangler secret put で設定）:
 *   BINGX_API_KEY     … デモ用APIキー
 *   BINGX_API_SECRET  … デモ用シークレット
 *   ACCESS_TOKEN      … このWorkerを呼ぶときの合言葉（自分で決めた文字列）
 * 任意の変数（wrangler.toml の [vars] または secret でも可）:
 *   BASE_URL          … 既定 "https://open-api-vst.bingx.com"（デモ）。実口座を使うなら
 *                        "https://open-api.bingx.com" に変更するが、その場合は実資金が動くことを
 *                        必ず理解した上で行うこと。
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

// ---- BingX署名: パラメータをASCII順にkey=valueで連結し、HMAC-SHA256(hex) ----
async function sign(secret, paramString) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
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
  const r = await fetch(url, {
    method,
    headers: { "X-BX-APIKEY": env.BINGX_API_KEY },
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  // BingXはHTTP自体は200でも、応答の中の code が 0以外なら実際は失敗、というケースがある。
  // 銘柄が存在しない場合などがこれに当たり、ここを見ないと「成功」と誤判定してしまう。
  if (!r.ok || (data && typeof data.code !== "undefined" && data.code !== 0)) {
    throw { httpStatus: r.ok ? 200 : r.status, bingxCode: data && data.code, body: data };
  }
  return data;
}

// symbol変換: "BTCUSDT" -> "BTC-USDT"（先物の形式）
function toBingxSymbol(sym) {
  if (sym.includes("-")) return sym;
  return sym.replace(/USDT$/, "-USDT");
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!checkAuth(req, env)) return json({ error: "unauthorized" }, 401);

    const u = new URL(req.url);
    const isDemo = (env.BASE_URL || "https://open-api-vst.bingx.com").includes("vst");

    try {
      // ---- 市場データ（公開・署名不要。CORS回避のための単純な中継） ----
      if (req.method === "GET" && u.pathname === "/market/ticker") {
        const symbol = u.searchParams.get("symbol");
        const qs = symbol ? "?symbol=" + encodeURIComponent(toBingxSymbol(symbol)) : "";
        const r = await fetch((env.BASE_URL || "https://open-api-vst.bingx.com") + "/openApi/swap/v2/quote/ticker" + qs);
        const text = await r.text();
        return new Response(text, { status: r.status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });
      }
      if (req.method === "GET" && u.pathname === "/market/premiumIndex") {
        const symbol = u.searchParams.get("symbol");
        const qs = symbol ? "?symbol=" + encodeURIComponent(toBingxSymbol(symbol)) : "";
        const r = await fetch((env.BASE_URL || "https://open-api-vst.bingx.com") + "/openApi/swap/v2/quote/premiumIndex" + qs);
        const text = await r.text();
        return new Response(text, { status: r.status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });
      }

      // ---- 残高（デモ資金USDT(VST)） ----
      if (req.method === "GET" && u.pathname === "/balance") {
        const r = await bingxRequest(env, "GET", "/openApi/swap/v2/user/balance");
        return json({ demo: isDemo, result: r });
      }

      // ---- 保有ポジション一覧 ----
      if (req.method === "GET" && u.pathname === "/positions") {
        const symbol = u.searchParams.get("symbol");
        const r = await bingxRequest(env, "GET", "/openApi/swap/v2/user/positions", symbol ? { symbol: toBingxSymbol(symbol) } : {});
        return json({ demo: isDemo, result: r });
      }

      // ---- 銘柄仕様（数量の精度など） ----
      if (req.method === "GET" && u.pathname === "/contracts") {
        const symbol = u.searchParams.get("symbol");
        const r = await bingxRequest(env, "GET", "/openApi/swap/v2/quote/contracts", symbol ? { symbol: toBingxSymbol(symbol) } : {});
        return json({ demo: isDemo, result: r });
      }

      // ---- レバレッジ確認/設定 ----
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

      // ---- 成行注文（新規） ----
      // body: { symbol:"BTCUSDT", side:"BUY"|"SELL", positionSide:"LONG"|"SHORT", quantity: 0.01 }
      if (req.method === "POST" && u.pathname === "/order") {
        const b = await req.json();
        if (!b.symbol || !b.side || !b.positionSide || !b.quantity) {
          return json({ error: "symbol, side, positionSide, quantity は必須です" }, 400);
        }
        const r = await bingxRequest(env, "POST", "/openApi/swap/v2/trade/order", {
          symbol: toBingxSymbol(b.symbol),
          side: b.side,
          positionSide: b.positionSide,
          type: "MARKET",
          quantity: b.quantity,
        });
        return json({ demo: isDemo, result: r });
      }

      // ---- 決済（そのポジションの反対売買で全量クローズ） ----
      // body: { symbol:"BTCUSDT", positionSide:"LONG"|"SHORT", quantity: 0.01 }
      if (req.method === "POST" && u.pathname === "/close") {
        const b = await req.json();
        if (!b.symbol || !b.positionSide || !b.quantity) {
          return json({ error: "symbol, positionSide, quantity は必須です" }, 400);
        }
        const r = await bingxRequest(env, "POST", "/openApi/swap/v2/trade/order", {
          symbol: toBingxSymbol(b.symbol),
          side: b.positionSide === "LONG" ? "SELL" : "BUY",
          positionSide: b.positionSide,
          type: "MARKET",
          quantity: b.quantity,
        });
        return json({ demo: isDemo, result: r });
      }

      // ---- 全ポジション決済（銘柄指定） ----
      if (req.method === "POST" && u.pathname === "/close-all") {
        const b = await req.json().catch(() => ({}));
        const r = await bingxRequest(env, "POST", "/openApi/swap/v2/trade/closeAllPositions", b.symbol ? { symbol: toBingxSymbol(b.symbol) } : {});
        return json({ demo: isDemo, result: r });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: "bingx_request_failed", detail: e.body || e.message || String(e), httpStatus: e.httpStatus }, 502);
    }
  },
};
