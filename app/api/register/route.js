import { put, del } from "@vercel/blob";
import { randomUUID } from "crypto";
import { connectDb } from "@/lib/mongodb";
import { jsonSuccess } from "@/lib/api-response";
import { withErrorHandler, authenticateRequest } from "@/lib/error-handler";
import { AppError, ValidationError, ForbiddenError } from "@/lib/errors";

if (typeof global !== "undefined" && !global.mockFile) {
  global.mockFile = {
    size: 1024,
    type: "image/jpeg",
    arrayBuffer: async () => new ArrayBuffer(1024),
  };
}

export const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_ATTEMPTS = 5;

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Leading magic bytes for each permitted image format.
 * Checked against the raw buffer after upload to ensure the file content
 * matches its declared MIME type — MIME spoofing cannot bypass this.
 *
 * JPEG : FF D8 FF
 * PNG  : 89 50 4E 47  (‌\x89PNG)
 * WEBP : 52 49 46 46 ?? ?? ?? ?? 57 45 42 50  (RIFF????WEBP)
 */
const MAGIC_BYTES = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png":  [0x89, 0x50, 0x4e, 0x47],
  "image/webp": [0x52, 0x49, 0x46, 0x46],
};
const WEBP_MARKER = [0x57, 0x45, 0x42, 0x50]; // bytes 8-11 in a WEBP file

const normalizeText = (value) =>
  typeof value === "string" ? value.trim() : "";

const getImageExtension = (mimeType) => {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/jpeg":
    default:
      return "jpg";
  }
};

export const POST = withErrorHandler(async (req) => {
  // 1. Rate Limiting Check
  const ip = req.headers.get("x-forwarded-for") || "127.0.0.1";
  const now = Date.now();
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, []);
  }
  const attempts = rateLimitMap.get(ip).filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW);
  attempts.push(now);
  rateLimitMap.set(ip, attempts);
/**
 * Validates that the first bytes of a buffer match the expected magic
 * bytes for the given MIME type, preventing MIME-spoofed uploads.
 * @param {Buffer} buffer - File content buffer
 * @param {string} mimeType - Declared MIME type
 * @returns {boolean} True if content matches the declared type
 */
const validateMagicBytes = (buffer, mimeType) => {
  const magic = MAGIC_BYTES[mimeType];
  if (!magic || buffer.length < magic.length) return false;

  for (let i = 0; i < magic.length; i++) {
    if (buffer[i] !== magic[i]) return false;
  }

  if (mimeType === "image/webp") {
    if (buffer.length < 12) return false;
    for (let i = 0; i < WEBP_MARKER.length; i++) {
      if (buffer[8 + i] !== WEBP_MARKER[i]) return false;
    }
  }

  return true;
};

export async function POST(req) {
  try {
    // 1. Authenticate Request
    const authorization = req.headers.get("authorization");
    const token = authorization?.split(" ")[1];

  if (attempts.length > MAX_ATTEMPTS) {
    console.warn(`[Rate Limit] Registration rate limit exceeded for IP: ${ip} at ${new Date(now).toISOString()}`);
    throw new AppError("Too many registration attempts. Please try again later.", 429);
  }

  // 2. Authenticate Request
  const decodedToken = await authenticateRequest(req);

  const formData = await req.formData();
  const name = normalizeText(formData.get("name"));
  const rollNo = normalizeText(formData.get("rollNo"));
  const email = normalizeText(formData.get("email")).toLowerCase();
  const file = formData.get("photo");

  if (!name || !rollNo || !email || !file) {
    throw new ValidationError("Name, rollNo, email, and photo are required");
  }

  if (!EMAIL_PATTERN.test(email)) {
    throw new ValidationError("Invalid email address");
  }

  // 3. Prevent arbitrary registrations - Must register own email
  if (decodedToken.email !== email) {
    throw new ForbiddenError("Forbidden: Cannot register face for a different user");
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new ValidationError("File size exceeds 5MB limit");
  }

  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    throw new ValidationError("Invalid file type. Only JPEG, PNG, and WebP images are allowed.");
  }

  // Get DB
  const db = await connectDb();
  const users = db.collection("users");

  // Check if user already registered
  const existingUser = await users.findOne({
    $or: [{ rollNo }, { email }],
  });
  if (existingUser) {
    throw new AppError("User already registered with a photo", 409);
  }

 
    // 5. Convert file to buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 6. Re-verify size against actual buffer length — file.size is client-supplied
    //    and can be spoofed; the buffer is authoritative
    if (buffer.length > MAX_FILE_SIZE) {
      return jsonError(
        `File too large. Maximum allowed size is ${MAX_FILE_SIZE / 1024 / 1024} MB.`,
        413
      );
    }

    // 7. Validate magic bytes — ensures binary content matches the declared MIME type
    if (!validateMagicBytes(buffer, file.type)) {
      return jsonError(
        "File content does not match the declared type. Please upload a valid image.",
        415
      );
    }

    // Generate unique filename
    const safeName      = name.replace(/[^a-zA-Z0-9_-]/g, "_") || "user";
    const fileExtension = getImageExtension(file.type);
    const fileName      = `labels/${safeName}/${randomUUID()}.${fileExtension}`;

    // Upload to Vercel Blob
    const blob = await put(fileName, buffer, {
      contentType: file.type,
      access: "public",
    });

  try {
    // Save user record in DB
    const user = {
      name,
      rollNo,
      email,
      image: blob.url,
      firebaseUid: decodedToken.uid,
    };
    const result = await users.insertOne(user);

    return jsonSuccess(
      {
        message: "User registered successfully",
        user: {
          _id: result.insertedId,
          name: user.name,
          rollNo: user.rollNo,
          email: user.email,
        },
      },
      201,
    );
  } catch (dbError) {
    try {
      await del(blob.url);
    } catch (cleanupError) {
      console.error("Failed to delete orphaned blob during rollback:", cleanupError);
    }
    throw dbError;
  }
});
