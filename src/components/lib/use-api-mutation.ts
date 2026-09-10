"use client";

import {
  useMutation,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { errorMessage } from "@/app/components/lib/api-client";

type MessageResolver<TData, TVariables> =
  string | ((data: TData, variables: TVariables) => string | null | undefined);

type ApiMutationOptions<TData, TVariables> = {
  invalidateKeys?: QueryKey[];
  mutationFn: (variables: TVariables) => Promise<TData>;
  onSuccess?: (data: TData, variables: TVariables) => void;
  refresh?: boolean;
  successMessage?: MessageResolver<TData, TVariables>;
};

export function useApiMutation<TData, TVariables = void>({
  invalidateKeys = [],
  mutationFn,
  onSuccess,
  refresh = true,
  successMessage,
}: ApiMutationOptions<TData, TVariables>) {
  const queryClient = useQueryClient();
  const router = useRouter();

  return useMutation({
    mutationFn,
    onError: (error) => {
      toast.error(errorMessage(error));
    },
    onSuccess: (data, variables) => {
      for (const queryKey of invalidateKeys) {
        void queryClient.invalidateQueries({ queryKey });
      }

      const message =
        typeof successMessage === "function"
          ? successMessage(data, variables)
          : successMessage;
      if (message) {
        toast.success(message);
      }

      onSuccess?.(data, variables);
      if (refresh) {
        router.refresh();
      }
    },
  });
}
