import { defineTool, Type } from "../interface.js";
import { getRequestSlot } from "../../runtime/request-context.js";

interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
}

interface PlanData {
  title: string;
  steps: PlanStep[];
  notes?: string;
}
const REQUEST_PLAN_SLOT = "builtin:update_plan";

export const updatePlanTool = defineTool({
  name: "update_plan",
  label: "Update Plan",
  description:
    "Show the user your step-by-step plan and update progress. " +
    "Use this at the start of a complex task to outline your approach, " +
    "then update step statuses as you complete them. " +
    "The frontend renders this as a progress tracker. " +
    "Only one step can be 'in_progress' at a time.",
  parameters: Type.Object({
    title: Type.Optional(Type.String({ description: "Plan title (set once at the start)" })),
    steps: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String({ description: "Step ID (e.g. 'step_1')" }),
          description: Type.String({ description: "What this step does" }),
          status: Type.String({ description: "pending | in_progress | completed | skipped" }),
        })
      )
    ),
    updateStep: Type.Optional(
      Type.Object({
        id: Type.String({ description: "Step ID to update" }),
        status: Type.String({ description: "New status: pending | in_progress | completed | skipped" }),
      })
    ),
    notes: Type.Optional(Type.String({ description: "Optional explanation or summary" })),
  }),
  execute: async (params) => {
    const state = getRequestSlot<{ plan: PlanData | null }>(REQUEST_PLAN_SLOT, () => ({ plan: null }));
    let plan = state.plan;

    // Create or update plan
    if (params.title || params.steps) {
      plan = {
        title: params.title ?? plan?.title ?? "Plan",
        steps: (params.steps as PlanStep[]) ?? plan?.steps ?? [],
        notes: params.notes ?? plan?.notes,
      };
      state.plan = plan;
    }

    // Update a single step
    if (params.updateStep && plan) {
      const step = plan.steps.find((s) => s.id === params.updateStep!.id);
      if (step) {
        step.status = params.updateStep.status as PlanStep["status"];
      }
      if (params.notes !== undefined) {
        plan.notes = params.notes;
      }
    }

    if (!plan) {
      return JSON.stringify({ error: "No plan exists. Provide title and steps first." });
    }

    return JSON.stringify(plan, null, 2);
  },
});
