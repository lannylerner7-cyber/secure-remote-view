-- Collapse duplicate live sessions per device: keep the newest invited/active,
-- mark all older ones as ended. Prevents the agent from cycling across stale
-- session ids and painting frames to the wrong one.
WITH ranked AS (
  SELECT id,
         device_id,
         ROW_NUMBER() OVER (
           PARTITION BY device_id
           ORDER BY created_at DESC
         ) AS rn
  FROM public.sessions
  WHERE state IN ('invited', 'consented', 'active', 'paused')
)
UPDATE public.sessions s
   SET state = 'ended',
       ended_at = now(),
       updated_at = now()
  FROM ranked r
 WHERE s.id = r.id
   AND r.rn > 1;
