"""Local transcription: same word-timing structure as the OpenRouter path.

The faster-whisper model is mocked, so these tests need no runtime install,
model download, GPU or network.
"""

import asyncio
import sys
import types

import pytest

from clip_engine.services import transcription_service as stt


def whisper_word(text, start, end):
    return types.SimpleNamespace(word=text, start=start, end=end)


try:
    import numpy

    def numpy_whisper_word(text, start, end):
        """Real faster-whisper returns numpy.float64 word times, not floats."""
        return types.SimpleNamespace(word=text, start=numpy.float64(start), end=numpy.float64(end))
except ImportError:  # pragma: no cover - numpy ships with the engine runtime
    numpy_whisper_word = whisper_word


class FakeWhisperModel:
    """Stands in for faster_whisper.WhisperModel with word timestamps."""

    def __init__(self, segments):
        self.segments = segments
        self.calls = []

    def transcribe(self, path, **options):
        self.calls.append((path, options))
        return iter(self.segments), types.SimpleNamespace(language="en")


def segment(text, words):
    return types.SimpleNamespace(text=text, words=words)


def local_settings(tmp_path, **overrides):
    model_dir = tmp_path / "small.en"
    model_dir.mkdir(exist_ok=True)
    settings = types.SimpleNamespace(
        transcription_provider="local",
        local_transcription_model_id="small.en",
        local_transcription_model_dir=str(model_dir),
        local_transcription_backend="faster-whisper",
        local_transcription_device="cpu",
        local_transcription_compute_type="int8",
        openrouter_api_key=None,
        clipping_mode="quality",
    )
    for key, value in overrides.items():
        setattr(settings, key, value)
    return settings


def service(settings):
    svc = stt.TranscriptionService.__new__(stt.TranscriptionService)
    svc.settings = settings
    svc.progress_callback = None
    return svc


def prepare(tmp_path, monkeypatch):
    """An audio file, a service and the FFmpeg probe stubbed to 16 kHz mono."""
    audio = tmp_path / "source.wav"
    audio.write_bytes(b"offline audio")
    # run_media returns bytes in production, so the probe result is bytes here
    # too; a str stub once hid a decode bug that broke every real local job.
    monkeypatch.setattr(stt, "run_media", lambda *args, **kwargs: types.SimpleNamespace(
        returncode=0, stdout=b"16000,1\n", stderr=b""))
    return audio


def structure(result):
    return [
        (s.start_time_ms, s.end_time_ms, s.text, s.speaker_label,
         [(w.word, w.start_time_ms, w.end_time_ms) for w in s.words])
        for s in result.segments
    ]


def openrouter_reference(words):
    reference = stt.TranscriptionService.__new__(stt.TranscriptionService)
    return reference._parse_openrouter_response(
        {"text": "Hello there. Hi! More.", "language": "en", "words": words}, 20.0)


def test_local_provider_matches_openrouter_word_timing_structure(tmp_path, monkeypatch):
    audio = prepare(tmp_path, monkeypatch)
    svc = service(local_settings(tmp_path))
    model = FakeWhisperModel([
        segment("Hello there.", [whisper_word("Hello", 0.1, 0.4), whisper_word("there.", 0.4, 0.9)]),
        # A 2.4 s gap starts a new segment in the OpenRouter parser too.
        segment("Hi! More.", [whisper_word("Hi!", 1.2, 1.5), whisper_word("More.", 3.9, 4.2)]),
    ])
    monkeypatch.setattr(stt, "load_faster_whisper_model", lambda settings: model)
    monkeypatch.setattr(svc, "_audio_duration", lambda _: 20.0)

    result = asyncio.run(svc.transcribe_audio(str(audio)))

    words = [
        {"word": "Hello", "start": 0.1, "end": 0.4},
        {"word": "there.", "start": 0.4, "end": 0.9},
        {"word": "Hi!", "start": 1.2, "end": 1.5},
        {"word": "More.", "start": 3.9, "end": 4.2},
    ]
    assert structure(result) == structure(openrouter_reference(words))
    assert result.provider == "local"
    assert result.model == "small.en"
    assert result.language == "en"
    assert result.full_text == "Hello there. Hi! More."
    # Local transcription costs nothing and never carries speaker labels.
    assert result.api_costs.provider == "local"
    assert result.api_costs.estimated_cost_usd == 0
    assert all(s.speaker_label is None for s in result.segments)
    # The provider asks for word timestamps and no cross-chunk conditioning.
    options = model.calls[0][1]
    assert options["word_timestamps"] is True
    assert options["condition_on_previous_text"] is False
    assert options["vad_filter"] is True


def test_numpy_word_times_from_faster_whisper_are_accepted(tmp_path, monkeypatch):
    """faster-whisper reports numpy.float64 times; an exact type check rejected them."""
    audio = prepare(tmp_path, monkeypatch)
    svc = service(local_settings(tmp_path))
    model = FakeWhisperModel([
        segment("Hello there.", [numpy_whisper_word("Hello", 0.1, 0.4), numpy_whisper_word("there.", 0.4, 0.9)]),
    ])
    monkeypatch.setattr(stt, "load_faster_whisper_model", lambda settings: model)
    monkeypatch.setattr(svc, "_audio_duration", lambda _: 20.0)

    result = asyncio.run(svc.transcribe_audio(str(audio)))
    assert [(w.word, w.start_time_ms, w.end_time_ms) for s in result.segments for w in s.words] == [
        ("Hello", 100, 400),
        ("there.", 400, 900),
    ]


def test_local_silence_is_valid_but_text_without_word_times_is_not(tmp_path, monkeypatch):
    audio = prepare(tmp_path, monkeypatch)
    svc = service(local_settings(tmp_path))
    monkeypatch.setattr(svc, "_audio_duration", lambda _: 20.0)

    silent = FakeWhisperModel([segment("", None)])
    monkeypatch.setattr(stt, "load_faster_whisper_model", lambda settings: silent)
    result = asyncio.run(svc.transcribe_audio(str(audio)))
    assert result.segments == []

    untimed = FakeWhisperModel([segment("Hello there.", [])])
    monkeypatch.setattr(stt, "load_faster_whisper_model", lambda settings: untimed)
    with pytest.raises(stt.TranscriptionError) as failure:
        asyncio.run(svc.transcribe_audio(str(audio)))
    assert failure.value.reason == "missing_word_timestamps"


def test_parakeet_tokens_become_words_with_real_times():
    from clip_engine.services.local_parakeet import _words_from_tokens

    # Token start times are real; the end of a word is bounded by the next
    # token and the token cadence the model itself reported (never spread).
    words = _words_from_tokens([" Hello", " the", "re", ".", " Bye"], [0.2, 0.5, 0.7, 0.9, 4.0], offset=10.0, window_end=12.0)
    assert [(w.word, w.start_time_ms, w.end_time_ms) for w in words] == [
        ("Hello", 10200, 10400),
        ("there.", 10500, 11100),
        ("Bye", 14000, 14200),
    ]
    # SentencePiece markers start a new word like a leading space does.
    sentencepiece = _words_from_tokens(["\u2581So", "\u2581anyway", "."], [0.0, 0.4, 0.8], offset=0.0, window_end=5.0)
    assert [(w.word, w.start_time_ms, w.end_time_ms) for w in sentencepiece] == [("So", 0, 400), ("anyway.", 400, 1200)]
    # Empty windows stay empty; missing timestamps never get invented.
    assert _words_from_tokens(None, None, 0.0, 5.0) == []
    with pytest.raises(stt.TranscriptionError) as failure:
        _words_from_tokens([" Hi"], None, 0.0, 5.0)
    assert failure.value.reason == "missing_word_timestamps"
    with pytest.raises(stt.TranscriptionProviderError):
        _words_from_tokens(["a", "b"], [0.5, 0.2], 0.0, 5.0)


def test_local_setup_failures_are_safe_and_actionable(tmp_path, monkeypatch):
    settings = local_settings(tmp_path, local_transcription_device="cuda")

    def cuda_failure(*args, **kwargs):
        raise RuntimeError("Library cudnn_ops_infer64_9.dll is not found")

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=cuda_failure))
    with pytest.raises(stt.TranscriptionError) as failure:
        stt.load_faster_whisper_model(settings)
    assert failure.value.reason == "local_gpu_unavailable"
    assert "AMD, Intel, or no dedicated GPU" in str(failure.value)

    # Choosing a modern NVIDIA family on a Pascal card asks for float16, which
    # CTranslate2 rejects with no CUDA/DLL words in the message. That is still
    # a GPU mismatch and gets the same actionable error (never a CPU retry).
    def float16_rejection(*args, **kwargs):
        raise ValueError("Requested float16 compute type, but the target device or backend do not support efficient float16 computation.")

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=float16_rejection))
    with pytest.raises(stt.TranscriptionError) as failure:
        stt.load_faster_whisper_model(settings)
    assert failure.value.reason == "local_gpu_unavailable"
    assert str(failure.value) == stt.GPU_LOAD_ERROR

    monkeypatch.delitem(sys.modules, "faster_whisper")
    monkeypatch.setitem(sys.modules, "faster_whisper", None)
    with pytest.raises(stt.TranscriptionError) as failure:
        stt.load_faster_whisper_model(local_settings(tmp_path))
    assert failure.value.reason == "local_runtime_missing"

    monkeypatch.delitem(sys.modules, "faster_whisper")
    missing = local_settings(tmp_path)
    missing.local_transcription_model_dir = str(tmp_path / "not-downloaded")
    with pytest.raises(stt.TranscriptionError) as failure:
        stt.load_faster_whisper_model(missing)
    assert failure.value.reason == "local_model_missing"
