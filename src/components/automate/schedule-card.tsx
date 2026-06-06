"use client";

import { CircleNotch } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { AutomationConfigState } from "@/hooks/use-automation";
import { notifyError } from "@/lib/toast";
import { HourSelect, type HourValue } from "./hour-select";

type ScheduleCardProps = {
	config: AutomationConfigState;
	onSave: (
		scheduleHour: number | null,
		timezone: string | null,
	) => Promise<{ ok: true } | { ok: false; error: string }>;
};

function detectTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

export function ScheduleCard({
	config,
	onSave,
}: ScheduleCardProps): React.JSX.Element {
	const [hour, setHour] = useState<HourValue>(config.scheduleHour);
	const [saving, setSaving] = useState(false);
	const persistedTz = useRef(config.timezone);

	// Auto-detect + persist the timezone on mount when not already stored.
	useEffect(() => {
		if (persistedTz.current) return;
		const detected = detectTimezone();
		persistedTz.current = detected;
		void onSave(config.scheduleHour, detected);
	}, [config.scheduleHour, onSave]);

	// Persist immediately when the hour changes — no explicit Save step.
	const changeHour = async (next: HourValue): Promise<void> => {
		setHour(next);
		setSaving(true);
		const result = await onSave(next, persistedTz.current ?? detectTimezone());
		if (!result.ok) {
			notifyError(result.error, "Could not save schedule.");
			setHour(config.scheduleHour);
		}
		setSaving(false);
	};

	return (
		<div className="rounded-xl border p-5">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h2 className="text-sm font-semibold">Schedule</h2>
					<p className="text-xs text-muted-foreground">
						Poll your sources once a day at this hour, in your local time.
					</p>
				</div>
			</div>

			<div className="mt-4 flex flex-wrap items-center gap-3">
				<HourSelect
					value={hour}
					onChange={(next) => void changeHour(next)}
					disabled={saving}
				/>
				{saving ? (
					<CircleNotch className="size-4 animate-spin text-muted-foreground" />
				) : null}
			</div>
		</div>
	);
}
