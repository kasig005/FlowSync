import os

from supabase import Client, create_client


def get_supabase_admin() -> Client:
    """Service-role client for backend/admin operations (bypasses RLS)."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

    if not url or not key:
        missing = [
            name
            for name, value in (
                ("SUPABASE_URL", url),
                ("SUPABASE_SERVICE_ROLE_KEY", key),
            )
            if not value
        ]
        raise RuntimeError(
            f"Missing Supabase env var(s): {', '.join(missing)}. "
            "Add them to agents/root_agent/.env (get the service role key from Supabase dashboard → Settings → API)."
        )

    return create_client(url, key)
