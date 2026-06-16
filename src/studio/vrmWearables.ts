export const VRM_WEARABLE_CATALOG = [
  {
    id: "flight-headset",
    label: "Flight Headset",
    slot: "Comms",
    bone: "head",
    source: "renderer-poc",
  },
  {
    id: "g-suit-harness",
    label: "G-Suit Harness",
    slot: "Torso",
    bone: "chest",
    source: "renderer-poc",
  },
  {
    id: "data-gloves",
    label: "Data Gloves",
    slot: "Hands",
    bone: "hands",
    source: "renderer-poc",
  },
] as const;

export const DEFAULT_VRM_WEARABLE_IDS = ["flight-headset", "g-suit-harness"] as const;

export type VrmWearableId = (typeof VRM_WEARABLE_CATALOG)[number]["id"];
export type VrmWearableCatalogItem = (typeof VRM_WEARABLE_CATALOG)[number];

const WEARABLE_IDS = new Set<string>(VRM_WEARABLE_CATALOG.map((item) => item.id));

export function normalizeVrmWearableIds(ids: readonly string[] | undefined): VrmWearableId[] {
  const selected = ids === undefined ? DEFAULT_VRM_WEARABLE_IDS : ids;
  return selected.filter((id): id is VrmWearableId => WEARABLE_IDS.has(id));
}
