export type PaginatedList<T> = {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  items: T[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
};

export type PaginationOptions = {
  defaultPageSize?: number;
  maxPageSize?: number;
  page?: number;
  pageSize?: number;
  totalCount: number;
};

export function normalizePagination({
  defaultPageSize = 20,
  maxPageSize = 100,
  page,
  pageSize,
  totalCount,
}: PaginationOptions) {
  const normalizedPageSize = clampInteger(
    pageSize,
    defaultPageSize,
    1,
    maxPageSize,
  );
  const totalPages = Math.max(1, Math.ceil(totalCount / normalizedPageSize));
  const normalizedPage = clampInteger(page, 1, 1, totalPages);

  return {
    hasNextPage: normalizedPage < totalPages,
    hasPreviousPage: normalizedPage > 1,
    offset: (normalizedPage - 1) * normalizedPageSize,
    page: normalizedPage,
    pageSize: normalizedPageSize,
    totalCount,
    totalPages,
  };
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }

  return Math.min(Math.max(value, min), max);
}
