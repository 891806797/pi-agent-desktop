/**
 * 会话事件总线 —— 多 tab 镜像一致的核心。
 *
 * agent → 前端的一切消息都经总线单点定序（seq 单调 + 500 条环形缓冲）：
 * 翻译层、审批管理器、REST 切换结果统一 publish 进来，所有 SSE 订阅者
 * 看到同一 seq 序列；前端 seq 幂等 + 跳洞对账 = 镜像一致（实施计划 §4）。
 */

import type { SequencedEvent, SSEEvent } from "@pi-agent/common";

const BUFFER_SIZE = 500;

export type BusSubscriber = (ev: SequencedEvent) => void;

export class SessionEventBus {
	readonly epoch = crypto.randomUUID();
	private seq = 0;
	private buffer: SequencedEvent[] = [];
	private subscribers = new Set<BusSubscriber>();

	/** 分配 seq → 入环形缓冲 → 广播给所有订阅者 */
	publish(ev: SSEEvent): SequencedEvent {
		const sequenced = { seq: ++this.seq, ...ev } as SequencedEvent;
		this.buffer.push(sequenced);
		if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();
		for (const sub of this.subscribers) {
			try {
				sub(sequenced);
			} catch (err) {
				// 单个订阅者异常不应影响广播（坏连接由 SSE 层清理）
				console.error("[event-bus] subscriber error:", err);
			}
		}
		return sequenced;
	}

	subscribe(fn: BusSubscriber): () => void {
		this.subscribers.add(fn);
		return () => {
			this.subscribers.delete(fn);
		};
	}

	get currentSeq(): number {
		return this.seq;
	}

	/**
	 * 增量重放：lastSeq 之后的事件。缓冲截断（lastSeq 已不在缓冲窗口）时
	 * 返回 undefined，客户端应回退 GET /history 全量对账。
	 */
	replaySince(lastSeq: number): SequencedEvent[] | undefined {
		if (lastSeq <= 0) return [];
		if (lastSeq > this.seq) return undefined;
		if (lastSeq === this.seq) return [];
		const oldest = this.buffer[0]?.seq ?? this.seq + 1;
		if (lastSeq < oldest - 1) return undefined; // 跳洞
		return this.buffer.filter((ev) => ev.seq > lastSeq);
	}

	subscriberCount(): number {
		return this.subscribers.size;
	}
}
