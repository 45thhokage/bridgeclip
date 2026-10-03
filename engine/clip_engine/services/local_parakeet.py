"""Local transcription with NVIDIA Parakeet TDT int8 ONNX (experimental).

onnx-asr reports real token-level timestamps, so words are rebuilt from tokens;
no timestamp is ever invented. Most Parakeet builds accept about 30 seconds per
call, so audio is cut into windows with the FFmpeg the app already uses and each
window's timestamps are offset back onto the source timeline.
"""

import os
import shutil
import subprocess
import tempfile
from typing import Optional

from clip_engine.services.transcription_service import (
    GPU_LOAD_ERROR,
    TranscriptWord,
    TranscriptionError,
    TranscriptionProviderError,
    _looks_like_cuda_failure,
    _nonnegative_number,
    add_cuda_dll_directories,
)

PARAKEET_WINDOW_SECONDS = 30.0
PARAKEET_MODEL_NAME = "nemo-parakeet-tdt-0.6b-v2"
# Bounds for the observed token cadence used to end the last token of a word.
TOKEN_GAP_MAX_SECONDS = 1.0
TOKEN_SPAN_MIN_SECONDS = 0.08
TOKEN_SPAN_MAX_SECONDS = 1.0
TOKEN_SPAN_FALLBACK_SECONDS = 0.25


def load_parakeet_model(settings):
    """Load the int8 ONNX model from its downloaded folder, offline."""
    model_dir = getattr(settings, "local_transcription_model_dir", "") or ""
    if not model_dir or not os.path.isdir(model_dir):
        raise TranscriptionError("The local transcription model is not downloaded", reason="local_model_missing")
    device = getattr(settings, "local_transcription_device", "cpu") or "cpu"
    if device == "cuda":
        add_cuda_dll_directories()
    try:
        import onnx_asr
    except ImportError:
        raise TranscriptionError("The local transcription runtime is not installed", reason="local_runtime_missing") from None
    providers = ["CPUExecutionProvider"]
    try:
        import onnxruntime
        if device == "cuda" and "CUDAExecutionProvider" in onnxruntime.get_available_providers():
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    except ImportError:
        pass
    try:
        return onnx_asr.load_model(PARAKEET_MODEL_NAME, model_dir, quantization="int8", providers=providers).with_timestamps()
    except Exception as error:
        if device == "cuda" and _looks_like_cuda_failure(error):
            raise TranscriptionError(GPU_LOAD_ERROR, reason="local_gpu_unavailable") from None
        raise TranscriptionError("The local transcription model could not be loaded", reason="local_model_invalid") from None


def transcribe_with_parakeet(model, path: str, duration: float) -> tuple[list[TranscriptWord], str]:
    """Recognize one already-quantized audio chunk, in 30-second windows."""
    work_dir = tempfile.mkdtemp(prefix="parakeet-", dir=os.path.dirname(os.path.abspath(path)))
    words: list[TranscriptWord] = []
    try:
        for window_path, offset in _cut_windows(path, duration, work_dir):
            try:
                result = model.recognize(window_path)
            except Exception:
                raise TranscriptionError("Local transcription failed", reason="local_transcription_failed") from None
            words.extend(_words_from_tokens(
                getattr(result, "tokens", None), getattr(result, "timestamps", None), offset,
                window_end=min(duration, offset + PARAKEET_WINDOW_SECONDS),
            ))
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
    for word in words:
        if word.start_time_ms < 0 or word.end_time_ms < word.start_time_ms or word.end_time_ms > round((duration + 1) * 1000):
            raise TranscriptionProviderError("invalid_response")
    return words, "en"


def _cut_windows(path: str, duration: float, work_dir: str) -> list[tuple[str, float]]:
    """(window file, start offset) pairs, about 30 seconds each."""
    windows: list[tuple[str, float]] = []
    options = ["-protocol_whitelist", "file,pipe,fd"]
    index = 0
    start = 0.0
    while start < duration:
        length = min(PARAKEET_WINDOW_SECONDS, duration - start)
        target = os.path.join(work_dir, f"window-{index:04d}.wav")
        try:
            from clip_engine.services.media_process import run_media
            run_media(
                ["ffmpeg", "-v", "error", "-nostdin", "-y", *options, "-ss", f"{start:.3f}", "-i", path,
                 "-t", f"{length:.3f}", "-vn", "-c:a", "pcm_s16le", "-ar", "16000", "-ac", "1", target],
                timeout=300, check=True,
            )
        except (OSError, subprocess.SubprocessError):
            raise TranscriptionError("Could not prepare audio for local transcription", reason="audio_chunk_failed") from None
        windows.append((target, start))
        index += 1
        start += length
    return windows


def _words_from_tokens(
    tokens: Optional[list[str]], timestamps: Optional[list[float]], offset: float, window_end: float,
) -> list[TranscriptWord]:
    """Build words from the model's real token start times (never spread evenly).

    A token that starts with a space (or the SentencePiece '▁' marker) begins a
    new word. Each word starts at its first token's real time and ends at the
    smaller of the next token's real time and the observed token cadence after
    its last token, so a word never stretches across silence.
    """
    if tokens is None or timestamps is None:
        # A silent window can come back with nothing at all; anything else
        # without timestamps is a real failure, never guessed timing.
        if not tokens and not timestamps:
            return []
        raise TranscriptionError("Local transcription did not include word timestamps", reason="missing_word_timestamps")
    if len(tokens) != len(timestamps):
        raise TranscriptionProviderError("invalid_response")
    starts: list[float] = []
    previous = -1.0
    for when in timestamps:
        if not _nonnegative_number(when) or when < previous:
            raise TranscriptionProviderError("invalid_response")
        starts.append(float(when))
        previous = float(when)
    token_span = _observed_token_span(starts, window_end)

    words: list[TranscriptWord] = []
    text = ""
    word_start: Optional[float] = None
    last_token: Optional[float] = None

    def flush(next_start: float) -> None:
        nonlocal text, word_start, last_token
        if text and word_start is not None and last_token is not None:
            end = min(last_token + token_span, next_start)
            if end < word_start:
                end = word_start
            words.append(TranscriptWord(text, round((offset + word_start) * 1000), round((offset + end) * 1000)))
        text, word_start, last_token = "", None, None

    for index, (token, when) in enumerate(zip(tokens, starts)):
        next_start = starts[index + 1] if index + 1 < len(starts) else window_end
        piece = str(token).replace("\u2581", " ")
        if piece[:1].isspace() and text:
            flush(when)
        piece = piece.strip()
        if piece:
            if word_start is None:
                word_start = when
            text += piece
            last_token = when
    flush(window_end)
    return words


def _observed_token_span(starts: list[float], window_end: float) -> float:
    """Typical time one token occupies, from the gaps the model reported.

    Gaps longer than a second are silences between words, not token durations,
    so they are ignored. With fewer than two usable gaps the fallback is used.
    """
    gaps = sorted(b - a for a, b in zip(starts, starts[1:]) if 0 < b - a <= TOKEN_GAP_MAX_SECONDS)
    if not gaps:
        return TOKEN_SPAN_FALLBACK_SECONDS
    middle = len(gaps) // 2
    median = gaps[middle] if len(gaps) % 2 else (gaps[middle - 1] + gaps[middle]) / 2
    return min(TOKEN_SPAN_MAX_SECONDS, max(TOKEN_SPAN_MIN_SECONDS, median))
