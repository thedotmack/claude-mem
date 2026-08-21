import { Suspense } from "react";
import AuthForm from "@/components/AuthForm";

export const metadata = { title: "Reset password" };

export default function ResetPage() {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-black" />}>
      <AuthForm mode="reset" />
    </Suspense>
  );
}
