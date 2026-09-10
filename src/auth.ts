import NextAuth from "next-auth";
import Google, { type GoogleProfile } from "next-auth/providers/google";
import { isGoogleEmailAllowed } from "@/lib/auth/google-email-allowlist";

export const { auth, handlers, signIn, signOut } = NextAuth({
  callbacks: {
    signIn({ account, profile }) {
      if (account?.provider !== "google") {
        return false;
      }

      const googleProfile = profile as GoogleProfile | undefined;
      return Boolean(
        googleProfile?.email_verified &&
        isGoogleEmailAllowed(googleProfile.email),
      );
    },
  },
  pages: {
    error: "/login",
    signIn: "/login",
  },
  session: {
    maxAge: 60 * 60 * 24 * 365,
  },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          prompt: "select_account",
        },
      },
    }),
  ],
});
