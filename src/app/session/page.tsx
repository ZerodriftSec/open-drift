import { redirect } from "next/navigation";
import type { DashboardPageSearchParams } from "@/app/components/dashboard/dashboard-page";
import { appendQueryString, sessionsPagePath } from "@/lib/page-routes";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type PageProps = {
  searchParams?: Promise<DashboardPageSearchParams>;
};

export default async function LegacySessionsPage({ searchParams }: PageProps) {
  const legacyParams = await searchParams;
  const nextParams = new URLSearchParams();

  for (const [key, value] of Object.entries(legacyParams ?? {})) {
    if (value) nextParams.set(key, value);
  }

  redirect(appendQueryString(sessionsPagePath(), nextParams));
}
