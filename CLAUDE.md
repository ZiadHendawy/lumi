# Lumi

Lumi is a voice-run task board. Read [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) (milestones, architecture, open questions) and [docs/TECH_STACK.md](docs/TECH_STACK.md) (stack choices and free-tier limits) before starting any work.

## Rules
- **Simplicity first:** every line should be easy to explain to a reader new to the code. Follow the "Simplicity rules" in docs/PROJECT_PLAN.md: no custom wrappers over LiveKit, few small files, plain SQL, comments explain *why*.
- **Work one milestone at a time** (M0 → M4). Don't start a milestone's product work until the open questions it depends on are answered.
- **Tests are only added, never deleted.** Every milestone must meet the plan's "definition of done": CI green, evals pass, smoke check passes, `docs/CODE_MAP.md` updated.
- **$0 budget.** Stay on the free tiers listed in docs/TECH_STACK.md. Ask before adding any new service or dependency.
- **Keep the docs in sync.** When a decision changes, update docs/PROJECT_PLAN.md / docs/TECH_STACK.md in the same change.
