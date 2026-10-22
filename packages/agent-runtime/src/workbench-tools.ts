import { Type } from "@earendil-works/pi-ai";

const action = Type.Union([
  Type.Literal("open"),
  Type.Literal("close"),
  Type.Literal("select"),
  Type.Literal("setStatus"),
]);
const status = Type.Union([
  Type.Literal("ready"),
  Type.Literal("unavailable"),
  Type.Literal("disabled"),
]);

export const workbenchToolParameters: Record<string, Parameters<typeof Type.Object>[0]> = {
  Workbench: {
    action,
    id: Type.String({ minLength: 1 }),
    status: Type.Optional(status),
  },
};

export const workbenchToolDescription =
  "Open, close, switch, or disable a Workbench page through the host session. Use this tool instead of Browser. Page ids are overview, example, or pluginId/pageId from contributes.workbenchPages. Disable changes status only and keeps the page record. Unknown page ids fail and do not change the saved session.";
