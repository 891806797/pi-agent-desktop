import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** 单个按需绘制循环：尺寸只在 ResizeObserver/重置时读取，空闲和上翻时没有循环。 */
export function createChatScroll(
	scroll: HTMLElement,
	content: HTMLElement,
	changed: (following: boolean) => void,
) {
	let following = true;
	let target = 0;
	let lastWritten = scroll.scrollTop;
	let frame: number | undefined;
	let previousTime: number | undefined;
	let touchY = 0;
	const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
	const cancel = () => {
		if (frame !== undefined) cancelAnimationFrame(frame);
		frame = undefined;
		previousTime = undefined;
	};
	const setFollowing = (value: boolean) => {
		if (following !== value) {
			following = value;
			changed(value);
		}
	};
	const write = (value: number) => {
		scroll.scrollTop = value;
		lastWritten = scroll.scrollTop;
	};
	const measure = () => {
		target = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
	};
	const tick = (time: number) => {
		frame = undefined;
		if (!following) return;
		const current = scroll.scrollTop;
		const distance = target - current;
		if (Math.abs(distance) <= 1 || motion.matches) {
			write(target);
			previousTime = undefined;
			return;
		}
		const elapsed = Math.min(64, previousTime === undefined ? 16.7 : time - previousTime);
		previousTime = time;
		write(
			current +
				Math.sign(distance) * Math.max(1, Math.abs(distance) * (1 - Math.exp(-elapsed / 65))),
		);
		frame = requestAnimationFrame(tick);
	};
	const schedule = () => {
		if (following && frame === undefined) frame = requestAnimationFrame(tick);
	};
	const pause = () => {
		if (target <= 1) return;
		cancel();
		setFollowing(false);
	};
	const resume = (instant = false) => {
		cancel();
		setFollowing(true);
		measure();
		if (instant || motion.matches) write(target);
		else schedule();
	};
	const onScroll = () => {
		// 程序写入不能被误判成用户上翻，否则平滑追踪在落后底部时会自行中断。
		if (Math.abs(scroll.scrollTop - lastWritten) < 1) return;
		// 视口变大或内容折叠也会由浏览器回缩 scrollTop，先更新边界再判断用户意图。
		measure();
		if (target - scroll.scrollTop <= 8) {
			setFollowing(true);
			schedule();
		} else pause();
	};
	const onWheel = (event: WheelEvent) => {
		if (event.deltaY < 0 && Math.abs(event.deltaY) >= Math.abs(event.deltaX)) pause();
	};
	const onTouchStart = (event: TouchEvent) => {
		touchY = event.touches[0]?.clientY ?? 0;
	};
	const onTouchMove = (event: TouchEvent) => {
		const next = event.touches[0]?.clientY ?? touchY;
		if (next > touchY + 1) pause();
		touchY = next;
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (
			event.defaultPrevented ||
			(event.target as Element).closest("input, textarea, [contenteditable=true]")
		)
			return;
		if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey))
			pause();
	};
	const observer = new ResizeObserver(() => {
		measure();
		schedule();
	});
	observer.observe(content);
	observer.observe(scroll);
	scroll.addEventListener("scroll", onScroll, { passive: true });
	scroll.addEventListener("wheel", onWheel, { passive: true });
	scroll.addEventListener("touchstart", onTouchStart, { passive: true });
	scroll.addEventListener("touchmove", onTouchMove, { passive: true });
	scroll.addEventListener("keydown", onKeyDown);
	return {
		resume,
		destroy() {
			cancel();
			observer.disconnect();
			scroll.removeEventListener("scroll", onScroll);
			scroll.removeEventListener("wheel", onWheel);
			scroll.removeEventListener("touchstart", onTouchStart);
			scroll.removeEventListener("touchmove", onTouchMove);
			scroll.removeEventListener("keydown", onKeyDown);
		},
	};
}

export function useChatScroll(sessionKey: string, loading: boolean) {
	const listRef = useRef<HTMLElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const controller = useRef<ReturnType<typeof createChatScroll> | null>(null);
	const [following, setFollowing] = useState(true);
	useLayoutEffect(() => {
		if (!listRef.current || !contentRef.current) return;
		const current = createChatScroll(listRef.current, contentRef.current, setFollowing);
		controller.current = current;
		return () => {
			current.destroy();
			controller.current = null;
		};
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 会话和异步历史切换后在 paint 前定位，不为历史播放滚动动画。
	useLayoutEffect(() => {
		controller.current?.resume(true);
	}, [sessionKey, loading]);
	const resume = useCallback(() => controller.current?.resume(), []);
	return { listRef, contentRef, following, resume };
}
