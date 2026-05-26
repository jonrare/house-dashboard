import { defineBackend } from "@aws-amplify/backend";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { scan } from "./functions/scan/resource";

const backend = defineBackend({ auth, data, scan });

// Single-user app: only the admin creates the one user. Disable public self-signup.
const { cfnUserPool } = backend.auth.resources.cfnResources;
cfnUserPool.adminCreateUserConfig = { allowAdminCreateUserOnly: true };
