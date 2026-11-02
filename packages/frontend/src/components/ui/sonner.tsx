import type { JSX } from "react";
import { Toaster as SonnerToaster } from "sonner";
import { useThemeStore } from "@/lib/theme";

// sonner toast 封装。独立库（非 Radix/Base UI），自带 portal，全局 <Toaster /> 挂载一次即可。
export { toast } from "sonner";

export function Toaster(): JSX.Element {
	const theme = useThemeStore((state) => state.theme);
	return (
		<SonnerToaster
			position="bottom-right"
			richColors
			closeButton
			theme={theme === "dark" ? "dark" : "light"}
			toastOptions={{
				style: {
					fontSize: "13px",
					fontFamily: "inherit",
				},
			}}
		/>
	);
}
