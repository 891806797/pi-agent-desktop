import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { CircleIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

// Base UI 把单选组拆成两个包：
//   @base-ui/react/radio-group -> RadioGroup（容器，value/onValueChange，泛型 <Value>）
//   @base-ui/react/radio       -> Radio.Root / Radio.Indicator
// RadioGroupRoot 保留泛型 <TValue>，让 value/onValueChange 类型从消费端推导（默认 string）。
function RadioGroupRoot<TValue = string>({
	className,
	ref,
	...props
}: RadioGroup.Props<TValue>): React.JSX.Element {
	return <RadioGroup<TValue> className={cn("grid gap-2", className)} ref={ref} {...props} />;
}
RadioGroupRoot.displayName = "RadioGroup";

const RadioGroupItem = React.forwardRef<
	React.ComponentRef<typeof Radio.Root>,
	React.ComponentPropsWithoutRef<typeof Radio.Root>
>(({ className, ...props }, ref) => (
	<Radio.Root
		ref={ref}
		className={cn(
			"relative aspect-square size-4 rounded-full border border-primary text-primary ring-offset-background focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
			className,
		)}
		{...props}
	>
		{/* Base UI Indicator 无默认定位，须显式 inset-0 居中，否则小点堆在圈顶部；
        8px 点对 16px 圈为标准比例（去边框后四周各留 3px） */}
		<Radio.Indicator className="absolute inset-0 flex items-center justify-center">
			<CircleIcon className="size-2 fill-current text-current" />
		</Radio.Indicator>
	</Radio.Root>
));
RadioGroupItem.displayName = "RadioGroupItem";

export { RadioGroupItem, RadioGroupRoot as RadioGroup };
