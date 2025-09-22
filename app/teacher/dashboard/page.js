// app/teacher/dashboard/page.jsx
"use client";
import ProtectedRoute from "@/components/ProtectedRoute";

export default function TeacherDashboard() {
  return (
    <ProtectedRoute allowedRoles={["teacher"]}>
      <div>Teacher Dashboard Content</div>
    </ProtectedRoute>
  );
}
