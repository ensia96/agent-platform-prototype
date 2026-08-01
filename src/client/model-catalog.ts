import type {
  AgentDefinition,
  ProviderModelCatalog,
  ProviderModelCatalogItem,
  ProviderProfile,
  ProviderReasoningEffortOption,
  ReasoningEffort
} from "../shared/types";

export type ModelCatalogLoadState = "idle" | "loading" | "loaded" | "error";

export function effectiveRunModelId(
  profile: ProviderProfile | null,
  agent: AgentDefinition | null,
  modelOverride: string
): string {
  return (
    modelOverride.trim() ||
    agent?.defaultRunOptions?.model?.trim() ||
    profile?.defaultRunOptions?.model?.trim() ||
    profile?.model?.trim() ||
    ""
  );
}

export function selectedCatalogModel(
  catalog: ProviderModelCatalog | null,
  profile: ProviderProfile | null,
  agent: AgentDefinition | null,
  modelOverride: string
): ProviderModelCatalogItem | null {
  const modelId = effectiveRunModelId(profile, agent, modelOverride);
  return catalog?.models.find((model) => model.id === modelId) ?? null;
}

export function advertisedReasoningEfforts(
  catalog: ProviderModelCatalog | null,
  profile: ProviderProfile | null,
  agent: AgentDefinition | null,
  modelOverride: string
): ProviderReasoningEffortOption[] {
  const model = selectedCatalogModel(catalog, profile, agent, modelOverride);
  return model?.reasoning.support === "supported" ? model.reasoning.efforts : [];
}

export function reconcileReasoningEffort(
  catalog: ProviderModelCatalog | null,
  profile: ProviderProfile | null,
  agent: AgentDefinition | null,
  modelOverride: string,
  currentEffort: ReasoningEffort | ""
): ReasoningEffort | "" {
  if (!currentEffort) {
    return "";
  }
  return advertisedReasoningEfforts(catalog, profile, agent, modelOverride).some((option) => option.value === currentEffort)
    ? currentEffort
    : "";
}

export function reconcileModelOverride(catalog: ProviderModelCatalog | null, modelOverride: string): string {
  if (!catalog || catalog.customModelAllowed || !modelOverride) {
    return modelOverride;
  }
  return catalog.models.some((model) => model.id === modelOverride) ? modelOverride : "";
}
