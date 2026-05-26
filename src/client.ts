import { generateClient } from "aws-amplify/data";
import type { Schema } from "../amplify/data/resource";

/** Shared, typed Data client for the whole frontend. */
export const client = generateClient<Schema>();

/**
 * Drain every page of a paginated list() and surface GraphQL errors (the Data
 * client resolves successfully even when the response carries an `errors` array).
 */
export async function listAll<T>(
  fetchPage: (token?: string) => Promise<{
    data: T[];
    nextToken?: string | null;
    errors?: { message: string }[];
  }>,
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const res = await fetchPage(token);
    if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join("; "));
    out.push(...res.data);
    token = res.nextToken ?? undefined;
  } while (token);
  return out;
}

/** Delete every Alert tied to a bill (used when a bill is paid, dismissed, or deleted). */
export async function clearAlertsForBill(billId: string): Promise<void> {
  const alerts = await listAll((nextToken) =>
    client.models.Alert.list({ filter: { billId: { eq: billId } }, nextToken }),
  );
  await Promise.all(alerts.map((a) => client.models.Alert.delete({ id: a.id })));
}

export type Biller = Schema["Biller"]["type"];
export type SenderFilter = Schema["SenderFilter"]["type"];
export type Bill = Schema["Bill"]["type"];
export type Alert = Schema["Alert"]["type"];
export type ScanRun = Schema["ScanRun"]["type"];
