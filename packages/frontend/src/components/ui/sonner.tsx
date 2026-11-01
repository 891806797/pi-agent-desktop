import type { JSX } from "react";
import { Toaster as SonnerToaster } from "sonner";

// sonner toast 封装。独立库（非 Radix/Base UI），自带 portal，全局 <Toaster /> 挂载一次即可。
export { toast } from "sonner";

export function Toaster(): JSX.Element {
	return (
		<SonnerToaster
			position="bottom-right"
			richColors
			closeButton
			theme="system"
			toastOptions={{
				style: {
					fontSize: "13px",
					fontFamily: "inherit",
				},
			}}
		/>
	);
}
