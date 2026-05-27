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

/** Delete an account and every ledger entry under it. */
export async function deleteAccountCascade(accountId: string): Promise<void> {
  const entries = await listAll((nextToken) =>
    client.models.LedgerEntry.list({ filter: { accountId: { eq: accountId } }, nextToken }),
  );
  await Promise.all(entries.map((e) => client.models.LedgerEntry.delete({ id: e.id })));
  await client.models.Account.delete({ id: accountId });
}

export type Biller = Schema["Biller"]["type"];
export type SenderFilter = Schema["SenderFilter"]["type"];
export type Account = Schema["Account"]["type"];
export type LedgerEntry = Schema["LedgerEntry"]["type"];
export type ScanRun = Schema["ScanRun"]["type"];
