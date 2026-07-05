// Handles both legs of the Xero OAuth flow. See frontend/src/routes/auth_.callback.tsx
// for the full contract this implements.
//
// mode = "login"  (identity-only scopes, no accounting.* access):
//   Exchanges the code, reads the user's identity out of Xero's id_token,
//   and creates-or-signs-in the matching Supabase user via a magic-link
//   token (Xero isn't a built-in Supabase Auth provider, so this is the
//   supported way to mint a real Supabase session from a third-party
//   identity we've already verified ourselves). Returns { session }.
//   The identity-only Xero tokens are deliberately NOT persisted -- we
//   don't need offline access to the user's identity, only to their
//   accounting data, which is requested separately in "connect" mode.
//
// mode = "connect" (org-level scopes, requires an existing Supabase session):
//   Exchanges the code for org-scoped tokens and stores them in
//   xero_connections, keyed to whichever Supabase user is calling.
import {
  decodeJwtPayload,
  errorResponse,
  exchangeAuthorizationCode,
  getCallingUserId,
  getServiceRoleClient,
  jsonResponse,
  corsHeaders,
  XeroApiError,
} from "../_shared/xero-client.ts";

interface CallbackBody {
  code?: string;
  redirectUri?: string;
  mode?: "login" | "connect";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = (await req.json()) as CallbackBody;
    const { code, redirectUri, mode = "login" } = body;

    if (!code || !redirectUri) {
      throw new XeroApiError("Missing 'code' or 'redirectUri'.", 400);
    }

    const tokens = await exchangeAuthorizationCode(code, redirectUri);
    const idTokenClaims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : {};
    const email = idTokenClaims.email as string | undefined;
    const xeroUserId = (idTokenClaims.xero_userid ?? idTokenClaims.sub) as string | undefined;

    if (mode === "connect") {
      const userId = await getCallingUserId(req);
      const supabase = getServiceRoleClient();

      const { error } = await supabase.from("xero_connections").upsert(
        {
          user_id: userId,
          xero_user_id: xeroUserId ?? null,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          scope: tokens.scope ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );

      if (error) throw new XeroApiError(`Failed to save Xero connection: ${error.message}`, 500);
      return jsonResponse({ ok: true });
    }

    // mode === "login"
    if (!email) {
      throw new XeroApiError("Xero didn't return an email address for this account.", 400);
    }

    const supabase = getServiceRoleClient();

    // Create the Supabase user if this is their first sign-in. Ignore the
    // "already registered" case -- that's the expected path for returning
    // users, not an error.
    const { error: createError } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: {
        xero_user_id: xeroUserId,
        given_name: idTokenClaims.given_name,
        family_name: idTokenClaims.family_name,
      },
    });
    if (createError && !/already been registered|already exists/i.test(createError.message)) {
      throw new XeroApiError(`Failed to provision account: ${createError.message}`, 500);
    }

    // Mint a real Supabase session for that user via a magic-link token.
    // We already verified the person's identity via Xero's OAuth flow, so
    // this link is generated and redeemed server-side immediately -- the
    // user never sees or clicks it.
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkError || !linkData) {
      throw new XeroApiError(`Failed to create session: ${linkError?.message ?? "unknown error"}`, 500);
    }

    const hashedToken = linkData.properties?.hashed_token;
    if (!hashedToken) throw new XeroApiError("Failed to create session token.", 500);

    const { data: verifyData, error: verifyError } = await supabase.auth.verifyOtp({
      token_hash: hashedToken,
      type: "magiclink",
    });
    if (verifyError || !verifyData.session) {
      throw new XeroApiError(`Failed to verify session: ${verifyError?.message ?? "unknown error"}`, 500);
    }

    return jsonResponse({
      session: {
        access_token: verifyData.session.access_token,
        refresh_token: verifyData.session.refresh_token,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
});