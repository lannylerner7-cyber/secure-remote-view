-- Preserve the existing job schedule, active state and authentication.
-- Do not create/activate a payment job on installations that have none.
DO $migration$
DECLARE
  job_record record;
  old_origin constant text := 'https://project--13b47594-1b4d-46c6-a939-da4132e55c1c.lovable.app';
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    FOR job_record IN
      SELECT jobid, command FROM cron.job
      WHERE jobname = 'reconcile-orders'
        AND strpos(command, old_origin || '/api/public/cron/reconcile-orders') > 0
    LOOP
      PERFORM cron.alter_job(
        job_record.jobid,
        command := replace(job_record.command, old_origin, 'https://connectliveagent.com')
      );
    END LOOP;
  END IF;
END
$migration$;
