import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import * as React from "react";

import { cn } from "@/lib/utils";

// Base UI Separator 封装（@base-ui/react/separator）。
// Base UI 始终 role=separator + aria-orientation；decorative 透传兼容（解构丢弃，不向底层传）。
const Separator = React.forwardRef<
	React.ComponentRef<typeof SeparatorPrimitive>,
	React.ComponentPropsWithoutRef<typeof SeparatorPrimitive> & {
		/** 透传兼容（Base UI 始终语义化，忽略值） */
		decorative?: boolean;
	}
>(({ className, orientation = "horizontal", decorative: _decorative, ...props }, ref) => (
	<SeparatorPrimitive
		ref={ref}
		orientation={orientation}
		className={cn(
			"shrink-0 bg-border",
			orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]",
			className,
		)}
		{...props}
	/>
));
Separator.displayName = "Separator";

export { Separator };
