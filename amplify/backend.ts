import { defineBackend } from "@aws-amplify/backend";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { scan } from "./functions/scan/resource";

const backend = defineBackend({ auth, data, scan });

// Single-user app: only the admin creates the one user. Disable public self-signup.
const { cfnUserPool } = backend.auth.resources.cfnResources;
cfnUserPool.adminCreateUserConfig = { allowAdminCreateUserOnly: true };

// Let the scan function read Gmail App Passwords from Secrets Manager.
// Secrets are namespaced under bill-tracker/ — create them with that prefix.
backend.scan.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ["secretsmanager:GetSecretValue"],
    resources: [
      `arn:aws:secretsmanager:*:*:secret:bill-tracker/*`,
    ],
  }),
);
