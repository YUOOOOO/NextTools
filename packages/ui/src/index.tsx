import type { ButtonHTMLAttributes, ReactNode } from "react";
export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      className="icon-button"
      type="button"
      title={label}
      aria-label={label}
      {...props}
    >
      {children}
    </button>
  );
}
