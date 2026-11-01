/**
 * ResizeHandle —— 复刻 opencode resize-handle：水平拖拽调宽。
 * 8px 命中区挂边界线（translateX(50%)），hover/active 显 3px 竖条；
 * mousedown 捕获起始宽 → document mousemove 计算 delta → min/max 钳制。
 */

import { useCallback, useRef, useState } from "react";

export function ResizeHandle({
	size,
	min,
	max,
	onResize,
	onEnd,
}: {
	size: number;
	min: number;
	max: number;
	onResize: (width: number) => void;
	onEnd?: () => void;
}) {
	const [active, setActive] = useState(false);
	const startRef = useRef({ x: 0, size: 0 });

	const onMouseDown = useCallback(
		(e: React.MouseEvent) => {
			if (e.detail > 1) return; // 忽略双击
			e.preventDefault();
			startRef.current = { x: e.clientX, size };
			setActive(true);
			document.body.style.userSelect = "none";
			document.body.style.overflow = "hidden";

			const onMouseMove = (ev: MouseEvent) => {
				const delta = ev.clientX - startRef.current.x;
				const next = startRef.current.size + delta;
				onResize(Math.min(max, Math.max(min, next)));
			};
			const onMouseUp = () => {
				setActive(false);
				document.body.style.userSelect = "";
				document.body.style.overflow = "";
				document.removeEventListener("mousemove", onMouseMove);
				document.removeEventListener("mouseup", onMouseUp);
				onEnd?.();
			};
			document.addEventListener("mousemove", onMouseMove);
			document.addEventListener("mouseup", onMouseUp);
		},
		[size, min, max, onResize, onEnd],
	);

	return (
		<div className="relative h-full w-0 shrink-0 overflow-visible" onMouseDown={onMouseDown}>
			{/* 8px 命中区：挂在边界线上向右偏移一半 */}
			<div
				className={`absolute inset-y-0 left-0 w-2 translate-x-1/2 cursor-col-resize ${active ? "" : "hover:[&::after]:opacity-100"}`}
			>
				<div
					className={`absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-primary transition-opacity duration-150 ${active ? "opacity-100" : "opacity-0"}`}
				/>
			</div>
		</div>
	);
}
