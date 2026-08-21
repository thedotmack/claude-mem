import { Suspense } from "react";
import AuthForm from "@/components/AuthForm";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-black" />}>
      <AuthForm mode="login" />
    </Suspense>
  );
}
