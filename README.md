# NextTools

A local-first personal workbench, developed on top of **PI-Desktop**, with a planned **OpenMinis-based mobile client**.

[简体中文](README.zh-CN.md) · [Development roadmap](docs/project/pi-workbench.md) · [Phase specifications](docs/project/pi-workbench/phases.md) · [Acceptance checklist](docs/project/pi-workbench/acceptance.md)

## Project status

The repository currently contains the PI-Desktop desktop baseline. The personal workbench roadmap is documented; the Activity Bar, Personal Agent, new bundled modules, encrypted relay and mobile adaptation remain planned work. This README does not describe them as shipped features.

Application names, package IDs and build metadata still use PI-Desktop. NextTools is the repository identity; PI Workbench is the working name used in the design documents. Branding and distribution changes are separate tasks.

## Reference projects

| Project | Role in NextTools | Source |
|---|---|---|
| PI-Desktop | Desktop fork foundation: Electron/React shell, project sessions, Agent runtime, Host Core, plugins, tools and permissions | [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop) |
| OpenMinis | Planned local-first mobile foundation; preserve native local Agent, chat, memory, tools and permissions while adapting shared Personal Agent data | [OpenMinis/OpenMinis](https://github.com/OpenMinis/OpenMinis) |

OpenMinis has **not been imported**. Its directory is reserved at [`apps/mobile/`](apps/mobile/README.md); source intake, licensing, native build and detailed adaptation are a future stage. Upstream code will be pinned to a reviewed commit and updated selectively, without automatic merges.

The Personal Agent memory design also takes inspiration from [MyAgents/Mino](https://github.com/hAcKlyc/MyAgents/tree/db56b48be4bdaf025a549a6669c1adf41fc1e943/bundled-workspaces/mino): identity, personality, user context and journal/topic/core memory. This is a design reference, not a third imported runtime or an adopted Git synchronization mechanism.

## Existing desktop foundation

The inherited PI desktop supports project/session workflows, model configuration, streaming Agent execution, local tools and permission approvals, persistent transcripts, plugins, a right work panel, scheduled tasks and notifications. Verify exact behavior against the current code and [PI specifications](docs/spec/README.md).

Desktop boundaries remain unchanged: the renderer handles interaction, Electron Main orchestrates, Rust Host Core owns durable storage and privileged host operations, and the Agent runtime owns model execution.

## Planned direction

- **Desktop navigation:** fixed left Activity Bar ordered Agent, Workbench, Scheduled Tasks, Extensions; Notifications and Settings at the bottom. Agent opens by default and retains its existing project/session workspace.
- **Plugin-first workbench:** prefer existing plugin capabilities; first-party modules are bundled and protected from uninstall. Built-in status does not bypass permissions. Workbench does not embed an Agent assistant.
- **Personal Agent:** a distinct identity with reviewable personality, conversations, user context, layered memory, revisions and gradual memory evolution.
- **Local-first phone:** adapt OpenMinis to the same Personal Agent record contract, keeping local execution and native data ownership.
- **Online-only project control:** the phone controls a reachable authenticated desktop session. Offline desktop tasks are not queued or automatically delivered later.
- **Encrypted peer synchronization:** devices exchange Personal Agent changes while both are online. The relay cannot decrypt or persist messages, ciphertext history, memory or snapshots. Conflicts and offline conversation branches remain explicit.
- **Business tools:** Tushare first, then Quant and News, sharing business services between direct UI operation and optional Agent Tools.

See [architecture and ownership](docs/project/pi-workbench/architecture.md) and [confirmed decisions/open questions](docs/project/pi-workbench/decisions.md). Detailed protocol and mobile designs require their own review before implementation.

## Repository layout

```text
apps/
  desktop/                 PI-Desktop Electron application
  mobile/                  Reserved OpenMinis mobile client; README only
packages/                  Existing Agent/runtime/plugin/shared packages
crates/host-core/          Rust-owned persistence, permissions and host services
docs/project/pi-workbench.md
                           Development roadmap
docs/project/pi-workbench/
  architecture.md          Ownership, memory model and interoperability proposal
  phases.md                Phase scope, dependencies and exit criteria
  acceptance.md            Pending acceptance gates
  decisions.md             Confirmed constraints and unresolved decisions
```

No mobile build, relay application or new plugin engine is introduced by the directory reservation.

## Desktop development

Requirements: Node.js `>=22.19.0`, pnpm as pinned by `packageManager` in [`package.json`](package.json), stable Rust and the platform's native build prerequisites. Follow [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for the repository workflow and validation rules.

For a new development environment:

```powershell
pnpm install
cargo build -p host-core
pnpm build:js
pnpm dev
```

Reuse the provisioned dependencies/caches in dedicated worktrees. Installing a second environment solely for verification is not the default workflow. There are no mobile setup or build commands until OpenMinis intake is approved.

Relevant checks, selected according to the change:

```powershell
pnpm docs:check
pnpm check:agent-policy
pnpm --filter @pi-desktop/desktop typecheck
pnpm lint
```

Commands listed here are usage instructions, not claims that they have passed for every candidate. The [acceptance checklist](docs/project/pi-workbench/acceptance.md) defines phase-specific evidence requirements.

## Documentation

- [Development roadmap](docs/project/pi-workbench.md)
- [Phase specifications](docs/project/pi-workbench/phases.md)
- [Acceptance checklist](docs/project/pi-workbench/acceptance.md)
- [Architecture proposal](docs/project/pi-workbench/architecture.md)
- [Decisions and source references](docs/project/pi-workbench/decisions.md)
- [Mobile reservation and intake policy](apps/mobile/README.md)
- [Existing plugin development guide](docs/plugin-development.md)
- [Existing desktop user guide](docs/guide/index.md)

## License and attribution

The current inherited desktop source is governed by the repository [LICENSE](LICENSE) (LGPL v3); preserve applicable upstream notices and file-specific terms. Referencing a project does not relicense its code.

OpenMinis uses GPL v3. Review compatibility, notices, source distribution and packaging obligations before mobile source import or combined distribution. MyAgents uses AGPL v3 at repository level; a Mino template notice does not license unrelated implementation files. No external implementation is imported as part of this roadmap/README change.

PI-Desktop and OpenMinis remain independent upstream projects. Their releases, badges and community links are not NextTools release or support channels.
