import { createClient } from "@supabase/supabase-js";
import { ENV, requireEnv } from "./env.js";
requireEnv(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
export const supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY);
