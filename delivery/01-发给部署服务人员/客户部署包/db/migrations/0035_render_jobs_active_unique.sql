-- Render job enqueue is check-then-insert; two concurrent "generate" clicks
-- could both observe no active job and create duplicate render jobs. The
-- partial unique index makes the second insert fail; the queue service
-- catches it and returns the already-active job instead.
DELETE FROM render_jobs
 WHERE status IN ('queued', 'processing')
   AND id NOT IN (
     SELECT MIN(id) FROM render_jobs
     WHERE status IN ('queued', 'processing')
     GROUP BY result_profile_id, template_id, template_version
   );
CREATE UNIQUE INDEX IF NOT EXISTS idx_render_jobs_active
  ON render_jobs(result_profile_id, template_id, template_version)
  WHERE status IN ('queued', 'processing');
