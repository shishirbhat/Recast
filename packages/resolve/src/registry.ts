import type { CapabilityContract } from "@recast/core";
import { gmailDraft, googleCalendar, googleSheets, googleTasks, notion } from "@recast/bridges";

/** API-friendly destination ids -> the capability contracts they route through. */
export const DESTINATIONS: Readonly<Record<string, CapabilityContract>> = {
  google_calendar: googleCalendar.contract,
  gmail: gmailDraft.contract,
  google_sheets: googleSheets.contract,
  google_tasks: googleTasks.contract,
  notion: notion.contract,
};
export const destinationIds = () => Object.keys(DESTINATIONS);
