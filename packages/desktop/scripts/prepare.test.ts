import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostTarget } from "../../backend/scripts/build";
import { assertReleaseVersions, assertResources, desktopTarget } from "./prepare";

test("Intel Mac stays Intel; unsupported arch never silently becomes x64", () => {
	expect(hostTarget("darwin", "x64")).toBe("bun-darwin-x64");
	expect(hostTarget("linux", "arm64")).toBe("bun-linux-arm64");
	expect(() => desktopTarget("aarch64-unknown-linux-gnu")).toThrow();
});
test("four supported installers receive correct binary names", () => {
	for (const [target, bun, extension] of [
		["x86_64-pc-windows-msvc", "bun-windows-x64", ".exe"],
		["aarch64-apple-darwin", "bun-darwin-arm64", ""],
		["x86_64-apple-darwin", "bun-darwin-x64", ""],
		["x86_64-unknown-linux-gnu", "bun-linux-x64", ""],
	]) {
		expect(String(desktopTarget(target!).bun)).toBe(bun!);
		expect(desktopTarget(target!).filename).toBe(`pi-agent-sidecar-${target}${extension}`);
	}
});
test("release rejects a stale native version or different tag", () => {
	expect(() => assertReleaseVersions("0.1.0", "0.1.0", "0.1.1", "v0.1.0")).toThrow();
	expect(() => assertReleaseVersions("0.1.0", "0.1.0", "0.1.0", "v0.2.0")).toThrow();
	expect(() => assertReleaseVersions("0.1.0", "0.1.0", "0.1.0", "v0.1.0")).not.toThrow();
});
test("missing/invalid WASM blocks packaging before Tauri", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-resource-"));
	try {
		expect(() => assertResources(dir)).toThrow();
		mkdirSync(join(dir, "resources"));
		writeFileSync(join(dir, "resources/photon_rs_bg.wasm"), "not wasm");
		expect(() => assertResources(dir)).toThrow();
		writeFileSync(
			join(dir, "resources/photon_rs_bg.wasm"),
			new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
		);
		expect(() => assertResources(dir)).not.toThrow();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
