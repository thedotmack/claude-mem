import { Suspense } from "react";
import AuthForm from "@/components/AuthForm";

export const metadata = { title: "Create your Face Card" };

export default function SignupPage() {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-black" />}>
      <AuthForm mode="signup" />
    </Suspense>
  );
}
