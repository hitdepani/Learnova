// app/institute/dashboard/page.jsx
"use client";
import ProtectedRoute from "@/components/ProtectedRoute";

export default function InstituteDashboard() {
  return (
    <ProtectedRoute allowedRoles={["institute"]}>
      <div>Institute Dashboard Content</div>
    </ProtectedRoute>
  );
}
