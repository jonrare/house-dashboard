import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const sm = new SecretsManagerClient({});

/**
 * Read a Gmail App Password from Secrets Manager. `credentialRef` is the secret
 * name/ARN stored on the EmailAccount record — the raw password never lives in
 * the database. The secret value is the App Password string (or a JSON object
 * with an `appPassword` field).
 */
export async function getAppPassword(credentialRef: string): Promise<string> {
  const res = await sm.send(
    new GetSecretValueCommand({ SecretId: credentialRef }),
  );
  const raw = res.SecretString;
  if (!raw) throw new Error(`Secret ${credentialRef} has no string value`);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.appPassword === "string") return parsed.appPassword;
  } catch {
    // Not JSON — treat the whole value as the password.
  }
  return raw;
}
