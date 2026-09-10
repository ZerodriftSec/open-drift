import { redirect } from "next/navigation";
import { sessionsPagePath } from "@/lib/page-routes";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function HomePage() {
  redirect(sessionsPagePath());
}
