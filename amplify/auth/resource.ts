import { defineAuth } from "@aws-amplify/backend";

/**
 * Single-user auth. Login is by email + password.
 *
 * This is a personal tool, so self-signup is disabled — the one Cognito user is
 * created manually (Amplify console or `aws cognito-idp admin-create-user`) after
 * the first deploy. See the plan's "Implementation steps" step 7.
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
});
