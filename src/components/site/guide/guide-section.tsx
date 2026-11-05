import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronUp, Pause, Play, RotateCcw, SendHorizonal, Volume2, VolumeX } from "lucide-react";
import { guideAssets } from "./guide-assets";
import { guideManifest } from "./guide-knowledge";
import { GuideScene } from "./guide-scene";
import { askGuide } from "./guide-api";
import { paginateGuideWords } from "./guide-captions";
import type { GuideActivity, GuideBoardPage, GuideReply } from "./guide-contract";
import { trackGuide } from "./guide-tracking";
import { useGuideVoice } from "./use-guide-voice";
import { ActionButton, Badge } from "../ui";
import "./guide.css";

type ChatMessage = { id: number; role: "visitor" | "guide"; text: string; reply?: GuideReply };
const SUGGESTIONS = ["What plans do you offer?", "How does device enrollment work?", "How do payments work?", "What is curtain mode?"];

function prefersStatic(): boolean {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return true;
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return true;
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") || probe.getContext("webgl");
    if (!gl) return true;
    (gl as WebGLRenderingContext).getExtension("WEBGL_lose_context")?.loseContext();
    return false;
  } catch { return true; }
}

export function GuideSection() {
  const [staticMode, setStaticMode] = useState<boolean | null>(null);
  const [stageActive, setStageActive] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [sceneFailed, setSceneFailed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [answerError, setAnswerError] = useState("");
  const [reply, setReply] = useState<GuideReply | null>(null);
  const [textActivity, setTextActivity] = useState<GuideActivity>("seated");
  const [scenePhase, setScenePhase] = useState("seated");
  const [manualPage, setManualPage] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const voice = useGuideVoice();
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const replyRef = useRef(reply);
  replyRef.current = reply;
  const sectionRef = useRef<HTMLElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const greetedRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef(0);
  const nextId = useRef(0);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const update = () => setStaticMode(prefersStatic());
    update();
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  const send = useCallback(async (raw: string, welcome = false) => {
    const text = raw.trim();
    if (!text || text.length > 500 || busyRef.current) return;
    greetedRef.current = true;
    busyRef.current = true;
    setBusy(true);
    setAnswerError("");
    setInput("");
    setManualPage(null);
    voiceRef.current.cancel();
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    setTextActivity("seated");
    if (!welcome) {
      setMessages((previous) => [...previous.slice(-39), { id: nextId.current++, role: "visitor", text }]);
      trackGuide("question_sent");
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const sequence = ++sequenceRef.current;
    const deadline = setTimeout(() => controller.abort(), 15_000);
    const started = performance.now();
    try {
      const answer = await askGuide(text, replyRef.current?.id, controller.signal);
      if (sequence !== sequenceRef.current) return;
      setReply(answer);
      replyRef.current = answer;
      setMessages((previous) => [...previous.slice(-39), { id: nextId.current++, role: "guide", text: answer.text, reply: answer }]);
      setNonce((value) => value + 1);
      trackGuide("answer_ready", { topic: answer.id, durationMs: Math.round(performance.now() - started) });
      if (voiceRef.current.enabled) void voiceRef.current.speak(answer);
      else {
        setTextActivity(welcome ? "greeting" : "presenting");
        idleTimerRef.current = setTimeout(() => setTextActivity("seated"), welcome ? 3500 : 6500);
      }
    } catch (cause) {
      if (sequence !== sequenceRef.current) return;
      setAnswerError(controller.signal.aborted ? "The answer took too long. Please try your question again."
        : cause instanceof Error ? cause.message : "The guide couldn't respond. Please try again.");
      trackGuide("answer_failed", { reason: "network" });
    } finally {
      clearTimeout(deadline);
      if (sequence === sequenceRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el || staticMode === null) return;
    const load = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setStageActive(true);
        load.disconnect();
      }
    }, { rootMargin: "400px" });
    const visible = new IntersectionObserver((entries) => {
      const inView = entries.some((entry) => entry.isIntersecting);
      if (!inView) voiceRef.current.pause("offscreen");
      if (inView && !greetedRef.current) {
        trackGuide("section_viewed");
        if (staticMode) trackGuide("static_mode", { reason: "static" });
        void send("hello", true);
      }
    }, { threshold: 0.08 });
    load.observe(el);
    visible.observe(el);
    return () => { load.disconnect(); visible.disconnect(); };
  }, [send, staticMode]);

  useEffect(() => {
    const box = messagesRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages, busy]);

  useEffect(() => () => {
    sequenceRef.current++;
    requestRef.current?.abort();
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
  }, []);

  const captionWords = useMemo(() => (reply?.text ?? guideManifest.greeting).split(/\s+/), [reply]);
  const pages = useMemo(() => paginateGuideWords(captionWords), [captionWords]);
  const autoPage = Math.max(0, pages.findIndex((page) => voice.wordIndex >= page.start && voice.wordIndex < page.end));
  const pageIndex = Math.min(manualPage ?? autoPage, pages.length - 1);
  const page = pages[pageIndex];
  const followsAudio = voice.speech?.text === reply?.text && ["playing", "paused", "ended", "loading"].includes(voice.status);
  const highlighted = followsAudio ? voice.wordIndex - page.start : -1;
  const board: GuideBoardPage = {
    heading: reply?.board?.heading ?? (reply?.id === "greeting" ? "Welcome to ConnectLive" : "Your question, explained"),
    words: page.words, activeWord: highlighted, page: pageIndex + 1, pages: pages.length,
    status: voice.status === "playing" ? "Speaking · live captions" : voice.status === "paused" ? "Paused" : "Read at your pace",
  };
  let activity: GuideActivity = textActivity;
  if (voice.status === "playing") {
    activity = reply?.id === "greeting" ? "greeting"
      : voice.wordIndex >= Math.min(14, Math.floor(captionWords.length / 3)) ? "presenting" : "speaking";
  } else if (["paused", "loading"].includes(voice.status) && voice.speech) activity = "paused";
  else if (voice.enabled) activity = "seated";

  useEffect(() => {
    if (reply) trackGuide("caption_page", { topic: reply.id, page: pageIndex + 1 });
  }, [reply, pageIndex]);

  const toggleCollapsed = () => {
    const next = !collapsed;
    if (next) { voice.pause("hidden"); setTextActivity("seated"); }
    setCollapsed(next);
    trackGuide(next ? "guide_hidden" : "guide_shown");
  };
  const changePage = (offset: number) => {
    voice.pause("visitor");
    setManualPage(Math.max(0, Math.min(pages.length - 1, pageIndex + offset)));
  };
  const showScene = staticMode === false && !sceneFailed && stageActive;
  const voiceLabel = voice.status === "playing" ? "Speaking" : voice.status === "loading" ? "Preparing voice…"
    : voice.status === "paused" ? "Paused" : voice.status === "error" ? "Text available" : voice.enabled ? "Voice ready" : "Voice off";

  return (
    <section id="guide" ref={sectionRef} className="gd-section border-b border-white/10 py-20 md:py-28" aria-labelledby="guide-heading" data-testid="section-guide">
      <audio ref={voice.audioRef} preload="none" data-testid="guide-audio" />
      <div className="container">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-3xl">
            <Badge live>ConnectLive virtual guide · AI assistant</Badge>
            <h2 id="guide-heading" className="mt-6 text-3xl font-semibold tracking-tight md:text-4xl">
              A little guidance. <span className="text-cl-signal-bright">A real conversation.</span>
            </h2>
            <p className="body-lg mt-5 text-cl-muted">
              Ask about ConnectLive. Listen to a clear explanation, follow every word on the board,
              or read at your own pace.
            </p>
          </div>
          <ActionButton variant="secondary" onClick={toggleCollapsed} aria-expanded={!collapsed} data-testid="button-guide-toggle">
            {collapsed ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
            {collapsed ? "Show guide" : "Hide guide"}
          </ActionButton>
        </div>

        {collapsed ? (
          <div className="surface mt-10 flex items-center justify-between gap-4 rounded-xl px-5 py-4">
            <p className="text-sm text-cl-muted">Guide hidden. Voice playback is paused.</p>
            <ActionButton variant="secondary" onClick={toggleCollapsed} data-testid="button-guide-reopen">Reopen</ActionButton>
          </div>
        ) : (
          <div className="gd-experience mt-10">
            <div className="gd-studio surface">
              <div className="gd-studio-heading">
                <span><span className="status-dot" aria-hidden="true" /> THE CONNECTLIVE LOUNGE</span>
                <span data-testid="guide-voice-status" role="status">{busy ? "Finding your answer…" : voiceLabel}</span>
              </div>
              <div className="gd-stage-wrap" data-testid="guide-stage-wrap">
                {showScene ? (
                  <GuideScene
                    activity={activity} board={board} nonce={nonce}
                    onReady={() => { setSceneReady(true); trackGuide("scene_ready"); }}
                    onError={() => { setSceneFailed(true); trackGuide("scene_failed", { reason: "webgl" }); }}
                    onActivityChange={(phase) => { setScenePhase(phase); trackGuide("movement", { phase }); }}
                  />
                ) : (
                  <div className="gd-shell gd-static-shell" data-ready="false">
                    <img className="gd-poster gd-poster-static" src={guideAssets.portraitSeatedUrl} alt="Your ConnectLive virtual guide, seated in the lounge" loading="lazy" decoding="async" />
                    <div className="gd-static-board" aria-label="Explanation board">
                      <span className="gd-eyebrow">YOUR EXPLANATION</span>
                      <h3>{board.heading}</h3>
                      <p>{page.words.map((word, index) => <span key={index} className={index === highlighted ? "gd-spoken-word" : ""}>{word} </span>)}</p>
                      <small>{board.page} / {board.pages}</small>
                    </div>
                  </div>
                )}
              </div>

              <div className="gd-player">
                <div className="gd-voice-controls">
                  {!voice.enabled ? (
                    <button className="gd-listen" type="button" disabled={!reply || busy} onClick={() => { if (reply) { setManualPage(null); voice.enable(reply); } }} data-testid="guide-enable-voice">
                      <Volume2 size={17} aria-hidden="true" /> Listen to guide
                    </button>
                  ) : (
                    <>
                      <button className="gd-listen" type="button" disabled={!reply || busy} onClick={() => {
                        if (voice.status === "playing" || voice.status === "loading") voice.pause();
                        else if (reply) { setManualPage(null); voice.resume(reply); }
                      }} data-testid="guide-play-pause">
                        {["playing", "loading"].includes(voice.status) ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                        {voice.status === "playing" || voice.status === "loading" ? "Pause" : "Play"}
                      </button>
                      <button type="button" className="gd-icon-button" disabled={!reply || busy} onClick={() => { if (reply) { setManualPage(null); voice.replay(reply); } }} aria-label="Replay answer" data-testid="guide-replay"><RotateCcw size={16} /></button>
                      <button type="button" className="gd-icon-button" onClick={voice.disable} aria-label="Turn voice off" data-testid="guide-mute"><VolumeX size={17} /></button>
                    </>
                  )}
                  <label className="gd-speed">Pace
                    <select aria-label="Voice pace" value={voice.rate} onChange={(event) => voice.updateRate(Number(event.target.value))}>
                      <option value={0.85}>Unhurried</option><option value={1}>Natural</option><option value={1.1}>Brisk</option>
                    </select>
                  </label>
                  <span className="gd-voice-credit">Bella · AI-generated female voice</span>
                </div>
                <div className="gd-page-controls" aria-label="Board pages">
                  <button type="button" onClick={() => changePage(-1)} disabled={pageIndex === 0} aria-label="Previous board page" data-testid="guide-page-prev"><ArrowLeft size={16} /></button>
                  <span data-testid="guide-page-number">Board {pageIndex + 1} <span>/ {pages.length}</span></span>
                  <button type="button" onClick={() => changePage(1)} disabled={pageIndex === pages.length - 1} aria-label="Next board page" data-testid="guide-page-next"><ArrowRight size={16} /></button>
                </div>
              </div>
              {voice.error && <p className="gd-notice" role="status" data-testid="guide-voice-error">{voice.error}</p>}
              {!voice.error && voice.speech?.warning && <p className="gd-notice" role="status" data-testid="guide-voice-warning">{voice.speech.warning}</p>}
              <div className="gd-caption-readable" aria-label="Readable board transcript" data-testid="guide-caption" data-page={pageIndex + 1} data-word-index={voice.wordIndex}>
                <span className="gd-eyebrow">{voice.status === "playing" ? "FOLLOW ALONG" : "ON THE BOARD"}</span>
                <p>{page.words.map((word, index) => <span key={`${pageIndex}-${index}`} data-active={index === highlighted ? "true" : undefined} className={index === highlighted ? "gd-spoken-word" : ""}>{word} </span>)}</p>
              </div>
            </div>

            <div className="gd-conversation-layout">
              <div className="gd-chat surface">
                <div className="gd-chat-heading">
                  <div><span className="gd-eyebrow">YOUR CONVERSATION</span><h3>What would you like to know?</h3></div>
                  <span className="gd-verified"><Check size={13} aria-hidden="true" /> Approved answers</span>
                </div>
                <div ref={messagesRef} className="gd-messages" aria-live="polite" aria-relevant="additions" data-testid="guide-messages">
                  {messages.length === 0 && !busy && <p className="gd-hint">Ask a question below. Sound stays off until you choose to listen.</p>}
                  {messages.map((message) => (
                    <div key={message.id} className={`gd-msg gd-msg-${message.role}`}>
                      <p>{message.text}</p>
                      {!!message.reply?.links?.length && <div className="gd-msg-links">{message.reply.links.map((link) => <a key={link.to + link.label} href={link.to}>{link.label}</a>)}</div>}
                    </div>
                  ))}
                  {busy && <div className="gd-msg gd-msg-guide gd-typing" aria-label="Finding an approved answer"><span /><span /><span /></div>}
                </div>
                {answerError && <p className="gd-notice" role="alert" data-testid="guide-answer-error">{answerError}</p>}
                <form className="gd-inputrow" onSubmit={(event) => { event.preventDefault(); void send(input); }}>
                  <label htmlFor="guide-input" className="sr-only">Ask the ConnectLive virtual guide a question</label>
                  <input id="guide-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask about plans, enrollment, payments…" autoComplete="off" maxLength={500} disabled={busy} data-testid="guide-input" />
                  <button type="submit" disabled={busy || !input.trim()} aria-label="Send question" data-testid="guide-send"><SendHorizonal size={18} /></button>
                </form>
                <p className="gd-footnote">AI guide, not a human operator. Never share passwords, pairing codes, or wallet keys.</p>
              </div>
              <aside className="gd-help-panel">
                <span className="gd-eyebrow">A GOOD PLACE TO START</span>
                <div className="gd-chips">{SUGGESTIONS.map((suggestion, index) => (
                  <button key={suggestion} type="button" disabled={busy} onClick={() => void send(suggestion)} data-testid={`guide-suggestion-${index}`}>
                    {suggestion}<ArrowRight size={15} aria-hidden="true" />
                  </button>
                ))}</div>
                <p className="gd-privacy-note">Only approved guide answers are sent to the voice service. Anonymous interaction and error events help us keep this section working. Your questions are not saved in tracking.</p>
                <details className="gd-diagnostics" data-testid="guide-diagnostics">
                  <summary>Experience status</summary>
                  <dl>
                    <div><dt>Scene</dt><dd>{staticMode || sceneFailed ? "Accessible still view" : sceneReady ? "3D ready" : "Loading 3D…"}</dd></div>
                    <div><dt>Movement</dt><dd>{showScene && sceneReady ? scenePhase : "Still"}</dd></div>
                    <div><dt>Voice</dt><dd>{voiceLabel}</dd></div>
                    <div><dt>Board</dt><dd>{voice.speech ? "Audio-timed captions" : "Complete text, paginated"}</dd></div>
                    <div><dt>Answer</dt><dd>{reply?.source === "catalog" ? "Live price catalog" : reply?.source === "unverified" ? "Honest fallback" : "Approved documentation"}</dd></div>
                  </dl>
                </details>
              </aside>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
