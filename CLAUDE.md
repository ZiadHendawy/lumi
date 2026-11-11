# Lumi

Lumi is a voice-run task board. Read [PROJECT_PLAN.md](PROJECT_PLAN.md) (milestones, architecture, open questions) and [TECH_STACK.md](TECH_STACK.md) (stack choices and free-tier limits) before starting any work.

## Rules
- **Simplicity first:** every line must be easy to explain to someone new to the code. Follow the "Simplicity rules" in PROJECT_PLAN.md: no custom wrappers over LiveKit, few small files, plain SQL, comments explain *why*.
- **Work one milestone at a time** (M0 → M4). Don't start a milestone's product work until the open questions it depends on are answered.
- **Tests are only added, never deleted.** Every milestone must meet the plan's "definition of done": CI green, evals pass, smoke check passes, `docs/CODE_MAP.md` updated.
- **$0 budget.** Stay on the free tiers listed in TECH_STACK.md. Ask before adding any new service or dependency.
- **Keep the docs in sync.** When a decision changes, update PROJECT_PLAN.md / TECH_STACK.md in the same change.
