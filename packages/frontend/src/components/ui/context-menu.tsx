"use client";

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import * as React from "react";

import { cn } from "@/lib/utils";

// Base UI ContextMenu 封装。Trigger asChild 走 render；Item onSelect 映射 onClick；
// Content = Portal+Positioner+Popup（无定位参数时默认锚触发器）。
// 仅导出消费方在用子集：Root/Trigger/Content/Item/Separator。

const ContextMenu = ContextMenuPrimitive.Root;

const ContextMenuTrigger = React.forwardRef<
	React.ComponentRef<typeof ContextMenuPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Trigger> & { asChild?: boolean }
>(({ asChild, children, ...props }, ref) => {
	// ContextMenu.Trigger 渲染 <div>，ref 类型为 HTMLDivElement
	const triggerRef = ref as React.Ref<HTMLDivElement>;
	if (asChild && React.isValidElement(children)) {
		return (
			<ContextMenuPrimitive.Trigger ref={triggerRef} render={children as React.ReactElement} />
		);
	}
	return (
		<ContextMenuPrimitive.Trigger ref={triggerRef} {...props}>
			{children}
		</ContextMenuPrimitive.Trigger>
	);
});
ContextMenuTrigger.displayName = "ContextMenuTrigger";

const ContextMenuContent = React.forwardRef<
	React.ComponentRef<typeof ContextMenuPrimitive.Popup>,
	React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Popup> & {
		align?: "start" | "center" | "end";
		side?: "top" | "bottom" | "left" | "right" | "inline-start" | "inline-end";
		sideOffset?: number;
	}
>(({ className, children, align, side, sideOffset = 4, ...props }, ref) => (
	<ContextMenuPrimitive.Portal>
		<ContextMenuPrimitive.Positioner
			align={align}
			side={side}
			sideOffset={sideOffset}
			className="z-50"
		>
			<ContextMenuPrimitive.Popup
				ref={ref}
				className={cn(
					"min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
					"transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
					className,
				)}
				{...props}
			>
				{children}
			</ContextMenuPrimitive.Popup>
		</ContextMenuPrimitive.Positioner>
	</ContextMenuPrimitive.Portal>
));
ContextMenuContent.displayName = "ContextMenuContent";

const ContextMenuItem = React.forwardRef<
	React.ComponentRef<typeof ContextMenuPrimitive.Item>,
	React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & {
		onSelect?: React.MouseEventHandler<HTMLElement>;
		inset?: boolean;
	}
>(({ className, onSelect, onClick, inset, ...props }, ref) => (
	<ContextMenuPrimitive.Item
		ref={ref}
		onClick={onSelect ?? onClick}
		className={cn(
			"relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
			inset && "pl-8",
			className,
		)}
		{...props}
	/>
));
ContextMenuItem.displayName = "ContextMenuItem";

const ContextMenuSeparator = React.forwardRef<
	React.ComponentRef<typeof ContextMenuPrimitive.Separator>,
	React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
	<ContextMenuPrimitive.Separator
		ref={ref}
		className={cn("-mx-1 my-1 h-px bg-muted", className)}
		{...props}
	/>
));
ContextMenuSeparator.displayName = "ContextMenuSeparator";

export {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
};
