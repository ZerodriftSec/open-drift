import {
  SessionsListPage,
  type DashboardPageSearchParams,
} from "@/app/components/dashboard/dashboard-page";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type PageProps = {
  searchParams?: Promise<DashboardPageSearchParams>;
};

export default function SessionsPage({ searchParams }: PageProps) {
  return <SessionsListPage searchParams={searchParams} />;
}
