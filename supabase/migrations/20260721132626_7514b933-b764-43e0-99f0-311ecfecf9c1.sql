
DROP POLICY IF EXISTS "Technicians can manage sessions" ON public.sessions;
CREATE POLICY "Staff can manage sessions" ON public.sessions FOR ALL TO authenticated
  USING (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin') OR has_role(auth.uid(),'technician'))
  WITH CHECK (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin') OR has_role(auth.uid(),'technician'));
CREATE POLICY "Viewers can read sessions" ON public.sessions FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'viewer'));

DROP POLICY IF EXISTS "Technicians can view devices" ON public.devices;
DROP POLICY IF EXISTS "Technicians can update devices" ON public.devices;
CREATE POLICY "Staff can view devices" ON public.devices FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin') OR has_role(auth.uid(),'technician') OR has_role(auth.uid(),'viewer'));
CREATE POLICY "Staff can update devices" ON public.devices FOR UPDATE TO authenticated
  USING (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin') OR has_role(auth.uid(),'technician'))
  WITH CHECK (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin') OR has_role(auth.uid(),'technician'));

DROP POLICY IF EXISTS "Technicians can read audit" ON public.audit_logs;
CREATE POLICY "Staff can read audit" ON public.audit_logs FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin') OR has_role(auth.uid(),'technician'));

DROP POLICY IF EXISTS "Technicians can view frames" ON public.session_frames;
CREATE POLICY "Staff can view frames" ON public.session_frames FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin') OR has_role(auth.uid(),'technician') OR has_role(auth.uid(),'viewer'));

DROP POLICY IF EXISTS "technicians manage inputs" ON public.session_inputs;
CREATE POLICY "Staff manage inputs" ON public.session_inputs FOR ALL TO authenticated
  USING (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin') OR has_role(auth.uid(),'technician'))
  WITH CHECK (has_role(auth.uid(),'super_admin') OR has_role(auth.uid(),'admin') OR has_role(auth.uid(),'technician'));
