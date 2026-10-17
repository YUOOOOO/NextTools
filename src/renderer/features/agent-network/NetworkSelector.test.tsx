import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { NetworkRegistry } from "@/api/agentNetwork";
const calls = vi.hoisted(() => ({
  select: vi.fn(),
  join: vi.fn(),
  remove: vi.fn(),
  accept: vi.fn(),
}));
vi.mock("@/api/agentNetwork", async (original) => ({
  ...(await original<typeof import("@/api/agentNetwork")>()),
  selectNetworkConnection: calls.select,
  joinNetworkConnection: calls.join,
  removeNetworkConnection: calls.remove,
}));
vi.mock("./store", () => ({ acceptNetworkRegistry: calls.accept }));
import { NetworkSelector } from "./NetworkSelector";
const registry: NetworkRegistry = {
  selfhostEnabled: true,
  selected: "official",
  connections: ["official", "self-a", "self-b"].map((id) => ({
    id,
    name:
      id === "official" ? "NextTools" : id === "self-a" ? "Team A" : "Team B",
    official: id === "official",
    url: null,
    removing: false,
    snapshot: {
      connectionId: id,
      state: "ready",
      principalId: id,
      networkId: id,
      error: null,
      revision: 1,
      authGeneration: 1,
    },
  })),
};
beforeEach(() => {
  vi.resetAllMocks();
  calls.select.mockResolvedValue({ ...registry, selected: "self-a" });
  calls.join.mockRejectedValue({ code: "ACCOUNT_CREDENTIALS_INVALID" });
});
it("always exposes the network controls without a Team Space build", () => {
  render(<NetworkSelector registry={{ ...registry, selfhostEnabled: undefined }} />);
  expect(screen.getByRole("heading")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "选择网络" })).toBeInTheDocument();
});
it("keeps the join dialog available when Team Space capability changes", async () => {
  const view = render(<NetworkSelector registry={registry} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "加入自部署网络" }));
  expect(screen.getByLabelText("密码")).toBeInTheDocument();
  view.rerender(<NetworkSelector registry={{ ...registry, selfhostEnabled: false }} />);
  expect(screen.getByLabelText("密码")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
});
it("switches only the selected view and never removes or reenrolls another connection", async () => {
  render(<NetworkSelector registry={registry} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /Team A/ }));
  await waitFor(() => expect(calls.select).toHaveBeenCalledWith("self-a"));
  expect(calls.remove).not.toHaveBeenCalled();
  expect(calls.join).not.toHaveBeenCalled();
  expect(calls.accept).toHaveBeenCalledWith(
    expect.objectContaining({
      selected: "self-a",
      connections: registry.connections,
    }),
  );
});
it("retains the URL and identifier but clears the password after a refused login", async () => {
  render(<NetworkSelector registry={registry} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "加入自部署网络" }),
  );
  const url = screen.getByLabelText("服务 URL");
  const identifier = screen.getByLabelText("邮箱或账号");
  const password = screen.getByLabelText("密码");
  fireEvent.change(url, { target: { value: "https://hub.example.test" } });
  fireEvent.change(identifier, { target: { value: "smoke-account" } });
  fireEvent.change(password, { target: { value: "ephemeral-password" } });
  fireEvent.click(screen.getByRole("button", { name: "加入网络" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("账号或密码无效");
  expect(url).toHaveValue("https://hub.example.test");
  expect(identifier).toHaveValue("smoke-account");
  expect(password).toHaveValue("");
  expect(calls.join).toHaveBeenCalledWith(
    "https://hub.example.test",
    "smoke-account",
    "ephemeral-password",
    false,
  );
  expect(calls.accept).not.toHaveBeenCalled();
});

it("submits explicit registration once and closes only after enrollment succeeds", async () => {
  let finish!: (value: NetworkRegistry) => void;
  calls.join.mockImplementation(() => new Promise<NetworkRegistry>((resolve) => { finish = resolve; }));
  render(<NetworkSelector registry={registry} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "加入自部署网络" }));
  fireEvent.change(screen.getByLabelText("服务 URL"), { target: { value: "https://hub.example.test" } });
  fireEvent.change(screen.getByLabelText("邮箱或账号"), { target: { value: "new@example.test" } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "ephemeral-password" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /注册新账号/ }));
  fireEvent.click(screen.getByRole("button", { name: "加入网络" }));
  expect(calls.join).toHaveBeenCalledExactlyOnceWith("https://hub.example.test", "new@example.test", "ephemeral-password", true);
  expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  finish({ ...registry, selected: "self-a" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(calls.accept).toHaveBeenCalledWith(expect.objectContaining({ selected: "self-a" }));
});
it("revokes a configured official connection without enabling selfhost networks", async () => {
  const connected = { ...registry, selfhostEnabled: false, connections: registry.connections.map(c => c.official ? { ...c, url: "https://official.example.test" } : c) };
  calls.remove.mockResolvedValue({ ...connected, connections: [] });
  render(<NetworkSelector registry={connected} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "移除网络" }));
  fireEvent.click(screen.getByRole("button", { name: "移除网络" }));
  await waitFor(() => expect(calls.remove).toHaveBeenCalledExactlyOnceWith("official"));
  expect(calls.accept).toHaveBeenCalledWith(expect.objectContaining({ connections: [] }));
});
it("distinguishes a signed-out account from an offline enrolled connection", async () => {
  render(<NetworkSelector registry={{ ...registry, connections: registry.connections.map(c => ({ ...c, snapshot: { ...c.snapshot, state: c.official ? "signedOut" : "disconnected" } })) }} />);
  fireEvent.click(screen.getByRole("button", { name: "选择网络" }));
  const items = screen.getAllByRole("menuitemradio");
  expect(items[0]).toHaveTextContent("NextTools 官方网络");
  expect(items[0]).toHaveTextContent("未登录");
  expect(items[1]).toHaveTextContent("Team A");
  expect(items[1]).toHaveTextContent("离线");
});
