import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/auth/callback")({
  head: () => ({
    meta: [
      { title: "Signing in — FlowSync" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AuthCallbackPage,
});

// Expected contract for the "xero-oauth-callback" edge function:
//
// Request body:  { code: string, redirectUri: string }
//
// The function should:
//   1. Exchange `code` for Xero tokens (access_token, refresh_token, id_token, expires_in)
//      using the Xero client secret (server-side only).
//   2. Upsert the refresh_token / access_token / expires_at into a table like
//      `xero_connections`, keyed by the resolved user id.
//   3. Create-or-sign-in the corresponding Supabase user (e.g. via the Xero id_token's
//      email claim, using admin.createUser / generateLink, or signInWithIdToken).
//   4. Return a Supabase session so the frontend can adopt it:
//
// Response body (success): { session: { access_token: string, refresh_token: string } }
// Response body (error):   { error: string }
function AuthCallbackPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"working" | "error">("working");
  const [errorMessage, setErrorMessage] = useState("");
  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;

    async function completeSignIn() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      const state = params.get("state");
      const errorParam = params.get("error");

      if (errorParam) {
        setStatus("error");
        setErrorMessage(`Xero denied the request: ${errorParam}`);
        return;
      }

      const expectedState = sessionStorage.getItem("xero_oauth_state");
      sessionStorage.removeItem("xero_oauth_state");

      if (!code || !state || !expectedState || state !== expectedState) {
        setStatus("error");
        setErrorMessage("Invalid or expired sign-in request. Please try again.");
        return;
      }

      const { data, error } = await supabase.functions.invoke("xero-oauth-callback", {
        body: {
          code,
          redirectUri: import.meta.env.VITE_XERO_REDIRECT_URI as string,
        },
      });

      if (error || !data?.session) {
        setStatus("error");
        setErrorMessage(error?.message ?? "Could not complete Xero sign-in.");
        return;
      }

      const { error: sessionError } = await supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });

      if (sessionError) {
        setStatus("error");
        setErrorMessage(sessionError.message);
        return;
      }

      navigate({ to: "/dashboard", replace: true });
    }

    completeSignIn().catch((err) => {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong.");
    });
  }, [navigate]);

  useEffect(() => {
    if (status === "error" && errorMessage) {
      toast.error(errorMessage);
    }
  }, [status, errorMessage]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="text-center">
        {status === "working" ? (
          <p className="text-sm text-muted-foreground">Finishing sign-in with Xero…</p>
        ) : (
          <>
            <p className="text-sm font-medium">Sign-in failed</p>
            <p className="mt-1 text-sm text-muted-foreground">{errorMessage}</p>
            <a href="/auth" className="mt-4 inline-block text-sm underline">
              Try again
            </a>
          </>
        )}
      </div>
    </div>
  );
}