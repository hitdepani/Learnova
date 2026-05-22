import { connectDb } from "./mongodb";

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10;

const fallbackRateLimitMap = new Map();
let lastCleanupTime = Date.now();
const MAP_CLEANUP_INTERVAL_MS = 60 * 1000;

function checkRateLimitFallback(userId) {
  const now = Date.now();

  // Periodically clean up the entire map to prevent memory leak from inactive users
  if (now - lastCleanupTime > MAP_CLEANUP_INTERVAL_MS) {
    for (const [key, timestamps] of fallbackRateLimitMap.entries()) {
      const active = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (active.length === 0) {
        fallbackRateLimitMap.delete(key);
      } else if (active.length !== timestamps.length) {
        fallbackRateLimitMap.set(key, active);
      }
    }
    lastCleanupTime = now;
  }

  if (!fallbackRateLimitMap.has(userId)) {
    fallbackRateLimitMap.set(userId, [now]);
    return { allowed: true, remaining: MAX_REQUESTS_PER_WINDOW - 1 };
  }

  const timestamps = fallbackRateLimitMap.get(userId);
  const validTimestamps = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (validTimestamps.length === 0) {
    fallbackRateLimitMap.set(userId, [now]);
    return { allowed: true, remaining: MAX_REQUESTS_PER_WINDOW - 1 };
  }

  if (validTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    fallbackRateLimitMap.set(userId, validTimestamps);
    return { allowed: false, remaining: 0 };
  }

  validTimestamps.push(now);
  fallbackRateLimitMap.set(userId, validTimestamps);
  return { allowed: true, remaining: MAX_REQUESTS_PER_WINDOW - validTimestamps.length };
}

let cleanupInterval = null;

function startCleanup() {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(async () => {
    try {
      const db = await connectDb();
      if (db && typeof db.collection === "function") {
        await db.collection("rate_limits").deleteMany({
          expiresAt: { $lt: new Date() },
        });
      }
    } catch (err) {
      console.error("[rate-limit-cleanup] Failed to clean up expired entries:", err.message);
    }
  }, 5 * 60 * 1000);

  if (cleanupInterval && typeof cleanupInterval.unref === "function") {
    cleanupInterval.unref();
  }
}

export async function checkRateLimit(userId) {
  try {
    const db = await connectDb();
    if (!db || typeof db.collection !== "function") {
      return checkRateLimitFallback(userId);
    }
    const collection = db.collection("rate_limits");

    startCleanup();

    const now = new Date();
    const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);

    const record = await collection.findOne({ userId });

    if (!record) {
      const initialRequests = [now];
      const initialTimestamps = [now.getTime()];
      await collection.insertOne({
        userId,
        requests: initialRequests,
        timestamps: initialTimestamps,
        expiresAt: new Date(now.getTime() + RATE_LIMIT_WINDOW_MS * 2),
      });
      return { allowed: true, remaining: MAX_REQUESTS_PER_WINDOW - 1 };
    }

    // Retrieve requests from requests field, fallback to timestamps field if requests is not present
    let rawRequests = record.requests || record.timestamps || [];
    const recentRequests = rawRequests
      .map((t) => new Date(t))
      .filter((d) => d >= windowStart);

    if (recentRequests.length >= MAX_REQUESTS_PER_WINDOW) {
      const recentTimestamps = recentRequests.map((d) => d.getTime());
      await collection.updateOne(
        { userId },
        {
          $set: {
            requests: recentRequests,
            timestamps: recentTimestamps,
            expiresAt: new Date(now.getTime() + RATE_LIMIT_WINDOW_MS * 2),
          },
        }
      );
      return { allowed: false, remaining: 0 };
    }

    recentRequests.push(now);
    const recentTimestamps = recentRequests.map((d) => d.getTime());

    await collection.updateOne(
      { userId },
      {
        $set: {
          requests: recentRequests,
          timestamps: recentTimestamps,
          expiresAt: new Date(now.getTime() + RATE_LIMIT_WINDOW_MS * 2),
        },
      }
    );

    return {
      allowed: true,
      remaining: MAX_REQUESTS_PER_WINDOW - recentRequests.length,
    };
  } catch (err) {
    console.error("[rate-limit] MongoDB error, falling back to in-memory:", err.message);
    return checkRateLimitFallback(userId);
  }
}
