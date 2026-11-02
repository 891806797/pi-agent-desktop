import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ExtensionPanel } from "../../src/components/chat/ExtensionPanel";
import { PermissionRequest } from "../../src/components/chat/PermissionRequest";
import { useChatStore } from "../../src/stores/chat";

const snapshot = await fetch("/extension-state").then((r) => r.json());
useChatStore.setState({
	ui: snapshot.ui,
	approvals: new Map(snapshot.pending.map((r: { requestId: string }) => [r.requestId, r])),
	lastSeq: snapshot.seq,
});
const stream = new EventSource(`/extension-events?sinceSeq=${snapshot.seq}`);
for (const name of ["extension_ui", "extension_notify", "approval_request", "approval_settled"])
	stream.addEventListener(name, (event) =>
		useChatStore.getState().applyEvent(JSON.parse((event as MessageEvent).data)),
	);
function Harness() {
	const ui = useChatStore((state) => state.ui);
	const approvals = useChatStore((state) => state.approvals);
	const [draft, setDraft] = useState("聊天草稿保留");
	return (
		<>
			<ExtensionPanel ui={ui} placement="aboveEditor" />
			<textarea
				aria-label="聊天草稿"
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
			/>
			<ExtensionPanel ui={ui} placement="belowEditor" />
			{[...approvals.values()].map((request) => (
				<PermissionRequest
					key={request.requestId}
					request={request}
					onApprove={async (action, data) => {
						const response = await fetch("/extension-answer", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ id: request.requestId, action, data }),
						});
						if (!response.ok) throw new Error(await response.text());
					}}
				/>
			))}
		</>
	);
}
createRoot(document.getElementById("root")!).render(<Harness />);
stream.onopen = () => (document.documentElement.dataset.ready = "true");
