import { defineTool, Type } from "../interface.js";

export const currentDatetimeTool = defineTool({
  name: "current_datetime",
  label: "Current Date/Time",
  description:
    "Get the current date, time, and timezone. " +
    "Use this when you need to know the current time for scheduling, " +
    "time-sensitive queries, or providing time-aware responses.",
  parameters: Type.Object({
    timezone: Type.Optional(
      Type.String({ description: "IANA timezone (e.g. 'America/New_York'). Defaults to UTC" })
    ),
  }),
  execute: async (params) => {
    const tz = params.timezone ?? "UTC";
    const now = new Date();

    try {
      const formatted = now.toLocaleString("en-US", {
        timeZone: tz,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      });

      return JSON.stringify({
        iso: now.toISOString(),
        formatted,
        timezone: tz,
        unix: Math.floor(now.getTime() / 1000),
      });
    } catch {
      throw new Error(`Invalid timezone: ${tz}`);
    }
  },
});
