"""Tests for the offline tools. Standard library only: ``python -m unittest discover -s tools/tests``.

Tests that need the compiled app (``npm run build``) or ``node`` are skipped, not failed, when those are absent.
"""
from __future__ import annotations

import math
import random
import shutil
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]
REPO = TOOLS.parent
sys.path.insert(0, str(TOOLS))

import alias_miner  # noqa: E402
import asr_bakeoff  # noqa: E402
import log_to_replay  # noqa: E402
import quote_tuner  # noqa: E402
import service_report  # noqa: E402
import vad_eval  # noqa: E402
from churchtools import appdata, errorrate, logs, text_norm  # noqa: E402

FIXTURE = TOOLS / "tests" / "fixtures" / "sample.jsonl"
HAS_BUILD = (REPO / "dist" / "apps" / "server" / "detector" / "regex-detector.js").exists() and shutil.which("node") is not None


def load_events():
    stats = logs.ReadStats()
    return list(logs.iter_events([str(FIXTURE)], stats)), stats


class LogsTests(unittest.TestCase):
    def test_bad_and_truncated_lines_are_counted_never_fatal(self):
        events, stats = load_events()
        self.assertEqual(stats.skipped, 2)  # the prose line and the cut-off JSON line
        self.assertEqual(stats.events, len(events))
        self.assertTrue(all(e.event for e in events))

    def test_only_final_transcripts_are_returned(self):
        events, _ = load_events()
        finals = [e.metadata["text"] for e in logs.final_transcripts(events)]
        self.assertIn("Verset 8.", finals)
        self.assertNotIn("Donc, nous allonsqu'on a vu dans Esaïe 4, le verset 8,", finals)  # a partial


class TextAndErrorRateTests(unittest.TestCase):
    def test_quote_tokens_mirror_the_app(self):
        # Same expectation as quoteTokens in quote-matcher.test.ts: elisions folded, accents stripped.
        self.assertEqual(text_norm.quote_tokens("L’Éternel, qu'il"), ["leternel", "quil"])
        self.assertEqual(text_norm.quote_tokens("cœur"), ["coeur"])

    def test_error_rates(self):
        self.assertEqual(errorrate.edit_distance("kitten", "sitting"), 3)
        self.assertAlmostEqual(errorrate.wer("a b c d", "a x c"), 0.5)
        self.assertEqual(errorrate.wer("", ""), 0.0)
        self.assertEqual(errorrate.wer("", "extra"), 1.0)
        self.assertAlmostEqual(errorrate.cer("ab cd", "abxd"), 0.25)


class AppDataTests(unittest.TestCase):
    """The tools read the app's own TypeScript tables, so they must keep parsing them."""

    def test_catalog_and_aliases_parse_from_the_real_source(self):
        catalog = appdata.load_catalog_ids()
        self.assertEqual(len(catalog), 66)
        self.assertIn("isaiah", catalog)
        aliases = appdata.load_aliases()
        self.assertEqual(aliases["esaie"], "isaiah")
        self.assertEqual(aliases["nombre"], "numbers")  # added from the live log of 2026-10-12

    def test_offline_keys_map_back_to_catalog_ids(self):
        keys = appdata.load_offline_keys()
        self.assertEqual(keys["genese"], "genesis")
        self.assertEqual(keys["nombres"], "numbers")


class AliasMinerTests(unittest.TestCase):
    def setUp(self):
        self.events, _ = load_events()
        self.catalog = appdata.load_catalog_ids()
        # The app now knows "nombre"; drop it so the miner can rediscover it from the log.
        self.aliases = {k: v for k, v in appdata.load_aliases().items() if k != "nombre"}

    def test_rediscovers_the_nombre_mishearing_with_evidence(self):
        proposals = alias_miner.mine(self.events, self.aliases, self.catalog)
        self.assertEqual([(p.token, p.book) for p in proposals], [("nombre", "numbers")])
        self.assertEqual(proposals[0].evidence, 2)
        self.assertEqual(proposals[0].examples[0], "dans nombre un, le verset 2,")

    def test_known_spellings_propose_nothing(self):
        # "Esther" is already a catalog book: the correction for it is not a new alias.
        proposals = alias_miner.mine(self.events, self.aliases, self.catalog)
        self.assertNotIn("esther", [p.token for p in proposals])
        self.assertEqual(alias_miner.mine(self.events, appdata.load_aliases(), self.catalog), [])  # nombre now known

    def test_collision_check_counts_the_word_in_other_finals(self):
        proposals = alias_miner.mine(self.events, self.aliases, self.catalog)
        # "nombre" also appears in a final that led to no correction ("Dans nombre un, le verset 2,").
        self.assertEqual(proposals[0].seen_in_other_finals, 1)
        self.assertEqual(proposals[0].risk, "medium")

    def test_split_reference_handles_volumes_and_multiword_books(self):
        self.assertEqual(alias_miner.split_reference("1 john 4:8"), "1 john")
        self.assertEqual(alias_miner.split_reference("song of solomon 2:1"), "song of solomon")
        self.assertIsNone(alias_miner.split_reference("nonsense"))


class LogToReplayTests(unittest.TestCase):
    def test_distinct_finals_only_in_log_order(self):
        events, _ = load_events()
        texts = log_to_replay.extract_finals(events)
        self.assertEqual(len(texts), len(set(t.lower() for t in texts)))
        self.assertIn("ils sont envoyésdans Psaume 119, verset 110.", texts)
        self.assertEqual(texts[0], "Donc, allons qu'on a vu dans Esaïe 4, le verset 8, pour pouvoir comprendre")
        self.assertIn("Verset 8.", texts)  # 9 characters: kept at the default minimum of 8 (see the next test for dropping it)
        self.assertEqual(sum("dans nombre un" in t.lower() for t in texts), 1)  # the two spellings dedupe to one case

    def test_min_chars_drops_short_fragments(self):
        events, _ = load_events()
        self.assertNotIn("Verset 8.", log_to_replay.extract_finals(events, min_chars=12))

    def test_ts_rows_are_valid_typescript_object_literals(self):
        rows = log_to_replay.render_ts_rows(['Dans "Esaïe" 4'], [{"shown": [], "rejected": ["isaiah 4:8"]}])
        self.assertIn('{ text: "Dans \\"Esaïe\\" 4", shown: [], rejected: ["isaiah 4:8"], note: "TODO review (from log)" },', rows)

    @unittest.skipUnless(HAS_BUILD, "needs `npm run build` and node")
    def test_real_detector_outcomes(self):
        out = log_to_replay.run_detector(["Jean 3 : 16", "Dans Esaïe 4, le verset 8", "Verset suivant."])
        self.assertEqual(out[0], {"shown": ["john 3:16"], "rejected": []})
        self.assertEqual(out[1], {"shown": [], "rejected": ["isaiah 4:8"]})
        self.assertEqual(out[2], {"shown": [], "rejected": []})


class ServiceReportTests(unittest.TestCase):
    def test_report_numbers(self):
        events, _ = load_events()
        report = service_report.build_report(events)
        self.assertEqual(report["latency_ms"]["count"], 2)
        self.assertEqual(report["latency_ms"]["p50"], 845)
        self.assertEqual(report["latency_ms"]["max"], 870)
        self.assertEqual(report["silence_gate"]["framesReceived"], 42933)  # the LAST snapshot
        self.assertEqual(report["near_misses"]["Noval verses cinq."], 1)
        self.assertEqual(report["navigation_no_ops"]["verse_out_of_range"], 2)
        self.assertEqual(report["quote_suggestions"], 1)
        self.assertTrue(any("(404)" in k for k in report["ai_failures"]))
        self.assertGreater(report["transcripts"]["final"], 5)

    def test_markdown_renders_every_section(self):
        events, stats = load_events()
        text = service_report.render_markdown(service_report.build_report(events), stats)
        for heading in ("# Service report", "## Latency", "## Silence gate", "near-misses", "## AI helper trouble"):
            self.assertIn(heading, text)
        self.assertIn("2 non-JSON lines skipped", text)

    def test_percentile_is_nearest_rank_and_safe_when_empty(self):
        self.assertEqual(service_report.percentile([10, 20, 30, 40], 50), 20)
        self.assertEqual(service_report.percentile([10, 20, 30, 40], 95), 40)
        self.assertTrue(math.isnan(service_report.percentile([], 50)))


class AsrBakeoffTests(unittest.TestCase):
    def test_numbers_are_scored_separately_from_words(self):
        ref = "ouvrons Jean 3 verset 16 et Romains 8 verset 28"
        good = asr_bakeoff.score("good", ref, "ouvrons Jean 3 verset 16 et Romains 8 verset 28")
        bad = asr_bakeoff.score("bad", ref, "ouvrons Jean 3 verset 60 et Romains 8 verset 28")
        self.assertEqual(good.wer, 0.0)
        self.assertEqual(good.number_recall, 1.0)
        self.assertAlmostEqual(bad.number_recall, 0.75)
        self.assertLess(bad.wer, 0.15)  # one wrong word looks harmless to WER, which is why numbers are reported on their own

    def test_accents_count_by_default(self):
        self.assertGreater(asr_bakeoff.score("p", "Éternel", "Eternel").wer, 0.0)
        self.assertEqual(asr_bakeoff.score("p", "Éternel", "Eternel", keep_accents=False).wer, 0.0)

    def test_hypothesis_from_log_joins_final_transcripts(self):
        text = asr_bakeoff.hypothesis_from_log(str(FIXTURE))
        self.assertIn("Verset 8.", text)
        self.assertNotIn("nous allonsqu'on", text)  # that one is a partial


class VadEvalTests(unittest.TestCase):
    RATE = 16000

    def _wav(self, directory: Path) -> Path:
        """0.5 s room noise, 1.0 s loud tone ("speech"), 1.0 s room noise."""
        rng = random.Random(1)

        def noise(n: int) -> list[int]:
            return [int(rng.gauss(0, 30)) for _ in range(n)]  # rms ~30, well under the 150 threshold

        tone = [int(3000 * math.sin(2 * math.pi * 220 * i / self.RATE)) for i in range(self.RATE)]
        samples = noise(self.RATE // 2) + tone + noise(self.RATE)
        path = directory / "synthetic.wav"
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(self.RATE)
            handle.writeframes(struct.pack("<%dh" % len(samples), *samples))
        return path

    def test_default_gate_keeps_all_speech_and_a_threshold_above_the_speech_drops_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            rate, samples = vad_eval.read_wav(self._wav(Path(tmp)))
        frame_ms = 1000 * vad_eval.DEFAULT_FRAME_SAMPLES / rate
        rms = vad_eval.frame_rms(samples, vad_eval.DEFAULT_FRAME_SAMPLES)
        truth = vad_eval.labels_to_frames([(0.5, 1.5)], len(rms), frame_ms)
        current = vad_eval.evaluate(rms, truth, frame_ms, 150, 600)
        self.assertEqual(current.dropped_speech_frames, 0)
        self.assertEqual(current.speech_recall, 1.0)
        too_high = vad_eval.evaluate(rms, truth, frame_ms, 5000, 600)
        self.assertEqual(too_high.speech_recall, 0.0)  # the failure that looks like "the mic doesn't work"

    def test_hangover_keeps_forwarding_for_600_ms_after_the_last_loud_frame(self):
        frame_ms = 8.0
        decisions = vad_eval.gate_decisions([1000.0] + [0.0] * 200, frame_ms, threshold=150, hangover_ms=600)
        self.assertTrue(all(decisions[:76]))  # 1 loud frame + 75 frames x 8 ms = 600 ms of hangover
        self.assertFalse(any(decisions[77:]))

    def test_non_pcm16_mono_is_refused_with_a_helpful_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "stereo.wav"
            with wave.open(str(path), "wb") as handle:
                handle.setnchannels(2)
                handle.setsampwidth(2)
                handle.setframerate(16000)
                handle.writeframes(b"\x00\x00" * 64)
            with self.assertRaisesRegex(ValueError, "mono"):
                vad_eval.read_wav(path)


class QuoteTunerTests(unittest.TestCase):
    def test_queries_are_deterministic_and_balanced(self):
        verses = [(f"john 3:{i}", "mot " * 12 + f"unique{i} " + "fin " * 3) for i in range(1, 40)]
        a = quote_tuner.make_queries(verses, 10, 0.2, 7, [])
        b = quote_tuner.make_queries(verses, 10, 0.2, 7, [])
        self.assertEqual([q.text for q in a], [q.text for q in b])
        self.assertEqual(sum(q.kind == "exact" for q in a), 10)
        self.assertEqual(sum(q.kind == "noisy" for q in a), 10)
        self.assertGreaterEqual(sum(q.kind == "negative" for q in a), 10)
        self.assertTrue(all(q.truth is None for q in a if q.kind == "negative"))

    def test_scoring_separates_exact_adjacent_wrong_and_false_positive(self):
        qs = [quote_tuner.Query(0, "", "exact", "john 3:16"), quote_tuner.Query(1, "", "exact", "john 3:16"),
              quote_tuner.Query(2, "", "noisy", "john 3:16"), quote_tuner.Query(3, "", "negative", None),
              quote_tuner.Query(4, "", "negative", None)]
        matches = [{"id": 0, "match": "john 3:16"}, {"id": 1, "match": "john 3:17"}, {"id": 2, "match": "romans 8:1"},
                   {"id": 3, "match": "john 1:1"}, {"id": 4, "match": None}]
        s = quote_tuner.score(qs, matches)
        self.assertAlmostEqual(s["recall"], 1 / 3)
        self.assertAlmostEqual(s["adjacent"], 1 / 3)
        self.assertAlmostEqual(s["wrong"], 1 / 3)
        self.assertAlmostEqual(s["false_positive"], 0.5)

    def test_recommendation_respects_the_false_positive_limit(self):
        safe = ({"shingle": 5}, {"recall": 0.5, "false_positive": 0.0, "wrong": 0.0})
        risky = ({"shingle": 3}, {"recall": 0.9, "false_positive": 0.2, "wrong": 0.0})
        self.assertEqual(quote_tuner.recommend([safe, risky], 0.0), safe)
        self.assertEqual(quote_tuner.recommend([safe, risky], 0.25), risky)
        self.assertIsNone(quote_tuner.recommend([risky], 0.0))

    def test_adjacent(self):
        self.assertTrue(quote_tuner.adjacent("john 3:16", "john 3:17"))
        self.assertFalse(quote_tuner.adjacent("john 3:16", "john 4:17"))

    @unittest.skipUnless(HAS_BUILD, "needs `npm run build` and node")
    def test_real_matcher_finds_a_verse_read_exactly_and_ignores_sermon_talk(self):
        verses = dict(quote_tuner.load_verses())
        queries = [quote_tuner.Query(0, verses["john 3:16"], "exact", "john 3:16"),
                   quote_tuner.Query(1, quote_tuner.SERMON_SENTENCES[0], "negative", None)]
        (results,) = quote_tuner.run_matcher([quote_tuner.DEFAULTS], queries)
        self.assertEqual(results[0]["match"], "john 3:16")
        self.assertIsNone(results[1]["match"])


if __name__ == "__main__":
    unittest.main()
