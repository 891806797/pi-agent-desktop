import { memo } from "react";
import { Foldable, ResultShell } from "./primitives";

/** SDK 文本按原文展示；结构化 JSON 仅格式化，不嗅探其他框架的标签或工具前缀。 */
export const ToolResultRenderer = memo(function ToolResultRenderer({
	content,
	error,
}: {
	content: string;
	error?: boolean;
}): React.JSX.Element {
	let display = content;
	try {
		const parsed: unknown = JSON.parse(content);
		if (parsed !== null && typeof parsed === "object") display = JSON.stringify(parsed, null, 2);
	} catch {
		/* 普通工具文本按原文展示。 */
	}
	return (
		<ResultShell error={error}>
			<Foldable content={display} error={error} />
		</ResultShell>
	);
});
