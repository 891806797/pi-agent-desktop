import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, run } from "../../backend/scripts/build";
import { assertResources, desktopTarget, nativeDir, nativeTarget, verifyVersions } from "./prepare";

// JSON stays a single argv value on Windows too; never interpolate certificate data into a shell.
const args = process.argv.slice(2);
const config: {
	build?: { beforeBuildCommand: string };
	bundle?: {
		windows: { certificateThumbprint: string; digestAlgorithm: string; timestampUrl: string };
	};
} = {};
const prepared = args.indexOf("--prepared");
if (prepared >= 0) {
	args.splice(prepared, 1);
	const targetPos = args.indexOf("--target");
	const target = targetPos >= 0 ? args[targetPos + 1] : nativeTarget();
	await verifyVersions();
	assertResources();
	if (
		!existsSync(join(nativeDir, "binaries", desktopTarget(target).filename)) ||
		!existsSync(join(repoRoot, "packages/frontend/dist/index.html"))
	)
		throw new Error("--prepared requires sidecar, WASM and frontend built from this checkout");
	// CI prepares once before cargo checks, then packages those exact checked inputs.
	config.build = { beforeBuildCommand: "" };
}
const thumbprint = process.env.WINDOWS_CERTIFICATE_THUMBPRINT;
if (thumbprint && process.platform === "win32") {
	if (!/^[0-9A-Fa-f]{40}$/.test(thumbprint))
		throw new Error("Invalid signing certificate thumbprint");
	config.bundle = {
		windows: {
			certificateThumbprint: thumbprint,
			digestAlgorithm: "sha256",
			timestampUrl: "http://timestamp.digicert.com",
		},
	};
}
if (Object.keys(config).length) args.push("--config", JSON.stringify(config));
await run([process.execPath, "run", "tauri", "build", ...args], join(repoRoot, "packages/desktop"));
