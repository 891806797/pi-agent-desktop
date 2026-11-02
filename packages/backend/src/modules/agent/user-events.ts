import type { SequencedUserEvent, UserEvent } from "@pi-agent/common";

/** 每用户独立游标，摘要连接不订阅后台会话正文。 */
export class UserEventHub {
	readonly epoch = crypto.randomUUID();
	private seq = 0;
	private events: SequencedUserEvent[] = [];
	private listeners = new Set<(event: SequencedUserEvent) => void>();
	get cursor() {
		return { epoch: this.epoch, seq: this.seq };
	}
	publish(event: UserEvent) {
		const value = { ...event, seq: ++this.seq, epoch: this.epoch } as SequencedUserEvent;
		this.events.push(value);
		if (this.events.length > 500) this.events.shift();
		for (const listener of this.listeners) {
			try {
				listener(value);
			} catch (error) {
				console.error("[user-events]", error);
			}
		}
	}
	subscribe(listener: (event: SequencedUserEvent) => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	replay(epoch: string, seq: number): SequencedUserEvent[] | undefined {
		if (epoch !== this.epoch || !Number.isSafeInteger(seq) || seq < 0 || seq > this.seq) return;
		if (seq < (this.events[0]?.seq ?? this.seq + 1) - 1) return;
		return this.events.filter((event) => event.seq > seq);
	}
}
