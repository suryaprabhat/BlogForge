import { cn, getInitials } from "../../lib/utils";

export function Avatar({ name, className }) {
  return (
    <span className={cn("ui-avatar", className)} aria-hidden="true">
      {getInitials(name)}
    </span>
  );
}
