-- Versioned migration: native/older sessions remain legacy for rollback.
BEGIN;
ALTER TABLE public.sessions ADD COLUMN media_mode text NOT NULL DEFAULT 'legacy'
  CHECK (media_mode IN ('legacy','video'));

CREATE FUNCTION public.guard_session_media_mode()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.media_mode IS DISTINCT FROM OLD.media_mode
    THEN RAISE EXCEPTION 'session_media_mode_immutable' USING ERRCODE = '42501'; END IF;
  IF TG_OP = 'INSERT' AND NEW.media_mode = 'video' AND NOT EXISTS (
    SELECT 1 FROM public.devices WHERE id = NEW.device_id AND platform = 'windows'
      AND metadata->'browser_video' = '1'::jsonb)
    THEN RAISE EXCEPTION 'video_agent_upgrade_required' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_media_mode_guard BEFORE INSERT OR UPDATE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_session_media_mode();

CREATE FUNCTION public.reject_video_session_frames()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sessions WHERE id = NEW.session_id AND media_mode = 'video')
    THEN RAISE EXCEPTION 'video_only_session' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER video_session_no_jpeg BEFORE INSERT OR UPDATE ON public.session_frames
  FOR EACH ROW EXECUTE FUNCTION public.reject_video_session_frames();
REVOKE ALL ON FUNCTION public.guard_session_media_mode(),public.reject_video_session_frames()
  FROM PUBLIC, anon, authenticated;
COMMIT;
