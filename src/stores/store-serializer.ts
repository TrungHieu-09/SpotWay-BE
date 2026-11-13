/** Stores are returned with the id of the building their floor belongs to, which the clients use to group them. */
export const STORE_WITH_BUILDING = { floor: { select: { buildingId: true } } } as const;

export function serializeStore<T extends { floor?: { buildingId: string } | null }>(store: T) {
  const { floor, ...rest } = store;
  return { ...rest, buildingId: floor?.buildingId ?? null };
}
