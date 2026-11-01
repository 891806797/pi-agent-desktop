import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

// Base UI Dialog 封装（@base-ui/react/dialog）。
// 受控用法：<Dialog open={o} onOpenChange={setO}><DialogContent>...</DialogContent></Dialog>
// onOpenChange 回调签名 (open, details)；无 asChild，用 render prop 传自定义触发器。

const Dialog = BaseDialog.Root;

const DialogTrigger = BaseDialog.Trigger;

const DialogPortal = BaseDialog.Portal;

const DialogClose = BaseDialog.Close;

// 遮罩：fixed 铺满，半透明黑 + 轻微模糊；transition 跟随 Base UI starting/ending-style
const DialogBackdrop = React.forwardRef<
	React.ComponentRef<typeof BaseDialog.Backdrop>,
	React.ComponentPropsWithoutRef<typeof BaseDialog.Backdrop>
>(({ className, ...props }, ref) => (
	<BaseDialog.Backdrop
		ref={ref}
		className={cn(
			"fixed inset-0 z-50 bg-black/50 backdrop-blur-[1px]",
			"transition-opacity duration-200 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
			className,
		)}
		{...props}
	/>
));
DialogBackdrop.displayName = "DialogBackdrop";

// 内容：Portal + Backdrop + Popup 一体，消费端无需手动套 Portal。
// Popup 居中定位，项目 CSS 变量配色，圆角 + 阴影；含右上角关闭按钮（hideClose 可隐藏）。
const DialogContent = React.forwardRef<
	HTMLDivElement,
	React.ComponentPropsWithoutRef<typeof BaseDialog.Popup> & { hideClose?: boolean }
>(({ className, children, hideClose, ...props }, ref) => (
	<BaseDialog.Portal>
		<DialogBackdrop />
		<BaseDialog.Popup
			ref={ref}
			className={cn(
				"fixed left-1/2 top-1/2 z-50 grid w-full max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4",
				"rounded-lg border border-[var(--border-base)] bg-[var(--bg-base)] p-5 shadow-[var(--elevation-raised)]",
				"transition-all duration-200 data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
				"max-h-[calc(100vh-2rem)] overflow-y-auto",
				className,
			)}
			{...props}
		>
			{children}
			{!hideClose && (
				<BaseDialog.Close
					className="absolute right-3 top-3 inline-flex size-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--overlay-hover)] hover:text-[var(--text-muted)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
					aria-label="关闭"
				>
					<XIcon className="size-4" />
				</BaseDialog.Close>
			)}
		</BaseDialog.Popup>
	</BaseDialog.Portal>
));
DialogContent.displayName = "DialogContent";

function DialogHeader({
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
	return <div className={cn("flex flex-col gap-1.5 pr-8 text-left", className)} {...props} />;
}

function DialogFooter({
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
	return (
		<div
			className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
			{...props}
		/>
	);
}

const DialogTitle = React.forwardRef<
	React.ComponentRef<typeof BaseDialog.Title>,
	React.ComponentPropsWithoutRef<typeof BaseDialog.Title>
>(({ className, ...props }, ref) => (
	<BaseDialog.Title
		ref={ref}
		className={cn("text-[15px] font-semibold leading-tight text-[var(--text-base)]", className)}
		{...props}
	/>
));
DialogTitle.displayName = "DialogTitle";

const DialogDescription = React.forwardRef<
	React.ComponentRef<typeof BaseDialog.Description>,
	React.ComponentPropsWithoutRef<typeof BaseDialog.Description>
>(({ className, ...props }, ref) => (
	<BaseDialog.Description
		ref={ref}
		className={cn("text-[13px] leading-relaxed text-[var(--text-muted)]", className)}
		{...props}
	/>
));
DialogDescription.displayName = "DialogDescription";

export {
	Dialog,
	DialogBackdrop,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPortal,
	DialogTitle,
	DialogTrigger,
};
