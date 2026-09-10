import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

type MarkdownProps = {
  children: string;
  className?: string;
};

export const Markdown = memo(function Markdown({
  children,
  className,
}: MarkdownProps) {
  return (
    <div className={cn("prose fade-in", className)} data-markdown="true">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
});
