import { cn } from "../../lib/utils";

export function Label({ className, ...props }) {
  return <label className={cn("ui-label", className)} {...props} />;
}
