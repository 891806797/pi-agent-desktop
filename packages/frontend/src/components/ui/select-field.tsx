import { Select } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";

export function SelectField({
	id,
	label,
	value,
	options,
	onChange,
}: {
	id: string;
	label: string;
	value: string;
	options: Array<{ value: string; label: string }>;
	onChange: (value: string) => void;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground">
			<label htmlFor={id}>{label}</label>
			<Select.Root
				items={options}
				value={value}
				onValueChange={(next) => {
					if (next !== null) onChange(next);
				}}
			>
				<Select.Trigger
					id={id}
					className="group flex h-10 w-full items-center justify-between gap-3 rounded-lg border border-input bg-background px-3 text-left text-sm text-foreground transition-colors hover:border-[var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
				>
					<Select.Value className="min-w-0 truncate" />
					<Select.Icon>
						<ChevronDown
							aria-hidden
							className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none group-data-[popup-open]:rotate-180"
						/>
					</Select.Icon>
				</Select.Trigger>
				<Select.Portal>
					<Select.Positioner
						sideOffset={6}
						align="start"
						alignItemWithTrigger={false}
						className="z-50"
					>
						<Select.Popup className="max-h-[min(var(--available-height),20rem)] w-[var(--anchor-width)] min-w-40 overflow-auto rounded-xl border border-[var(--border-base)] bg-popover p-1.5 text-popover-foreground shadow-[var(--elevation-raised)] outline-none transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 motion-reduce:transition-none">
							<Select.List>
								{options.map((option) => (
									<Select.Item
										key={option.value}
										value={option.value}
										className="flex min-h-10 cursor-pointer items-center justify-between gap-4 rounded-lg px-3 py-2 text-sm outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
									>
										<Select.ItemText>{option.label}</Select.ItemText>
										<Select.ItemIndicator>
											<Check aria-hidden className="size-4 shrink-0 text-primary" />
										</Select.ItemIndicator>
									</Select.Item>
								))}
							</Select.List>
						</Select.Popup>
					</Select.Positioner>
				</Select.Portal>
			</Select.Root>
		</div>
	);
}
