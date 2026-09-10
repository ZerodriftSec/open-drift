"use client";

import { LogOut } from "lucide-react";
import { signOut } from "next-auth/react";

export function SignOutButton({ mobile = false }: { mobile?: boolean }) {
  return (
    <button
      className={
        mobile
          ? "inline-flex h-9 items-center gap-2 rounded-app px-3 text-[13px] font-medium text-app-text-muted hover:bg-app-hover hover:text-app-text"
          : "grid min-h-14 justify-items-center gap-1 rounded-[14px] px-1 py-2 text-[10px] font-medium leading-tight text-app-text-muted transition-colors hover:bg-app-hover hover:text-app-text"
      }
      onClick={() => void signOut({ redirectTo: "/login" })}
      type="button"
    >
      <LogOut className="h-4.5 w-4.5" aria-hidden="true" strokeWidth={1.8} />
      <span>Sign out</span>
    </button>
  );
}
