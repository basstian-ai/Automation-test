# Roadmap Migration

Legacy repositories can move existing roadmap data into Supabase.

## Steps

1. Install dependencies with `npm install`.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in your environment.
3. Run the migration script:
   ```bash
   npx ts-node scripts/migrate-roadmap.ts
   ```
   The script scans `roadmap/*.md` (excluding `vision.md`) and inserts any YAML `items` into the `tasks` table.
4. Verify the items appear in Supabase and remove the old roadmap files if desired.
