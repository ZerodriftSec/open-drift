import DashboardPage, {
  type DashboardPageSearchParams,
} from "@/app/components/dashboard/dashboard-page";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type PageProps = {
  params: Promise<{ sessionId: string }>;
  searchParams?: Promise<DashboardPageSearchParams>;
};

export default async function SessionResourcePage({
  params,
  searchParams,
}: PageProps) {
  const { sessionId } = await params;

  return (
    <DashboardPage
      resource={{ id: sessionId, type: "session" }}
      searchParams={searchParams}
    />
  );
}
