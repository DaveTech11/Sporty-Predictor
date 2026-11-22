const http = require("http");
const crypto = require("crypto");
const { Telegraf, Markup } = require("telegraf");

// ---------- CONFIG ----------
for (const k of ["BOT_TOKEN", "FOOTBALL_API_KEY"]) {
  if (!process.env[k]) console.warn(`⚠️ Missing env variable: ${k}`);
}
if (!process.env.XAI_API_KEY) console.warn("ℹ️ XAI_API_KEY not set: Grok AI button disabled");

const bot = new Telegraf(process.env.BOT_TOKEN);
const API = "https://api.football-data.org/v4";
const GROK_URL = "https://api.x.ai/v1/chat/completions";
const GROK_MODEL = process.env.GROK_MODEL || "grok-4";

const LEAGUES = {
  PL: "🏴 Premier League",
  PD: "🇪🇸 La Liga",
  SA: "🇮🇹 Serie A",
  BL1: "🇩🇪 Bundesliga",
  FL1: "🇫🇷 Ligue 1",
  CL: "🏆 Champions League",
};

// Force-join channels (the bot must be an ADMIN in each one to verify members)
const CHANNELS = [
  { chat: "@linkbyeffc", handle: "@linkbyeffc", url: "https://t.me/linkbyeffc" },
  { chat: "@xryonai", handle: "@xryonai", url: "https://t.me/xryonai" },
  { chat: "@freakscrib3", handle: "@freakscrib3", url: "https://t.me/freakscrib3" },
];

// Public HTTPS address of your deployed bot, e.g. https://your-app.onrender.com
const webUrl = () =>
  process.env.WEBAPP_URL ? process.env.WEBAPP_URL.replace(/\/+$/, "") + "/app" : null;

const esc = (s = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Keep the process alive on unexpected errors
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e));
process.on("uncaughtException", (e) => console.error("Uncaught exception:", e));

// ---------- API + CACHE ----------
const cache = new Map();
const inflight = new Map();

async function api(path, ttl = 3600000) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.t < ttl) return hit.d;
  if (inflight.has(path)) return inflight.get(path);

  const p = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(API + path, {
        headers: { "X-Auth-Token": process.env.FOOTBALL_API_KEY },
        signal: ctrl.signal,
      });
      if (r.status === 429) throw new Error("RATE_LIMIT");
      if (!r.ok) throw new Error("API " + r.status);
      const d = await r.json();
      cache.set(path, { t: Date.now(), d });
      return d;
    } catch (e) {
      if (hit) return hit.d; // fall back to older cached data
      throw e;
    } finally {
      clearTimeout(timer);
      inflight.delete(path);
    }
  })();

  inflight.set(path, p);
  return p;
}

const fail = (ctx, e) => {
  console.error(e);
  const msg = String(e && e.message).includes("RATE_LIMIT")
    ? "⏳ Too many requests to the football data API. Wait about a minute, then try again."
    : "⚠️ Something went wrong. Please try again shortly.";
  return ctx.reply(msg).catch(() => {});
};

// ---------- GROK AI ----------
async function grok(prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch(GROK_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROK_MODEL,
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content:
              "You are a careful football analyst. Use ONLY the data given. " +
              "Never guarantee outcomes. Be concise, plain text, no markdown, under 130 words.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`Grok ${r.status} ${body.slice(0, 200)}`);
    }
    const d = await r.json();
    return d.choices?.[0]?.message?.content?.trim() || "No response.";
  } finally {
    clearTimeout(timer);
  }
}

const grokCooldown = new Map();

// ---------- MODEL ----------
const fact = (n) => (n <= 1 ? 1 : n * fact(n - 1));
const pois = (k, l) => (Math.exp(-l) * l ** k) / fact(k);

function predict(h, a, avg) {
  const hAtt = h.gf / h.p / avg, hDef = h.ga / h.p / avg;
  const aAtt = a.gf / a.p / avg, aDef = a.ga / a.p / avg;
  const lh = avg * hAtt * aDef * 1.1;
  const la = avg * aAtt * hDef * 0.92;

  let home = 0, draw = 0, away = 0, over25 = 0, btts = 0;
  let best = { p: 0, s: "0-0" };
  for (let i = 0; i <= 7; i++) {
    for (let j = 0; j <= 7; j++) {
      const p = pois(i, lh) * pois(j, la);
      if (i > j) home += p;
      else if (i === j) draw += p;
      else away += p;
      if (i + j > 2) over25 += p;
      if (i > 0 && j > 0) btts += p;
      if (p > best.p) best = { p, s: `${i}-${j}` };
    }
  }
  const t = home + draw + away;
  return {
    home: (home / t) * 100,
    draw: (draw / t) * 100,
    away: (away / t) * 100,
    over25: (over25 / t) * 100,
    btts: (btts / t) * 100,
    score: best.s,
    xgH: lh,
    xgA: la,
  };
}

// ---------- HELPERS ----------
const pct = (n) => n.toFixed(0) + "%";
const bar = (n) => {
  const f = Math.max(0, Math.min(10, Math.round(n / 10)));
  return "█".repeat(f) + "░".repeat(10 - f);
};

const confidence = (r) => {
  const m = Math.max(r.home, r.draw, r.away);
  if (m >= 60) return { label: "🔥 Strong", stars: "⭐⭐⭐" };
  if (m >= 45) return { label: "👍 Medium", stars: "⭐⭐" };
  return { label: "⚠️ Risky", stars: "⭐" };
};

const leanRaw = (r, h, a) =>
  r.home > r.away && r.home > r.draw ? `${h.name} win`
  : r.away > r.draw ? `${a.name} win` : "Draw";
const lean = (r, h, a) => esc(leanRaw(r, h, a));

// "2026-11-22T15:00:00Z" -> "22/11 15:00"
const kickoff = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}`;

async function getTable(code) {
  const d = await api(`/competitions/${code}/standings`);
  const total = d.standings.find((s) => s.type === "TOTAL") || d.standings[0];
  const table = total.table;
  const avg =
    table.reduce((s, t) => s + t.goalsFor, 0) /
    Math.max(1, table.reduce((s, t) => s + t.playedGames, 0));
  const find = (id) => {
    const r = table.find((t) => t.team.id === +id);
    return r && r.playedGames > 0
      ? { name: r.team.shortName || r.team.name, p: r.playedGames, gf: r.goalsFor, ga: r.goalsAgainst, pos: r.position, pts: r.points }
      : null;
  };
  return { find, avg };
}

async function load(code, hid, aid) {
  const { find, avg } = await getTable(code);
  const h = find(hid), a = find(aid);
  if (!h || !a) return null;
  return { h, a, r: predict(h, a, avg) };
}

async function form(id) {
  try {
    const d = await api(`/teams/${id}/matches?status=FINISHED`);
    const last = [...d.matches]
      .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
      .slice(-5);
    if (!last.length) return "n/a";
    return last
      .map((m) => {
        const w = m.score.winner;
        if (w === "DRAW") return "🟨";
        const isHome = m.homeTeam.id === +id;
        return (w === "HOME_TEAM") === isHome ? "🟩" : "🟥";
      })
      .join("");
  } catch {
    return "n/a";
  }
}

const safeEdit = async (ctx, text, extra) => {
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", ...extra });
  } catch (e) {
    if (!String(e.description || e).includes("not modified")) throw e;
  }
};

const backKb = (to = "home", label = "⬅️ Back") =>
  Markup.inlineKeyboard([[Markup.button.callback(label, to)]]);

// ---------- ODDS ----------
const MARKETS = {
  1: { label: (h) => `${h.name} win`, p: (r) => r.home },
  X: { label: () => "Draw", p: (r) => r.draw },
  2: { label: (h, a) => `${a.name} win`, p: (r) => r.away },
  a: { label: (h) => `${h.name} or Draw (1X)`, p: (r) => r.home + r.draw },
  b: { label: (h, a) => `Draw or ${a.name} (X2)`, p: (r) => r.draw + r.away },
  c: { label: () => "No draw (12)", p: (r) => r.home + r.away },
  O: { label: () => "Over 2.5 goals", p: (r) => r.over25 },
  U: { label: () => "Under 2.5 goals", p: (r) => 100 - r.over25 },
  B: { label: () => "Both teams score", p: (r) => r.btts },
  N: { label: () => "Both teams score: No", p: (r) => 100 - r.btts },
};
const MK = "1X2abcOUBN";
const PRESET_ODDS = ["1.30", "1.50", "1.80", "2.00", "2.50", "3.00", "3.50", "5.00"];

// users who picked a market and may type custom odds
const pending = new Map();
setInterval(() => {
  for (const [k, v] of pending) if (Date.now() - v.t > 300000) pending.delete(k);
}, 60000).unref();

function valueText(d, mk, odds) {
  const { h, a, r } = d;
  const m = MARKETS[mk];
  const prob = Math.min(0.99, Math.max(0.01, m.p(r) / 100));
  const implied = 1 / odds;
  const edge = prob * odds - 1;
  const fair = 1 / prob;
  const kelly = Math.max(0, Math.min(((prob * odds - 1) / (odds - 1)) * 0.25, 0.05));

  const verdict =
    edge > 0.05 ? "✅ <b>VALUE</b>: odds beat the model's fair price"
    : edge > 0 ? "🟡 <b>Slight value</b>: thin margin"
    : "❌ <b>No value</b>: odds too low for this risk";

  return (
    `💰 <b>Odds check</b>\n` +
    `⚽ ${esc(h.name)} vs ${esc(a.name)}\n\n` +
    `🎯 Pick: <b>${esc(m.label(h, a))}</b>\n` +
    `🏷 Bookie odds: <b>${odds.toFixed(2)}</b>\n\n` +
    `<blockquote>📊 Model chance: <b>${pct(prob * 100)}</b>\n` +
    `🧾 Bookie implied: <b>${pct(implied * 100)}</b>\n` +
    `⚖️ Fair odds: <b>${fair.toFixed(2)}</b>\n` +
    `📈 Edge: <b>${(edge * 100).toFixed(1)}%</b></blockquote>\n` +
    `${verdict}\n\n` +
    `<blockquote expandable>🛡 <b>Stake guide</b> (quarter-Kelly, max 5%)\n` +
    (kelly > 0
      ? `Suggested stake: <b>${(kelly * 100).toFixed(1)}%</b> of your bankroll.\n`
      : `No stake suggested.\n`) +
    `Edge relies on a simple stats model. It can be wrong.</blockquote>\n` +
    `<tg-spoiler>⚠️ Not financial advice. Bet responsibly, 18+.</tg-spoiler>`
  );
}

function valueKb(code, hid, aid, mk) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Change odds", `om:${code}:${hid}:${aid}:${mk}`)],
    [Markup.button.callback("🎯 Change market", `o:${code}:${hid}:${aid}`)],
    [Markup.button.callback("⬅️ Match", `m:${code}:${hid}:${aid}`)],
    [Markup.button.callback("🏠 Home", "home")],
  ]);
}

// ---------- SCREENS ----------
const homeKb = () => {
  const rows = Object.entries(LEAGUES).map(([c, n]) => [Markup.button.callback(n, "lg:" + c)]);
  if (webUrl()) rows.push([Markup.button.webApp("🌐 Open Web App", webUrl())]);
  rows.push([Markup.button.callback("ℹ️ How it works", "about")]);
  return Markup.inlineKeyboard(rows);
};

const homeText = (ctx) =>
  `⚽ <b>Sporty Predictor AI</b>\n\n` +
  `👋 Hi <b>${esc(ctx.from.first_name)}</b>!\n` +
  `<blockquote>📊 Poisson model\n📈 Team form\n💰 Odds &amp; value check\n🤖 Grok AI analysis\n🌐 Web app</blockquote>\n` +
  `Pick a league 👇\n<i>Stats-based estimates, not guarantees.</i>`;

const sendHome = (ctx, edit) =>
  edit
    ? safeEdit(ctx, homeText(ctx), homeKb())
    : ctx.reply(homeText(ctx), { parse_mode: "HTML", ...homeKb() });

// ---------- FORCE JOIN ----------
const memberCache = new Map(); // userId -> cache expiry (ms)

async function checkMembership(userId, fresh = false) {
  if (!fresh) {
    const exp = memberCache.get(userId);
    if (exp && exp > Date.now()) return { ok: true, results: [], missing: [] };
  }
  const results = await Promise.all(
    CHANNELS.map(async (ch) => {
      try {
        const m = await bot.telegram.getChatMember(ch.chat, userId);
        const ok =
          ["creator", "administrator", "member"].includes(m.status) ||
          (m.status === "restricted" && m.is_member === true);
        return { ch, ok };
      } catch (e) {
        console.error(`Membership check failed for ${ch.chat}: ${e.message} (is the bot an admin there?)`);
        return { ch, ok: false };
      }
    })
  );
  const missing = results.filter((r) => !r.ok);
  if (missing.length) memberCache.delete(userId);
  else memberCache.set(userId, Date.now() + 120000);
  return { ok: !missing.length, results, missing };
}

const joinText = (results = []) => {
  const lines = CHANNELS.map((ch) => {
    const r = results.find((x) => x.ch.chat === ch.chat);
    return `${r ? (r.ok ? "✅" : "❌") : "📢"} ${ch.handle}`;
  }).join("\n");
  return (
    `🔒 <b>Join to unlock</b>\n\n` +
    `To use <b>Sporty Predictor AI</b>, join our channels:\n\n` +
    `<blockquote>${lines}</blockquote>\n` +
    `1️⃣ Tap each button below and join\n` +
    `2️⃣ Come back and tap <b>✅ Joined</b>\n\n` +
    `<i>Access unlocks instantly after verification.</i>`
  );
};

const joinKb = () =>
  Markup.inlineKeyboard([
    ...CHANNELS.map((ch) => [Markup.button.url(`📢 Join ${ch.handle}`, ch.url)]),
    [Markup.button.callback("✅ Joined", "verify")],
  ]);

const sendJoin = (ctx, results) =>
  ctx.reply(joinText(results), { parse_mode: "HTML", ...joinKb() });

// Gate: every update must come from a verified member
bot.use(async (ctx, next) => {
  if (!ctx.from || ctx.from.is_bot) return next();
  if (ctx.callbackQuery && ctx.callbackQuery.data === "verify") return next();
  const res = await checkMembership(ctx.from.id);
  if (res.ok) return next();
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery("🔒 Join our channels first", { show_alert: true }).catch(() => {});
  }
  return sendJoin(ctx, res.results);
});

// "✅ Joined" button
bot.action("verify", async (ctx) => {
  try {
    const res = await checkMembership(ctx.from.id, true);
    if (res.ok) {
      await ctx.answerCbQuery("✅ Verified! Access granted");
      try {
        return await sendHome(ctx, true);
      } catch {
        return await sendHome(ctx);
      }
    }
    await ctx.answerCbQuery("❌ You haven't joined all channels yet", { show_alert: true });
    await safeEdit(ctx, joinText(res.results), joinKb());
  } catch (e) {
    fail(ctx, e);
  }
});

bot.start((ctx) => sendHome(ctx));
bot.command("menu", (ctx) => sendHome(ctx));
bot.help((ctx) =>
  ctx.reply("<b>Commands</b>\n/start - Open predictor\n/menu - Show leagues", { parse_mode: "HTML" })
);

bot.action("home", async (ctx) => {
  await ctx.answerCbQuery();
  pending.delete(ctx.from.id);
  try {
    await sendHome(ctx, true);
  } catch (e) {
    fail(ctx, e);
  }
});

bot.action("about", async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await safeEdit(
      ctx,
      `ℹ️ <b>How it works</b>\n\n` +
        `<blockquote expandable>1️⃣ Reads each team's goals scored and conceded\n` +
        `2️⃣ Compares them to the league average\n` +
        `3️⃣ Adds a small home advantage\n` +
        `4️⃣ Runs a <b>Poisson model</b> for probabilities\n` +
        `5️⃣ <b>Odds check</b>: compares your bookie odds to the model's fair odds\n` +
        `6️⃣ <b>Grok AI</b> writes a short analysis from the data</blockquote>\n` +
        `⚠️ <b>No model predicts football reliably.</b> Bookmaker odds already include this info.\n` +
        `<i>Never bet money you can't afford to lose. 18+ only.</i>`,
      backKb()
    );
  } catch (e) {
    fail(ctx, e);
  }
});

// League -> matches
bot.action(/^lg:(\w+)$/, async (ctx) => {
  const code = ctx.match[1];
  await ctx.answerCbQuery("Loading matches...");
  try {
    const d = await api(`/competitions/${code}/matches?status=SCHEDULED`, 600000);
    const ms = d.matches.slice(0, 8);
    if (!ms.length) return await safeEdit(ctx, "📭 No upcoming matches found.", backKb());

    const rows = ms.map((m) => [
      Markup.button.callback(
        `${kickoff(m.utcDate)} ${m.homeTeam.shortName || m.homeTeam.name} vs ${m.awayTeam.shortName || m.awayTeam.name}`,
        `m:${code}:${m.homeTeam.id}:${m.awayTeam.id}`
      ),
    ]);
    rows.unshift([Markup.button.callback("🔥 Top Picks (best confidence)", "top:" + code)]);
    rows.push([Markup.button.callback("⬅️ Back", "home")]);

    await safeEdit(
      ctx,
      `<b>${LEAGUES[code] || code}</b>\n\n📅 <i>Next fixtures (UTC). Select a match:</i>`,
      Markup.inlineKeyboard(rows)
    );
  } catch (e) {
    fail(ctx, e);
  }
});

// Top picks
bot.action(/^top:(\w+)$/, async (ctx) => {
  const code = ctx.match[1];
  await ctx.answerCbQuery("Ranking picks...");
  try {
    const d = await api(`/competitions/${code}/matches?status=SCHEDULED`, 600000);
    const { find, avg } = await getTable(code);
    const list = d.matches
      .slice(0, 8)
      .map((m) => {
        const h = find(m.homeTeam.id), a = find(m.awayTeam.id);
        if (!h || !a) return null;
        const r = predict(h, a, avg);
        return { h, a, r, top: Math.max(r.home, r.draw, r.away) };
      })
      .filter(Boolean)
      .sort((x, y) => y.top - x.top)
      .slice(0, 3);

    const medals = ["🥇", "🥈", "🥉"];
    const body = list
      .map(
        (x, i) =>
          `${medals[i]} <b>${esc(x.h.name)} vs ${esc(x.a.name)}</b>\n` +
          `   🧠 ${lean(x.r, x.h, x.a)} (<b>${pct(x.top)}</b>) ${confidence(x.r).stars}`
      )
      .join("\n\n");

    await safeEdit(
      ctx,
      `🔥 <b>Top Picks: ${LEAGUES[code] || code}</b>\n\n${body || "Not enough data yet."}\n\n` +
        `<tg-spoiler>⚠️ Estimates only. Bet responsibly, 18+.</tg-spoiler>`,
      Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Matches", "lg:" + code)],
        [Markup.button.callback("🏠 Home", "home")],
      ])
    );
  } catch (e) {
    fail(ctx, e);
  }
});

// Match -> prediction
bot.action(/^m:(\w+):(\d+):(\d+)$/, async (ctx) => {
  const [, code, hid, aid] = ctx.match;
  await ctx.answerCbQuery("Analyzing...");
  pending.delete(ctx.from.id);
  try {
    const d = await load(code, hid, aid);
    if (!d) return ctx.reply("📭 Not enough data for this match yet.");
    const { h, a, r } = d;
    const c = confidence(r);
    const [fh, fa] = await Promise.all([form(hid), form(aid)]);

    await safeEdit(
      ctx,
      `⚽ <b>${esc(h.name)} vs ${esc(a.name)}</b>\n` +
        `<i>${LEAGUES[code] || code}</i>\n\n` +
        `🏠 ${esc(h.name)}: <b>${pct(r.home)}</b>\n<code>${bar(r.home)}</code>\n` +
        `🤝 Draw: <b>${pct(r.draw)}</b>\n<code>${bar(r.draw)}</code>\n` +
        `✈️ ${esc(a.name)}: <b>${pct(r.away)}</b>\n<code>${bar(r.away)}</code>\n\n` +
        `<blockquote>🎯 Likely score: <b>${r.score}</b>\n` +
        `📈 Over 2.5: <b>${pct(r.over25)}</b>\n` +
        `🥅 BTTS: <b>${pct(r.btts)}</b>\n` +
        `📊 xG: ${r.xgH.toFixed(1)} - ${r.xgA.toFixed(1)}</blockquote>\n` +
        `🧠 <b>Model lean:</b> ${lean(r, h, a)}\n` +
        `${c.stars} <b>Confidence:</b> ${c.label}\n\n` +
        `<blockquote expandable>📋 <b>Deep dive</b>\n` +
        `${esc(h.name)}: #${h.pos} • ${h.pts} pts • ${h.gf}:${h.ga} goals\n` +
        `Form: ${fh}\n\n` +
        `${esc(a.name)}: #${a.pos} • ${a.pts} pts • ${a.gf}:${a.ga} goals\n` +
        `Form: ${fa}\n\n` +
        `🟩 win  🟨 draw  🟥 loss (last 5)</blockquote>\n` +
        `<tg-spoiler>⚠️ Estimates only. Bet responsibly, 18+.</tg-spoiler>`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback("💰 Odds check", `o:${code}:${hid}:${aid}`),
          Markup.button.callback("🤖 Grok AI", `g:${code}:${hid}:${aid}`),
        ],
        [Markup.button.callback("⬅️ Matches", "lg:" + code)],
        [Markup.button.callback("🏠 Home", "home")],
      ])
    );
  } catch (e) {
    fail(ctx, e);
  }
});

// ---------- ODDS FLOW ----------
// Step 1: choose market
bot.action(/^o:(\w+):(\d+):(\d+)$/, async (ctx) => {
  const [, code, hid, aid] = ctx.match;
  await ctx.answerCbQuery();
  pending.delete(ctx.from.id);
  try {
    const d = await load(code, hid, aid);
    if (!d) return ctx.reply("📭 Not enough data.");
    const { h, a } = d;
    const b = (mk, label) => Markup.button.callback(label, `om:${code}:${hid}:${aid}:${mk}`);
    await safeEdit(
      ctx,
      `💰 <b>Odds check</b>\n⚽ ${esc(h.name)} vs ${esc(a.name)}\n\n` +
        `<i>Step 1: choose the market you want to bet on:</i>\n` +
        `<blockquote>1 = ${esc(h.name)} • 2 = ${esc(a.name)}</blockquote>`,
      Markup.inlineKeyboard([
        [b("1", "🏠 1 Home"), b("X", "🤝 X Draw"), b("2", "✈️ 2 Away")],
        [b("a", "1X"), b("b", "X2"), b("c", "12")],
        [b("O", "📈 Over 2.5"), b("U", "📉 Under 2.5")],
        [b("B", "🥅 BTTS Yes"), b("N", "🚫 BTTS No")],
        [Markup.button.callback("⬅️ Back", `m:${code}:${hid}:${aid}`)],
      ])
    );
  } catch (e) {
    fail(ctx, e);
  }
});

// Step 2: choose odds (presets or type your own)
bot.action(new RegExp(`^om:(\\w+):(\\d+):(\\d+):([${MK}])$`), async (ctx) => {
  const [, code, hid, aid, mk] = ctx.match;
  await ctx.answerCbQuery();
  pending.set(ctx.from.id, { code, hid, aid, mk, t: Date.now() });
  try {
    const d = await load(code, hid, aid);
    if (!d) return ctx.reply("📭 Not enough data.");
    const m = MARKETS[mk];
    const rows = [];
    for (let i = 0; i < PRESET_ODDS.length; i += 4) {
      rows.push(
        PRESET_ODDS.slice(i, i + 4).map((o) =>
          Markup.button.callback(o, `od:${code}:${hid}:${aid}:${mk}:${o}`)
        )
      );
    }
    rows.push([Markup.button.callback("⬅️ Change market", `o:${code}:${hid}:${aid}`)]);
    await safeEdit(
      ctx,
      `💰 <b>Odds check</b>\n🎯 Pick: <b>${esc(m.label(d.h, d.a))}</b>\n\n` +
        `<i>Step 2: tap the odds your bookie shows, or <b>type them</b> in chat (e.g. 1.85):</i>`,
      Markup.inlineKeyboard(rows)
    );
  } catch (e) {
    fail(ctx, e);
  }
});

// Step 3: result (preset button)
bot.action(new RegExp(`^od:(\\w+):(\\d+):(\\d+):([${MK}]):([\\d.]+)$`), async (ctx) => {
  const [, code, hid, aid, mk, o] = ctx.match;
  await ctx.answerCbQuery();
  pending.delete(ctx.from.id);
  try {
    const d = await load(code, hid, aid);
    if (!d) return ctx.reply("📭 Not enough data.");
    await safeEdit(ctx, valueText(d, mk, parseFloat(o)), valueKb(code, hid, aid, mk));
  } catch (e) {
    fail(ctx, e);
  }
});

// Step 3: result (typed odds)
bot.on("text", async (ctx) => {
  const p = pending.get(ctx.from.id);
  if (!p || Date.now() - p.t > 300000) {
    pending.delete(ctx.from.id);
    return ctx.reply("Use /menu to open the predictor 👇");
  }
  const odds = parseFloat(ctx.message.text.replace(",", "."));
  if (!isFinite(odds) || odds < 1.01 || odds > 100) {
    return ctx.reply("Send odds as a number between 1.01 and 100, e.g. 1.85");
  }
  pending.delete(ctx.from.id);
  try {
    const d = await load(p.code, p.hid, p.aid);
    if (!d) return ctx.reply("📭 Not enough data.");
    await ctx.reply(valueText(d, p.mk, odds), {
      parse_mode: "HTML",
      ...valueKb(p.code, p.hid, p.aid, p.mk),
    });
  } catch (e) {
    fail(ctx, e);
  }
});

// ---------- GROK ANALYSIS ----------
bot.action(/^g:(\w+):(\d+):(\d+)$/, async (ctx) => {
  const [, code, hid, aid] = ctx.match;

  if (!process.env.XAI_API_KEY) {
    return ctx.answerCbQuery("Grok is not set up (XAI_API_KEY missing).", { show_alert: true });
  }
  const last = grokCooldown.get(ctx.from.id) || 0;
  if (Date.now() - last < 15000) {
    return ctx.answerCbQuery("Please wait a few seconds ⏳", { show_alert: true });
  }
  grokCooldown.set(ctx.from.id, Date.now());
  await ctx.answerCbQuery("🤖 Grok is thinking...");

  let d;
  try {
    d = await load(code, hid, aid);
    if (!d) return ctx.reply("📭 Not enough data.");
  } catch (e) {
    return fail(ctx, e);
  }

  try {
    const { h, a, r } = d;
    const [fh, fa] = await Promise.all([form(hid), form(aid)]);
    const clean = (s) => s.replace(/🟩/g, "W").replace(/🟨/g, "D").replace(/🟥/g, "L");

    const prompt =
      `League: ${LEAGUES[code] || code}\n` +
      `Match: ${h.name} (home) vs ${a.name} (away)\n` +
      `${h.name}: position ${h.pos}, ${h.pts} pts, ${h.p} games, goals ${h.gf}:${h.ga}, last 5: ${clean(fh)}\n` +
      `${a.name}: position ${a.pos}, ${a.pts} pts, ${a.p} games, goals ${a.gf}:${a.ga}, last 5: ${clean(fa)}\n` +
      `Model probabilities: home ${pct(r.home)}, draw ${pct(r.draw)}, away ${pct(r.away)}, ` +
      `over 2.5 ${pct(r.over25)}, BTTS ${pct(r.btts)}, likely score ${r.score}.\n\n` +
      `Give a short match analysis: key factors, the main risk, and which market looks most sensible. ` +
      `Mention that the model is a simple stats model.`;

    const text = await grok(prompt);

    await safeEdit(
      ctx,
      `🤖 <b>Grok AI analysis</b>\n⚽ ${esc(h.name)} vs ${esc(a.name)}\n\n` +
        `<blockquote expandable>${esc(text).slice(0, 3000)}</blockquote>\n` +
        `<tg-spoiler>⚠️ AI can be wrong. Estimates only. Bet responsibly, 18+.</tg-spoiler>`,
      Markup.inlineKeyboard([
        [Markup.button.callback("💰 Odds check", `o:${code}:${hid}:${aid}`)],
        [Markup.button.callback("⬅️ Match", `m:${code}:${hid}:${aid}`)],
        [Markup.button.callback("🏠 Home", "home")],
      ])
    );
  } catch (e) {
    console.error(e);
    ctx.reply("⚠️ Grok is unavailable right now. Check XAI_API_KEY, your xAI credits and GROK_MODEL.").catch(() => {});
  }
});

bot.catch((err, ctx) => console.error(`Error ${ctx.updateType}:`, err));

// ---------- WEB APP (Telegram Mini App) ----------
const WEB_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Sporty Predictor AI</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:var(--tg-theme-bg-color,#fff);--tx:var(--tg-theme-text-color,#111);--hint:var(--tg-theme-hint-color,#777);--btn:var(--tg-theme-button-color,#2481cc);--btx:var(--tg-theme-button-text-color,#fff);--card:var(--tg-theme-secondary-bg-color,#f1f1f1)}
*{box-sizing:border-box}
body{margin:0;padding:14px;background:var(--bg);color:var(--tx);font:15px/1.4 -apple-system,Segoe UI,Roboto,sans-serif}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--hint);font-size:12px;margin-bottom:12px}
.tabs{display:flex;gap:6px;overflow-x:auto;padding-bottom:8px}
.tab{flex:none;border:0;border-radius:16px;padding:8px 12px;background:var(--card);color:var(--tx);font-size:13px}
.tab.on{background:var(--btn);color:var(--btx)}
.card{background:var(--card);border-radius:12px;padding:12px;margin:10px 0}
.t{font-weight:600}
.k{color:var(--hint);font-size:12px;margin-bottom:8px}
.row{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:13px}
.lab{width:72px;flex:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.track{flex:1;height:8px;border-radius:4px;background:rgba(127,127,127,.25);overflow:hidden}
.fill{height:100%;background:var(--btn)}
.v{width:38px;text-align:right}
.meta{font-size:13px;margin-top:8px}
.btn{margin-top:10px;border:0;border-radius:8px;padding:9px 12px;background:var(--btn);color:var(--btx);font-size:13px}
select,input{width:100%;margin-top:8px;padding:9px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:var(--bg);color:var(--tx);font-size:14px}
.res{margin-top:8px;font-size:13px}
.good{color:#1a9c4a}
.bad{color:#d33}
.note{color:var(--hint);font-size:11px;margin-top:14px}
</style></head><body>
<h1>⚽ Sporty Predictor AI</h1>
<div class="sub">Stats-based estimates, not guarantees. 18+</div>
<div id="tabs" class="tabs"></div>
<div id="out"></div>
<div class="note">⚠️ No model predicts football reliably. Bet responsibly.</div>
<script>
var tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }
var initData = tg ? tg.initData : "";
var LEAGUES = [["PL","Premier League"],["PD","La Liga"],["SA","Serie A"],["BL1","Bundesliga"],["FL1","Ligue 1"],["CL","Champions League"]];
var MK = [
  ["Home win", function(r){return r.home;}],
  ["Draw", function(r){return r.draw;}],
  ["Away win", function(r){return r.away;}],
  ["Home or draw (1X)", function(r){return r.home + r.draw;}],
  ["Draw or away (X2)", function(r){return r.draw + r.away;}],
  ["No draw (12)", function(r){return r.home + r.away;}],
  ["Over 2.5 goals", function(r){return r.over25;}],
  ["Under 2.5 goals", function(r){return 100 - r.over25;}],
  ["Both teams score", function(r){return r.btts;}],
  ["Both teams score: No", function(r){return 100 - r.btts;}]
];
var out = document.getElementById("out");
var tabs = document.getElementById("tabs");

function E(tag, cls, txt) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}
function msg(t) { out.innerHTML = ""; out.appendChild(E("div", "card", t)); }
function bar(label, val) {
  var row = E("div", "row");
  row.appendChild(E("div", "lab", label));
  var tr = E("div", "track");
  var f = E("div", "fill");
  f.style.width = Math.round(val) + "%";
  tr.appendChild(f);
  row.appendChild(tr);
  row.appendChild(E("div", "v", Math.round(val) + "%"));
  return row;
}
function card(m) {
  var c = E("div", "card");
  c.appendChild(E("div", "t", m.home + " vs " + m.away));
  c.appendChild(E("div", "k", m.kickoff + " UTC"));
  c.appendChild(bar(m.home, m.r.home));
  c.appendChild(bar("Draw", m.r.draw));
  c.appendChild(bar(m.away, m.r.away));
  c.appendChild(E("div", "meta", "🎯 " + m.r.score + "  ·  Over 2.5: " + Math.round(m.r.over25) + "%  ·  BTTS: " + Math.round(m.r.btts) + "%"));
  c.appendChild(E("div", "meta", "🧠 Lean: " + m.lean + "  ·  " + m.conf));

  var btn = E("button", "btn", "💰 Odds check");
  var box = E("div");
  box.style.display = "none";
  var sel = E("select");
  MK.forEach(function (x, i) { var o = E("option", null, x[0]); o.value = i; sel.appendChild(o); });
  var inp = E("input");
  inp.type = "number"; inp.step = "0.01"; inp.min = "1.01"; inp.placeholder = "Bookie odds, e.g. 1.85";
  inp.setAttribute("inputmode", "decimal");
  var res = E("div", "res");
  function calc() {
    var odds = parseFloat(inp.value);
    if (!(odds > 1)) { res.textContent = ""; return; }
    var p = Math.min(99, Math.max(1, MK[sel.value][1](m.r))) / 100;
    var edge = p * odds - 1;
    res.className = "res " + (edge > 0 ? "good" : "bad");
    res.textContent = "Model " + Math.round(p * 100) + "%  ·  Fair odds " + (1 / p).toFixed(2) + "  ·  Edge " + (edge * 100).toFixed(1) + "%  →  " + (edge > 0.05 ? "✅ VALUE" : edge > 0 ? "🟡 Slight value" : "❌ No value");
  }
  sel.onchange = calc;
  inp.oninput = calc;
  btn.onclick = function () { box.style.display = box.style.display === "none" ? "block" : "none"; };
  box.appendChild(sel); box.appendChild(inp); box.appendChild(res);
  c.appendChild(btn); c.appendChild(box);
  return c;
}
function load(code) {
  msg("Loading matches...");
  fetch("/api/matches?code=" + code, { headers: { "x-init-data": initData } })
    .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
    .then(function (x) {
      if (x.s === 403) return msg("🔒 Join our channels first. Go back to the bot and tap ✅ Joined.");
      if (x.s === 401) return msg("Session expired. Close and reopen from the bot.");
      if (x.s === 429) return msg("Too many requests. Try again in a minute.");
      if (x.s !== 200) return msg("Couldn't load matches. Try again shortly.");
      if (!x.j.matches.length) return msg("No upcoming matches found.");
      out.innerHTML = "";
      x.j.matches.forEach(function (m) { out.appendChild(card(m)); });
    })
    .catch(function () { msg("Network error. Try again."); });
}
if (!initData) {
  msg("Open this page from the Telegram bot (tap 🌐 Open Web App).");
} else {
  LEAGUES.forEach(function (l, i) {
    var b = E("button", "tab" + (i === 0 ? " on" : ""), l[1]);
    b.onclick = function () {
      Array.prototype.forEach.call(tabs.children, function (t) { t.className = "tab"; });
      b.className = "tab on";
      load(l[0]);
    };
    tabs.appendChild(b);
  });
  load(LEAGUES[0][0]);
}
</script></body></html>`;

// Validate Telegram's signed initData and return the user (or null)
function verifyInitData(initData) {
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get("hash");
    if (!hash) return null;
    p.delete("hash");
    const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN || "").digest();
    const calc = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
    const a = Buffer.from(calc), b = Buffer.from(hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return null;
    return JSON.parse(p.get("user"));
  } catch {
    return null;
  }
}

const sendJson = (res, status, obj) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
};

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");

      if (url.pathname === "/app") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(WEB_HTML);
      }

      if (url.pathname === "/api/matches") {
        const user = verifyInitData(req.headers["x-init-data"] || "");
        if (!user) return sendJson(res, 401, { error: "auth" });

        const code = url.searchParams.get("code");
        if (!LEAGUES[code]) return sendJson(res, 400, { error: "league" });

        const mem = await checkMembership(user.id);
        if (!mem.ok) return sendJson(res, 403, { error: "join" });

        try {
          const d = await api(`/competitions/${code}/matches?status=SCHEDULED`, 600000);
          const { find, avg } = await getTable(code);
          const matches = d.matches
            .slice(0, 10)
            .map((m) => {
              const h = find(m.homeTeam.id), a = find(m.awayTeam.id);
              if (!h || !a) return null;
              const r = predict(h, a, avg);
              return {
                home: h.name,
                away: a.name,
                kickoff: kickoff(m.utcDate),
                r: {
                  home: r.home, draw: r.draw, away: r.away,
                  over25: r.over25, btts: r.btts, score: r.score,
                },
                lean: leanRaw(r, h, a),
                conf: confidence(r).label,
              };
            })
            .filter(Boolean);
          return sendJson(res, 200, { league: LEAGUES[code], matches });
        } catch (e) {
          console.error(e);
          return sendJson(res, String(e.message).includes("RATE_LIMIT") ? 429 : 500, { error: "api" });
        }
      }

      res.writeHead(200);
      res.end("Predictor bot is running");
    } catch (e) {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: "server" });
    }
  })
  .listen(process.env.PORT || 3000);

// ---------- START ----------
bot.telegram
  .setMyCommands([
    { command: "start", description: "Open predictor" },
    { command: "menu", description: "Show leagues" },
    { command: "help", description: "Get help" },
  ])
  .catch((e) => console.error("setMyCommands failed:", e.message));

bot
  .launch()
  .catch((e) => {
    console.error("Bot failed to start. Check BOT_TOKEN:", e.message);
    process.exit(1);
  });
console.log("Predictor bot running...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
