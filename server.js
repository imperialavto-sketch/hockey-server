require("dotenv").config();
const express = require("express");
const cors = require("cors");
const prisma = require("./lib/prisma");
const { sendSmsCode, checkSmscStatus } = require("./services/sms");

const app = express();
const PORT = process.env.PORT || 3000;

// CORS: production uses allowlist from ALLOWED_ORIGINS; dev stays open.
const isProduction = process.env.NODE_ENV === "production";
if (isProduction) {
  const raw = process.env.ALLOWED_ORIGINS;
  const origins =
    typeof raw === "string" && raw.trim() !== ""
      ? raw.split(",").map((o) => o.trim()).filter(Boolean)
      : [];
  app.use(cors({ origin: origins.length > 0 ? origins : false }));
} else {
  app.use(cors());
}
app.use(express.json());
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    console.error("[json-parse-error]", err.message);
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  next(err);
});

// --- AUTH HELPERS (DEV) ---
function getBearerToken(req) {
  const header = req.get("authorization") || req.get("Authorization");
  if (typeof header !== "string" || header.trim() === "") return null;
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token || token.trim() === "") return null;
  return token.trim();
}

function requireBearerAuth(req, res, next) {
  const header = req.get("authorization") || req.get("Authorization");
  if (typeof header !== "string" || header.trim() === "") {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.auth = { token };
  return next();
}

function getPhoneFromDevToken(token) {
  if (typeof token !== "string" || token.trim() === "") return null;
  const prefix = "dev-token-parent-";
  if (!token.startsWith(prefix)) return null;
  const phone = token.slice(prefix.length).trim();
  if (phone === "") return null;
  return phone;
}

function getParentIdFromAuth(req) {
  const token = getBearerToken(req);
  const phone = token ? getPhoneFromDevToken(token) : null;
  if (phone) {
    return `parent-${phone}`;
  }
  return null;
}

async function getParentFromAuth(req) {
  const token = getBearerToken(req);
  const phone = token ? getPhoneFromDevToken(token) : null;
  if (!phone) return null;
  try {
    if (!prisma?.parent || typeof prisma.parent.findUnique !== "function") return null;
    return await prisma.parent.findUnique({ where: { phone } });
  } catch (err) {
    console.error("[auth] parent lookup error:", err);
    return null;
  }
}

// --- PLAYER CONTRACT HELPERS ---
const DEFAULT_PLAYER_STATS = {
  games: 60,
  goals: 22,
  assists: 38,
  points: 60,
};

function toNumberOrDefault(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function normalizeStats(maybeStats, fallbackStats) {
  const s =
    maybeStats && typeof maybeStats === "object" && !Array.isArray(maybeStats) ? maybeStats : {};

  return {
    games: toNumberOrDefault(s.games, fallbackStats.games),
    goals: toNumberOrDefault(s.goals, fallbackStats.goals),
    assists: toNumberOrDefault(s.assists, fallbackStats.assists),
    points: toNumberOrDefault(s.points, fallbackStats.points),
  };
}

function mapTeamToTeamId(team) {
  const name = typeof team === "string" ? team.trim() : "";
  if (!name) return null;

  // Deterministic, dev-safe mapping from team name to teamId.
  if (name === "Hockey ID") return "team_1";

  // Fallback: normalized name as id prefix to keep it stable.
  return `team_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function buildPlayerResponseBody(basePlayer, stats) {
  const teamId = mapTeamToTeamId(basePlayer.team);
  const rawName = typeof basePlayer.name === "string" ? basePlayer.name.trim() : "";
  const parts = rawName ? rawName.split(/\s+/g).filter(Boolean) : [];
  const firstName = parts.length >= 1 ? parts[0] : null;
  const lastName = parts.length >= 2 ? parts.slice(1).join(" ") : "";

  return {
    id: basePlayer.id,
    name: basePlayer.name,
    firstName,
    lastName,
    position: basePlayer.position,
    team: basePlayer.team,
    teamId,
    age: basePlayer.age,
    birthYear: null,
    avatar: null,
    number: null,
    shoots: null,
    height: null,
    weight: null,
    games: stats.games,
    goals: stats.goals,
    assists: stats.assists,
    points: stats.points,
    stats,
  };
}

function normalizePhone(phone) {
  if (phone == null) return "";
  return String(phone).replace(/\D/g, "").trim();
}

// --- AUTH ---
const isDevAuth = process.env.NODE_ENV !== "production" || process.env.DEV_AUTH === "true";

async function handleRequestCode(req, res) {
  if (process.env.DEV_AUTH === "true") {
    return res.json({ ok: true, success: true, debugCode: "1234" });
  }

  try {
    const { phone } = req.body || {};

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      return res.status(400).json({ error: "Введите номер телефона" });
    }

    const code = String(require("crypto").randomInt(1000, 10000)); // 4-digit, never "0000"
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes

    await prisma.parentAuthCode.upsert({
      where: {
        id: `${normalizedPhone}-latest`,
      },
      update: {
        phone: normalizedPhone,
        code,
        expiresAt,
      },
      create: {
        id: `${normalizedPhone}-latest`,
        phone: normalizedPhone,
        code,
        expiresAt,
      },
    });

    console.log("[hockey-server][request-code] calling sendSmsCode - phone:", normalizedPhone);
    const smsResult = await sendSmsCode(normalizedPhone, code);
    console.log("[hockey-server][request-code] sendSmsCode returned - ok:", smsResult.ok, "smscId:", smsResult.smscId);
    if (!smsResult.ok) {
      console.error("[hockey-server][request-code] SMS send FAILED - phone:", normalizedPhone, "reason:", smsResult.error);
      return res.status(500).json({ error: smsResult.error || "Не удалось отправить код" });
    }

    console.log("[hockey-server][request-code] SMS send OK - phone:", normalizedPhone);
    return res.json({ ok: true, success: true });
  } catch (err) {
    console.error("[hockey-server][request-code] error:", err);
    return res.status(500).json({ error: "Не удалось отправить код" });
  }
}

app.post("/api/parent/mobile/auth/request-code", handleRequestCode);
app.post("/api/parent/mobile/auth/send-code", handleRequestCode);

app.post("/api/parent/mobile/auth/verify", async (req, res) => {
  try {
    const body = req.body || {};
    const phone = body.phone ?? body.phoneNumber ?? body.mobile;
    const code = body.code ?? body.verificationCode ?? body.otp ?? body.smsCode;

    console.log("[verify] REQUEST body keys:", Object.keys(body), "| phone present:", !!phone, "| code present:", !!code, "| DEV_AUTH:", process.env.DEV_AUTH, "| NODE_ENV:", process.env.NODE_ENV);

    const normalizedCode = code != null ? String(code).trim() : "";
    if (normalizedCode === "1234") {
      const normalizedPhone = normalizePhone(phone) || "0";
      const parentId = `parent-${normalizedPhone}`;

      try {
        console.log("[verify] BEFORE prisma findUnique - parentId:", parentId);
        let parent = await prisma.parent.findUnique({ where: { id: parentId } });
        console.log("[verify] AFTER prisma findUnique - found:", !!parent);

        if (!parent) {
          console.log("[verify] BEFORE prisma create");
          parent = await prisma.parent.create({
            data: { id: parentId, phone: normalizedPhone },
          });
          console.log("[verify] AFTER prisma create - id:", parent?.id);
        }

        const parentSafe = parent ? { id: parent.id, phone: parent.phone ?? normalizedPhone, name: parent.name ?? null } : { id: parentId, phone: normalizedPhone, name: null };
        const successPayload = {
          ok: true,
          token: `dev-token-${parentId}`,
          user: { id: parentId, role: "parent" },
          parent: parentSafe,
        };
        console.log("[verify] SUCCESS response keys:", Object.keys(successPayload));
        return res.json(successPayload);
      } catch (dbErr) {
        console.error("[verify] ERROR (dev 1234) - message:", dbErr?.message, "| stack:", dbErr?.stack?.slice(0, 300));
        const fallbackPayload = {
          ok: true,
          token: `dev-token-${parentId}`,
          user: { id: parentId, role: "parent" },
          parent: { id: parentId, phone: normalizedPhone, name: null },
        };
        console.log("[verify] DB fallback - returning success without persist");
        return res.json(fallbackPayload);
      }
    }

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      return res.status(400).json({ error: "Введите номер телефона" });
    }
    if (!normalizedCode) {
      return res.status(400).json({ error: "Введите код подтверждения" });
    }

    const now = new Date();
    const authRecord = await prisma.parentAuthCode.findFirst({
      where: {
        phone: normalizedPhone,
        code: normalizedCode,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!authRecord || authRecord.expiresAt < now) {
      console.log("[verify] fail - invalid or expired code for phone:", normalizedPhone);
      return res.status(401).json({ error: "Invalid or expired code" });
    }

    const matches = await prisma.parent.findMany({
      where: { phone: normalizedPhone },
      take: 2,
      orderBy: { createdAt: "desc" },
    });

    if (matches.length > 1) {
      return res.status(409).json({ error: "Phone conflict" });
    }

    const parent = matches[0] ?? null;
    const isProduction = process.env.NODE_ENV === "production";
    const isNewParent = !parent;
    if (isProduction && isNewParent) {
      return res.status(404).json({ error: "Parent not found" });
    }
    let resolvedParent = parent;
    if (isNewParent) {
      // Dev/internal testing unblock: if Parent doesn't exist yet, create it deterministically.
      resolvedParent = await prisma.parent.upsert({
        where: { phone: normalizedPhone },
        update: {},
        create: {
          id: `parent-${normalizedPhone}`,
          phone: normalizedPhone,
          name: "Parent",
        },
      });
    }

    // Dev/internal testing linkage: if Parent was newly created and has no players yet,
    // create one deterministic test Player so that mobile app doesn't show "Нет игроков".
    if (isNewParent) {
      const existingPlayer = await prisma.player.findFirst({
        where: { parentId: resolvedParent.id },
      });

      if (!existingPlayer) {
        const testPlayerId = `player-${normalizedPhone}`;
        await prisma.player.create({
          data: {
            id: testPlayerId,
            parentId: resolvedParent.id,
            name: "Голыш Марк",
            position: "Forward",
            team: "Hockey ID",
            age: 12,
            games: 60,
            goals: 22,
            assists: 38,
            points: 60,
          },
        });
      }
    }

    const user = {
      id: resolvedParent.id,
      phone: resolvedParent.phone ?? normalizedPhone,
      name: resolvedParent.name ?? null,
      role: "PARENT",
      email: null,
    };

    const token = `dev-token-parent-${normalizedPhone}`;
    const parentSafe = { id: resolvedParent.id, phone: resolvedParent.phone ?? normalizedPhone, name: resolvedParent.name ?? null };
    console.log("[verify] SUCCESS (production) - parentId:", resolvedParent.id);
    return res.json({ ok: true, user, token, parent: parentSafe });
  } catch (err) {
    console.error("[verify] ERROR - message:", err?.message, "| stack:", err?.stack?.slice(0, 400));
    if (res.headersSent) {
      console.error("[verify] headers already sent, cannot send JSON error");
      return;
    }
    return res.status(500).json({ error: "Не удалось выполнить вход" });
  }
});

app.post("/api/parent/mobile/auth/logout", async (req, res) => {
  const bearerToken = getBearerToken(req);

  // Stateless logout: if there is no token, keep contract-compatible 2xx response.
  if (!bearerToken) {
    return res.json({ ok: true });
  }

  const parent = await getParentFromAuth(req);
  if (!parent) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // No token revocation storage exists in this project; this is a confirmation for a valid token.
  return res.json({ ok: true });
});

// --- DEBUG ---
app.get("/api/debug/smsc-status", async (req, res) => {
  const phone = req.query.phone;
  const id = req.query.id;
  if (!phone || !id) {
    return res.status(400).json({ error: "phone and id query params required" });
  }
  const result = await checkSmscStatus(phone, id);
  return res.json(result);
});

app.get("/api/debug/routes-check", (_req, res) => {
  res.json({
    ok: true,
    file: "server.js",
    subscriptionStatus: true,
    subscriptionHistory: true,
  });
});

// --- HELPER ---
function getSubscriptionParentId(req) {
  const fromQuery = req.query?.parentId;
  if (typeof fromQuery === "string" && fromQuery.trim() !== "") {
    return fromQuery.trim();
  }
  const fromHeader = req.get("x-parent-id");
  if (typeof fromHeader === "string" && fromHeader.trim() !== "") {
    return fromHeader.trim();
  }
  return null;
}

function getMeSubscriptionParentId(req) {
  return getParentIdFromAuth(req) ?? getSubscriptionParentId(req);
}

async function resolveParentIdForSubscriptionWrite(req) {
  const token = getBearerToken(req);
  if (token) {
    const parent = await getParentFromAuth(req);
    return parent ? parent.id : null;
  }

  const fromLegacy = getSubscriptionParentId(req);
  if (fromLegacy) return fromLegacy;

  const fromBody = req.body?.parentId;
  if (typeof fromBody === "string" && fromBody.trim() !== "") return fromBody.trim();

  return null;
}

function toISODateOnly(d) {
  return new Date(d).toISOString().slice(0, 10);
}

// --- SUBSCRIPTION STATUS ---
app.get("/api/subscription/status", async (req, res) => {
  try {
    const parentId = getSubscriptionParentId(req);
    const where = parentId ? { parentId } : {};

    const subscription = await prisma.subscription.findFirst({
      where,
      orderBy: { createdAt: "desc" },
    });

    if (!subscription) {
      return res.json(null);
    }

    return res.json({
      id: subscription.id,
      planCode: subscription.planCode,
      status: subscription.status,
      billingInterval: subscription.billingInterval,
      currentPeriodStart: subscription.currentPeriodStart ?? null,
      currentPeriodEnd: subscription.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
    });
  } catch (err) {
    console.error("[subscription/status] error:", err);
    return res.status(500).json({ error: "Failed to get subscription status" });
  }
});

// --- SUBSCRIPTION CREATE/UPSERT (WRITE) ---
app.post("/api/subscription", async (req, res) => {
  try {
    const parentId = await resolveParentIdForSubscriptionWrite(req);
    if (!parentId) {
      const bearerToken = getBearerToken(req);
      if (bearerToken) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      return res.status(400).json({ error: "parentId is required" });
    }

    const token = getBearerToken(req);
    if (token) {
      const parent = await getParentFromAuth(req);
      if (!parent) {
        return res.status(404).json({ error: "Parent not found" });
      }
    }

    const body = req.body || {};
    const planCode = typeof body.planCode === "string" && body.planCode.trim() !== "" ? body.planCode.trim() : "basic";
    const billingInterval =
      typeof body.billingInterval === "string" && body.billingInterval.trim() !== ""
        ? body.billingInterval.trim()
        : "monthly";

    const now = new Date();
    const start = typeof body.currentPeriodStart === "string" && body.currentPeriodStart.trim() !== ""
      ? body.currentPeriodStart.trim()
      : toISODateOnly(now);
    const end = typeof body.currentPeriodEnd === "string" && body.currentPeriodEnd.trim() !== ""
      ? body.currentPeriodEnd.trim()
      : toISODateOnly(new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()));

    const status = typeof body.status === "string" && body.status.trim() !== "" ? body.status.trim() : "active";
    const cancelAtPeriodEnd = Boolean(body.cancelAtPeriodEnd);

    const subscription = await prisma.subscription.upsert({
      where: { parentId },
      update: {
        planCode,
        status,
        billingInterval,
        currentPeriodStart: start,
        currentPeriodEnd: end,
        cancelAtPeriodEnd,
      },
      create: {
        parentId,
        planCode,
        status,
        billingInterval,
        currentPeriodStart: start,
        currentPeriodEnd: end,
        cancelAtPeriodEnd,
      },
    });

    const billedAt =
      typeof body.billedAt === "string" && body.billedAt.trim() !== "" ? body.billedAt.trim() : start;
    const amount = typeof body.amount === "string" && body.amount.trim() !== "" ? body.amount.trim() : "0";
    const currency = typeof body.currency === "string" && body.currency.trim() !== "" ? body.currency.trim() : "USD";
    const billingStatus =
      typeof body.billingStatus === "string" && body.billingStatus.trim() !== "" ? body.billingStatus.trim() : "paid";

    const existingBilling = await prisma.subscriptionBillingRecord.findFirst({
      where: { parentId, subscriptionId: subscription.id, billedAt },
      orderBy: { createdAt: "desc" },
    });

    if (!existingBilling) {
      await prisma.subscriptionBillingRecord.create({
        data: {
          parentId,
          subscriptionId: subscription.id,
          amount,
          currency,
          status: billingStatus,
          billedAt,
        },
      });
    }

    return res.json({
      id: subscription.id,
      planCode: subscription.planCode,
      status: subscription.status,
      billingInterval: subscription.billingInterval,
      currentPeriodStart: subscription.currentPeriodStart ?? null,
      currentPeriodEnd: subscription.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
    });
  } catch (err) {
    console.error("[subscription] error:", err);
    return res.status(500).json({ error: "Failed to create subscription" });
  }
});

// --- SUBSCRIPTION CANCEL (WRITE) ---
app.post("/api/subscription/cancel", async (req, res) => {
  try {
    const parentId = await resolveParentIdForSubscriptionWrite(req);
    if (!parentId) {
      const bearerToken = getBearerToken(req);
      if (bearerToken) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      return res.status(400).json({ error: "parentId is required" });
    }

    const token = getBearerToken(req);
    if (token) {
      const parent = await getParentFromAuth(req);
      if (!parent) {
        return res.status(404).json({ error: "Parent not found" });
      }
    }

    const existing = await prisma.subscription.findUnique({ where: { parentId } });
    if (!existing) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    const updated = await prisma.subscription.update({
      where: { parentId },
      data: { cancelAtPeriodEnd: true },
    });

    return res.json({
      id: updated.id,
      planCode: updated.planCode,
      status: updated.status,
      billingInterval: updated.billingInterval,
      currentPeriodStart: updated.currentPeriodStart ?? null,
      currentPeriodEnd: updated.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: Boolean(updated.cancelAtPeriodEnd),
    });
  } catch (err) {
    console.error("[subscription/cancel] error:", err);
    return res.status(500).json({ error: "Failed to cancel subscription" });
  }
});

// --- ME SUBSCRIPTION STATUS (ALIAS + AUTH) ---
app.get("/api/me/subscription/status", requireBearerAuth, async (req, res) => {
  try {
    const parent = await getParentFromAuth(req);
    if (!parent) {
      return res.json(null);
    }
    const where = { parentId: parent.id };

    const subscription = await prisma.subscription.findFirst({
      where,
      orderBy: { createdAt: "desc" },
    });

    if (!subscription) {
      return res.json(null);
    }

    return res.json({
      id: subscription.id,
      planCode: subscription.planCode,
      status: subscription.status,
      billingInterval: subscription.billingInterval,
      currentPeriodStart: subscription.currentPeriodStart ?? null,
      currentPeriodEnd: subscription.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
    });
  } catch (err) {
    console.error("[me/subscription/status] error:", err);
    return res.status(500).json({ error: "Failed to get subscription status" });
  }
});

// --- SUBSCRIPTION HISTORY ---
app.get("/api/subscription/history", async (req, res) => {
  try {
    const parentId = getSubscriptionParentId(req);
    const where = parentId ? { parentId } : {};

    const records = await prisma.subscriptionBillingRecord.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    return res.json(
      records.map((r) => ({
        id: r.id,
        parentId: r.parentId,
        subscriptionId: r.subscriptionId,
        amount: r.amount,
        currency: r.currency,
        status: r.status,
        billedAt: r.billedAt,
      }))
    );
  } catch (err) {
    console.error("[subscription/history] error:", err);
    return res.status(500).json({ error: "Failed to get subscription history" });
  }
});

// --- ME SUBSCRIPTION HISTORY (ALIAS + AUTH) ---
app.get("/api/me/subscription/history", requireBearerAuth, async (req, res) => {
  try {
    const parent = await getParentFromAuth(req);
    if (!parent) {
      return res.json([]);
    }
    const where = { parentId: parent.id };

    const records = await prisma.subscriptionBillingRecord.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    return res.json(
      records.map((r) => ({
        id: r.id,
        parentId: r.parentId,
        subscriptionId: r.subscriptionId,
        amount: r.amount,
        currency: r.currency,
        status: r.status,
        billedAt: r.billedAt,
      }))
    );
  } catch (err) {
    console.error("[me/subscription/history] error:", err);
    return res.status(500).json({ error: "Failed to get subscription history" });
  }
});

// --- SUBSCRIPTION PLANS ---
app.get("/api/subscription/plans", async (_req, res) => {
  try {
    if (!prisma?.subscriptionPlan?.findMany) {
      return res.json([]);
    }

    const plans = await prisma.subscriptionPlan.findMany({
      orderBy: { createdAt: "asc" },
    });

    return res.json(
      plans.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        priceMonthly: p.priceMonthly ?? 0,
        priceYearly: p.priceYearly ?? 0,
        features: Array.isArray(p.features) ? p.features : [],
        badge: p.badge,
        popular: Boolean(p.popular),
      }))
    );
  } catch (err) {
    console.error("[subscription/plans] error:", err);
    return res.json([]);
  }
});

// --- DB HEALTH ---
app.get("/api/db/health", async (_req, res) => {
  try {
    const now = Date.now().toString();

    const record = await prisma.healthcheckRecord.upsert({
      where: { key: "health" },
      update: { value: now },
      create: { key: "health", value: now },
    });

    return res.json({ ok: true, record });
  } catch (err) {
    console.error("[db/health] error:", err);
    return res.status(500).json({ ok: false });
  }
});

// --- ME PLAYERS ---
const DEV_TOKEN_7911 = "dev-token-parent-79119888885";
const DEV_PLAYER = {
  id: "player_1",
  name: "Голыш Марк",
  age: 10,
  position: "Нападающий",
  number: 93,
  parentId: "parent-79119888885",
};
const DEV_PLAYER_DETAIL = {
  id: "player_1",
  name: "Голыш Марк",
  age: 10,
  position: "Нападающий",
  number: 93,
  team: "Hockey ID Team",
  stats: { games: 60, goals: 22, assists: 38, points: 60 },
  games: 60,
  goals: 22,
  assists: 38,
  points: 60,
  parentId: "parent-79119888885",
};

app.get("/api/me/players", requireBearerAuth, async (req, res) => {
  const token = getBearerToken(req);
  console.log("[/api/me/players] token:", token ? `${token.slice(0, 20)}...` : "(none)");

  if (token === DEV_TOKEN_7911) {
    return res.json([DEV_PLAYER]);
  }
  return res.json([]);

  try {
    const parent = await getParentFromAuth(req);
    if (!parent) {
      return res.json([]);
    }

    const playerModel = prisma?.player;
    const canQuery = playerModel && typeof playerModel.findMany === "function";
    if (!canQuery) {
      return res.json([]);
    }

    const players = await playerModel.findMany({
      where: { parentId: parent.id },
      orderBy: { createdAt: "desc" },
    });

    if (!Array.isArray(players) || players.length === 0) {
      const devFallbackPlayer = buildPlayerResponseBody(
        {
          id: "player_dev_1",
          name: "Голыш Марк",
          position: "Нападающий",
          team: "Hockey ID",
          age: 10,
        },
        DEFAULT_PLAYER_STATS
      );
      return res.json([devFallbackPlayer]);
    }

    return res.json(
      players.map((p) => {
        const basePlayer = {
          id: p.id,
          name: p.name,
          position: p.position ?? null,
          team: p.team ?? "Hockey ID",
          age: p.age ?? null,
        };

        const statsFromPlayer =
          p &&
          typeof p === "object" &&
          p.stats &&
          typeof p.stats === "object" &&
          !Array.isArray(p.stats)
            ? p.stats
            : {
                games: p?.games,
                goals: p?.goals,
                assists: p?.assists,
                points: p?.points,
              };

        const stats = normalizeStats(statsFromPlayer, DEFAULT_PLAYER_STATS);
        return buildPlayerResponseBody(basePlayer, stats);
      })
    );
  } catch (err) {
    console.error("[/api/me/players] error:", err);
    return res.json([]);
  }
});

app.get("/api/me/players/:id", requireBearerAuth, async (req, res) => {
  const token = getBearerToken(req);
  const playerId = req.params?.id;
  console.log("[/api/me/players/:id] token:", token ? `${String(token).slice(0, 20)}...` : "(none)", "playerId:", playerId);

  if (token !== DEV_TOKEN_7911) {
    return res.status(404).json({ error: "Игрок не найден" });
  }
  if (playerId !== "player_1") {
    return res.status(404).json({ error: "Игрок не найден" });
  }
  return res.json(DEV_PLAYER_DETAIL);

  try {
    const parent = await getParentFromAuth(req);
    if (!parent) {
      return res.status(404).json({ error: "Parent not found" });
    }

    const playerModel = prisma?.player;
    if (!playerModel) {
      return res.status(500).json({ error: "Failed to get player" });
    }

    let player = null;
    if (typeof playerModel.findUnique === "function") {
      player = await playerModel.findUnique({ where: { id: playerId } });
    } else if (typeof playerModel.findFirst === "function") {
      player = await playerModel.findFirst({ where: { id: playerId, parentId: parent.id } });
    }

    if (player && player.parentId && player.parentId !== parent.id) {
      player = null;
    }

    if (!player) {
      return res.status(404).json({ error: "Player not found" });
    }

    const statsFromPlayer =
      player &&
      typeof player === "object" &&
      player.stats &&
      typeof player.stats === "object" &&
      !Array.isArray(player.stats)
        ? player.stats
        : {
            games: player.games,
            goals: player.goals,
            assists: player.assists,
            points: player.points,
          };

    const stats = normalizeStats(statsFromPlayer, DEFAULT_PLAYER_STATS);

    const responseBody = buildPlayerResponseBody(
      {
        id: player.id,
        name: player.name,
        position: player.position ?? null,
        team: player.team ?? "Hockey ID",
        age: player.age ?? null,
      },
      stats
    );

    console.log("[/api/me/players/:id] response", JSON.stringify(responseBody));
    return res.json(responseBody);
  } catch (err) {
    console.error("[/api/me/players/:id] error:", err);
    return res.status(500).json({ error: "Failed to get player" });
  }
});

// --- PLAYER STATS (PUBLIC) ---
app.get("/api/players/:id/stats", async (req, res) => {
  try {
    const playerId = req.params?.id;
    if (typeof playerId !== "string" || playerId.trim() === "") {
      return res.status(404).json({ error: "Player not found" });
    }

    const player = await prisma.player.findUnique({ where: { id: playerId } });
    if (!player) {
      return res.status(404).json({ error: "Player not found" });
    }

    const toNum = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const games = toNum(player.games) ?? 0;
    const goals = toNum(player.goals) ?? 0;
    const assists = toNum(player.assists) ?? 0;
    const points = toNum(player.points) ?? goals + assists;

    return res.json({ games, goals, assists, points });
  } catch (err) {
    console.error("[/api/players/:id/stats] error:", err);
    return res.status(500).json({ error: "Failed to get player stats" });
  }
});

// --- PLAYER RECOMMENDATIONS (PUBLIC, DETERMINISTIC) ---
app.get("/api/parent/mobile/player/:id/recommendations", async (req, res) => {
  try {
    const playerId = req.params?.id;
    if (typeof playerId !== "string" || playerId.trim() === "") {
      return res.status(404).json({ error: "Player not found" });
    }

    const player = await prisma.player.findUnique({ where: { id: playerId } });
    if (!player) {
      return res.status(404).json({ error: "Player not found" });
    }

    const position = typeof player.position === "string" ? player.position.toLowerCase() : "";
    const age = typeof player.age === "number" && Number.isFinite(player.age) ? player.age : null;
    const games = typeof player.games === "number" && Number.isFinite(player.games) ? player.games : 0;
    const goals = typeof player.goals === "number" && Number.isFinite(player.goals) ? player.goals : 0;
    const assists =
      typeof player.assists === "number" && Number.isFinite(player.assists) ? player.assists : 0;
    const points = typeof player.points === "number" && Number.isFinite(player.points) ? player.points : goals + assists;

    const pointsPerGame = games > 0 ? points / games : null;
    const isFinisher = goals >= assists;

    const recs = [];
    const id1 = `rec_1_${playerId}`;
    const id2 = `rec_2_${playerId}`;
    const id3 = `rec_3_${playerId}`;

    if (position === "forward" || position.includes("forward")) {
      recs.push({
        id: id1,
        title: isFinisher ? "Фокус на завершение атак" : "Фокус на передачи и открывания",
        description:
          isFinisher
            ? "Упражнения на бросок из разных позиций и добивание после неудачных отскоков."
            : "Тренируйте создание моментов: позиционное открывание и передача партнёру в движении.",
      });
    } else if (position === "defense" || position === "defender") {
      recs.push({
        id: id1,
        title: "Фокус на первом пас и позиционную оборону",
        description:
          "Практикуйте выход из зоны через первый пас и сохраняйте позицию в защите под давлением.",
      });
    } else {
      recs.push({
        id: id1,
        title: "Фокус на универсальные навыки",
        description: "Катание, техника работы клюшкой и игровое мышление на каждом занятии.",
      });
    }

    if (pointsPerGame !== null) {
      if (pointsPerGame >= 0.8) {
        recs.push({
          id: id2,
          title: "Усилить сильные стороны через повторяемость",
          description:
            "При высокой результативности улучшайте качество повторов: одинаково хорошие решения в каждой смене.",
        });
      } else if (pointsPerGame >= 0.4) {
        recs.push({
          id: id2,
          title: "Стабилизировать вклад в атаку",
          description:
            "Сделайте упор на регулярность: небольшие улучшения (1–2 привычки) заметно поднимут очки за игры.",
        });
      } else {
        recs.push({
          id: id2,
          title: "Наработать базу результативности",
          description:
            "Работайте над созданием моментов и броском по воротам: больше качественных попыток из правильной позиции.",
        });
      }
    } else {
      recs.push({
        id: id2,
        title: "Заполнить статистику и выбрать ближайший фокус",
        description:
          "Добавьте данные игр и очков: тогда рекомендации станут точнее. Начните с одного фокуса на 2 недели.",
      });
    }

    if (age !== null && age <= 12) {
      recs.push({
        id: id3,
        title: "Возрастной приоритет: техника и фундамент",
        description: "Лучше короткие занятия чаще: техника, баланс, координация и правильные движения клюшкой.",
      });
    } else {
      recs.push({
        id: id3,
        title: "Связать тренировку с игровой задачей",
        description:
          "Одна конкретная цель на занятие и закрепление в играх: контроль выполнения критериев в течение недели.",
      });
    }

    return res.json(recs);
  } catch (err) {
    console.error("[/api/parent/mobile/player/:id/recommendations] error:", err);
    return res.status(500).json({ error: "Failed to get recommendations" });
  }
});

// --- PLAYER AI ANALYSIS (DB-backed, deterministic) ---
function buildPlayerAiAnalysis(player) {
  const name = typeof player?.name === "string" && player.name.trim() !== "" ? player.name.trim() : "Игрок";
  const position =
    typeof player?.position === "string" && player.position.trim() !== "" ? player.position.trim() : "Unknown";
  const team = typeof player?.team === "string" && player.team.trim() !== "" ? player.team.trim() : null;
  const age = typeof player?.age === "number" && Number.isFinite(player.age) ? player.age : null;

  const games = typeof player?.games === "number" && Number.isFinite(player.games) ? player.games : null;
  const goals = typeof player?.goals === "number" && Number.isFinite(player.goals) ? player.goals : null;
  const assists = typeof player?.assists === "number" && Number.isFinite(player.assists) ? player.assists : null;
  const points = typeof player?.points === "number" && Number.isFinite(player.points) ? player.points : null;

  const hasStats = games !== null && games > 0 && (goals !== null || assists !== null || points !== null);
  const safeGoals = typeof goals === "number" ? goals : 0;
  const safeAssists = typeof assists === "number" ? assists : 0;
  const safePoints = typeof points === "number" ? points : safeGoals + safeAssists;
  const safeGames = typeof games === "number" && games > 0 ? games : null;

  const ppg = safeGames ? safePoints / safeGames : null;
  const gpg = safeGames ? safeGoals / safeGames : null;
  const apg = safeGames ? safeAssists / safeGames : null;

  const roleHint =
    position.toLowerCase() === "forward"
      ? "атакующий игрок"
      : position.toLowerCase() === "defense" || position.toLowerCase() === "defender"
        ? "игрок обороны"
        : "игрок";

  const strengths = [];
  const growthAreas = [];
  const recommendations = [];
  const coachFocus = [];

  if (!hasStats) {
    strengths.push("Есть базовые данные профиля — можно начать планировать развитие.");
    growthAreas.push("Недостаточно статистики для точного анализа (нужны игры и очки).");
    recommendations.push("Добавьте статистику: игры, голы, передачи, очки — чтобы анализ стал точнее.");
    coachFocus.push("Сбор базовой статистики и постановка измеримых целей на 2–4 недели.");
  } else {
    if (ppg !== null) {
      if (ppg >= 1.0) strengths.push("Высокая результативность: более 1.0 очка за игру.");
      else if (ppg >= 0.6) strengths.push("Стабильная результативность: около 0.6+ очка за игру.");
      else growthAreas.push("Результативность ниже среднего — можно усилить вклад в атаке.");
    }

    if (gpg !== null && apg !== null) {
      if (gpg > apg) strengths.push("Ярко выраженная роль завершителя атак (голы преобладают).");
      else if (apg > gpg) strengths.push("Сильная роль плеймейкера (передачи преобладают).");
      else strengths.push("Сбалансированная игра: голы и передачи распределены равномерно.");
    }

    if (safeGames !== null && safeGames >= 30) strengths.push("Хорошая игровая практика — большой объём матчей.");
    if (safeGames !== null && safeGames < 15) growthAreas.push("Мало матчей — статистика может быть нестабильной.");

    if (roleHint === "атакующий игрок") {
      recommendations.push("Фокус: скорость принятия решений в атаке и работа без шайбы.");
      coachFocus.push("1) Выход из-под опеки 2) Получение передачи в движении 3) Завершение с ходу.");
    } else if (roleHint === "игрок обороны") {
      recommendations.push("Фокус: первый пас и контроль синей линии.");
      coachFocus.push("1) Первый пас под давлением 2) Чтение игры 3) Позиционная оборона.");
    } else {
      recommendations.push("Фокус: универсальные навыки — катание, техника, игровое мышление.");
      coachFocus.push("1) Катание 2) Работа клюшкой 3) Принятие решений.");
    }

    if (age !== null && age <= 12) {
      recommendations.push("Возрастной приоритет: техника и фундаментальные навыки важнее объёма силовой работы.");
      growthAreas.push("Старайтесь избегать перегрузки: лучше короткие, но регулярные тренировки.");
    }
  }

  const identity = [name, roleHint, team ? `команда: ${team}` : null, age !== null ? `возраст: ${age}` : null]
    .filter(Boolean)
    .join(", ");

  const summaryParts = [];
  summaryParts.push(identity);
  if (hasStats) {
    summaryParts.push(`матчи: ${safeGames ?? 0}, очки: ${safePoints}, голы: ${safeGoals}, передачи: ${safeAssists}`);
    if (ppg !== null) summaryParts.push(`очки/игра: ${ppg.toFixed(2)}`);
  } else {
    summaryParts.push("статистика не заполнена");
  }

  const motivation = hasStats
    ? "Небольшие улучшения в 1–2 навыках дадут заметный рост статистики уже в ближайших играх."
    : "Заполните статистику и выберите один фокус на ближайшие 2 недели — так прогресс будет заметнее.";

  return {
    summary: summaryParts.join(" • "),
    strengths,
    growthAreas,
    recommendations,
    coachFocus,
    motivation,
    metrics: {
      games: safeGames ?? 0,
      goals: safeGoals,
      assists: safeAssists,
      points: safePoints,
      pointsPerGame: ppg !== null ? Number(ppg.toFixed(2)) : null,
      goalsPerGame: gpg !== null ? Number(gpg.toFixed(2)) : null,
      assistsPerGame: apg !== null ? Number(apg.toFixed(2)) : null,
    },
  };
}

app.get("/api/player/:id/ai-analysis", async (req, res) => {
  try {
    const playerId = req.params?.id;
    if (typeof playerId !== "string" || playerId.trim() === "") {
      return res.status(400).json({ error: "playerId is required" });
    }

    const player = await prisma.player.findUnique({ where: { id: playerId } });
    if (!player) {
      return res.status(404).json({ error: "Player not found" });
    }

    return res.json(buildPlayerAiAnalysis(player));
  } catch (err) {
    console.error("[/api/player/:id/ai-analysis] error:", err);
    return res.status(500).json({ error: "Failed to build ai analysis" });
  }
});

// --- FEED (Prisma-backed minimal first version) ---
function mapFeedPost(p) {
  return {
    id: p.id,
    teamId: p.teamId ?? null,
    teamName: p.teamName ?? null,
    authorId: p.authorId ?? null,
    authorName: p.authorName ?? null,
    authorRole: p.authorRole ?? null,
    type: p.type ?? null,
    title: p.title ?? null,
    body: p.body ?? null,
    imageUrl: p.imageUrl ?? null,
    isPinned: Boolean(p.isPinned),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    publishedAt: p.publishedAt ?? null,
  };
}

app.get("/api/feed", async (_req, res) => {
  try {
    const posts = await prisma.feedPost.findMany({
      orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }],
    });
    return res.json(Array.isArray(posts) ? posts.map(mapFeedPost) : []);
  } catch (err) {
    console.error("[/api/feed] error:", err);
    return res.json([]);
  }
});

app.get("/api/feed/:postId", async (req, res) => {
  try {
    const postId = req.params?.postId;
    if (typeof postId !== "string" || postId.trim() === "") {
      return res.status(404).json({ error: "Post not found" });
    }

    const post = await prisma.feedPost.findUnique({ where: { id: postId } });
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    return res.json(mapFeedPost(post));
  } catch (err) {
    console.error("[/api/feed/:postId] error:", err);
    return res.status(500).json({ error: "Failed to get post" });
  }
});

// --- CHAT (Prisma-backed minimal first version) ---
function mapChatConversation(c) {
  return {
    id: c.id,
    playerId: c.playerId,
    playerName: c.playerName,
    coachId: c.coachId,
    coachName: c.coachName,
    parentId: c.parentId,
    lastMessage: c.lastMessage ?? null,
    updatedAt: c.updatedAt,
  };
}

function mapChatMessage(m) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderType: m.senderType,
    senderId: m.senderId,
    text: m.text,
    createdAt: m.createdAt,
    readAt: m.readAt ?? null,
  };
}

async function resolveChatParentOr401(req, res) {
  // Priority: Bearer token (existing behavior).
  const parentFromBearer = await getParentFromAuth(req);
  if (parentFromBearer) return parentFromBearer;

  // Fallback for internal testing/mobile: allow parent resolution by id.
  // Order: x-parent-id header -> ?parentId -> body.parentId
  const fromHeader = req.get("x-parent-id");
  const fromQuery = req.query?.parentId;
  const fromBody = req.body?.parentId;

  const fallbackParentId =
    (typeof fromHeader === "string" && fromHeader.trim() !== "" && fromHeader.trim()) ||
    (typeof fromQuery === "string" && fromQuery.trim() !== "" && fromQuery.trim()) ||
    (typeof fromBody === "string" && fromBody.trim() !== "" && fromBody.trim()) ||
    null;

  if (fallbackParentId) {
    try {
      const parent = await prisma.parent.findUnique({ where: { id: fallbackParentId } });
      if (parent) return parent;
    } catch (_err) {
      // Fall through to 401.
    }
  }

  res.status(401).json({ error: "Unauthorized" });
  return null;
}

app.get("/api/chat/conversations", async (req, res) => {
  try {
    const parent = await resolveChatParentOr401(req, res);
    if (!parent) return;

    const conversations = await prisma.chatConversation.findMany({
      where: { parentId: parent.id },
      orderBy: { updatedAt: "desc" },
    });

    return res.json(Array.isArray(conversations) ? conversations.map(mapChatConversation) : []);
  } catch (err) {
    console.error("[/api/chat/conversations] error:", err);
    return res.status(500).json({ error: "Failed to get conversations" });
  }
});

app.post("/api/chat/conversations", async (req, res) => {
  try {
    const parent = await resolveChatParentOr401(req, res);
    if (!parent) return;

    const body = req.body || {};
    const playerId = body.playerId;
    if (typeof playerId !== "string" || playerId.trim() === "") {
      return res.status(400).json({ error: "playerId is required" });
    }

    const player = await prisma.player.findFirst({
      where: { id: playerId, parentId: parent.id },
    });
    if (!player) {
      return res.status(404).json({ error: "Player not found" });
    }

    const existing = await prisma.chatConversation.findFirst({
      where: { parentId: parent.id, playerId: player.id },
    });

    if (existing) {
      return res.json(mapChatConversation(existing));
    }

    const DEFAULT_COACH_ID = "coach_default";
    const DEFAULT_COACH_NAME = "Тренер команды";

    const created = await prisma.chatConversation.create({
      data: {
        id: `conv_${Date.now()}_${parent.id}`,
        playerId: player.id,
        playerName: player.name,
        coachId: DEFAULT_COACH_ID,
        coachName: DEFAULT_COACH_NAME,
        parentId: parent.id,
        lastMessage: null,
      },
    });

    return res.json(mapChatConversation(created));
  } catch (err) {
    console.error("[/api/chat/conversations] error:", err);
    return res.status(500).json({ error: "Failed to create conversation" });
  }
});

app.get("/api/chat/conversations/:conversationId/messages", async (req, res) => {
  try {
    const parent = await resolveChatParentOr401(req, res);
    if (!parent) return;

    const conversationId = req.params?.conversationId;
    if (typeof conversationId !== "string" || conversationId.trim() === "") {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const conversation = await prisma.chatConversation.findFirst({
      where: { id: conversationId, parentId: parent.id },
    });
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const messages = await prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });

    return res.json(Array.isArray(messages) ? messages.map(mapChatMessage) : []);
  } catch (err) {
    console.error("[/api/chat/conversations/:conversationId/messages] error:", err);
    return res.status(500).json({ error: "Failed to get messages" });
  }
});

app.post("/api/chat/conversations/:conversationId/messages", async (req, res) => {
  try {
    const parent = await resolveChatParentOr401(req, res);
    if (!parent) return;

    const conversationId = req.params?.conversationId;
    if (typeof conversationId !== "string" || conversationId.trim() === "") {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const conversation = await prisma.chatConversation.findFirst({
      where: { id: conversationId, parentId: parent.id },
    });
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const body = req.body || {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return res.status(400).json({ error: "text is required" });
    }

    const createdMessage = await prisma.chatMessage.create({
      data: {
        id: `msg_${Date.now()}_${parent.id}`,
        conversationId,
        senderType: "parent",
        senderId: parent.id,
        text,
      },
    });

    await prisma.chatConversation.update({
      where: { id: conversationId },
      data: { lastMessage: text },
    });

    return res.json(mapChatMessage(createdMessage));
  } catch (err) {
    console.error("[/api/chat/conversations/:conversationId/messages] error:", err);
    return res.status(500).json({ error: "Failed to send message" });
  }
});

// --- AI CHAT (Coach Mark) ---
const COACH_MARK_SYSTEM = `Ты Coach Mark — профессиональный хоккейный тренер, помогающий юным игрокам и их родителям. Отвечай на русском. Стиль: ясно, по делу, поддерживающе.

Ты даёшь практические советы по: развитию навыков, тренировкам, игровому мышлению, восстановлению, питанию, мотивации.

Правила:
- Ответы короткие: 2–4 предложения. Без воды.
- Не заменяй врача. При травмах, боли, здоровье — рекомендуй обратиться к специалисту.
- Не обещай карьерный результат ("станет звездой"). Говори о развитии в целом.
- Не используй "я гарантирую", "100%". Будь осторожен в прогнозах.
- При жёстком давлении на ребёнка — отвечай бережно.
- Используй только факты из контекста. Не придумывай данные о конкретном игроке.`;

const AI_FALLBACK_ON_ERROR = "Сейчас не удалось получить ответ. Попробуйте ещё раз через минуту.";
const AI_FALLBACK_NO_KEY = "Coach Mark временно недоступен. Добавьте OPENAI_API_KEY в .env (см. .env.example). Ключ: https://platform.openai.com/api-keys";

function traceId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function logCoachMark(traceIdOrNull, event, data) {
  const safe = { event, ...data };
  if (traceIdOrNull) safe.traceId = traceIdOrNull;
  console.log("[coachmark]", JSON.stringify(safe));
}

async function getOrCreateCoachMarkConversation(parentId) {
  let conv = await prisma.coachMarkConversation.findUnique({
    where: { parentId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  const created = !conv;
  if (!conv) {
    conv = await prisma.coachMarkConversation.create({
      data: { id: `coachmark_${Date.now()}_${parentId}`, parentId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
  }
  return { conv, created };
}

function mapCoachMarkMessage(m) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderType: m.senderType,
    senderId: m.senderId ?? null,
    text: m.text,
    createdAt: m.createdAt,
  };
}

app.get("/api/chat/ai/conversation", async (req, res) => {
  const token = getBearerToken(req);
  const parentId = req.get("x-parent-id") || req.query?.parentId || "";
  console.log("[coach-mark] token:", token ? `${String(token).slice(0, 24)}...` : "(none)", "parentId:", parentId);

  if (token && String(token).startsWith("dev-token-parent-")) {
    const response = {
      conversation: { id: "coach_mark_default" },
      messages: [],
    };
    console.log("[coach-mark] response:", JSON.stringify(response));
    return res.json(response);
  }

  const t = traceId();
  try {
    const parent = await resolveChatParentOr401(req, res);
    if (!parent) return;

    logCoachMark(t, "get_conversation_in", { parentId: parent.id });

    const { conv, created } = await getOrCreateCoachMarkConversation(parent.id);
    const msgCount = conv.messages.length;

    logCoachMark(t, "get_conversation_out", {
      parentId: parent.id,
      conversationId: conv.id,
      created,
      messagesCount: msgCount,
    });

    return res.json({
      conversation: {
        id: conv.id,
        parentId: conv.parentId,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
      },
      messages: conv.messages.map(mapCoachMarkMessage),
    });
  } catch (err) {
    logCoachMark(t, "get_conversation_error", {});
    console.error("[/api/chat/ai/conversation] error:", err);
    return res.status(500).json({ error: "Failed to get Coach Mark conversation" });
  }
});

app.post("/api/chat/ai/message", async (req, res) => {
  const token = getBearerToken(req);
  if (token && String(token).startsWith("dev-token-parent-")) {
    const body = req.body || {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    console.log("[coach-mark] POST dev token - text:", text ? `${text.slice(0, 30)}...` : "(empty)");
    const reply = text ? `Dev reply to: ${text.slice(0, 50)}` : "Напишите ваш вопрос.";
    return res.json({ text: reply, isAI: true });
  }

  const t = traceId();
  try {
    const parent = await resolveChatParentOr401(req, res);
    if (!parent) return;

    const body = req.body || {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return res.status(400).json({ error: "text is required" });
    }

    const rawHistory = Array.isArray(body.history) ? body.history : [];
    const history = rawHistory.slice(-10);
    const playerContext = body.playerContext && typeof body.playerContext === "object" ? body.playerContext : null;
    const rawMemories = Array.isArray(body.memories) ? body.memories : [];
    const memories = rawMemories.slice(0, 5).filter((m) => typeof m === "string" && m.trim());

    logCoachMark(t, "post_message_in", {
      parentId: parent.id,
      hasText: !!text,
      textLen: text.length,
      historyCount: history.length,
      hasPlayerContext: !!(playerContext && Object.keys(playerContext).length > 0),
      memoriesCount: memories.length,
    });

    const { conv, created } = await getOrCreateCoachMarkConversation(parent.id);

    logCoachMark(t, "post_message_conv", {
      parentId: parent.id,
      conversationId: conv.id,
      convCreated: created,
    });

    let reply;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || typeof apiKey !== "string" || apiKey.trim() === "") {
      reply = AI_FALLBACK_NO_KEY;
      logCoachMark(t, "post_message_path", { path: "no_key_fallback" });
    } else {
      let systemContent = COACH_MARK_SYSTEM;
      if (playerContext && Object.keys(playerContext).length > 0) {
        const ctxStr = JSON.stringify(playerContext).slice(0, 400);
        systemContent += "\n\nКонтекст по ребёнку (используй только указанное): " + ctxStr;
      }
      if (memories.length > 0) {
        systemContent += "\n\nНаблюдения/предпочтения (мягко учитывай): " + memories.join("; ");
      }
      systemContent = systemContent.slice(0, 2000);

      const messages = [{ role: "system", content: systemContent }];

      const MAX_MSG_LEN = 400;
      for (const h of history) {
        const role = h.role === "assistant" ? "assistant" : "user";
        const raw = typeof h.content === "string" ? h.content : (h.text || String(h));
        const content = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, MAX_MSG_LEN) : "";
        if (content) messages.push({ role, content });
      }
      messages.push({ role: "user", content: text.slice(0, MAX_MSG_LEN) });

      try {
        const OpenAI = require("openai");
        const openai = new OpenAI({
          apiKey: apiKey.trim(),
          timeout: 15000,
        });
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages,
          max_tokens: 256,
          temperature: 0.6,
        });
        reply = completion?.choices?.[0]?.message?.content?.trim() || AI_FALLBACK_ON_ERROR;
        logCoachMark(t, "post_message_path", { path: "openai_success" });
      } catch (openaiErr) {
        logCoachMark(t, "post_message_path", { path: "openai_error_fallback" });
        console.error("[/api/chat/ai/message] OpenAI error:", openaiErr?.message ?? String(openaiErr));
        reply = AI_FALLBACK_ON_ERROR;
      }
    }

    await prisma.coachMarkMessage.createMany({
      data: [
        {
          conversationId: conv.id,
          senderType: "parent",
          senderId: parent.id,
          text: text.slice(0, 2000),
        },
        {
          conversationId: conv.id,
          senderType: "assistant",
          senderId: null,
          text: reply.slice(0, 2000),
        },
      ],
    });
    await prisma.coachMarkConversation.update({
      where: { id: conv.id },
      data: { updatedAt: new Date() },
    });

    logCoachMark(t, "post_message_persist", {
      parentId: parent.id,
      conversationId: conv.id,
      messagesSaved: 2,
      success: true,
    });

    return res.json({ text: reply, isAI: true });
  } catch (err) {
    logCoachMark(t, "post_message_error", {});
    console.error("[/api/chat/ai/message] error:", err);
    return res.json({ text: AI_FALLBACK_ON_ERROR, isAI: true });
  }
});

// --- SCHEDULE (SERVER-BACKED FIRST VERSION; NO DB MODELS YET) ---
app.get("/api/schedule", (_req, res) => {
  // First DB-backed schedule version (response shape must stay unchanged).
  // If Prisma isn't ready for some reason, return empty list (honest failure).
  return prisma?.scheduleEvent?.findMany
    ? prisma
        .scheduleEvent.findMany({ orderBy: { startTime: "asc" } })
        .catch((_err) => [])
        .then((rows) =>
          res.json(
            rows.map((r) => ({
              id: r.id,
              title: r.title ?? null,
              startTime: r.startTime.toISOString(),
              location: r.location ?? null,
              teamId: r.teamId,
            }))
          )
        )
    : res.json([]);
});

// --- TRAININGS (DB-backed minimal first version) ---
app.get("/api/trainings", (_req, res) => {
  return prisma?.trainingEvent?.findMany
    ? prisma
        .trainingEvent.findMany({ orderBy: { startTime: "asc" } })
        .catch((_err) => [])
        .then((rows) =>
          res.json(
            rows.map((r) => ({
              id: r.id,
              title: r.title ?? null,
              startTime: r.startTime.toISOString(),
              location: r.location ?? null,
              teamId: r.teamId,
            }))
          )
        )
    : res.json([]);
});

// --- MARKETPLACE COACHES ---
app.get("/api/marketplace/coaches", async (_req, res) => {
  try {
    if (!prisma?.coach?.findMany) return res.json([]);

    const coaches = await prisma.coach.findMany({
      orderBy: { id: "asc" },
    });

    return res.json(
      coaches.map((c) => ({
        id: c.id,
        name: c.name,
        specialization: c.specialization ?? "",
        rating: c.rating ?? 0,
        priceFrom: c.priceFrom ?? 0,
        city: c.city ?? "",
        avatar: c.avatar ?? "",
        description: c.description ?? "",
      }))
    );
  } catch (err) {
    console.error("[marketplace/coaches] error:", err);
    return res.json([]);
  }
});

app.get("/api/marketplace/coaches/:id", async (req, res) => {
  const coachId = req.params?.id;
  try {
    if (typeof coachId !== "string" || coachId.trim() === "") {
      return res.status(404).json({ error: "Coach not found" });
    }
    if (!prisma?.coach?.findUnique) {
      return res.status(404).json({ error: "Coach not found" });
    }

    const coach = await prisma.coach.findUnique({ where: { id: coachId } });
    if (!coach) {
      return res.status(404).json({ error: "Coach not found" });
    }

    return res.json({
      id: coach.id,
      name: coach.name,
      specialization: coach.specialization ?? "",
      rating: coach.rating ?? 0,
      priceFrom: coach.priceFrom ?? 0,
      city: coach.city ?? "",
      avatar: coach.avatar ?? "",
      description: coach.description ?? "",
    });
  } catch (err) {
    console.error("[marketplace/coaches/:id] error:", err);
    return res.status(500).json({ error: "Failed to get coach" });
  }
});

app.get("/api/marketplace/coaches/:coachId/slots", async (req, res) => {
  const coachId = req.params?.coachId;
  try {
    if (typeof coachId !== "string" || coachId.trim() === "") {
      return res.status(404).json({ error: "Coach not found" });
    }

    if (!prisma?.coach?.findUnique || !prisma?.coachSlot?.findMany) {
      return res.status(404).json({ error: "Coach not found" });
    }

    const coach = await prisma.coach.findUnique({ where: { id: coachId } });
    if (!coach) {
      return res.status(404).json({ error: "Coach not found" });
    }

    const slots = await prisma.coachSlot.findMany({
      where: { coachId },
      orderBy: { time: "asc" },
    });

    return res.json(
      slots.map((s) => ({
        time: s.time,
        available: Boolean(s.available),
      }))
    );
  } catch (err) {
    console.error("[marketplace/coaches/:coachId/slots] error:", err);
    return res.status(500).json({ error: "Failed to get coach slots" });
  }
});

app.post("/api/marketplace/booking-request", async (req, res) => {
  const coachId = req.body?.coachId;
  try {
    if (typeof coachId !== "string" || coachId.trim() === "") {
      return res.status(400).json({ error: "coachId is required" });
    }

    if (!prisma?.coach?.findUnique || !prisma?.bookingRequest?.create) {
      return res.status(404).json({ error: "Coach not found" });
    }

    const coach = await prisma.coach.findUnique({ where: { id: coachId } });
    if (!coach) {
      return res.status(404).json({ error: "Coach not found" });
    }

    const requestId = `request_${Date.now()}`;
    await prisma.bookingRequest.create({
      data: { id: requestId, coachId },
    });

    return res.json({
      id: requestId,
      message: "Booking request sent successfully",
      coachId,
    });
  } catch (err) {
    console.error("[marketplace/booking-request] error:", err);
    return res.status(500).json({ error: "Failed to send booking request" });
  }
});

// --- HEALTH (deploy liveness) ---
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// --- ROOT ---
app.get("/", (_req, res) => {
  res.json({ ok: true, message: "hockey-server" });
});

// --- 404: return JSON so frontend doesn't get HTML on wrong path
app.use((req, res) => {
  console.log("[404]", req.method, req.path);
  res.status(404).json({ error: "Not found", path: req.path });
});

// --- Error handler: always return JSON (no HTML)
app.use((err, req, res, _next) => {
  console.error("[express-error]", err?.message ?? err, "| stack:", err?.stack?.slice(0, 300));
  if (!res.headersSent) {
    res.status(500).json({ error: "Не удалось выполнить вход" });
  }
});

const HOST = process.env.HOST || "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log("Server listening on", HOST + ":" + PORT);
});
