import { useEffect, useRef, useState } from "react";

export function ResizeHandle({
	size,
	min,
	max,
	onResize,
	onEnd,
	defaultSize = 344,
}: {
	size: number;
	min: number;
	max: number;
	onResize: (width: number) => void;
	onEnd?: (width: number) => void;
	defaultSize?: number;
}) {
	const [active, setActive] = useState(false);
	const drag = useRef<{ x: number; size: number; next: number; frame?: number } | null>(null);
	const restore = useRef<(() => void) | null>(null);
	const clamp = (width: number) => Math.min(max, Math.max(min, width));
	const finish = () => {
		const current = drag.current;
		if (!current) return;
		if (current.frame) cancelAnimationFrame(current.frame);
		const width = clamp(current.next);
		drag.current = null;
		restore.current?.();
		restore.current = null;
		setActive(false);
		onResize(width);
		onEnd?.(width);
	};
	useEffect(
		() => () => {
			if (drag.current?.frame) cancelAnimationFrame(drag.current.frame);
			restore.current?.();
		},
		[],
	);

	return (
		// biome-ignore lint/a11y/useSemanticElements: 可交互的窗口分隔轴需要指针捕获和方向键，hr 不适合承载交互。
		<div
			role="separator"
			tabIndex={0}
			aria-label="调整会话列表宽度"
			aria-orientation="vertical"
			aria-valuemin={min}
			aria-valuemax={max}
			aria-valuenow={Math.round(size)}
			title="左右拖动调整宽度，方向键微调，双击恢复默认"
			className={`group relative hidden w-2 shrink-0 touch-none cursor-col-resize items-center justify-center outline-none md:flex ${active ? "bg-[var(--overlay-hover)]" : "hover:bg-[var(--overlay-hover)]"}`}
			onPointerDown={(event) => {
				if (event.button !== 0 || drag.current) return;
				event.preventDefault();
				event.currentTarget.focus();
				event.currentTarget.setPointerCapture(event.pointerId);
				drag.current = { x: event.clientX, size, next: size };
				const { cursor, userSelect } = document.body.style;
				document.body.style.cursor = "col-resize";
				document.body.style.userSelect = "none";
				restore.current = () => {
					document.body.style.cursor = cursor;
					document.body.style.userSelect = userSelect;
				};
				setActive(true);
			}}
			onPointerMove={(event) => {
				const current = drag.current;
				if (!current) return;
				current.next = clamp(current.size + event.clientX - current.x);
				if (current.frame) return;
				current.frame = requestAnimationFrame(() => {
					current.frame = undefined;
					onResize(current.next);
				});
			}}
			onPointerUp={finish}
			onPointerCancel={finish}
			onLostPointerCapture={finish}
			onDoubleClick={() => {
				const width = clamp(defaultSize);
				onResize(width);
				onEnd?.(width);
			}}
			onKeyDown={(event) => {
				const step = event.shiftKey ? 32 : 8;
				const next =
					event.key === "ArrowLeft"
						? size - step
						: event.key === "ArrowRight"
							? size + step
							: event.key === "Home"
								? min
								: event.key === "End"
									? max
									: null;
				if (next === null) return;
				event.preventDefault();
				const width = clamp(next);
				onResize(width);
				onEnd?.(width);
			}}
		>
			<span
				aria-hidden
				className={`h-9 w-[3px] rounded-full transition-colors duration-150 motion-reduce:transition-none group-hover:bg-[var(--text-muted)] group-focus-visible:bg-primary ${active ? "bg-primary" : "bg-[var(--border-base)]"}`}
			/>
		</div>
	);
}
