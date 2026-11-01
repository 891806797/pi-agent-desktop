/**
 * `/` 命令列表聚合：Web 已实现的原生命令、扩展命令、prompt 模板与 skills。
 * 与 pi 内部 SlashCommandInfo 口径一致（agent-session.ts getCommands），
 * name 与 pi 一致不带 '/' 前缀；输入组件只添加一次前缀。
 */

import { BUILTIN_SLASH_COMMANDS, type SlashCommand } from "@pi-agent/common";
import type { SessionContext } from "./session-registry";

function commandName(name: string): string {
	return name.replace(/^\/+/, "");
}

export function listCommands(ctx: SessionContext): SlashCommand[] {
	const commands: SlashCommand[] = [...BUILTIN_SLASH_COMMANDS];

	for (const command of ctx.session.extensionRunner.getRegisteredCommands()) {
		commands.push({
			name: commandName(command.invocationName),
			description: command.description,
			source: "extension",
		});
	}
	for (const template of ctx.resourceLoader.getPrompts().prompts) {
		commands.push({
			name: commandName(template.name),
			description: template.description,
			source: "prompt",
		});
	}
	for (const skill of ctx.resourceLoader.getSkills().skills) {
		commands.push({
			name: `skill:${skill.name}`,
			description: skill.description,
			source: "skill",
		});
	}
	return commands;
}
