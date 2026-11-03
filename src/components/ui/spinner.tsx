import { Loader2Icon } from "lucide-react"

import { cn } from "@/lib/utils"

/** 轉圈的載入圖示（shadcn/ui 的 Spinner）。只是裝飾：文字說明由外層提供。 */
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return <Loader2Icon aria-hidden="true" data-slot="spinner" className={cn("size-4 shrink-0 animate-spin motion-reduce:animate-[spin_2.4s_linear_infinite]", className)} {...props} />
}

export { Spinner }
