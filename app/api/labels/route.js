import { connectDb } from "@/lib/mongodb";
import { jsonSuccess } from "@/lib/api-response";
import { withErrorHandler, authenticateRequest } from "@/lib/error-handler";
import { AppError } from "@/lib/errors";

export const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_ATTEMPTS = 10;

export const GET = withErrorHandler(async (request) => {
  // 1. Rate Limiting Check
  const ip = request.headers.get("x-forwarded-for") || "127.0.0.1";
  const now = Date.now();
  
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, []);
  }
  
  const attempts = rateLimitMap.get(ip).filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW);
  attempts.push(now);
  rateLimitMap.set(ip, attempts);

  if (attempts.length > MAX_ATTEMPTS) {
    console.warn(`[Rate Limit] Labels fetch rate limit exceeded for IP: ${ip} at ${new Date(now).toISOString()}`);
    throw new AppError("Too many attempts. Please try again later.", 429);
  }

  // 2. Token Authentication Check
  await authenticateRequest(request);

  // 3. Extract search parameter and build query
  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search");
  const query = search
    ? {
        $or: [
          { name: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
        ],
      }
    : {};

  // 4. Fetch Data with Projection
  const db = await connectDb();
  const users = db.collection("users");

  const allUsers = await users
    .find(query, { projection: { _id: 0, name: 1, email: 1, image: 1 } })
    .limit(50)
    .toArray();

  return jsonSuccess(allUsers, 200);
});
