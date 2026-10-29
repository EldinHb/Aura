import { useEffect, useState } from "react";
import type { Feature, MeetingMode } from "../gen";
import { useStore } from "../state/store";
import { MEETING_MODE_LABEL } from "../lib/features";

/**
 * How a feature's team meets: as the setting for every feature owner says,
 * or this feature's own mode. Live meetings cost more tokens, so the user
 * picks them.
 */
export function MeetingModePicker({ ownerId, feature }: { ownerId: string; feature: Feature }) {
  const client = useStore((st) => st.client);
  const toast = useStore((st) => st.toast);
  const [global, setGlobal] = useState<MeetingMode | null>(null);
  useEffect(() => {
    client?.meetingSettings().then((s) => setGlobal(s.mode), () => {});
  }, [client, feature.meeting_mode]);
  const own = feature.meeting_mode ?? null;
  const change = async (value: string) => {
    if (!client) return;
    const mode = value === "setting" ? null : (value as MeetingMode);
    try {
      await client.setFeatureMeetingMode(ownerId, mode);
      toast(mode ? `This feature's meetings are ${MEETING_MODE_LABEL[mode]} now` : "This feature's meetings follow the setting again");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  return (
    <select
      className="meeting-mode-picker"
      aria-label="Meetings"
      value={own ?? "setting"}
      data-hint
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => void change(e.target.value)}
    >
      <option value="setting">{global ? `${MEETING_MODE_LABEL[global]} (setting)` : "as the setting says"}</option>
      <option value="written">written</option>
      <option value="live">live</option>
    </select>
  );
}
