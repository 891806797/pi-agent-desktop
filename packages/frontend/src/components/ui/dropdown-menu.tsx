"use client";

import { Menu } from "@base-ui/react/menu";
import * as React from "react";

import { cn } from "@/lib/utils";

// Base UI Menu 封装。要点：
//   Trigger asChild → render prop（克隆元素合并 onClick/props，children 保留）；
//   Item onSelect 映射为 onClick（点击默认关闭菜单）；
//   Content 的 side/align/sideOffset 传给 Positioner（Positioner+Popup 两层）；
//   高亮态用 data-[highlighted]（适配 roving focus）。
// 仅导出消费方在用子集：Root/Trigger/Content/Item/Separator。

const DropdownMenu = Menu.Root;

const DropdownMenuTrigger = React.forwardRef<
	React.ComponentRef<typeof Menu.Trigger>,
	React.ComponentPropsWithoutRef<typeof Menu.Trigger> & { asChild?: boolean }
>(({ asChild, children, ...props }, ref) => {
	// Menu.Trigger 渲染 <button>，ref 类型为 HTMLButtonElement；泛型组件推导为 HTMLElement，
	// 此处收敛 cast（消费方不传 ref，仅类型层面）
	const triggerRef = ref as React.Ref<HTMLButtonElement>;
	if (asChild && React.isValidElement(children)) {
		return <Menu.Trigger ref={triggerRef} render={children as React.ReactElement} />;
	}
	return (
		<Menu.Trigger ref={triggerRef} {...props}>
			{children}
		</Menu.Trigger>
	);
});
DropdownMenuTrigger.displayName = "DropdownMenuTrigger";

const DropdownMenuContent = React.forwardRef<
	React.ComponentRef<typeof Menu.Popup>,
	React.ComponentPropsWithoutRef<typeof Menu.Popup> & {
		align?: "start" | "center" | "end";
		side?: "top" | "bottom" | "left" | "right" | "inline-start" | "inline-end";
		sideOffset?: number;
	}
>(({ className, children, align, side, sideOffset = 4, ...props }, ref) => (
	<Menu.Portal>
		<Menu.Positioner align={align} side={side} sideOffset={sideOffset} className="z-50">
			<Menu.Popup
				ref={ref}
				className={cn(
					"min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
					"transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
					className,
				)}
				{...props}
			>
				{children}
			</Menu.Popup>
		</Menu.Positioner>
	</Menu.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

const DropdownMenuItem = React.forwardRef<
	React.ComponentRef<typeof Menu.Item>,
	React.ComponentPropsWithoutRef<typeof Menu.Item> & {
		/** onSelect 代理：转发到 onClick（点击即选中并默认关闭菜单） */
		onSelect?: React.MouseEventHandler<HTMLElement>;
		inset?: boolean;
	}
>(({ className, onSelect, onClick, inset, ...props }, ref) => (
	<Menu.Item
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
DropdownMenuItem.displayName = "DropdownMenuItem";

const DropdownMenuSeparator = React.forwardRef<
	React.ComponentRef<typeof Menu.Separator>,
	React.ComponentPropsWithoutRef<typeof Menu.Separator>
>(({ className, ...props }, ref) => (
	<Menu.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-muted", className)} {...props} />
));
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

export {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
};
