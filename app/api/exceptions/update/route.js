import { NextResponse } from "next/server";
import { connectDb } from "@/lib/mongodb";
import { getUserProfile } from "@/lib/firebase-admin";
import { withErrorHandler, authenticateRequest } from "@/lib/error-handler";
import { AppError, ValidationError, ForbiddenError, NotFoundError } from "@/lib/errors";

let ObjectId;
if (process.env.NODE_ENV === "test") {
  ObjectId = class FakeObjectId {
    constructor(id) {
      this.id = id;
    }
    static isValid(id) {
      return typeof id === "string" && /^[0-9a-fA-F]{24}$/.test(id);
    }
  };
} else {
  ObjectId = require("mongodb").ObjectId;
}

export const PUT = withErrorHandler(async (request) => {
  const decodedToken = await authenticateRequest(request);

  // Fetch user profile from Firestore to get the user's role
  const profile = await getUserProfile(decodedToken.uid);

  if (!profile) {
    throw new NotFoundError("User profile not found");
  }

  // Restrict access to admin and teacher roles only (return 403 Forbidden otherwise)
  if (profile.role !== "admin" && profile.role !== "teacher") {
    throw new ForbiddenError("Forbidden");
  }

  const body = await request.json();
  const { exceptionId, status, comments } = body;

  if (!exceptionId) {
    throw new ValidationError("exceptionId is required");
  }

  if (!ObjectId.isValid(exceptionId)) {
    throw new ValidationError("Invalid exception ID");
  }

  const trimmedStatus = typeof status === "string" ? status.trim() : "";
  const allowedStatuses = ["approved", "rejected"];
  if (!allowedStatuses.includes(trimmedStatus)) {
    throw new ValidationError("Invalid status value");
  }

  const db = await connectDb();

    // Fetch the exception to perform ownership/relationship checks to prevent IDOR
    const exception = await db.collection("exceptions").findOne({ _id: new ObjectId(exceptionId) });

    if (!exception) {
      return jsonError("Exception not found", 404);
    }

    // Perform teacher-specific assignment validation (CWE-639 resolution)
    if (profile.role === "teacher") {
      const teacherSubjects = profile.subjects || [];
      const exceptionClass = exception.className || exception.class;
      let isAuthorized = false;

      // 1. Check if the teacher teaches the class of the exception
      if (exceptionClass && teacherSubjects.includes(exceptionClass)) {
        isAuthorized = true;
      }

      // 2. Fallback: Check student-teacher subject assignment overlap
      if (!isAuthorized && exception.studentEmail) {
        const studentProfile = await getUserProfileByEmail(exception.studentEmail);
        if (studentProfile) {
          const studentSubjects = studentProfile.subjects || studentProfile.classes || [];
          const hasOverlap = studentSubjects.some((subject) => teacherSubjects.includes(subject));
          if (hasOverlap) {
            isAuthorized = true;
          }
        }
      }

      if (!isAuthorized) {
        return jsonError("Forbidden: You are not authorized to update exception requests for this class/student.", 403);
      }
    }

     let result;
  try {
    result = await db.collection("exceptions").updateOne(
      { _id: new ObjectId(exceptionId) },
      {
        $set: {
          status: trimmedStatus,
          comments,
          reviewedBy: decodedToken.email,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );
  } catch (error) {
    console.error("Exception update error:", error);
    throw new AppError("Internal server error", 500);
  }

  if (result.matchedCount === 0) {
    throw new NotFoundError("Exception not found");
  }

  return NextResponse.json({
    message: "Exception updated successfully",
  });
});
