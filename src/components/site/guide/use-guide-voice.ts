import { useCallback, useEffect, useRef, useState } from "react";
import { loadGuideSpeech } from "./guide-api";
import { activeGuideWord } from "./guide-captions";
import type { GuideReply, GuideSpeech, GuideEventData } from "./guide-contract";
import { trackGuide } from "./guide-tracking";

export type VoiceStatus = "off" | "ready" | "loading" | "playing" | "paused" | "ended" | "error";

export function useGuideVoice() {
  const audioRef = useRef<HTMLAudioElement>(null);
  // Voice is armed, not autoplayed on page load. Submitting a question is the
  // gesture that starts a reply; an explicit sound-off choice always wins.
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState<VoiceStatus>("ready");
  const [speech, setSpeech] = useState<GuideSpeech | null>(null);
  const [wordIndex, setWordIndex] = useState(-1);
  const [error, setError] = useState("");
  const [rate, setRate] = useState(1);
  const enabledRef = useRef(true);
  const statusRef = useRef<VoiceStatus>("ready");
  const primingRef = useRef(false);
  const [blocked, setBlocked] = useState(false);
  const speechRef = useRef<GuideSpeech | null>(null);
  const replyRef = useRef<GuideReply | null>(null);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const blobRef = useRef<string | null>(null);
  const rateRef = useRef(1);
  const frameRef = useRef(0);
  const mountedRef = useRef(true);
  const cacheRef = useRef(new Map<string, GuideSpeech>());
  const changeStatus = useCallback((next: VoiceStatus) => {
    statusRef.current = next;
    if (mountedRef.current) setStatus(next);
  }, []);

  const releaseBlob = useCallback(() => {
    if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    blobRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    requestRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    speechRef.current = null;
    primingRef.current = false;
    replyRef.current = null;
    changeStatus(enabledRef.current ? "ready" : "off");
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.removeAttribute("src"); audio.load(); }
    cancelAnimationFrame(frameRef.current);
    releaseBlob();
    setSpeech(null);
    setWordIndex(-1);
    setError("");
    setBlocked(false);
  }, [changeStatus, releaseBlob]);

  const prepareForInput = useCallback(() => {
    const audio = audioRef.current;
    if (!enabledRef.current || !audio) return;
    // Unlock this same element in the input gesture, before fetching the
    // answer/voice. A valid silent PCM sample works without an external request.
    const generation = requestRef.current;
    primingRef.current = true;
    audio.src = "data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==";
    void audio.play().catch(() => {
      // Some browsers still require their own sound permission. Handle that
      // explicitly on the real reply, never claim it has started.
    }).finally(() => {
      if (generation === requestRef.current) primingRef.current = false;
    });
  }, []);

  const pause = useCallback((reason: GuideEventData["reason"] = "visitor") => {
    if (!["playing", "loading"].includes(statusRef.current)) return;
    if (abortRef.current) {
      requestRef.current++;
      abortRef.current.abort();
      abortRef.current = null;
    }
    changeStatus("paused");
    audioRef.current?.pause();
    cancelAnimationFrame(frameRef.current);
    trackGuide("voice_paused", { topic: replyRef.current?.id, reason });
  }, [changeStatus]);

  const playAudio = useCallback(async () => {
    const audio = audioRef.current;
    if (!enabledRef.current || !audio || !speechRef.current) return;
    const generation = requestRef.current;
    setError("");
    try {
      audio.playbackRate = rateRef.current;
      audio.preservesPitch = true;
      await audio.play();
    } catch (cause) {
      if (generation !== requestRef.current) return;
      if ((cause as DOMException).name === "NotAllowedError") {
        changeStatus("ready");
        setBlocked(true);
        setError("Your browser needs permission for sound. Enable sound below; future questions will speak automatically.");
      } else if ((cause as DOMException).name !== "AbortError") {
        changeStatus("error");
        setError("Audio couldn't play. Submit your question again, or read the transcript.");
        trackGuide("voice_failed", { topic: replyRef.current?.id, reason: "playback" });
      }
    }
  }, [changeStatus]);

  const speak = useCallback(async (reply: GuideReply) => {
    if (!enabledRef.current) return;
    cancel();
    const requestId = requestRef.current;
    replyRef.current = reply;
    changeStatus("loading");
    trackGuide("voice_loading", { topic: reply.id });
    const controller = new AbortController();
    abortRef.current = controller;
    const deadline = setTimeout(() => controller.abort(), 55_000);
    try {
      let result = cacheRef.current.get(reply.textHash);
      if (!result) {
        result = await loadGuideSpeech(reply, controller.signal);
        if (result.text !== reply.text || result.words.map((word) => word.text).join(" ") !== reply.text) {
          throw new Error("The voice and answer don't match. Ask your question again for the latest answer.");
        }
        if (cacheRef.current.size >= 8) cacheRef.current.delete(cacheRef.current.keys().next().value!);
        cacheRef.current.set(reply.textHash, result);
      }
      if (requestId !== requestRef.current || !mountedRef.current) return;
      abortRef.current = null;
      speechRef.current = result;
      setSpeech(result);
      const audio = audioRef.current;
      if (!audio) return;
      if ("url" in result.audio) audio.src = result.audio.url;
      else {
        const bytes = Uint8Array.from(atob(result.audio.base64), (character) => character.charCodeAt(0));
        blobRef.current = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
        audio.src = blobRef.current;
      }
      audio.load();
      await playAudio();
    } catch (cause) {
      if (requestId !== requestRef.current || !mountedRef.current) return;
      changeStatus("error");
      setError(controller.signal.aborted ? "Voice took too long. Please try again; the answer is still readable."
        : cause instanceof Error ? cause.message : "Voice is unavailable. You can still read the answer.");
      trackGuide("voice_failed", { topic: reply.id, reason: "provider" });
    } finally {
      clearTimeout(deadline);
      if (requestId === requestRef.current) abortRef.current = null;
    }
  }, [cancel, changeStatus, playAudio]);

  const enable = useCallback((reply: GuideReply) => {
    enabledRef.current = true;
    setEnabled(true);
    prepareForInput();
    trackGuide("voice_enabled");
    void speak(reply);
  }, [prepareForInput, speak]);

  const disable = useCallback(() => {
    enabledRef.current = false;
    setEnabled(false);
    cancel();
    trackGuide("voice_disabled");
  }, [cancel]);

  const resume = useCallback((reply: GuideReply) => {
    if (!enabledRef.current) { enable(reply); return; }
    if (speechRef.current?.text === reply.text && statusRef.current !== "error") void playAudio();
    else void speak(reply);
  }, [enable, playAudio, speak]);

  const replay = useCallback((reply: GuideReply) => {
    trackGuide("voice_replayed", { topic: reply.id });
    if (!enabledRef.current) { enable(reply); return; }
    if (speechRef.current?.text === reply.text && statusRef.current !== "error" && audioRef.current) {
      audioRef.current.currentTime = 0;
      setWordIndex(-1);
      void playAudio();
    } else void speak(reply);
  }, [enable, playAudio, speak]);

  const updateRate = useCallback((value: number) => {
    if (![0.85, 1, 1.1].includes(value)) return;
    rateRef.current = value;
    setRate(value);
    if (audioRef.current) audioRef.current.playbackRate = value;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const audio = audioRef.current;
    if (!audio) return;
    const update = () => {
      if (speechRef.current) setWordIndex(activeGuideWord(speechRef.current.words, audio.currentTime));
    };
    const tick = () => {
      update();
      if (!audio.paused && !audio.ended) frameRef.current = requestAnimationFrame(tick);
    };
    const onPlaying = () => {
      if (primingRef.current) return;
      if (!enabledRef.current || !speechRef.current) { audio.pause(); return; }
      changeStatus("playing");
      setError("");
      setBlocked(false);
      cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(tick);
      trackGuide("voice_started", { topic: replyRef.current?.id });
    };
    const onEnded = () => {
      if (!speechRef.current) return;
      changeStatus("ended");
      cancelAnimationFrame(frameRef.current);
      update();
      trackGuide("voice_completed", {
        topic: replyRef.current?.id,
        durationMs: Math.round((Number.isFinite(audio.duration) ? audio.duration : 0) * 1000),
      });
    };
    const onPause = () => {
      cancelAnimationFrame(frameRef.current);
      if (statusRef.current === "playing" && !audio.ended) changeStatus("paused");
    };
    const onWaiting = () => {
      if (statusRef.current === "playing") changeStatus("loading");
    };
    const onError = () => {
      if (!speechRef.current) return;
      changeStatus("error");
      setError("Audio couldn't load. Submit your question again; the written answer is still available.");
      trackGuide("voice_failed", { topic: replyRef.current?.id, reason: "playback" });
    };
    const onVisibility = () => { if (document.visibilityState === "hidden") pause("hidden"); };
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("timeupdate", update);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("error", onError);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mountedRef.current = false;
      requestRef.current++;
      abortRef.current?.abort();
      cancelAnimationFrame(frameRef.current);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("timeupdate", update);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("error", onError);
      document.removeEventListener("visibilitychange", onVisibility);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      releaseBlob();
    };
  }, [changeStatus, pause, releaseBlob]);

  return { audioRef, enabled, status, speech, wordIndex, error, blocked, rate, enable, disable, speak, pause, cancel, prepareForInput, resume, replay, updateRate };
}
