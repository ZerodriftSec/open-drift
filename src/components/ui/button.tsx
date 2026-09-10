import { cva, type VariantProps } from "class-variance-authority";
import { Loader2, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from "react";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  [
    "inline-flex shrink-0 select-none items-center justify-center gap-1.5 rounded-app border font-medium outline-none",
    "transition-[background-color,border-color,box-shadow,color,transform] duration-150",
    "focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
    "active:translate-y-px disabled:pointer-events-none disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-60",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ].join(" "),
  {
    defaultVariants: {
      size: "md",
      variant: "secondary",
    },
    variants: {
      size: {
        icon: "h-7 w-7 p-0 [&_svg]:size-3.5",
        lg: "min-h-9 px-3.5 text-[13px] [&_svg]:size-4",
        md: "min-h-8 px-3 text-[13px] [&_svg]:size-3.5",
        sm: "min-h-7 px-2.5 text-xs [&_svg]:size-3.5",
      },
      variant: {
        danger:
          "border-destructive/15 bg-destructive/10 text-destructive hover:border-destructive/30 hover:bg-destructive/15",
        destructive:
          "border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90",
        ghost:
          "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
        link: "border-transparent bg-transparent px-0 text-primary underline-offset-4 hover:underline",
        outline:
          "border-border bg-background text-foreground hover:border-app-border-strong hover:bg-muted",
        primary:
          "border-primary bg-primary text-primary-foreground hover:bg-app-primary-hover",
        secondary:
          "border-border bg-card text-card-foreground hover:border-app-border-strong hover:bg-muted",
      },
    },
  },
);

type CommonProps = {
  asChild?: boolean;
  children?: ReactNode;
  className?: string;
  href?: string;
  icon?: LucideIcon;
  loading?: boolean;
} & VariantProps<typeof buttonVariants>;

type ButtonAsButton = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps | "type"> & {
    href?: undefined;
    type?: "button" | "submit" | "reset";
  };

type ButtonAsLink = CommonProps & {
  href: string;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps | "href">;

type ButtonProps = ButtonAsButton | ButtonAsLink;

const localButtonPropNames = new Set([
  "asChild",
  "children",
  "className",
  "href",
  "icon",
  "loading",
  "size",
  "variant",
]);

function getForwardedProps(props: object) {
  return Object.fromEntries(
    Object.entries(props).filter(([key]) => !localButtonPropNames.has(key)),
  );
}

function ButtonContent({
  children,
  icon: Icon,
  loading,
}: {
  children?: ReactNode;
  icon?: LucideIcon;
  loading?: boolean;
}) {
  return (
    <>
      {loading ? (
        <Loader2
          className="h-3.5 w-3.5 shrink-0 animate-spin"
          aria-hidden="true"
        />
      ) : Icon ? (
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : null}
      {children ? (
        <span className="inline-flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
          {children}
        </span>
      ) : null}
    </>
  );
}

export function Button(props: ButtonProps) {
  const {
    asChild = false,
    children,
    className,
    icon: Icon,
    loading = false,
    size = "md",
    variant = "secondary",
  } = props;

  const classes = cn(buttonVariants({ className, size, variant }));

  if (props.href !== undefined) {
    const rest = getForwardedProps(
      props,
    ) as AnchorHTMLAttributes<HTMLAnchorElement>;

    return (
      <Link
        href={props.href}
        prefetch={false}
        scroll={false}
        className={classes}
        {...rest}
      >
        <ButtonContent icon={Icon} loading={loading}>
          {children}
        </ButtonContent>
      </Link>
    );
  }

  if (asChild) {
    const rest = getForwardedProps(
      props,
    ) as ButtonHTMLAttributes<HTMLButtonElement>;

    return (
      <Slot.Root data-slot="button" className={classes} {...rest}>
        {children}
      </Slot.Root>
    );
  }

  const rest = getForwardedProps(
    props,
  ) as ButtonHTMLAttributes<HTMLButtonElement>;
  const isDisabled = rest.disabled || loading;
  const type = rest.type ?? "button";

  return (
    <button
      {...rest}
      data-slot="button"
      className={classes}
      disabled={isDisabled}
      type={type}
    >
      <ButtonContent icon={Icon} loading={loading}>
        {children}
      </ButtonContent>
    </button>
  );
}
