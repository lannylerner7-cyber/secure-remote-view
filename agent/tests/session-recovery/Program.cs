using ConnectLive.Agent;

int checks = 0;
void Check(bool value, string label)
{
    if (!value) throw new InvalidOperationException(label);
    checks++;
    Console.WriteLine("PASS: " + label);
}

var pump = new AsyncMftPump();
var events = new Queue<AsyncMftEvent>(new[] {
    AsyncMftEvent.NeedInput, AsyncMftEvent.NeedInput, AsyncMftEvent.NeedInput,
});
int inputs = 0, outputs = 0, eventReads = 0;
bool produced = false;
AsyncMftEvent Next()
{
    eventReads++;
    return events.TryDequeue(out var value) ? value : AsyncMftEvent.None;
}
bool Submit()
{
    inputs++;
    events.Enqueue(AsyncMftEvent.HaveOutput);
    return true;
}
bool Output() { outputs++; produced = true; return true; }
Check(pump.Step(Next, Submit, Output, () => produced), "first async frame succeeds");
Check(inputs == 1 && outputs == 1 && pump.PendingInputs == 2,
    "extra NeedInput events survive the first Encode call");
produced = false;
Check(pump.Step(Next, Submit, Output, () => produced) && inputs == 2 && outputs == 2,
    "next frame uses saved input credit without waiting for a new event");
produced = false;
Check(pump.Step(Next, Submit, Output, () => produced) && inputs == 3 && outputs == 3,
    "all queued input credits are consumed exactly once");
int before = eventReads;
produced = false;
Check(pump.Step(Next, Submit, Output, () => produced) && eventReads == before + 1 && inputs == 3,
    "empty event queue returns immediately, with no 120ms busy spin or unrequested input");
events.Enqueue(AsyncMftEvent.HaveOutput);
events.Enqueue(AsyncMftEvent.HaveOutput);
produced = false;
pump.Step(Next, Submit, Output, () => produced);
Check(events.Count == 1 && outputs == 4, "separate access units are not merged into one RTP frame");

// Event-driven encoder model with bursts and delayed output. Thousands of
// iterations cover the reported '103 frames then forever empty' failure shape.
pump = new AsyncMftPump();
events.Clear();
inputs = outputs = 0;
for (int i = 0; i < 1800; i++)
{
    if (i % 3 == 0)
        for (int j = 0; j < 3; j++) events.Enqueue(AsyncMftEvent.NeedInput);
    produced = false;
    if (!pump.Step(Next, Submit, Output, () => produced)) throw new Exception("pump failed");
}
Check(inputs == 1800 && outputs == 1800 && pump.PendingInputs == 0,
    "burst-credit video continues for 1800 frames instead of starving");
Check(!new AsyncMftPump().Step(() => AsyncMftEvent.Error, () => true, () => true, () => false),
    "event errors fail explicitly");
Check(!new AsyncMftPump().Step(() => AsyncMftEvent.NeedInput, () => false, () => true, () => false),
    "input errors fail explicitly");
Check(!new AsyncMftPump().Step(() => AsyncMftEvent.HaveOutput, () => true, () => false, () => false),
    "output errors fail explicitly");
int reads = 0;
Check(new AsyncMftPump().Step(() => { reads++; return AsyncMftEvent.Other; },
    () => true, () => true, () => false) && reads == 64, "event work is bounded");

var progress = new EncoderProgress();
Check(!progress.Observe(1000, false), "pipelined startup is not immediately a stall");
for (int i = 1; i <= 8; i++) progress.Observe(1000 + i * 300, false);
Check(progress.Observe(4100, false) && progress.TryRestart(4100),
    "sustained empty output allows one same-peer encoder restart");
Check(!progress.Observe(4200, true) && !progress.Observe(6500, false),
    "actual output resets the stall deadline");
for (int i = 0; i < 8; i++) progress.Observe(8000, false);
Check(progress.Observe(8000, false) && progress.TryRestart(8000), "second encoder restart is bounded");
Check(!progress.TryRestart(12000) && progress.Restarts == 2, "repeated driver failure cannot spin in a restart loop");
var idle = new EncoderProgress();
idle.Observe(0, true);
Check(!idle.Observe(60000, false), "an idle desktop with no submitted frames is not sufficient stall evidence");
string Receipt(string state, string session = "visit", string grant = "grant") =>
    System.Text.Json.JsonSerializer.Serialize(new { session_status = new { id = session, state, authorization_id = grant } });
Check(SessionCompletion.RequiresPairing(Receipt("ended"), "visit", "grant"),
    "explicit matching ended receipt requests a new pairing");
foreach (var state in new[] { "active", "paused", "invited", "declined", "unknown" })
    Check(!SessionCompletion.RequiresPairing(Receipt(state), "visit", "grant"), $"{state} is not an ended receipt");
Check(!SessionCompletion.RequiresPairing(Receipt("ended", "other"), "visit", "grant"), "other session cannot request pairing");
Check(!SessionCompletion.RequiresPairing(Receipt("ended", grant: "other"), "visit", "grant"), "old grant cannot request pairing");
foreach (var body in new[] { "gateway timeout", "{}", "{\"sessions\":[]}", "{\"session_status\":null}", "{\"session_status\":{}}" })
    Check(!SessionCompletion.RequiresPairing(body, "visit", "grant"), "missing/invalid status is never implicit termination");
Check(!SessionCompletion.RequiresPairing(Receipt("ended"), null, "grant"), "unaccepted session cannot request pairing");
Console.WriteLine($"{checks} portable session-recovery checks passed. Windows encoding/display NOT executed.");
