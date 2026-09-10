"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { z } from "zod";
import { signIn } from "@/auth";
import { isAuthenticationRequired } from "@/lib/auth/config";
import { safeRedirectPath } from "@/lib/auth/safe-redirect";

const signInFormSchema = z.object({
  callbackUrl: z.string().optional(),
});

export async function signInWithGoogle(formData: FormData) {
  const form = signInFormSchema.parse({
    callbackUrl: formData.get("callbackUrl") ?? undefined,
  });
  const callbackUrl = safeRedirectPath(form.callbackUrl);

  if (!isAuthenticationRequired()) {
    redirect(callbackUrl);
  }

  try {
    await signIn("google", {
      redirectTo: callbackUrl,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      redirect(`/login?error=${encodeURIComponent(error.type)}`);
    }

    throw error;
  }
}
