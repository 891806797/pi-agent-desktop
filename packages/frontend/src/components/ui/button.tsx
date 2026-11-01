import { Button as BaseButton } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground enabled:hover:bg-primary/90",
				destructive: "bg-destructive text-destructive-foreground enabled:hover:bg-destructive/90",
				outline:
					"border border-input bg-background enabled:hover:bg-accent enabled:hover:text-accent-foreground",
				secondary: "bg-secondary text-secondary-foreground enabled:hover:bg-secondary/80",
				ghost: "enabled:hover:bg-accent enabled:hover:text-accent-foreground",
				link: "text-primary underline-offset-4 enabled:hover:underline",
			},
			size: {
				default: "h-10 px-4 py-2",
				sm: "h-9 rounded-md px-3",
				lg: "h-11 rounded-md px-8",
				icon: "h-10 w-10",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

// Base UI Button 原生支持 ref + render prop；此处只叠加 cva 的 variant/size 样式。
export interface ButtonProps
	extends React.ComponentProps<typeof BaseButton>,
		VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLElement, ButtonProps>(
	({ className, variant, size, ...props }, ref) => {
		return (
			<BaseButton
				ref={ref}
				className={cn(buttonVariants({ variant, size, className }))}
				{...props}
			/>
		);
	},
);
Button.displayName = "Button";

export { Button, buttonVariants };
