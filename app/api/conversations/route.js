import { connectDb } from "@/lib/mongodb";
import { jsonSuccess } from "@/lib/api-response";
import { z } from "zod";
import xss from "xss";
import { withErrorHandler, authenticateRequest } from "@/lib/error-handler";
import { AppError, ValidationError } from "@/lib/errors";

const sanitizeText = (text) => {
  if (typeof text !== "string") return "";
  return xss(text, {
    whiteList: {},
    stripIgnoreTag: true,
    stripIgnoreTagBody: ["script"],
  }).trim();
};

const conversationSchema = z.object({
  userMessage: z
    .string({
      required_error: "userMessage is required",
      invalid_type_error: "userMessage must be a string",
    })
    .min(1, "userMessage cannot be empty")
    .max(10000, "userMessage must not exceed 10,000 characters")
    .transform(sanitizeText),

  botMessage: z
    .string({
      required_error: "botMessage is required",
      invalid_type_error: "botMessage must be a string",
    })
    .min(1, "botMessage cannot be empty")
    .max(10000, "botMessage must not exceed 10,000 characters")
    .transform(sanitizeText),
});

export const POST = withErrorHandler(async (req) => {
  const decodedToken = await authenticateRequest(req);


  // Enforce maximum document size (1MB = 1048576 bytes)
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > 1024 * 1024) {
    throw new AppError("Payload too large", 413);
  }

  const rawText = await req.text();
  if (Buffer.byteLength(rawText, "utf8") > 1024 * 1024) {
    throw new AppError("Payload too large", 413);
  }

  let parsedBody;
  try {
    parsedBody = JSON.parse(rawText);
  } catch (e) {
    throw new ValidationError("Invalid JSON payload");
  }

  // Validate using Zod
  const validation = conversationSchema.safeParse(parsedBody);
  if (!validation.success) {
    const firstError = validation.error.issues?.[0]?.message || "Invalid request payload";
    throw new ValidationError(firstError);
  }

  const { userMessage, botMessage } = validation.data;

  const db = await connectDb();
  const collection = db.collection("conversations");

  const newConversation = {
    userId: decodedToken.uid,
    userEmail: decodedToken.email,
    userMessage,
    botMessage,
    timestamp: new Date(),
  };

  await collection.insertOne(newConversation);

  return jsonSuccess(newConversation);
});

export const GET = withErrorHandler(async (request) => {
  const decodedToken = await authenticateRequest(request);


  const db = await connectDb();
  const collection = db.collection("conversations");

  const history = await collection
    .find({ userId: decodedToken.uid })
    .sort({ timestamp: 1 })
    .limit(50)
    .toArray();

  return jsonSuccess(history);
});

